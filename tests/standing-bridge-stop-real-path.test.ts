import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord, OwnedRuntimeAdapter } from '@/lib/runtimes/shared/owned-session/types';

const bridge = vi.hoisted(() => vi.fn());
const alive = vi.hoisted(() => vi.fn());
const signal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: bridge, isBridgeSessionAlive: alive, signalBridgeTerminalSession: signal }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
// Model the supported legacy launch without an MCP config; the owned launch path stays real.
vi.mock('@/lib/runtimes/shared/owned-session/worker-mcp-config', () => ({ prepareOwnedWorkerMcpConfig: async () => ({ servers: [], sandboxReadPaths: [] }) }));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'standing-bridge-'));
const originalEnv = { ...process.env };
const repo = join(root, 'repo');
const sessions = join(root, 'sessions');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'state.db'),
  O8_TEST_STANDING_BRIDGE_ROOT: sessions, O8_TEST_STANDING_BRIDGE_BIN: process.execPath,
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_PROCESS_SUPERVISOR: '0', O8_WORKER_SANDBOX: '0', O8_PACKAGED_APP: '0' });
let child: ChildProcess | undefined;
let exited: Promise<unknown> | undefined;
afterAll(async () => {
  child?.kill('SIGKILL'); await exited;
  (await import('@/lib/db')).closeDb();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('reaps a successful delayed legacy bridge when the standing lane was durably stopped before its response', async () => {
  const { createLane } = await import('@/lib/lane/registry');
  const { saveStandingLane, readStandingLane } = await import('@/lib/lane/standing-store');
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
  const packetId = 'pkt-standing-bridge';
  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'main', runtime: 'codex', packetId });
  saveStandingLane(lane.id, { model: 'fixture', effort: 'high', stopped: false, removed: false, blockedReason: null,
    tasks: [{ id: packetId, prompt: 'bridge fixture', branch: 'main', phase: 'dispatching', startedAt: new Date().toISOString() }] });
  await withLockedState(state => { state.packets.push({ id: packetId, title: 'bridge fixture', summary: '', referenceLabel: packetId,
    runtime: 'codex', standingLaneId: lane.id, workspaceTargetPath: repo, branchTarget: 'main',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', status: 'running', releaseState: 'pending', review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, sessionKey: null, runtime: 'codex', repoPath: repo, worktreePath: repo } }); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  bridge.mockImplementation(async (options: { sessionName: string; env: NodeJS.ProcessEnv }) => {
    await gate;
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: repo, env: options.env, detached: true, stdio: 'ignore' });
    exited = once(child, 'exit');
    await once(child, 'spawn');
    return { ok: true, sessionName: options.sessionName, pid: child.pid };
  });
  alive.mockImplementation(async () => Boolean(child && child.exitCode === null && child.signalCode === null));
  signal.mockImplementation(async (_name: string, sig: NodeJS.Signals) => { if (child?.pid) process.kill(-child.pid, sig); });
  const adapter: OwnedRuntimeAdapter = { runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'O8_TEST_STANDING_BRIDGE_ROOT',
    rootDefault: sessions, binaryName: 'node', binaryEnvOverride: 'O8_TEST_STANDING_BRIDGE_BIN', humanLabel: 'Fixture', squadShortName: 'Fixture',
    launchArgs: () => ['-e', 'setInterval(() => {}, 1000)'], resumeArgs: () => [], parseRunLog: () => ({ entries: [], completedTurn: false, outcome: 'running' }) };
  const store = createOwnedSessionStore(adapter, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
  const launching = store.launch({ cwd: repo, prompt: 'bridge fixture', laneId: lane.id, packetId, model: 'fixture', effort: 'high' });
  const outcome = launching.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await vi.waitFor(() => expect(bridge).toHaveBeenCalledOnce());
  const { POST } = await import('@/app/api/orchestrator/standing-lanes/route');
  const token = (await import('@/lib/ws-auth')).getOrCreateWsToken();
  const stopped = await POST(new NextRequest('http://fixture.test/api/orchestrator/standing-lanes', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', laneId: lane.id, idempotencyKey: 'bridge-stop' }) }));
  expect(stopped.status).toBe(200);
  expect(readStandingLane(lane.id)?.stopped).toBe(true);
  release();
  const result = await outcome;
  expect(result.error?.message).toMatch(/stopped|admission/i);
  expect(bridge).toHaveBeenCalledOnce();
  expect(signal).toHaveBeenCalled();
  await exited;
  const record = JSON.parse(readFileSync(join(sessions, readdirSync(sessions)[0], 'session.json'), 'utf8')) as OwnedSessionRecord;
  expect(record.activeRun).toBeFalsy();
  expect(record.recentRuns[0]).toMatchObject({ outcome: 'interrupted', interruptRequestedAt: expect.any(String), tmuxSession: expect.any(String) });
}, 30000);
