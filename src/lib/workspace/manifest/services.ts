import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { childEnvironment, providerCredentialName } from '@/lib/providers/spawn-environment';
import { writeExactChildFile, readExactChildFile } from '@/lib/workspace/exact-parent-operation';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { guardedWorkspaceScriptInvocation } from '@/lib/worktree/materialization-execution';
import { getDataDir } from '@/lib/data-dir-migration';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';
import { registerManagedRun, finishManagedRun } from '@/lib/runtimes/managed-runs/registry';
import type { WorkspaceManifest, WorkspaceManifestService } from './types';
import type { WorkspaceManifestServiceReceipt } from './lifecycle';
import { WORKSPACE_SERVICE_RUNNER_SOURCE } from './service-runner-source';
import { recoverWorkspaceServiceGroups, type WorkspaceServiceProcessState } from './service-process-recovery';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const defaultServiceLimits = { timeoutMs: 5000, outputLimitBytes: 1024 * 1024, shutdownGraceMs: 100 };
export interface WorkspaceServiceIdentity { worktreePath: string; packetId: string; laneId: string; serviceGeneration?: string }
interface ServiceState extends WorkspaceServiceProcessState {
  version: 1; generation: string; state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  services: WorkspaceManifestServiceReceipt[]; error?: string; teardown?: { state: string }; cleanupUnconfirmed?: boolean;
}
interface ServiceHandle { generation: string; directory: string; runId: string; startedAt: string; timeoutMs: number; readinessTimeoutMs: number; directoryIdentity: WorktreeMaterializationIdentity }
const running = new Map<string, ServiceHandle>();
const stops = new Map<string, Promise<ServiceState | null>>();
function key(input: WorkspaceServiceIdentity): string { return digest(JSON.stringify([path.resolve(input.worktreePath), input.packetId, input.laneId])); }
function directory(input: WorkspaceServiceIdentity): string { return path.join(getDataDir(), 'workspace-services', key(input)); }
async function privateDirectory(value: string): Promise<void> {
  await mkdir(value, { recursive: true, mode: 0o700 });
  if (!(await lstat(value)).isDirectory() || (await lstat(value)).isSymbolicLink()) throw new Error('Workspace service state directory is not exact.');
}
async function readPrivateJson(file: string): Promise<unknown> {
  const root = await realpath(getDataDir());
  const relative = path.relative(getDataDir(), file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace service state escaped its data directory.');
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Workspace service state directory changed.');
  }
  const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink > 1 || entry.size > 1024 * 1024) throw new Error('Workspace service state file is invalid.');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
async function readHandle(input: WorkspaceServiceIdentity): Promise<ServiceHandle | null> {
  try {
    const handle = await readPrivateJson(path.join(directory(input), 'handle.json')) as ServiceHandle;
    if (!/^[a-f0-9]{32}$/.test(handle.generation) || handle.runId !== handle.generation
      || handle.directory !== path.join(directory(input), handle.generation)
      || !handle.directoryIdentity || !Number.isSafeInteger(handle.directoryIdentity.device) || !Number.isSafeInteger(handle.directoryIdentity.inode)
      || handle.directoryIdentity.canonicalPath !== path.join(await realpath(getDataDir()), 'workspace-services', key(input), handle.generation)
      || !Number.isSafeInteger(handle.timeoutMs) || handle.timeoutMs < 1 || handle.timeoutMs > 90_000_000
      || !Number.isSafeInteger(handle.readinessTimeoutMs) || handle.readinessTimeoutMs < 1 || handle.readinessTimeoutMs > 5_000_000) throw new Error('Workspace service handle is invalid.');
    return handle;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readWorkspaceServiceState(input: WorkspaceServiceIdentity): Promise<ServiceState | null> {
  const handle = running.get(key(input)) ?? await readHandle(input);
  if (!handle || input.serviceGeneration && input.serviceGeneration !== handle.generation) return null;
  try {
    const state = await readPrivateJson(path.join(handle.directory, 'state.json')) as ServiceState;
    if (state.version !== 1 || state.generation !== handle.generation || !Array.isArray(state.services)) throw new Error('Workspace service generation changed.');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function orderedWorkspaceServices(manifest: WorkspaceManifest): WorkspaceManifestService[] {
  const services = manifest.services ?? [];
  const result: WorkspaceManifestService[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (service: WorkspaceManifestService) => {
    if (visiting.has(service.name)) throw new Error('Workspace service dependency cycle.');
    if (visited.has(service.name)) return;
    visiting.add(service.name);
    for (const name of service.dependsOn ?? []) {
      const dependency = services.find(candidate => candidate.name === name);
      if (!dependency) throw new Error(`Service ${service.name} has an unknown dependency.`);
      visit(dependency);
    }
    visiting.delete(service.name); visited.add(service.name); result.push(service);
  };
  services.forEach(visit);
  return result;
}
export async function validateWorkspaceServicePaths(manifest: WorkspaceManifest, worktreePath: string): Promise<void> {
  const root = await realpath(worktreePath);
  for (const service of orderedWorkspaceServices(manifest)) {
    const cwd = path.resolve(root, service.cwd ?? '.');
    const relative = path.relative(root, cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative) || await realpath(cwd) !== cwd) throw new Error(`Service ${service.name} cwd escapes the packet worktree.`);
  }
}
function validateLocalUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || [...url.searchParams.keys()].some(name => /token|secret|password|credential|api.?key|authorization/i.test(name))) throw new Error('Workspace preview and health require an unauthenticated loopback URL.');
}
export function assertWorkspaceManifestSafe(manifest: WorkspaceManifest): void {
  const encoded = JSON.stringify(manifest);
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i.test(encoded)) throw new Error('Workspace manifest contains an authenticated URL.');
  if (childEnvironment({ inherit: false, inject: false, env: { CONTENT: encoded } }).CONTENT !== encoded) throw new Error('Workspace manifest contains credential material.');
  for (const service of manifest.services ?? []) {
    for (const name of Object.keys(service.env ?? {})) {
      if (providerCredentialName(name) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTHORIZATION|DATABASE_URL|BASH_ENV|NODE_OPTIONS|^ENV$)/i.test(name)) throw new Error('Workspace manifest must use scoped credentials rather than inline secrets.');
    }
  }
  for (const value of [manifest.preview?.url, ...(manifest.services ?? []).map(service => service.health?.http)]) {
    if (value) validateLocalUrl(value.replace(/\{\{[^}]+\}\}/g, '1'));
  }
}
export async function startWorkspaceServices(input: WorkspaceServiceIdentity & {
  manifest: WorkspaceManifest; ports: Record<string, number>; environment: NodeJS.ProcessEnv;
  resolveTemplate: (value: string, port?: number) => string;
  onGeneration: (generation: string) => Promise<void>;
}): Promise<void> {
  assertWorkspaceManifestSafe(input.manifest);
  if (!input.manifest.services?.length && !input.manifest.teardown?.length) return;
  if (process.platform === 'win32') throw new Error('Workspace services require an owned POSIX terminal on this platform.');
  if (running.has(key(input))) throw new Error('Workspace services already have an active generation.');
  const previous = await readWorkspaceServiceState(input);
  if (previous && !['stopped', 'failed'].includes(previous.state)) throw new Error('Previous workspace services require settlement before restart.');
  const generation = randomUUID().replaceAll('-', '');
  await input.onGeneration(generation);
  const base = directory(input);
  await privateDirectory(path.dirname(base));
  await privateDirectory(base);
  const runDirectory = path.join(base, generation);
  await privateDirectory(runDirectory);
  const limits = { ...defaultServiceLimits, ...input.manifest.limits };
  const runId = generation;
  const processMarker = `workspace-${generation}`;
  // Only declared non-secret values and common executable lookup enter repository services.
  const environment = childEnvironment({ inherit: false, inject: false, env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    ...input.environment, O8_MANAGED_RUN_MARKER: processMarker,
  } });
  if (input.manifest.preview) validateLocalUrl(input.resolveTemplate(input.manifest.preview.url, Object.values(input.ports)[0]));
  const services = orderedWorkspaceServices(input.manifest).map(service => {
    const declared = Object.fromEntries(Object.entries(service.env ?? {}).map(([name, value]) => {
      if (providerCredentialName(name) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTHORIZATION|DATABASE_URL|BASH_ENV|NODE_OPTIONS|^ENV$)/i.test(name)) throw new Error(`Service ${service.name} must use scoped credentials rather than a manifest secret.`);
      return [name, input.resolveTemplate(value, input.ports[service.name])];
    }));
    if (service.health?.http) validateLocalUrl(input.resolveTemplate(service.health.http, input.ports[service.name]));
    return { ...service, commandId: digest(service.command), port: input.ports[service.name],
      environment: childEnvironment({ inherit: false, inject: false, env: { ...environment, ...declared, PORT: input.ports[service.name] === undefined ? undefined : String(input.ports[service.name]) } }),
      visibleEnvironment: { ...input.environment },
      ...(service.health ? { health: { ...service.health, ...(service.health.http ? { http: input.resolveTemplate(service.health.http, input.ports[service.name]) } : {}) } } : {}),
    };
  });
  const identity = await stat(input.worktreePath);
  const configuration = { generation, worktreePath: await realpath(input.worktreePath), device: identity.dev, inode: identity.ino,
    ownerPid: process.pid, ownerIdentity: (await execute('ps', ['-p', String(process.pid), '-o', 'lstart='], { timeout: 3000 })).stdout.trim(), services, environment, limits, teardown: (input.manifest.teardown ?? []).map(command => ({ command, commandId: digest(command) })) };
  const configPath = path.join(runDirectory, 'config.json');
  const runnerPath = path.join(runDirectory, 'runner.cjs');
  const directoryStat = await stat(runDirectory);
  const directoryIdentity = { device: directoryStat.dev, inode: directoryStat.ino, canonicalPath: await realpath(runDirectory) };
  const handle: ServiceHandle = { directoryIdentity, generation, directory: runDirectory, runId, startedAt: new Date().toISOString(), timeoutMs: Math.max(limits.shutdownGraceMs, ...services.map(service => service.shutdownGraceMs ?? limits.shutdownGraceMs)) + 1500 + (limits.timeoutMs + limits.shutdownGraceMs + 1500) * configuration.teardown.length + 5000, readinessTimeoutMs: services.reduce((sum, service) => sum + ((service.health?.timeoutMs ?? 5000) + (service.shutdownGraceMs ?? limits.shutdownGraceMs) + (service.restart?.delayMs ?? 100) + 1500) * (1 + (service.restart?.maxRestarts ?? 0)), 10_000) };
  if (handle.readinessTimeoutMs > 45 * 60_000) throw new Error('Workspace service readiness budget exceeds 45 minutes.');
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(runnerPath, WORKSPACE_SERVICE_RUNNER_SOURCE, { mode: 0o600 });
  const handleTemporary = path.join(base, `handle.${generation}.tmp`);
  await writeFile(handleTemporary, JSON.stringify(handle), { mode: 0o600, flag: 'wx' });
  await rename(handleTemporary, path.join(base, 'handle.json'));
  running.set(key(input), handle);
  // The supervisor watches stop/owner death immediately; only activation permits repository commands.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `exec /usr/bin/env -i PATH=${quote(process.env.PATH ?? '')} ${quote(process.execPath)} ${quote(runnerPath)} ${quote(configPath)}`;
  await execute('tmux', ['new-session', '-d', '-s', `cortex-run-${runId}`, '-x', '120', '-y', '30', '/bin/sh', '-c', command], { timeout: 10_000, env: childEnvironment({ inject: false }) });
  const { stdout } = await execute('tmux', ['list-panes', '-t', `cortex-run-${runId}`, '-F', '#{pane_pid}'], { timeout: 3000 });
  registerManagedRun({ id: runId, session: `cortex-run-${runId}`, command: 'Workspace services', title: input.packetId,
    cwd: input.worktreePath, packetId: input.packetId, laneId: input.laneId, panePid: Number(stdout.trim()), processMarker,
    workspaceService: { worktreePath: input.worktreePath, packetId: input.packetId, laneId: input.laneId },
    mode: 'detach', startedAt: handle.startedAt, status: 'running' }, true);
}
async function writePrivateFlag(handle: ServiceHandle, name: 'stop' | 'activate'): Promise<void> {
  const entry = await lstat(handle.directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== handle.directoryIdentity.device
    || entry.ino !== handle.directoryIdentity.inode || await realpath(handle.directory) !== handle.directoryIdentity.canonicalPath) throw new Error('Workspace service control directory changed.');
  const file = path.join(handle.directory, name);
  try { await writeExactChildFile(handle.directory, handle.directoryIdentity, file, '', 0o600); }
  catch (error) {
    // Another authorized stopper may already have published this exact empty flag.
    const existing = await readExactChildFile(handle.directory, handle.directoryIdentity, file).catch(() => null);
    if (!existing || existing.contents !== '') throw error;
  }
}
export async function activateWorkspaceServices(input: WorkspaceServiceIdentity): Promise<void> {
  const handle = running.get(key(input)) ?? await readHandle(input);
  if (handle) await writePrivateFlag(handle, 'activate');
}
export async function waitWorkspaceServices(input: WorkspaceServiceIdentity, signal: AbortSignal): Promise<ServiceState> {
  const handle = running.get(key(input)) ?? await readHandle(input);
  const deadline = Date.now() + (handle?.readinessTimeoutMs ?? 60_000);
  for (;;) {
    if (Date.now() > deadline) throw new Error('Workspace supervisor did not publish a readiness result.');
    if (signal.aborted) throw new Error('Workspace manifest cancelled.');
    const state = await readWorkspaceServiceState(input);
    if (state?.state === 'ready' || state?.state === 'failed' || state?.state === 'stopped') return state;
    await pause(25);
  }
}
export async function stopWorkspaceServices(input: WorkspaceServiceIdentity, options: { allowFailedTeardown?: boolean } = {}): Promise<ServiceState | null> {
  const state = await stopWorkspaceServiceProcesses(input);
  // Process cleanup is shared, but a relaxed operator policy cannot grant a
  // concurrent lifecycle caller permission to release failed teardown evidence.
  if (state?.teardown?.state === 'failed' && !options.allowFailedTeardown) throw new Error('Workspace teardown failed; retain the cleanup evidence and worktree.');
  return state;
}
function stopWorkspaceServiceProcesses(input: WorkspaceServiceIdentity): Promise<ServiceState | null> {
  const identity = key(input);
  const existing = stops.get(identity);
  if (existing) return existing;
  const stop = (async () => {
    const handle = running.get(identity) ?? await readHandle(input);
    if (!handle || input.serviceGeneration && input.serviceGeneration !== handle.generation) return null;
    const initial = await readWorkspaceServiceState(input);
    if (!initial || !['stopped', 'failed'].includes(initial.state)) await writePrivateFlag(handle, 'stop');
    const deadline = Date.now() + handle.timeoutMs;
    while (Date.now() < deadline) {
      await recoverWorkspaceServiceGroups(handle.directory, () => readWorkspaceServiceState(input), async state => {
        // Capture cwd before validation, then use only relative paths for atomic publication.
        const invocation = guardedWorkspaceScriptInvocation(`
          const fs = require('node:fs');
          const temporary = '.recovery-' + require('node:crypto').randomUUID();
          const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, process.argv[1]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, 'state.json');
        `, [JSON.stringify(state)], handle.directoryIdentity);
        await execute(invocation.command, invocation.args, { cwd: handle.directory, timeout: 5000 });
      });
      const state = await readWorkspaceServiceState(input);
      if (state?.cleanupUnconfirmed) throw new Error('Workspace service cleanup is unconfirmed; retain the worktree and leases.');
      if (state && ['stopped', 'failed'].includes(state.state)) {
        finishManagedRun(handle.runId, state.state === 'stopped' ? 0 : 1);
        running.delete(identity);
        return state;
      }
      await pause(25);
    }
    throw new Error('Workspace service cleanup is unconfirmed; retain the worktree and leases.');
  })();
  stops.set(identity, stop);
  void stop.finally(() => { if (stops.get(identity) === stop) stops.delete(identity); }).catch(() => {});
  return stop;
}

/** Observe durable supervisor output; no extra work or polling belongs to the UI. */
export function monitorWorkspaceServices(input: WorkspaceServiceIdentity, onFailure: (state: ServiceState) => Promise<void>): void {
  let busy = false;
  let previous = '';
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const state = await readWorkspaceServiceState(input);
      if (!state || state && ['failed', 'stopped'].includes(state.state)) {
        clearInterval(timer);
        if (state) await onFailure(state);
      } else if (JSON.stringify(state) !== previous) {
        previous = JSON.stringify(state);
        await onFailure(state);
      }
    })().catch(() => { /* Durable state remains available to terminal settlement. */ }).finally(() => { busy = false; });
  }, 250);
  timer.unref();
}


/** A terminal stop must finish the approved lifecycle before process-tree escalation. */
export async function stopManagedWorkspaceService(record: ManagedRunRecord): Promise<void> {
  const identity = record.workspaceService;
  if (!identity || record.packetId !== identity.packetId || record.laneId !== identity.laneId || record.cwd !== identity.worktreePath) throw new Error('Workspace service stop binding changed.');
  const handle = await readHandle(identity);
  if (!handle || handle.runId !== record.id || record.session !== `cortex-run-${handle.runId}`) throw new Error('Workspace service stop generation changed.');
  // Operator process termination can finish after an interrupted teardown, while
  // ordinary lifecycle settlement still retains its failure, evidence and leases.
  await stopWorkspaceServices(identity, { allowFailedTeardown: true });
}
