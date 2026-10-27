import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '@/lib/runtime/actions';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { SupervisorCallbacks } from '@/lib/supervisor/agent-supervisor-types';

const h = vi.hoisted(() => ({
  launch: vi.fn<(request: RuntimeLaunchRequest) => Promise<RuntimeLaunchResult>>(async (request) => ({
    ok: true, runtime: request.runtime, surfaceId: `${request.runtime}-owned:retried`,
    note: 'Provider boundary captured without starting a process.',
    cwd: request.cwd!, repoPath: request.repoPath!, worktree: null,
    laneId: request.existingLaneId!, clientMutationId: request.clientMutationId,
  })),
}));

vi.mock('@/lib/codex/service-tier-catalogue', async () => ({ getCodexSpeedCatalogue: async () =>
  (await import('./helpers/codex-model-list-fixture')).codexEffortCatalogFixture }));
vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(), launchRuntimeSurface: h.launch,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
// Inventory is supplied by the test; no provider transcript discovery is needed.
vi.mock('@/lib/claude-code/owned', () => ({
  getOwnedClaudeCodeTelemetrySources: vi.fn(async () => ({ stdoutPaths: [] })),
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-retry-identity-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(dataDir, 'owned-codex');
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(dataDir, 'owned-claude-code');

const { relaunchSupervisedAgent } = await import('@/lib/supervisor/relaunch-agent');
const { createLane, getLane, getLaneEvents, listLanes, updateLane } = await import('@/lib/lane/registry');
const { closeDb, getSqlite } = await import('@/lib/db');
const route = await import('@/app/api/runtime/launch/route');
const supervisor = await import('@/lib/supervisor/agent-supervisor');
let ordinal = 0;
const launchImplementation = h.launch.getMockImplementation()!;

function fixture(runtime: 'claude-code' | 'codex', config?: Record<string, string>) {
  const id = ++ordinal;
  const repo = path.join(dataDir, `repo-${id}`);
  const worktree = path.join(dataDir, `worktree-${id}`);
  mkdirSync(repo);
  mkdirSync(worktree);
  const surface = `${runtime}-owned:failed-${id}`;
  const lane = createLane({ repoPath: repo, worktreePath: worktree, runtime, branch: `retry-${id}`, sessionKey: surface });
  updateLane(lane.id, { status: 'running' });
  const sessionDir = path.join(dataDir, `owned-${runtime}`, `session-${id}`);
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId: surface, laneId: lane.id, sessionDir, cwd: worktree, repoPath: worktree,
    title: 'retry fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    latestPrompt: 'read only', latestSummary: '', recentRuns: [{ id: `failed-${id}`, mode: 'launch',
      prompt: 'read only', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      pid: 0, stdoutPath: '', stderrPath: '', outcome: 'failed' }], effort: 'high',
    model: runtime === 'codex' || config?.modelSource === 'codex-subscription' ? 'gpt-5.6-sol' : 'claude-opus-5',
    runtimeConfig: config,
  };
  const save = () => writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  save();
  return { repo, worktree, surface, lane, session, save };
}

function serveLaunchRoute() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/api/runtime/launch');
    return route.POST(new NextRequest(String(input), {
      method: 'POST', headers: init?.headers, body: String(init?.body ?? ''),
    }));
  });
}

afterEach(() => {
  supervisor.stopSupervisorLoop();
  for (const watched of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(watched.surfaceId);
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.launch.mockReset().mockImplementation(launchImplementation);
});
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('supervisor retry identity through persisted state and the launch route', () => {
  function watch(f: ReturnType<typeof fixture>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const callbacks = {
      fetchFleetStatus: vi.fn(async () => [{ sessionKey: f.surface, status: 'failed' }]),
      fetchTranscript: vi.fn(async () => []),
      steerAgent: vi.fn(async () => {}),
      interruptAgent: vi.fn(async () => {}),
      relaunchAgent: vi.fn(relaunchSupervisedAgent),
      broadcastAgentUpdate: vi.fn(),
      queueOrchestratorEscalation: vi.fn(),
      onAgentCompletion: vi.fn(),
      onAgentRetry: vi.fn(),
    } satisfies SupervisorCallbacks;
    supervisor.registerWatchedAgent(f.surface, f.repo, 'failed worker', 'read only');
    supervisor.getWatchedAgents(f.repo)[0].nextPollAt = Date.now();
    supervisor.startSupervisorLoop(callbacks);
    return callbacks;
  }

  it.each(['missing-model', 'paused', 'launch-error'] as const)(
    'settles a %s retry through the live poll callback without counting or claiming an attempt',
    async (kind) => {
      const f = fixture('claude-code', { modelSource: 'native' });
      if (kind === 'missing-model') { f.session.model = undefined; f.save(); }
      if (kind === 'paused') updateLane(f.lane.id, { status: 'paused' });
      const transport = serveLaunchRoute();
      const callbacks = watch(f);
      if (kind === 'launch-error') callbacks.relaunchAgent.mockRejectedValueOnce(new Error('unconfirmed launch'));
      await vi.waitFor(() => expect(callbacks.broadcastAgentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'awaiting_input' }),
      ));
      expect(callbacks.relaunchAgent).toHaveBeenCalledTimes(1);
      expect(callbacks.broadcastAgentUpdate.mock.calls.some(([event]) => event.status === 'retrying')).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(callbacks.onAgentCompletion).not.toHaveBeenCalled();
      expect(callbacks.onAgentRetry).not.toHaveBeenCalled();
      closeDb();
      expect(getSqlite().prepare('SELECT retry_count, completion_reported, last_status FROM watched_agents WHERE surface_id = ?')
        .get(f.surface)).toEqual({ retry_count: 0, completion_reported: 1, last_status: 'failed' });
      expect(getLane(f.lane.id)?.status).toBe(kind === 'paused' ? 'paused' : kind === 'missing-model' ? 'awaiting_input' : 'running');
      // A stale later inventory must not reopen a terminal held watcher.
      callbacks.fetchFleetStatus.mockResolvedValue([{ sessionKey: f.surface, status: 'running' }]);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(supervisor.getWatchedAgents(f.repo)[0]).toMatchObject({ retryCount: 0, completionReported: true, lastStatus: 'failed' });
      expect(callbacks.relaunchAgent).toHaveBeenCalledTimes(1);
      supervisor.stopSupervisorLoop();
      // The production startup query excludes this durable, terminal hold.
      expect(getSqlite().prepare('SELECT surface_id FROM watched_agents WHERE completion_reported = 0')
        .all()).toEqual([]);
    },
  );

  it('counts one accepted retry and reserves the failed transition while acceptance is pending', async () => {
    const f = fixture('claude-code', { modelSource: 'native', workMode: 'read-only' });
    let accept!: (result: RuntimeLaunchResult) => void;
    h.launch.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    serveLaunchRoute();
    const callbacks = watch(f);
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));
    expect(supervisor.getWatchedAgents(f.repo)[0]).toMatchObject({ retryCount: 0, completionReported: true });
    expect(callbacks.broadcastAgentUpdate.mock.calls.some(([event]) => event.status === 'retrying')).toBe(false);
    await supervisor.ingestAgentCompletionSignal(f.surface);
    expect(callbacks.onAgentCompletion).not.toHaveBeenCalled();
    accept({ ok: true, runtime: 'claude-code', surfaceId: 'claude-code-owned:accepted-retry',
      note: 'test acceptance', cwd: f.worktree, repoPath: f.worktree, worktree: null, laneId: f.lane.id });
    await vi.waitFor(() => expect(callbacks.onAgentRetry).toHaveBeenCalledExactlyOnceWith(f.surface, 'claude-code-owned:accepted-retry'));
    expect(supervisor.getWatchedAgents(f.repo)).toEqual([expect.objectContaining({
      surfaceId: 'claude-code-owned:accepted-retry', retryCount: 1, completionReported: false,
    })]);
    closeDb();
    expect(getSqlite().prepare('SELECT retry_count FROM watched_agents WHERE surface_id = ?')
      .get('claude-code-owned:accepted-retry')).toEqual({ retry_count: 1 });
    expect(getSqlite().prepare('SELECT surface_id FROM watched_agents WHERE surface_id = ?').get(f.surface)).toBeUndefined();
    expect(callbacks.broadcastAgentUpdate.mock.calls.filter(([event]) => event.status === 'retrying')).toHaveLength(1);
  });

  it('holds a persisted single-attempt worker before any supervisor retry request', async () => {
    const f = fixture('codex', { workMode: 'read-only' });
    f.session.executionPolicy = { version: 1, mode: 'single-attempt', runtime: 'codex',
      model: f.session.model!, effort: 'high', runtimeConfig: { workMode: 'read-only' } };
    f.save();
    closeDb();
    const transport = serveLaunchRoute();
    const callbacks = watch(f);
    await vi.waitFor(() => expect(callbacks.broadcastAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'awaiting_input' }),
    ));
    expect(getLane(f.lane.id)?.outcomeNote).toContain('single-attempt');
    expect(transport).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(callbacks.onAgentRetry).not.toHaveBeenCalled();
    expect(supervisor.getWatchedAgents(f.repo)[0]).toMatchObject({ retryCount: 0, completionReported: true });
  });

  it.each([
    ['claude-code', 'native'],
    ['claude-code', 'codex-subscription'],
    ['codex', undefined],
  ] as const)('preserves %s / %s after database reopen', async (runtime, carrier) => {
    const f = fixture(runtime, { workMode: 'read-only', ...(carrier ? { modelSource: carrier } : {}) });
    const lanesBefore = listLanes().length;
    closeDb();
    const transport = serveLaunchRoute();
    expect(await relaunchSupervisedAgent('read only', f.repo, 'retry', f.surface))
      .toEqual({ status: 'launched', surfaceId: `${runtime}-owned:retried` });
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runtime, model: f.session.model, effort: 'high', workMode: 'read-only',
      automaticRecoverySurfaceId: f.surface, automaticRecoveryRunId: f.session.recentRuns[0].id,
      ...(carrier ? { claudeCodeModel: f.session.model, claudeCodeCarrier: carrier } : {}),
      repoPath: f.worktree, cwd: f.worktree, projectRepoPath: f.repo,
      isolate: false, skipSetup: true, existingLaneId: f.lane.id,
      branchName: f.lane.branch, clientMutationId: expect.any(String),
    }));
    expect(listLanes()).toHaveLength(lanesBefore);
    expect(getLane(f.lane.id)?.sessionKey).toBe(f.surface);
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    const replay = await route.POST(new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify(body),
    }));
    expect(replay.status).toBe(200);
    expect(h.launch).toHaveBeenCalledTimes(1);
    const conflict = await route.POST(new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify({ ...body, claudeCodeCarrier: carrier === 'native' ? 'codex-subscription' : 'native' }),
    }));
    expect(conflict.status).toBe(409);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it('does not silently reset a metered packet budget on retry', async () => {
    const f = fixture('claude-code', { modelSource: 'openrouter', spendCapCostUsd: '0.5', spendCapInputTokens: '10000' });
    const transport = serveLaunchRoute();
    await expect(relaunchSupervisedAgent('read only', f.repo, 'retry', f.surface))
      .resolves.toEqual({ status: 'held', reason: expect.stringContaining('remaining-budget') });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['carrier', 'model', 'effort', 'worktree', 'runtime', 'active-run'] as const)(
    'holds an unverifiable %s before any launch', async (missing) => {
      const f = fixture('claude-code', { modelSource: 'native' });
      if (missing === 'carrier') f.session.runtimeConfig = {};
      if (missing === 'model') f.session.model = undefined;
      if (missing === 'effort') f.session.effort = undefined;
      if (missing === 'worktree') rmSync(f.worktree, { recursive: true });
      if (missing === 'runtime') {
        getSqlite().prepare('UPDATE lanes SET runtime = ? WHERE id = ?').run('codex', f.lane.id);
        expect(getLane(f.lane.id)?.runtime).toBe('codex');
      }
      if (missing === 'active-run') f.session.activeRun = { outcome: 'running' } as OwnedSessionRecord['activeRun'];
      f.save();
      const transport = serveLaunchRoute();
      await expect(relaunchSupervisedAgent('read only', f.repo, 'retry', f.surface))
        .resolves.toEqual({ status: 'held', reason: expect.stringContaining('Automatic retry held') });
      expect(transport).not.toHaveBeenCalled();
      expect(h.launch).not.toHaveBeenCalled();
      expect(getLane(f.lane.id)?.status).toBe('awaiting_input');
      expect(getLaneEvents(f.lane.id).some((event) => event.payload.reason === 'supervisor_retry_held')).toBe(true);
    },
  );

  it('does not restart a paused or archived lane', async () => {
    const f = fixture('claude-code', { modelSource: 'native' });
    const transport = serveLaunchRoute();
    for (const status of ['paused', 'archived'] as const) {
      updateLane(f.lane.id, { status });
      await expect(relaunchSupervisedAgent('read only', f.repo, 'retry', f.surface))
        .resolves.toEqual({ status: 'held', reason: expect.stringContaining('Automatic retry held') });
      expect(getLane(f.lane.id)?.status).toBe(status);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('honors an operator stop during the saved-session read', async () => {
    const f = fixture('claude-code', { modelSource: 'native' });
    const sessionIo = await import('@/lib/runtimes/shared/owned-session/session-io');
    const original = sessionIo.createOwnedSessionIo;
    vi.spyOn(sessionIo, 'createOwnedSessionIo').mockImplementation((options) => {
      const io = original(options);
      return { ...io, async findSession(surfaceId) {
        const session = await io.findSession(surfaceId);
        updateLane(f.lane.id, { status: 'paused' });
        return session;
      } };
    });
    const transport = serveLaunchRoute();
    await expect(relaunchSupervisedAgent('read only', f.repo, 'retry', f.surface))
      .resolves.toEqual({ status: 'held', reason: expect.stringContaining('lane changed') });
    expect(getLane(f.lane.id)?.status).toBe('paused');
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains an explicit spend cap in the correlated route body', async () => {
    const body = { runtime: 'claude-code', model: 'test-model', claudeCodeCarrier: 'openrouter',
      spendCap: { carrier: 'openrouter', costUsd: 0.5, inputTokens: 10000 },
      prompt: 'test', cwd: dataDir, clientMutationId: 'cap-preservation' };
    const response = await route.POST(new NextRequest('http://localhost/api/runtime/launch', { method: 'POST', body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(h.launch.mock.calls[0][0].spendCap).toEqual(body.spendCap);
    const conflict = await route.POST(new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify({ ...body, spendCap: { ...body.spendCap, costUsd: 1 } }),
    }));
    expect(conflict.status).toBe(409);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid explicit carrier and safety fields', async () => {
    for (const invalid of [{ claudeCodeCarrier: 'unknown' }, { workMode: 'unsafe' }, { spendCap: { carrier: 'openrouter', costUsd: -1 } }]) {
      const response = await route.POST(new NextRequest('http://localhost/api/runtime/launch', {
        method: 'POST', body: JSON.stringify({ runtime: 'claude-code', prompt: 'test', clientMutationId: 'invalid-retry', ...invalid }),
      }));
      expect(response.status).toBe(400);
    }
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('wires the production supervisor callback to the tested retry path', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    const start = source.indexOf('async relaunchAgent(');
    const section = source.slice(start, source.indexOf('broadcastAgentUpdate(', start));
    expect(section).toContain('relaunchSupervisedAgent(prompt, repoPath, taskName, retryOfSurfaceId)');
    expect(section).not.toContain("runtime: 'codex'");
  });
});
