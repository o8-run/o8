import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import * as recoveryModule from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import * as laneGitModule from '@/lib/lane/lane-git';
import { getSqlite } from '@/lib/db';
import type { RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { getDataDir } from '@/lib/data-dir-migration';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({ status: 'ready', binaryPath: process.execPath }),
}));

const fallbackLaunch = vi.hoisted(() => vi.fn(async () => ({ ok: true, surfaceId: 'claude-code-owned:receiving-fixture', note: 'launched' })));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface: fallbackLaunch }));

const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
const { createLane, attachSession, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

let workerRuntime: 'codex' | 'claude-code';
let workerModel: string;
let root: string;
let repo: string;
let resetAt: number;
let capacity: RuntimeCapacitySnapshot;
let observeCapacity: ReturnType<typeof vi.fn<() => Promise<RuntimeCapacitySnapshot | null>>>;
let sessionPath: string;

function adapter(): OwnedRuntimeAdapter {
  return {
    runtimeId: workerRuntime, surfaceIdPrefix: `${workerRuntime}-owned:`, rootEnvVar: 'O8_CAPACITY_TEST_ROOT',
    rootDefault: path.join(root, 'sessions'), binaryName: 'node', binaryEnvOverride: 'O8_CAPACITY_TEST_BIN',
    humanLabel: 'Capacity fixture', squadShortName: 'Capacity',
    launchArgs: () => ['-e', `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'})); console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached'}})); process.exit(1);`],
    resumeArgs: (session) => ['-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'resumes'))}, ${JSON.stringify(session.threadId + '\n')}); console.log('resumed');`],
    parseRunLog: (raw) => ({ threadId: raw.includes('thread.started') ? 'fixture-thread' : undefined,
      entries: [{ id: 'progress', kind: 'message', label: 'Assistant', text: 'Implemented part one; verification remains.' }], outcome: raw.includes('turn.failed') ? 'failed' : 'finished', completedTurn: !raw.includes('turn.failed') }),
    observeCapacity: async () => { const observed = await observeCapacity(); if (!observed) throw new Error('fixture unavailable'); return observed; },
  };
}

async function saved(): Promise<OwnedSessionRecord> {
  return JSON.parse(await readFile(sessionPath, 'utf8'));
}

async function start() {
  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'main', runtime: workerRuntime });
  const store = createOwnedSessionStore(adapter());
  const response = await store.launch({ cwd: repo, laneId: lane.id, prompt: 'Finish the fixture task. <task-contract>preserve the public API</task-contract>', model: workerModel, effort: 'low' });
  expect(response.ok, response.note).toBe(true);
  attachSession(lane.id, response.surfaceId, 'system');
  setLaneStatus(lane.id, 'running', 'system', 'session_launched');
  sessionPath = path.join(root, 'sessions', response.surfaceId.split(':')[1], 'session.json');
  return { lane, store, surfaceId: response.surfaceId };
}

async function launch(wait: boolean | 'card' = true) {
  const { lane, store, surfaceId } = await start();
  await vi.waitFor(async () => expect(getLaneEvents(lane.id).some(e => e.verb === (wait === 'card' ? 'worker_quota_exhausted' : wait ? 'worker_capacity_wait' : 'worker_fallback'))).toBe(true), { timeout: 8000 });
  await store.getFleetAdditions({ fresh: true });
  if (wait === 'card') {
    const { listInboxItems } = await import('@/lib/supervisor/inbox');
    await vi.waitFor(() => expect(listInboxItems({ includeAllProjects: true }).some(item => item.repoPath === repo)).toBe(true));
  }
  return { lane, store, surfaceId };
}

beforeEach(async () => {
  workerRuntime = 'codex'; workerModel = 'gpt-6.1-sol';
  root = await realpath(await mkdtemp(path.join(getDataDir(), 'capacity-resume-')));
  repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'fixture.txt'), 'before\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@o8.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo });
  vi.stubEnv('O8_CAPACITY_TEST_ROOT', path.join(root, 'sessions'));
  vi.stubEnv('O8_CAPACITY_TEST_BIN', process.execPath);
  resetAt = Date.now() + 60_000;
  capacity = { runtime: 'codex', identityId: null, status: 'available', reason: null,
    observedAt: new Date().toISOString(), source: 'app-server', confidence: 'exact',
    buckets: [{ id: 'primary', label: 'Window', usedRatio: 1, used: null, remaining: null, unit: null,
      resetsAt: new Date(resetAt).toISOString(), expiresAt: null }] };
  observeCapacity = vi.fn(async () => capacity);
  await updateOperatorDefaults({ crossHouseWorkerFallback: false });
});

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

describe('owned worker capacity recovery through real child exit and fleet polling', () => {
  it('persists the reset, survives store recreation, and resumes the same thread exactly once', async () => {
    const { lane, surfaceId, store } = await launch();
    expect(getLane(lane.id)).toMatchObject({ status: 'paused', lastEventLabel: `waiting_for_limit_reset:${new Date(resetAt).toISOString()}` });
    expect(await saved()).toMatchObject({ capacityWait: { runId: (await saved()).recentRuns[0].id, resetsAt: new Date(resetAt).toISOString() } });
    expect((await store.getFleetAdditions({ fresh: true })).agents[0]).toMatchObject({ status: 'waiting', currentTask: expect.stringContaining(new Date(resetAt).toISOString()) });
    expect(observeCapacity).toHaveBeenCalledTimes(1);
    const { createEmptyOrchestratorMissionState, reconcileOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { synthesizePacketFromLane } = await import('@/lib/orchestrator/synthesize-packet');
    const packet = { ...synthesizePacketFromLane('capacity-projection-fixture', getLane(lane.id)!), queueState: 'queued' as const };
    const project = () => {
      const persisted = getLane(lane.id)!;
      return reconcileOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), packets: [packet] }, {
        laneSnapshots: [], runtimeTruth: [], domainLanes: [{ laneId: persisted.id, packetId: packet.id,
          status: persisted.status, sessionKey: persisted.sessionKey, lastEventLabel: persisted.lastEventLabel }],
      }).packets[0];
    };
    expect(project()).toMatchObject({ status: 'blocked', blockedReason: `Waiting for limit reset at ${new Date(resetAt).toISOString()}` });
    capacity.buckets[0].usedRatio = 0.1;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    capacity.observedAt = new Date().toISOString();
    const recreated = createOwnedSessionStore(adapter());
    await Promise.all([recreated.getFleetAdditions({ fresh: true }), recreated.getFleetAdditions({ fresh: true })]);
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'resumes'), 'utf8')).toBe('fixture-thread\n'));
    expect(getLane(lane.id)).toMatchObject({ status: 'running', sessionKey: surfaceId });
    expect(project().status).toBe('running');
    await recreated.getFleetAdditions({ fresh: true });
    expect(await readFile(path.join(root, 'resumes'), 'utf8')).toBe('fixture-thread\n');
  }, 20_000);

  it('carries the task contract, workspace diff and last messages through the opt-in handoff', async () => {
    await writeFile(path.join(repo, 'fixture.txt'), 'partial implementation\n');
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });
    fallbackLaunch.mockClear();
    const { lane } = await launch(false);
    await vi.waitFor(() => expect(getLane(lane.id)?.sessionKey).toBe('claude-code-owned:receiving-fixture'));
    const prompt = (fallbackLaunch.mock.calls[0] as unknown as [Record<string, string>])[0].prompt;
    expect(prompt).toContain('<task-contract>preserve the public API</task-contract>');
    expect(prompt).toContain('+partial implementation');
    expect(prompt).toContain('Implemented part one; verification remains.');
    expect(getLaneEvents(lane.id).some(event => event.verb === 'worker_fallback' && event.payload.contextCarried === true)).toBe(true);
  }, 20_000);



  it.each(['sonnet', 'opus'] as const)('ignores unrelated model windows for a Claude %s session', async family => {
    workerRuntime = 'claude-code'; workerModel = `claude-${family}-5`;
    capacity.runtime = workerRuntime;
    capacity.buckets.push({ ...capacity.buckets[0], id: `seven_day_${family === 'sonnet' ? 'opus' : 'sonnet'}`,
      resetsAt: new Date(resetAt + 86_400_000).toISOString() });
    const { store } = await launch();
    expect((await saved()).capacityWait?.resetsAt).toBe(new Date(resetAt).toISOString());
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    capacity.observedAt = new Date().toISOString(); capacity.buckets[0].usedRatio = 0;
    await store.getFleetAdditions({ fresh: true });
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'resumes'), 'utf8')).toBe('fixture-thread\n'));
  }, 20_000);

  it('repairs the durable wait when a crash precedes the lane checkpoint', async () => {
    const { lane } = await launch();
    const persisted = await saved();
    const checkpoint = persisted.capacityWait!.laneCheckpoint!;
    getSqlite().prepare('UPDATE lanes SET status = ?, last_event_label = ?, updated_at = ? WHERE id = ?')
      .run(checkpoint.status, checkpoint.lastEventLabel, checkpoint.updatedAt, lane.id);
    const recreated = createOwnedSessionStore(adapter());
    await recreated.getFleetAdditions({ fresh: true });
    expect(getLane(lane.id)).toMatchObject({ status: 'paused', lastEventLabel: `waiting_for_limit_reset:${new Date(resetAt).toISOString()}` });
    expect((await saved()).capacityWait).toBeDefined();
  }, 20_000);

  it('holds a consumed schedule when a crash leaves no proven resume process', async () => {
    const { lane } = await launch();
    const persisted = await saved();
    persisted.capacityResumeClaim = { runId: persisted.capacityWait!.runId, resetsAt: persisted.capacityWait!.resetsAt, stopVersion: persisted.capacityWait!.stopVersion };
    delete persisted.capacityWait;
    await writeFile(sessionPath, JSON.stringify(persisted));
    const recreated = createOwnedSessionStore(adapter());
    await recreated.getFleetAdditions({ fresh: true });
    expect(getLane(lane.id)).toMatchObject({ status: 'awaiting_input', lastEventLabel: 'limit_reset_resume_held' });
    expect((await saved()).capacityResumeClaim).toBeUndefined();
    expect(await readFile(path.join(root, 'resumes'), 'utf8').catch(() => '')).toBe('');
  }, 20_000);

  it('preserves Stop intent that arrives before the handoff reads its source state', async () => {
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });
    fallbackLaunch.mockClear();
    const realRead = recoveryModule.readOwnedRecoveryState;
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(recoveryModule, 'readOwnedRecoveryState').mockImplementation(async (...args) => {
      entered = true; await gate; return realRead(...args);
    });
    const { store, surfaceId } = await start();
    await vi.waitFor(() => expect(entered).toBe(true));
    const stopping = store.interrupt(surfaceId);
    release(); await stopping;
    await store.getFleetAdditions({ fresh: true });
    expect(fallbackLaunch).not.toHaveBeenCalled();
    expect((await saved()).recentRuns[0].interruptRequestedAt).toBeDefined();
  }, 20_000);

  it.each(['stop', 'rebind'] as const)('cancels handoff when %s arrives during context collection', async action => {
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });
    fallbackLaunch.mockClear();
    const realGit = laneGitModule.laneGit;
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(laneGitModule, 'laneGit').mockImplementation(async (cwd, host, args, options) => {
      const result = realGit(cwd, host, args, options);
      if (args[0] === 'diff') { entered = true; await gate; }
      return result;
    });
    const { store, surfaceId, lane } = await start();
    await vi.waitFor(() => expect(entered).toBe(true));
    const stopping = action === 'stop' ? store.interrupt(surfaceId) : Promise.resolve(attachSession(lane.id, 'codex-owned:replacement', 'system'));
    release();
    await stopping;
    await store.getFleetAdditions({ fresh: true });
    expect(fallbackLaunch).not.toHaveBeenCalled();
    expect(getLane(lane.id)?.sessionKey).toBe(action === 'stop' ? surfaceId : 'codex-owned:replacement');
  }, 20_000);

  it('lets an explicit resume replace a scheduled reset without another automatic turn', async () => {
    const { store, surfaceId } = await launch();
    await expect(store.resume(surfaceId, 'Continue with the requested correction.')).resolves.toMatchObject({ ok: true });
    expect((await saved()).capacityWait).toBeUndefined();
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'resumes'), 'utf8')).toBe('fixture-thread\n'));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    await store.getFleetAdditions({ fresh: true });
    expect(await readFile(path.join(root, 'resumes'), 'utf8')).toBe('fixture-thread\n');
  }, 20_000);

  it.each(['stale', 'wrong-account', 'unknown-reset', 'unavailable'] as const)('does not schedule from %s capacity', async kind => {
    if (kind === 'stale') capacity.observedAt = new Date(Date.now() - 60_000).toISOString();
    if (kind === 'wrong-account') capacity.identityId = 'another-account';
    if (kind === 'unknown-reset') capacity.buckets[0].resetsAt = null;
    if (kind === 'unavailable') capacity.status = 'unavailable';
    await launch('card');
    expect((await saved()).capacityWait).toBeUndefined();
    expect(await readFile(path.join(root, 'resumes'), 'utf8').catch(() => '')).toBe('');
  }, 20_000);

  it('keeps an unknown reset observation parked and bounds repeated probes', async () => {
    const { store, lane } = await launch();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    observeCapacity.mockResolvedValue(null);
    await store.getFleetAdditions({ fresh: true });
    await store.getFleetAdditions({ fresh: true });
    expect(observeCapacity).toHaveBeenCalledTimes(2);
    expect(getLane(lane.id)?.status).toBe('paused');
    expect((await saved()).capacityWait).toBeDefined();
    expect(await readFile(path.join(root, 'resumes'), 'utf8').catch(() => '')).toBe('');
  }, 20_000);

  it('lets Stop win while a reset observation is in flight', async () => {
    const { store, surfaceId } = await launch();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    capacity.buckets[0].usedRatio = 0;
    capacity.observedAt = new Date().toISOString();
    let release!: (snapshot: RuntimeCapacitySnapshot) => void;
    observeCapacity.mockImplementationOnce(() => new Promise<RuntimeCapacitySnapshot>(resolve => { release = resolve; }));
    const polling = store.getFleetAdditions({ fresh: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stopping = store.interrupt(surfaceId);
    release(capacity);
    await Promise.all([polling, stopping]);
    expect(await readFile(path.join(root, 'resumes'), 'utf8').catch(() => '')).toBe('');
    expect((await saved()).capacityWait).toBeUndefined();
  }, 20_000);

  it.each(['stop', 'rebind'] as const)('lets an explicit %s cancel a pending reset', async (action) => {
    const { lane, store, surfaceId } = await launch();
    if (action === 'stop') await store.interrupt(surfaceId);
    else attachSession(lane.id, 'codex-owned:replacement', 'system');
    capacity.buckets[0].usedRatio = 0;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(resetAt + 1);
    capacity.observedAt = new Date().toISOString();
    await store.getFleetAdditions({ fresh: true });
    expect(await readFile(path.join(root, 'resumes'), 'utf8').catch(() => '')).toBe('');
    expect((await saved()).capacityWait).toBeUndefined();
  }, 20_000);
});
