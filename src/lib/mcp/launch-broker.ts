import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { spawnWithWorkAdmission as spawn } from '@/lib/app-update/work-launch-admission';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { providerCredentialMaterials } from '@/lib/providers/key-store';
import { assertMcpTransport, mcpLaunchEnvironment, redactMcpResponse } from '@/lib/providers/mcp-launch-policy';
import { onCredentialPolicyChange } from '@/lib/providers/policy-events';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { SANDBOX_EXEC_PATH } from '@/lib/runtimes/shared/owned-session/sandbox';
import { listEnabledExternalMcpServers, type OrchestratorMcpServerConfig } from './external-servers';
import { templateWorkerMcpServer, type ResolvedWorkerMcpServer, type WorkerMcpInjectionContext } from './worker-injection';
import { MCP_BROKER_CLIENT } from './broker-client';
import { getDataDir } from '@/lib/data-dir-migration';
import { registerSymonMcpCacheInvalidator } from './symon-tools-cache';

const MAX_FRAME = 1024 * 1024;
type Identity = Parameters<typeof guardedWorkspaceInvocation>[2];
export type BrokerLaunchPolicy = { materializationIdentity: Identity; sandboxProfile?: string };
type Scope = { cwd: string; directory: string; worker?: WorkerMcpInjectionContext; runId?: string; sandboxRequired?: boolean };
type Binding = { id: string; name: string; token: string; file: string; active?: () => void };
const brokers = new Map<string, LaunchBroker>();
const leadBrokers = new Map<string, LaunchBroker>();

/** One run, private capabilities, and immutable server-side launch context. */
class LaunchBroker {
  readonly references: ResolvedWorkerMcpServer[];
  readonly readPaths: string[];
  private readonly bindings: Binding[];
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer({ allowHalfOpen: true }, socket => this.accept(socket));
  private policy: BrokerLaunchPolicy | null;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private pending: ReturnType<typeof setTimeout>;

  constructor(servers: readonly Pick<ResolvedWorkerMcpServer, 'id' | 'name'>[], private readonly scope: Scope) {
    this.policy = scope.runId ? null : { materializationIdentity: null };
    mkdirSync(scope.directory, { recursive: true, mode: 0o700 });
    this.bindings = servers.map(server => {
      assertMcpTransport([server.id, server.name]);
      return { id: server.id, name: server.name, token: randomBytes(32).toString('hex'),
        file: path.join(scope.directory, `mcp-broker-${randomUUID()}.json`) };
    });
    this.references = this.bindings.map(binding => ({ id: binding.id, name: binding.name,
      command: process.execPath, args: ['-e', MCP_BROKER_CLIENT, binding.file], env: null }));
    this.readPaths = this.bindings.map(binding => binding.file);
    this.pending = setTimeout(() => this.close(), 10 * 60_000); this.pending.unref();
    if (!scope.runId) clearTimeout(this.pending);
    this.timer = setInterval(() => { if (this.policy && !this.current()) this.close(); }, 1000); this.timer.unref();
    this.server.on('error', () => this.close());
    this.server.listen(0, '127.0.0.1', () => {
      const address = this.server.address();
      if (this.closed) { this.server.close(); return; }
      if (!address || typeof address === 'string') return;
      try {
        for (const binding of this.bindings) writeFileSync(binding.file,
          JSON.stringify({ version: 1, host: '127.0.0.1', port: address.port, token: binding.token }), { mode: 0o600, flag: 'wx' });
      } catch { this.close(); }
    });
    this.server.unref();
  }
  bind(policy: BrokerLaunchPolicy): void {
    if (this.closed || this.scope.sandboxRequired && !policy.sandboxProfile) throw new Error('MCP launch policy unavailable.');
    this.policy = policy; clearTimeout(this.pending);
  }
  private current(): boolean {
    if (!this.scope.runId) return true;
    try {
      const state = JSON.parse(readFileSync(path.join(this.scope.directory, 'session.json'), 'utf8'));
      return state.activeRun?.id === this.scope.runId && state.activeRun.outcome === 'running'
        && !state.activeRun.interruptRequestedAt && !state.activeRun.finishedAt;
    } catch { return false; }
  }
  pendingIn(directory: string): boolean { return !this.policy && this.scope.directory === directory; }
  disconnect(): void { for (const binding of this.bindings) binding.active?.(); }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.pending); clearInterval(this.timer); this.disconnect();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    for (const binding of this.bindings) { try { unlinkSync(binding.file); } catch { /* Already removed. */ } }
    if (this.scope.runId) brokers.delete(this.scope.runId);
    for (const [key, broker] of leadBrokers) if (broker === this) leadBrokers.delete(key);
  }
  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= 16) { socket.destroy(); return; }
    this.sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let input = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) { socket.destroy(); return; }
      const newline = input.indexOf(10); if (newline < 0) return;
      socket.removeListener('data', authenticate); socket.pause(); socket.setTimeout(0);
      try {
        const auth = JSON.parse(input.subarray(0, newline).toString());
        if (Object.keys(auth).length !== 1 || !/^[a-f0-9]{64}$/.test(auth.token)) throw new Error();
        const binding = this.bindings.find(candidate => timingSafeEqual(Buffer.from(candidate.token), Buffer.from(auth.token)));
        if (!binding || binding.active || !this.policy || !this.current()) throw new Error();
        this.launch(binding, socket, input.subarray(newline + 1));
      } catch { socket.end('{"ready":false}\n'); socket.destroySoon(); }
    };
    socket.on('data', authenticate);
  }
  private launch(binding: Binding, socket: Socket, initial: Buffer): void {
    withProviderStoreLock(() => {
      if (!this.policy || !this.current()) throw new Error();
      const registered = listEnabledExternalMcpServers().find(server => server.id === binding.id && server.transport === 'stdio'
        && (!this.scope.worker || server.workerInjection && (server.teamId === null || server.teamId === this.scope.worker.teamId)));
      if (!registered) throw new Error();
      const server = this.scope.worker ? templateWorkerMcpServer(registered, this.scope.worker) : registered;
      // Provider credentials belong only in freshly resolved child env, never argv.
      assertMcpTransport([server.command, server.args]);
      const env = mcpLaunchEnvironment(server.command, server.env ?? {});
      const secrets = [...new Set([...providerCredentialMaterials().values,
        ...Object.entries(env).filter(([key]) => /API_KEY|AUTH_TOKEN/.test(key)).map(([, value]) => value).filter(Boolean)])];
      let launch = cliInvocation(server.command, server.args);
      if (this.scope.sandboxRequired) {
        if (!this.policy.sandboxProfile) throw new Error();
        launch = { command: SANDBOX_EXEC_PATH, args: ['-p', this.policy.sandboxProfile, launch.command, ...launch.args] };
      }
      launch = guardedWorkspaceInvocation(launch.command, launch.args, this.policy.materializationIdentity);
      const child = spawn(launch.command, launch.args, { cwd: this.scope.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const stop = () => {
        if (binding.active !== stop) return;
        binding.active = undefined; socket.destroy();
        if (child.exitCode === null && child.signalCode === null) {
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* Already exited. */ }
          const force = setTimeout(() => { if (child.exitCode !== null || child.signalCode !== null) return; try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ } }, 500);
          force.unref();
        }
      };
      binding.active = stop;
      socket.once('close', stop); child.once('error', stop);
      child.stderr.on('data', () => {}); child.stdin.on('error', stop);
      let output = '';
      const decoder = new StringDecoder('utf8');
      const scrub = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        output += decoder.write(chunk);
        if (Buffer.byteLength(output) > MAX_FRAME) { callback(new Error('MCP frame exceeds limit.')); return; }
        for (let index = output.indexOf('\n'); index >= 0; index = output.indexOf('\n')) {
          const line = output.slice(0, index); output = output.slice(index + 1);
          try { this.push(JSON.stringify({ type: 'stdout', text: JSON.stringify(redactMcpResponse(JSON.parse(line), secrets)) + '\n' }) + '\n'); }
          catch { this.push(JSON.stringify({ type: 'stdout', text: '[invalid MCP frame]\n' }) + '\n'); }
        }
        callback();
      } });
      scrub.once('error', stop);
      let exitCode: number | undefined;
      const finish = () => {
        if (exitCode === undefined || !scrub.readableEnded || binding.active !== stop) return;
        binding.active = undefined;
        socket.end(JSON.stringify({ type: 'exit', code: exitCode }) + '\n');
      };
      scrub.once('end', finish);
      child.once('close', code => { exitCode = code ?? 1; finish(); });
      child.once('spawn', () => {
        socket.write('{"ready":true}\n'); child.stdout.pipe(scrub).pipe(socket, { end: false });
        if (initial.length) child.stdin.write(initial);
        socket.pipe(child.stdin); socket.resume();
      });
    });
  }
}

export function createWorkerMcpBroker(servers: ResolvedWorkerMcpServer[], context: WorkerMcpInjectionContext,
  sessionDir: string, runId: string, sandboxRequired: boolean) {
  const broker = new LaunchBroker(servers, { cwd: context.worktreePath, directory: sessionDir, worker: context, runId, sandboxRequired });
  brokers.set(runId, broker);
  return { servers: broker.references, readPaths: broker.readPaths, close: () => broker.close() };
}
export function bindWorkerMcpBroker(runId: string, policy: BrokerLaunchPolicy): void { brokers.get(runId)?.bind(policy); }
export function closeWorkerMcpBroker(runId: string): void { brokers.get(runId)?.close(); }
export function closePendingWorkerMcpBrokers(directory: string): void {
  for (const broker of brokers.values()) if (broker.pendingIn(directory)) broker.close();
}
/** Stable per-workspace reference: the parent never sees registered credentials. */
export function externalMcpBrokerConfig(server: { id: string; name: string }, cwd: string): OrchestratorMcpServerConfig {
  const key = JSON.stringify([getDataDir(), server.id, cwd]);
  let broker = leadBrokers.get(key);
  if (!broker) {
    broker = new LaunchBroker([server], { cwd, directory: path.join(getDataDir(), 'mcp', 'broker-references') });
    leadBrokers.set(key, broker);
  }
  const reference = broker.references[0];
  return { type: 'stdio', command: reference.command, args: reference.args };
}
onCredentialPolicyChange(() => { for (const broker of [...brokers.values(), ...leadBrokers.values()]) broker.disconnect(); });
registerSymonMcpCacheInvalidator(() => { for (const broker of [...brokers.values(), ...leadBrokers.values()]) broker.disconnect(); });
export function closeMcpLaunchBrokers(): void { for (const broker of [...brokers.values(), ...leadBrokers.values()]) broker.close(); }
process.once('exit', closeMcpLaunchBrokers);
