import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord, OwnedSessionStore } from '@/lib/runtimes/shared/owned-session/types';

const h = vi.hoisted(() => ({ before: undefined as (() => Promise<void>) | undefined,
  after: undefined as ((surfaceId: string) => Promise<void>) | undefined,
  settled: undefined as (() => void) | undefined, store: undefined as OwnedSessionStore | undefined }));
vi.mock('@/lib/runtimes/shared/owned-session/store', async (original) => {
  const actual = await original<typeof import('@/lib/runtimes/shared/owned-session/store')>();
  return { ...actual, createOwnedSessionStore: (...args: Parameters<typeof actual.createOwnedSessionStore>) => {
    const store = actual.createOwnedSessionStore(...args);
    if (args[0].runtimeId === 'claude-code') h.store = store;
    return store;
  } };
});
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/runtime/actions', async (original) => {
  const actual = await original<typeof import('@/lib/runtime/actions')>();
  return { ...actual, launchRuntimeSurface: async (...args: Parameters<typeof actual.launchRuntimeSurface>) => {
    try {
      await h.before?.();
      const result = await actual.launchRuntimeSurface(...args);
      await h.after?.(result.surfaceId);
      return result;
    } finally { h.settled?.(); }
  } };
});
vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'fixture', waitedMs: 0, attempts: 1 })),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: vi.fn(async () => {}),
}));
vi.mock('@/lib/claude-code/codex-subscription-proxy', async (original) => ({
  ...await original<typeof import('@/lib/claude-code/codex-subscription-proxy')>(),
  prepareClaudeCodeWorkerConfig: vi.fn(async (sessionDir: string) => {
    const configDir = join(sessionDir, 'worker-config'); mkdirSync(configDir, { recursive: true });
    return { configDir, credentialEnv: {} };
  }),
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/worktree/safety-hooks', async (original) => ({
  ...await original<typeof import('@/lib/worktree/safety-hooks')>(), writeManagedWorkspaceSafetyHooks: vi.fn(async () => {}),
}));
vi.mock('@/lib/cortex/spec-ingest', () => ({ ingestRepoSpecs: vi.fn(async () => ({})), purgeOrphanedSpecDirectives: vi.fn(() => ({ purged: 0, slugs: [] })) }));

const root = mkdtempSync(join(tmpdir(), 'o8-recovery-stop-race-'));
const repo = join(root, 'repo'); const ownedRoot = join(root, 'owned'); const pidFile = join(root, 'pids.json');
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_PROCESS_SUPERVISOR = '0';
const binary = join(root, 'worker.mjs');
const child = `// ${root}\nsetInterval(() => {}, 1000);`;
writeFileSync(binary, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--help') || process.argv.includes('--version')) { console.log('fixture 1.0.0'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  const worker = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => worker.kill(signal));
  worker.once('exit', () => process.exit(0));
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ interpreter: process.pid, worker: worker.pid }));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'b04619e1-c3b5-45e8-a8eb-07be9d6d0146' }) + '\\n');
  setInterval(() => {}, 1000);
});
`);
chmodSync(binary, 0o755); process.env.O8_CLAUDE_CODE_BIN = binary;
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'README.md'), 'Stop race fixture\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
const ipc = createServer((_request, response) => response.writeHead(200).end('{}'));
await new Promise<void>(resolve => ipc.listen(0, '127.0.0.1', resolve));
const port = (ipc.address() as { port: number }).port;
process.env.O8_API_PORT = process.env.O8_WS_PORT = String(port);
const { closeDb } = await import('@/lib/db');
const lanes = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
await writeClaudeCodeWorkerProfile({ source: 'native', model: null, codexModel: null });
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
saveRuntimeBillingMode('claude-code', 'subscription');
const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
const { dispatch } = await import('@/lib/lane/commands');
const { withOwnedActionGuard } = await import('@/lib/runtimes/shared/owned-session/action-admission');
const { assertRecoveryPacketAdmission } = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
const { createOwnedSessionIo } = await import('@/lib/runtimes/shared/owned-session/session-io');
const io = createOwnedSessionIo({ root: ownedRoot, surfacePrefix: 'claude-code-owned:', invalidateFleetCache: () => {} });
await import('@/lib/claude-code/owned');
const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout>)[Symbol.for('o8.ownedSession.refreshTimer.claude-code')];
clearInterval(timer);
const { panelGateMiddleware } = await import('@/middleware');
const mcp = await import('@/app/api/mcp/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const token = getOrCreateWsToken();
let sequence = 0;
let release: (() => void) | undefined;
let finishAttempt: (() => void) | undefined;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = (): { interpreter: number; worker: number } => JSON.parse(readFileSync(pidFile, 'utf8'));
async function workers() {
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
  return pids();
}
async function dead() {
  await vi.waitFor(() => expect(Object.values(pids()).map(alive)).toEqual([false, false]), { timeout: 6000 });
}
afterEach(async () => {
  release?.(); finishAttempt?.(); h.before = undefined; h.after = undefined; h.settled = undefined;
  if (existsSync(pidFile)) {
    const saved = pids();
    // The interpreter reaps its child before exiting; never orphan the child.
    for (const pid of [saved.worker, saved.interpreter]) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
    }
  }
  rmSync(pidFile, { force: true });
});
afterAll(async () => {
  ipc.closeAllConnections(); await new Promise<void>(resolve => ipc.close(() => resolve()));
  closeDb(); rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const id = `stop-race-${++sequence}`;
  const packet = { id, referenceLabel: 'P1', title: 'Stop race', summary: 'Read the fixture.',
    runtime: 'claude-code', workspaceTargetPath: repo, branchTarget: `task/${id}`, dependencyLabels: [], dependencyPacketIds: [],
    status: 'queued', queueState: 'queued', releaseState: 'pending', lane: null } as OrchestratorPacket;
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [packet] });
  return id;
}
function bindPacketLane(laneId: string) {
  const lane = lanes.getLane(laneId)!;
  const state = control.readOrchestratorControlPlaneState();
  state.packets[0].lane = { tileId: '', tabId: '', laneId, runtime: lane.runtime, repoPath: lane.repoPath,
    worktreePath: lane.worktreePath, sessionKey: lane.sessionKey, lastHeartbeatAt: null,
    lastEventAt: lane.lastEventAt, lastEventLabel: lane.lastEventLabel };
  control.writeOrchestratorControlPlaneState(state);
}
async function mcpDispatch(id: string) {
  const request = new NextRequest('http://localhost/api/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'o8_task_dispatch', arguments: { taskId: id, requestedRuntime: 'claude-code' },
    } }),
  });
  expect(panelGateMiddleware(request).status).toBe(200);
  const response = await mcp.POST(request); expect(response.status).toBe(200);
  const body = await response.json(); return JSON.parse(body.result.content[0].text);
}

it.each(['store', 'mcp'] as const)('keeps Stop authoritative before spawn via %s', async entry => {
  const id = fixture(); let entered = false; let settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.before = async () => { entered = true; await gate; };
  h.settled = () => { settled = true; };
  const lane = entry === 'store' ? lanes.createLane({ repoPath: repo, branch: `task/${id}`, runtime: 'claude-code', packetId: id }) : null;
  const pending = withOwnedActionGuard(() => assertRecoveryPacketAdmission({ packetId: id } as OwnedSessionRecord),
    () => (entry === 'store'
      ? dispatch({ verb: 'launch_session', laneId: lane!.id, prompt: 'Synthetic recovery.', actor: 'orchestrator' })
      : mcpDispatch(id)).catch(() => ({ ok: false })));
  if (entry === 'mcp') expect(await pending).toMatchObject({ ok: true, status: 'launching' });
  await vi.waitFor(() => expect(entered).toBe(true));
  const currentLane = lanes.findLaneByPacket(id)!; bindPacketLane(currentLane.id);
  expect((await dispatch({ verb: 'stop', laneId: currentLane.id, actor: 'user' })).ok).toBe(true);
  release!(); await pending;
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10000 });
  expect(existsSync(pidFile)).toBe(false);
  expect(lanes.getLane(currentLane.id)).toMatchObject({ status: 'paused', sessionKey: null });
  expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held' });
}, 30000);

it.each(['store', 'mcp'] as const)('confirms exact worker cleanup when Stop wins between spawn and attachment via %s', async entry => {
  const id = fixture();
  const gate = new Promise<void>(resolve => { release = resolve; });
  let spawned: string | undefined;
  h.after = async surfaceId => {
    await workers();
    spawned = surfaceId;
    await gate;
  };
  const lane = entry === 'store' ? lanes.createLane({ repoPath: repo, branch: `task/${id}`, runtime: 'claude-code', packetId: id }) : null;
  const attempt = new Promise<void>(resolve => { finishAttempt = resolve; });
  let launchResult: { ok: boolean; status?: string } | undefined;
  const pending = withOwnedActionGuard(() => assertRecoveryPacketAdmission({ packetId: id } as OwnedSessionRecord), async () => {
    launchResult = await (entry === 'store'
      ? dispatch({ verb: 'launch_session', laneId: lane!.id, prompt: 'Synthetic recovery.', actor: 'orchestrator' })
      : mcpDispatch(id)).catch(() => ({ ok: false }));
    // Keep the parent recovery attempt active while its late launch cleans up.
    await attempt;
  });
  if (entry === 'mcp') await vi.waitFor(() => expect(launchResult).toMatchObject({ ok: true, status: 'launching' }));
  await vi.waitFor(() => expect(spawned).toBeTruthy(), { timeout: 15000 });
  const currentLane = lanes.findLaneByPacket(id)!;
  expect(currentLane.sessionKey).toBeNull();
  const saved = (await io.findSession(spawned!))!;
  expect(saved.activeRun?.spawnState).toBe('started');
  expect(Object.values(pids()).map(alive)).toEqual([true, true]);
  bindPacketLane(currentLane.id);
  const stop = await dispatch({ verb: 'stop', laneId: currentLane.id, actor: 'user' });
  expect(stop.ok, stop.note).toBe(true);
  release!();
  if (entry === 'store') await vi.waitFor(() => expect(launchResult?.ok).toBe(false));
  await vi.waitFor(() => expect(lanes.getLaneEvents(currentLane.id, 100).some(event => event.verb === 'task_dispatch_cleanup')).toBe(true), { timeout: 12000 });
  expect.soft(lanes.getLaneEvents(currentLane.id, 100)).toContainEqual(expect.objectContaining({
    verb: 'task_dispatch_cleanup', payload: { surfaceId: spawned, cleanup: 'confirmed' },
  }));
  await dead();
  expect(lanes.getLane(currentLane.id)).toMatchObject({ status: 'paused', sessionKey: null });
  expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held' });
  expect((await io.findSession(spawned!))?.recentRuns[0]).toMatchObject({ id: saved.activeRun!.id, outcome: 'interrupted' });
  finishAttempt!(); await pending;
}, 40000);

it.each(['store', 'escalation'] as const)('allows %s Stop under a live denied recovery guard after attachment', async entry => {
  const id = fixture();
  const lane = lanes.createLane({ repoPath: repo, branch: `task/${id}`, runtime: 'claude-code', packetId: id });
  expect((await dispatch({ verb: 'launch_session', laneId: lane.id, prompt: 'Synthetic active turn.', actor: 'orchestrator' })).ok).toBe(true);
  await workers(); const surfaceId = lanes.getLane(lane.id)!.sessionKey!;
  bindPacketLane(lane.id);
  const state = control.readOrchestratorControlPlaneState(); state.packets[0].operatorStopped = true;
  control.writeOrchestratorControlPlaneState(state);
  await withOwnedActionGuard(() => assertRecoveryPacketAdmission({ packetId: id } as OwnedSessionRecord), async () => {
    if (entry === 'store') {
      expect((await h.store!.interrupt(surfaceId)).interrupted).toBe(true);
    } else {
      const stop = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });
      expect(stop.ok, stop.note).toBe(true);
    }
  });
  await dead();
  expect((await io.findSession(surfaceId))?.recentRuns[0].outcome).toBe('interrupted');
}, 30000);
