import { createHash } from 'node:crypto';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const browserCalls = vi.hoisted(() => ({ evaluations: 0, beforeReply: null as null | (() => Promise<void>) }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({ O8WebviewClient: class {
  async evalJs(script: string) {
    browserCalls.evaluations++;
    const callback = browserCalls.beforeReply;
    browserCalls.beforeReply = null;
    await callback?.();
    const requestId = JSON.parse(script.match(/const requestId = ("[^"]+")/)![1]);
    return { result: JSON.stringify({ requestId, ok: false, status: 'unavailable', automaticReplay: false }) };
  }
  async listWindows() { return { windows: [] }; }
} }));

const root = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-services-')));
const prior = { ...process.env };
const running: Array<{ worktreePath: string; packetId: string; laneId: string }> = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = quote(process.execPath);

async function stopInFreshProcess(id: string, onSpawn?: (child: ChildProcess) => void) {
  const script = `void (async () => {
    const imported = await import('./src/lib/runtimes/managed-runs/termination.ts');
    const { terminateManagedRun } = imported.default ?? imported;
    const registry = await import('./src/lib/runtimes/managed-runs/registry.ts');
    const { findManagedRun } = registry.default ?? registry;
    try {
      const receipt = await terminateManagedRun(findManagedRun(${JSON.stringify(id)}), { reason: 'operator_stop', exitCode: 130 });
      console.log('O8_STOP ' + JSON.stringify(receipt));
    } catch (error) { console.log('O8_STOP ' + JSON.stringify({ error: error.message })); }
    const db = await import('./src/lib/db/index.ts'); (db.default ?? db).closeDb();
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  // Launch the actual interpreter directly: killing a tsx CLI parent would
  // leave its interpreter child running and let it race the recovery assertion.
  const pending = promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--eval', script], {
    cwd: process.cwd(), timeout: 35_000, env: { ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' ') },
  });
  onSpawn?.(pending.child);
  const result = await pending;
  const line = result.stdout.split('\n').find(line => line.startsWith('O8_STOP '));
  if (!line) throw new Error(`Missing fresh-process stop receipt: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('O8_STOP '.length));
}

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  process.env.O8_DATA_DIR = path.join(root, 'data');
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  process.env.SERVICE_TEST_TOKEN = 'fixture-only-secret';
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001, workspaceManifestPolicy: 'auto' });
});

afterAll(async () => {
  const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
  for (const identity of running) await settleTerminalWorkspaceManifest(identity);
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const key of ['CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'O8_WORKTREE_ROOT', 'O8_SKIP_PRELAUNCH_TYPECHECK', 'SERVICE_TEST_TOKEN']) {
    if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
  }
  rmSync(root, { recursive: true, force: true });
});

async function fixture(name: string, manifest: Record<string, unknown>) {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(path.join(repoPath, 'server.cjs'), `
const http = require('node:http');
const fs = require('node:fs');
(async () => {
  if (process.env.SERVICE_TEST_TOKEN) process.exit(8);
  if (process.env.PEER) {
    const response = await fetch(process.env.PEER);
    if (await response.text() !== 'api') process.exit(6);
  }
  const server = http.createServer((req, res) => res.end(process.env.NAME));
  server.listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync(process.env.NAME + '.pid', String(process.pid)));
})();
`);
  writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify(manifest));
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-qm', 'fixture'], { cwd: repoPath });
  execFileSync('git', ['remote', 'add', 'origin', repoPath], { cwd: repoPath });
  return repoPath;
}

async function provision(repoPath: string, name: string) {
  const { createLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
  const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
  const lane = createLane({ repoPath, branch: `test/${name}`, baseBranch: 'main', runtime: 'codex', label: name, packetId: name });
  setLaneStatus(lane.id, 'launching', 'system', 'fixture');
  const prepared = await prepareLaunchWorktree({ repoRoot: repoPath, agentType: 'codex', taskName: name,
    branchName: `test/${name}`, baseBranch: 'main', isolate: true, skipSetup: true, packetId: name, laneId: lane.id });
  if (!prepared) throw new Error('fixture worktree was not provisioned');
  updateLane(lane.id, { worktreePath: prepared.cwd }, 'system');
  const identity = { worktreePath: prepared.cwd, packetId: name, laneId: lane.id };
  running.push(identity);
  const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
  return { identity, receipt: await readWorkspaceManifestReceipt(prepared.cwd) };
}

const services = [
  { name: 'api', command: `${node} server.cjs`, env: { NAME: 'api' }, port: { preferred: 43520, env: 'API_PORT' },
    health: { http: 'http://127.0.0.1:{{port}}', timeoutMs: 3000 } },
  { name: 'web', command: `${node} server.cjs`, env: { NAME: 'web', PEER: 'http://127.0.0.1:{{service:api}}' },
    port: { preferred: 43520, env: 'WEB_PORT' }, health: { http: 'http://127.0.0.1:{{port}}', timeoutMs: 3000 } },
];
const teardown = `${node} -e ${quote("require('node:fs').appendFileSync('teardown.txt', 'done\\n')")}`;

describe.sequential('owned workspace services through packet creation', () => {
  it('starts actual peer services in isolated packets and tears down each generation once', async () => {
    const repo = await fixture('dependent', { version: 1, setup: [`${node} -e ${quote('if (process.env.SERVICE_TEST_TOKEN) process.exit(19)')}`], services, teardown: [teardown], preview: { url: 'http://127.0.0.1:{{service:web}}' } });
    const [first, second] = await Promise.all([provision(repo, 'first'), provision(repo, 'second')]);
    expect(first.receipt?.state).toBe('completed');
    expect(second.receipt?.state).toBe('completed');
    const ports = [first.receipt!.ports.api, first.receipt!.ports.web, second.receipt!.ports.api, second.receipt!.ports.web];
    expect(new Set(ports).size).toBe(4);
    const handle = (packet: typeof first) => JSON.parse(readFileSync(path.join(root, 'data', 'workspace-services',
      createHash('sha256').update(JSON.stringify([packet.identity.worktreePath, packet.identity.packetId, packet.identity.laneId])).digest('hex'), 'handle.json'), 'utf8')) as { directory: string };
    const firstHandle = handle(first), secondHandle = handle(second);
    renameSync(firstHandle.directory, `${firstHandle.directory}.held`);
    symlinkSync(secondHandle.directory, firstHandle.directory, 'dir');
    try {
      const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
      await expect(settleTerminalWorkspaceManifest(first.identity)).rejects.toThrow();
      expect(existsSync(path.join(secondHandle.directory, 'stop'))).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${second.receipt!.ports.web}`)).text()).toBe('web');
    } finally {
      unlinkSync(firstHandle.directory);
      renameSync(`${firstHandle.directory}.held`, firstHandle.directory);
    }

    for (const packet of [first, second]) {
      expect(await (await fetch(`http://127.0.0.1:${packet.receipt!.ports.web}`)).text()).toBe('web');
      const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
      await Promise.all([settleTerminalWorkspaceManifest(packet.identity), settleTerminalWorkspaceManifest(packet.identity)]);
      expect(readFileSync(path.join(packet.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
      await expect(fetch(`http://127.0.0.1:${packet.receipt!.ports.web}`)).rejects.toThrow();
      for (const name of ['api', 'web']) {
        const pid = Number(readFileSync(path.join(packet.identity.worktreePath, `${name}.pid`), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      }
    }
  }, 120_000);

  it('settles failed provisioning and runs teardown without leaking the already started peer', async () => {
    const repo = await fixture('failed', { version: 1, services: [services[0], { ...services[1], command: 'exit 23' }], teardown: [teardown] });
    const result = await provision(repo, 'failed');
    expect(result.receipt?.state).toBe('failed');
    await vi.waitFor(() => expect(existsSync(path.join(result.identity.worktreePath, 'teardown.txt'))).toBe(true));
    expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
    const pidFile = path.join(result.identity.worktreePath, 'api.pid');
    expect(existsSync(pidFile)).toBe(true);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  }, 60_000);
});

describe.sequential('workspace lifecycle failure and recovery boundaries', () => {
  it('orders explicit dependencies, retains restart exits, and records a later crash', async () => {
    const failOnce = `${node} -e ${quote("const f=require('node:fs'); if (!f.existsSync('attempted')) {f.writeFileSync('attempted','1'); process.exit(23)}")}`;
    // The shell conditional preserves exit23 for the first command attempt.
    const api = { ...services[0], command: `${failOnce} && exec ${node} server.cjs`, restart: { maxRestarts: 1, delayMs: 25 } };
    const repo = await fixture('restart', { version: 1, services: [{ ...services[1], dependsOn: ['api'] }, api], teardown: [teardown] });
    const result = await provision(repo, 'restart');
    expect(result.receipt?.state).toBe('completed');
    expect(result.receipt?.services.map(service => service.name)).toEqual(['api', 'web']);
    const attempts = result.receipt?.services[0].attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts?.[0]).toMatchObject({ exitCode: 23, finishedAt: expect.any(String) });
    process.kill(Number(readFileSync(path.join(result.identity.worktreePath, 'web.pid'), 'utf8')), 'SIGTERM');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    await vi.waitFor(async () => expect((await readWorkspaceManifestReceipt(result.identity.worktreePath))?.state).toBe('failed'), { timeout: 10_000 });
    expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
    const { waitForPreviewReady } = await import('@/lib/orchestrator/ui-loop-preview');
    expect((await waitForPreviewReady({ packetId: result.identity.packetId, laneId: result.identity.laneId, timeoutMs: 100 })).state).toBe('no_preview');
  }, 90_000);

  it.each(['setup', 'health', 'reset', 'terminal-stop'] as const)('settles %s with one durable teardown', async mode => {
    const slowTeardown = `${node} -e ${quote("setTimeout(()=>require('node:fs').appendFileSync('teardown.txt','done\\n'), 2200)")}`;
    const repo = await fixture(mode, { version: 1,
      ...(mode === 'setup' ? { setup: ['exit 23'] } : {}),
      services: mode === 'health' ? [{ ...services[0], command: 'exec sleep 600', health: { tcp: true, timeoutMs: 150 } }] : [services[0]],
      teardown: [mode === 'terminal-stop' ? slowTeardown : teardown] });
    const result = await provision(repo, mode);
    const { archiveWorkspaceManifestRunForReset, settleTerminalWorkspaceManifest, readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    if (mode === 'reset') {
      const archive = await archiveWorkspaceManifestRunForReset(result.identity);
      expect(archive).toBeTruthy();
      expect(JSON.parse(readFileSync(archive!, 'utf8')).packetId).toBe(result.identity.packetId);
      expect(await readWorkspaceManifestReceipt(result.identity.worktreePath)).toBeNull();
    } else if (mode === 'terminal-stop') {
      const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
      const run = (await listManagedRuns()).find(run => run.packetId === mode)!;
      expect(run).toBeDefined();
      vi.resetModules(); // The stop route must recover the coordinator from persisted state.
      const { POST } = await import('@/app/api/panel/managed-runs/route');
      const { getOrCreateWsToken } = await import('@/lib/ws-auth');
      const response = await POST(new Request('http://localhost/api/panel/managed-runs', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` },
        body: JSON.stringify({ action: 'kill', session: run.session }),
      }));
      expect(response.status).toBe(200);
      expect((await response.json()).termination.confirmedDead).toBe(true);
    } else {
      expect(result.receipt?.state).toBe('failed');
      expect(result.receipt?.cleanup?.state).toBe('completed');
    }
    await settleTerminalWorkspaceManifest(result.identity);
    expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
    if (mode !== 'setup') await expect(fetch(`http://127.0.0.1:${result.receipt!.ports.api}`)).rejects.toThrow();
  }, 90_000);

  it('keeps failed teardown visible and refuses to release its evidence or admit another generation', async () => {
    const repo = await fixture('teardown-failed', { version: 1, services: [services[0]], teardown: ['exit 23'] });
    const result = await provision(repo, 'teardown-failed');
    const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    await expect(settleTerminalWorkspaceManifest(result.identity)).rejects.toThrow('Workspace teardown failed');
    const { applyWorkspaceManifest } = await import('@/lib/workspace/manifest/apply');
    await expect(applyWorkspaceManifest({ ...result.identity, repoPath: repo })).resolves.toBeNull();
    // This known failed fixture remains held; subsequent global cleanup must not retry teardown.
    running.splice(running.indexOf(result.identity), 1);
    const { readWorkspaceServiceState } = await import('@/lib/workspace/manifest/services');
    expect((await readWorkspaceServiceState(result.identity))?.teardown?.state).toBe('failed');
  }, 60_000);

  it('recovers detached teardown groups after the supervisor is killed without replaying teardown or stopping a sibling', async () => {
    const command = `${node} -e ${quote("const fs=require('node:fs'); fs.appendFileSync('teardown-attempts','1'); fs.writeFileSync('orphan.pid',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")}`;
    const repo = await fixture('killed-supervisor', { version: 1, services: [services[0]], teardown: [command], limits: { timeoutMs: 1000, shutdownGraceMs: 25 } });
    const result = await provision(repo, 'killed-supervisor');
    const sibling = await provision(await fixture('surviving-sibling', { version: 1, services: [services[0]], teardown: [teardown] }), 'surviving-sibling');
    const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
    const run = (await listManagedRuns()).find(run => run.packetId === 'killed-supervisor')!;
    const { stopWorkspaceServices } = await import('@/lib/workspace/manifest/services');
    let stopper: ChildProcess | undefined;
    const firstStop = stopInFreshProcess(run.id, child => { stopper = child; }).catch(error => error);
    const key = createHash('sha256').update(JSON.stringify([result.identity.worktreePath, result.identity.packetId, result.identity.laneId])).digest('hex');
    const handle = JSON.parse(readFileSync(path.join(root, 'data', 'workspace-services', key, 'handle.json'), 'utf8'));
    let group: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(path.join(result.identity.worktreePath, 'orphan.pid'))).toBe(true), { timeout: 10_000 });
      const state = JSON.parse(readFileSync(path.join(handle.directory, 'state.json'), 'utf8'));
      group = state.teardown.commands[0].pid;
      const orphan = Number(readFileSync(path.join(result.identity.worktreePath, 'orphan.pid'), 'utf8'));
      stopper!.kill('SIGKILL');
      process.kill(run.panePid!, 'SIGKILL');
      await firstStop;
      expect(() => process.kill(orphan, 0)).not.toThrow();
      const stopped = await stopInFreshProcess(run.id);
      expect(stopped).toMatchObject({ confirmedDead: true });
      await vi.waitFor(() => {
        const rows = execFileSync('ps', ['ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
        expect(rows.split('\n').some(row => { const parts = row.trim().split(/\s+/); return Number(parts[1]) === group && !parts[2]?.startsWith('Z'); })).toBe(false);
      });
      const recovered = JSON.parse(readFileSync(path.join(handle.directory, 'state.json'), 'utf8'));
      expect(recovered).toMatchObject({ state: 'failed', cleanupUnconfirmed: false, teardown: { state: 'failed' } });
      expect(readFileSync(path.join(result.identity.worktreePath, 'teardown-attempts'), 'utf8')).toBe('1');
      expect(await (await fetch(`http://127.0.0.1:${sibling.receipt!.ports.api}`)).text()).toBe('api');
      await expect(stopWorkspaceServices(result.identity)).rejects.toThrow('Workspace teardown failed');
    } finally {
      // Red runs must also stop their fixture-owned orphan group.
      if (group) { try { process.kill(-group, 'SIGKILL'); } catch { /* Already settled. */ } }
      stopper?.kill('SIGKILL');
      running.splice(running.indexOf(result.identity), 1); // Interrupted teardown remains held.
      await firstStop;
    }
  }, 90_000);

  it('keeps failed teardown held for a lifecycle caller concurrent with an operator stop', async () => {
    const repo = await fixture('stop-policies', { version: 1, services: [services[0]], teardown: ['sleep 1; exit 23'] });
    const result = await provision(repo, 'stop-policies');
    const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
    const run = (await listManagedRuns()).find(run => run.packetId === 'stop-policies')!;
    const { readWorkspaceServiceState, stopManagedWorkspaceService } = await import('@/lib/workspace/manifest/services');
    const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    const operator = stopManagedWorkspaceService(run);
    try {
      await vi.waitFor(async () => expect((await readWorkspaceServiceState(result.identity))?.teardown?.state).toBe('running'), { timeout: 10_000 });
      const outcomes = await Promise.allSettled([operator, settleTerminalWorkspaceManifest(result.identity)]);
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Workspace teardown failed') }) });
    } finally {
      await operator.catch(() => {});
      running.splice(running.indexOf(result.identity), 1);
    }
  }, 60_000);

  it('preserves clean settlement when a fresh process stops an already exited supervisor', async () => {
    const repo = await fixture('clean-stop-again', { version: 1, services: [services[0]], teardown: [teardown] });
    const result = await provision(repo, 'clean-stop-again');
    const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
    const run = (await listManagedRuns()).find(run => run.packetId === 'clean-stop-again')!;
    const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    const { readWorkspaceServiceState } = await import('@/lib/workspace/manifest/services');
    await settleTerminalWorkspaceManifest(result.identity);
    await vi.waitFor(() => expect(() => process.kill(run.panePid!, 0)).toThrow());
    expect(await stopInFreshProcess(run.id)).toMatchObject({ confirmedDead: true });
    expect(await readWorkspaceServiceState(result.identity)).toMatchObject({ state: 'stopped', teardown: { state: 'completed' } });
    expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
  }, 60_000);

  it.each([
    { name: 'cycle', services: [{ ...services[0], dependsOn: ['web'] }, { ...services[1], dependsOn: ['api'] }] },
    { name: 'escape', services: [{ ...services[0], cwd: '..' }] },
    { name: 'inline-secret', services: [{ ...services[0], env: { DATABASE_URL: 'postgres://user:fixture-password@localhost/db' } }] },
    { name: 'preview-userinfo', services: [], preview: { url: 'http://user:fixture-password@127.0.0.1/' } },
    { name: 'preview-query', services: [], preview: { url: 'http://127.0.0.1/?token=fixture-token' } },
    { name: 'health-bound', services: [{ ...services[0], health: { tcp: true, timeoutMs: Number.MAX_SAFE_INTEGER } }] },
  ])('refuses $name before setup runs', async candidate => {
    const { name, ...definition } = candidate;
    const repo = await fixture(name, { version: 1, ...definition, setup: ['touch should-not-run'] });
    const result = await provision(repo, candidate.name);
    expect(result.receipt?.state ?? 'failed').toBe('failed');
    expect(existsSync(path.join(result.identity.worktreePath, 'should-not-run'))).toBe(false);
  }, 60_000);
});

it('keeps the trusted exit pipe private from repository commands', async () => {
  const repo = await fixture('exit-pipe', { version: 1, services: [services[0]],
    teardown: [`(printf 'diagnostic' >&3) 2>/dev/null || true; ${teardown}`], limits: { timeoutMs: 2000 } });
  const result = await provision(repo, 'exit-pipe');
  const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
  await expect(settleTerminalWorkspaceManifest(result.identity)).resolves.toBeUndefined();
  expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
}, 60_000);

it('settles already started peers if the next command activation pipe fails', async () => {
  const repo = await fixture('gate-failure', { version: 1, services, teardown: [teardown] });
  const originalNode = process.execPath;
  const preload = path.join(root, 'gate-failure.cjs');
  const wrapper = path.join(root, 'gate-failure-node');
  // Inject a process-boundary write failure into the real supervisor. Repository
  // commands, tmux ownership, persistence and packet provisioning remain real.
  writeFileSync(preload, `
if (process.argv[1]?.endsWith('/runner.cjs')) {
  const cp = require('node:child_process'), spawn = cp.spawn;
  cp.spawn = function(command, args, options) {
    const child = spawn.call(this, command, args, options);
    if (args[0] === '-e' && options.env.NAME === 'web') {
      child.stdin.end = function() {
        queueMicrotask(() => this.emit('error', Object.assign(new Error('fixture gate closed'), { code: 'EPIPE' })));
        return this;
      };
    }
    return child;
  };
}
`);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(originalNode)} --require ${quote(preload)} "$@"\n`, { mode: 0o700 });
  let result: Awaited<ReturnType<typeof provision>>;
  try {
    process.execPath = wrapper;
    result = await provision(repo, 'gate-failure');
  } finally { process.execPath = originalNode; }
  expect(result.receipt?.state).toBe('failed');
  expect(result.receipt?.cleanup?.state).toBe('completed');
  expect(existsSync(path.join(result.identity.worktreePath, 'web.pid'))).toBe(false);
  expect(() => process.kill(Number(readFileSync(path.join(result.identity.worktreePath, 'api.pid'), 'utf8')), 0)).toThrow();
  expect(readFileSync(path.join(result.identity.worktreePath, 'teardown.txt'), 'utf8')).toBe('done\n');
}, 60000);


it('uses the approved auto-open option and preserves honest unavailable-browser evidence', async () => {
  const repo = await fixture('auto-open', { version: 1, services: [services[0]], teardown: [teardown],
    preview: { url: 'http://127.0.0.1:{{service:api}}', autoOpen: true } });
  const before = browserCalls.evaluations;
  const result = await provision(repo, 'auto-open');
  expect(result.receipt?.state).toBe('completed');
  expect(browserCalls.evaluations).toBeGreaterThan(before);
  const { getLaneEvents } = await import('@/lib/lane/registry');
  expect(getLaneEvents(result.identity.laneId, 100).find(event => event.verb === 'workspace_manifest_applied')?.payload.previewOpen)
    .toMatchObject({ ok: false, status: 'unavailable', automaticReplay: false });
}, 60_000);


it('refuses a ready publication when a service dies while auto-open is being observed', async () => {
  const repo = await fixture('auto-open-crash', { version: 1, services: [services[0]], teardown: [teardown],
    preview: { url: 'http://127.0.0.1:{{service:api}}', autoOpen: true } });
  browserCalls.beforeReply = async () => {
    const { getWorktreeManager } = await import('@/lib/worktree/launch');
    const workspace = (await getWorktreeManager(repo).list()).find(workspace => workspace.branch === 'test/auto-open-crash')!;
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    const receipt = (await readWorkspaceManifestReceipt(workspace.path))!;
    process.kill(Number(readFileSync(path.join(workspace.path, 'api.pid'), 'utf8')), 'SIGTERM');
    const { readWorkspaceServiceState } = await import('@/lib/workspace/manifest/services');
    await vi.waitFor(async () => expect((await readWorkspaceServiceState({ worktreePath: workspace.path, packetId: receipt.packetId, laneId: receipt.laneId }))?.state).toBe('failed'), { timeout: 10000 });
  };
  const result = await provision(repo, 'auto-open-crash');
  const { getLaneEvents } = await import('@/lib/lane/registry');
  expect(getLaneEvents(result.identity.laneId, 100).filter(event => event.verb === 'workspace_manifest_applied')).toEqual([]);
  expect(result.receipt?.state).toBe('failed');
}, 60000);
