import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { CompletionVerificationResult } from '@/lib/supervisor/completion-verification';
import type { RuntimeActionRequest, RuntimeActionResult } from '@/lib/runtime/actions';
import type { OwnedRunRecord, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const h = vi.hoisted(() => ({
  perform: vi.fn(), verify: vi.fn(), commit: vi.fn(), capture: vi.fn(), probe: vi.fn(), transcript: vi.fn(),
}));
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: h.perform }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/supervisor/completion-liveness', () => ({
  shouldDeferCompletionForLiveRuntime: vi.fn(async () => false),
}));
vi.mock('@/lib/orchestrator/cost-persistence', () => ({ persistRuntimeSessionCost: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/no-changes-produced', () => ({ probeNoChangesProduced: h.probe }));
vi.mock('@/lib/supervisor/completion-verification', () => ({
  runCompletionVerification: h.verify, autoCommitCompletionWorktree: h.commit,
}));
vi.mock('@/lib/orchestrator/context-relay', () => ({ capturePacketCompletionContext: h.capture }));
vi.mock('@/lib/runtime/transcript', () => ({ readRuntimeTranscript: h.transcript }));
vi.mock('@/lib/lane/worktree-cleanup', () => ({ pruneRepoWorktrees: vi.fn(async () => []) }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-completion-steer-race-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const ownedRoot = join(dataDir, 'owned-claude-code');
mkdirSync(ownedRoot, { mode: 0o700 });
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { packetAutomaticRecoveryHoldReason, packetRecoveryStopReason, persistLanePacketHold } = await import('@/lib/lane/packet-stop-hold');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { handleAgentCompletion } = await import('@/lib/supervisor/agent-completion');
const { getWatchedAgents, ingestAgentCompletionSignal, registerWatchedAgent,
  runSupervisorTickForTesting, startSupervisorLoop, stopSupervisorLoop, unregisterWatchedAgent } = await import('@/lib/supervisor/agent-supervisor');
const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const { assertAutomaticRecoveryGeneration, readOwnedCompletionState, readOwnedRecoveryState } = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
const runsRoute = await import('@/app/api/panel/managed-runs/route');
const headlessRoute = await import('@/app/api/orchestrator/headless-tick/route');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { recordMission } = await import('@/lib/db/missions-store');

const dependencies = {
  enqueueAutoReview: vi.fn(async () => {}),
  triggerHeadlessSprintTick: vi.fn(async () => {}),
  queueReviewContinuation: vi.fn(),
  enqueueVerificationFailureInboxItem: vi.fn(async () => 'test-inbox'),
};
const broadcast = vi.fn();
const verified: CompletionVerificationResult = { ok: true, kind: 'typecheck', output: '' };
let sequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { queueState?: OrchestratorPacket['queueState']; capHit?: boolean; reviewable?: boolean } = {}) {
  const id = `pkt-completion-race-${++sequence}`;
  const repoPath = join(dataDir, id);
  const sessionKey = `claude-code-owned:${id}`;
  mkdirSync(repoPath, { mode: 0o700 });
  const lane = createLane({ repoPath, worktreePath: repoPath, branch: `inline/${id}`,
    runtime: 'claude-code', packetId: id, sessionKey });
  const sessionDir = join(ownedRoot, id);
  mkdirSync(sessionDir, { mode: 0o700 });
  const now = new Date().toISOString();
  const session: OwnedSessionRecord = {
    surfaceId: sessionKey, laneId: lane.id, packetId: id,
    sessionDir, cwd: repoPath, repoPath, title: id,
    createdAt: now, updatedAt: now, latestPrompt: 'Verify completion overlap',
    latestSummary: 'Finished fixture run', recentRuns: [{
      id: `run-${id}`, mode: 'launch', prompt: 'Verify completion overlap',
      startedAt: now, finishedAt: now, pid: 0, outcome: 'finished',
      stdoutPath: join(sessionDir, 'stdout.log'), stderrPath: join(sessionDir, 'stderr.log'),
    }],
  };
  const metadataPath = join(sessionDir, 'session.json');
  function saveSession(saved: OwnedSessionRecord) {
    writeFileSync(metadataPath + '.tmp', JSON.stringify(saved), { mode: 0o600 });
    renameSync(metadataPath + '.tmp', metadataPath);
  }
  function writeFinishedLogs(run: OwnedRunRecord) {
    writeFileSync(run.stdoutPath, JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'Finished fixture run',
    }) + '\n', { mode: 0o600 });
    writeFileSync(run.stderrPath, '', { mode: 0o600 });
  }
  writeFinishedLogs(session.recentRuns[0]);
  saveSession(session);
  let resumedRuns = 0;
  function finishRun() {
    const saved = JSON.parse(readFileSync(metadataPath, 'utf8')) as OwnedSessionRecord;
    const current = saved.activeRun;
    expect(current).toMatchObject({ mode: 'resume', outcome: 'running' });
    if (!current) throw new Error('Fixture has no active resumed run');
    const finished: OwnedRunRecord = { ...current, pid: 0, outcome: 'finished',
      finishedAt: new Date().toISOString(),
      childExit: { code: 0, signal: null, classification: 'clean-exit' } };
    writeFinishedLogs(finished);
    saved.recentRuns = saved.recentRuns.map((run) => run.id === finished.id ? finished : run);
    saved.activeRun = undefined;
    saveSession(saved);
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      surfaceId: sessionKey, runId: finished.id, exitCode: 0,
    });
    return finished.id;
  }
  setLaneStatus(lane.id, options.reviewable ? 'reviewing' : 'running', 'system', options.reviewable ? 'review_requested' : 'runtime_started');
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: id, runtime: 'claude-code',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
    // Reviewable work is queued; an explicit held queue is a durable stop.
    dependencyLabels: [], dependencyPacketIds: [], queueState: options.queueState ?? 'queued',
    releaseState: 'pending', status: options.reviewable ? 'awaiting_review' : 'running', operatorStopped: false,
    ...(options.capHit ? { spendTelemetry: { capHit: true, costUsd: null, inputTokens: 1, outputTokens: 0,
      costSource: 'unknown' as const, updatedAt: now } } : {}),
    blockedReason: null, lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
      worktreePath: repoPath, runtime: 'claude-code', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, packets: [packet] });
  recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
  h.perform.mockImplementation(async (request: RuntimeActionRequest): Promise<RuntimeActionResult> => {
    expect(request).toMatchObject({ action: 'steer', surfaceId: sessionKey });
    const saved = JSON.parse(readFileSync(metadataPath, 'utf8')) as OwnedSessionRecord;
    const next: OwnedRunRecord = {
      id: 'run-' + id + '-resume-' + (++resumedRuns), mode: 'resume', prompt: request.message ?? '',
      startedAt: new Date().toISOString(), outcome: 'running',
      // The mock owns no child; its test process keeps the admitted run live.
      pid: process.pid, stdoutPath: join(sessionDir, 'stdout-' + resumedRuns + '.log'),
      stderrPath: join(sessionDir, 'stderr-' + resumedRuns + '.log'),
    };
    writeFileSync(next.stdoutPath, '', { mode: 0o600 });
    writeFileSync(next.stderrPath, '', { mode: 0o600 });
    saved.activeRun = next;
    saved.recentRuns = [next, ...saved.recentRuns];
    saved.latestPrompt = next.prompt;
    saveSession(saved);
    return { ok: true, action: request.action, surfaceId: sessionKey, runtime: 'claude-code',
      status: 'queued', sessionKey, runId: next.id, note: 'accepted' };
  });
  registerWatchedAgent(sessionKey, repoPath, id, 'test');
  broadcast.mockClear();
  return { packet, lane, sessionKey, runId: session.recentRuns[0].id, finishRun,
    readSession: () => JSON.parse(readFileSync(metadataPath, 'utf8')) as OwnedSessionRecord };
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
async function steer(packetId: string) {
  const response = steerRoute.POST(request('/api/orchestrator/steer-packet', {
    packetId, message: 'Run the next verification', idempotencyKey: `steer-${packetId}`,
  }));
  // The route reads the request before scheduling its startup probe. Advance
  // fake time until it settles, rather than racing a one-shot clock advance.
  let settled = false;
  void response.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
  return response;
}
function register(packet: OrchestratorPacket, suffix: string) {
  const id = `race${sequence}${suffix}`;
  return runsRoute.POST(request('/api/panel/managed-runs', {
    id, session: `cortex-run-${id}`, command: 'node --version',
    cwd: packet.workspaceTargetPath, packetId: packet.id, laneId: packet.lane?.laneId,
  }));
}
function delayVerification() {
  const entered = deferred<void>();
  const result = deferred<CompletionVerificationResult>();
  h.verify.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  return { entered: entered.promise, ...result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  dependencies.triggerHeadlessSprintTick.mockReset().mockResolvedValue(undefined);
  h.perform.mockReset();
  h.verify.mockReset().mockResolvedValue(verified);
  h.commit.mockReset().mockResolvedValue(false);
  h.probe.mockReset().mockResolvedValue({ noChangesProduced: false });
  h.capture.mockReset().mockResolvedValue({});
  h.transcript.mockReset().mockResolvedValue([]);
  startSupervisorLoop({
    fetchFleetStatus: async () => [], fetchTranscript: async () => [],
    steerAgent: async () => {}, interruptAgent: async () => {},
    relaunchAgent: async () => ({ status: 'held', reason: 'test' }),
    broadcastAgentUpdate: broadcast, queueOrchestratorEscalation: vi.fn(),
    onAgentCompletion: (surfaceId, outcome) => handleAgentCompletion(surfaceId, outcome, dependencies),
  });
  stopSupervisorLoop();
});
afterEach(() => {
  for (const watched of getWatchedAgents()) unregisterWatchedAgent(watched.surfaceId);
  stopSupervisorLoop();
  vi.clearAllTimers();
  vi.useRealTimers();
});
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('completion and steer overlap through production callbacks and routes', () => {
  it.each(['current', 'registry'] as const)('keeps fully settled %s work reviewable across repeated continuation', async (location) => {
    const { packet, lane, sessionKey, finishRun } = fixture();
    const missionId = `mission-${packet.id}`;
    if (location === 'registry') {
      recordMission({
        id: missionId, repoPath: lane.repoPath, runtime: 'claude-code',
        prompt: 'Verify repeated continuation', summary: 'Review without release',
        constraints: '', packetMeta: [], totalWaves: 1,
        missionState: readOrchestratorControlPlaneState(),
      });
      expect(readMissionRegistryEntry(missionId)?.mission.packets[0]?.id).toBe(packet.id);
      writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    }
    let tick: Promise<void> = Promise.resolve();
    // Preserve the bridge's former argument mapping so an accidental release
    // list reaches the real route rather than disappearing into a no-op stub.
    dependencies.triggerHeadlessSprintTick.mockImplementation((releasePacketIds?: string[]) => {
      tick = headlessRoute.POST(request('/api/orchestrator/headless-tick',
        releasePacketIds ? { releasePacketIds } : {})).then(async (response) => {
        expect(response.status, await response.clone().text()).toBe(200);
      });
      return tick;
    });
    for (let turn = 0; turn < 3; turn += 1) {
      await handleAgentCompletion(sessionKey, 'completed', dependencies);
      await tick;
      closeDb();
      const saved = location === 'current' ? readOrchestratorControlPlaneState()
        : readMissionRegistryEntry(missionId, { includeArchived: true })?.mission;
      expect(saved?.packets.find((p) => p.id === packet.id)).toMatchObject({ releaseState: 'pending' });
      expect(getLane(lane.id)?.status).toBe('reviewing');
      expect(dependencies.triggerHeadlessSprintTick).toHaveBeenLastCalledWith();
      expect((await register(packet, `closed${turn}`)).status).toBe(409);
      // A distinct operator mutation per turn, not an idempotent replay.
      const response = steerRoute.POST(request('/api/orchestrator/steer-packet', {
        packetId: packet.id, message: `Review correction ${turn}`, idempotencyKey: `repeat-${packet.id}-${turn}`,
      }));
      let settled = false;
      void response.finally(() => { settled = true; });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
      expect((await response).status).toBe(200);
      expect((await register(packet, `active${turn}`)).status).toBe(200);
      finishRun();
    }
    expect(h.perform).toHaveBeenCalledTimes(3);
    await persistLanePacketHold(packet.id);
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet, 'stopped')).status).toBe(409);
    expect(h.perform).toHaveBeenCalledTimes(3);
  });

  it('rejects raw release IDs at the scheduler route without changing review state', async () => {
    const { packet, lane } = fixture({ reviewable: true });
    const response = await headlessRoute.POST(request('/api/orchestrator/headless-tick', {
      releasePacketIds: [packet.id],
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'release_requires_merge_evidence' });
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseState).toBe('pending');
    expect(getLane(lane.id)?.status).toBe('reviewing');
  });

  it.each(['pass', 'fail', 'throw'] as const)('discards a delayed %s result while the next turn remains admitted', async (outcome) => {
    const { packet, lane, sessionKey, runId, finishRun } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey, runId);
    await delayed.entered;
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet, 'before')).status).toBe(200);
    closeDb();
    if (outcome === 'throw') delayed.reject(new Error('old verifier failed'));
    else delayed.resolve({ ...verified, ok: outcome === 'pass' });
    expect(await completion).toBe(true);

    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'after')).status).toBe(200);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(readOrchestratorControlPlaneState().packets[0]?.attemptCount).toBe(0);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    expect(await ingestAgentCompletionSignal(sessionKey, runId)).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
    const nextRunId = finishRun();
    expect(nextRunId).not.toBe(runId);
    expect((await register(packet, 'exited')).status).toBe(409);
    expect(await ingestAgentCompletionSignal(sessionKey, runId)).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(getLane(lane.id)?.status).toBe('running');
    expect(await ingestAgentCompletionSignal(sessionKey, nextRunId)).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(dependencies.enqueueAutoReview).toHaveBeenCalledTimes(1);
  });

  it('rejects an old completion even when the newer turn has already exited', async () => {
    const { packet, sessionKey, runId, finishRun } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey, runId);
    await delayed.entered;
    expect((await steer(packet.id)).status).toBe(200);
    finishRun();
    delayed.resolve(verified);
    await completion;
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect((await register(packet, 'exited')).status).toBe(409);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
  });

  it('preserves an operator hold and never restores its removed watcher', async () => {
    const { packet, lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    await persistLanePacketHold(packet.id);
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    unregisterWatchedAgent(sessionKey);
    delayed.resolve(verified);
    await completion;
    expect(getLane(lane.id)?.status).toBe('paused');
    expect((await register(packet, 'held')).status).toBe(409);
    expect((await steer(packet.id)).status).toBe(409);
    expect(getWatchedAgents()).toHaveLength(0);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not apply old completion state or watcher persistence to a rebound session', async () => {
    const { lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    updateLane(lane.id, { sessionKey: `${sessionKey}-replacement` });
    registerWatchedAgent(sessionKey, lane.repoPath, 'new watch', 'new prompt');
    const replacement = getWatchedAgents().find((entry) => entry.surfaceId === sessionKey);
    delayed.resolve(verified);
    await completion;
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)).toBe(replacement);
    expect(getSqlite().prepare('SELECT prompt FROM watched_agents WHERE surface_id = ?').get(sessionKey)).toEqual({ prompt: 'new prompt' });
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('does not let a finished turn cleanup timer delete a newly registered watch', async () => {
    const { lane, sessionKey } = fixture();
    expect(await ingestAgentCompletionSignal(sessionKey)).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueueAutoReview).toHaveBeenCalledTimes(1);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(true);
    registerWatchedAgent(sessionKey, lane.repoPath, 'successor', 'new prompt');
    const replacement = getWatchedAgents().find((entry) => entry.surfaceId === sessionKey);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)).toBe(replacement);
  });

  it('does not enqueue stale review work if a new steer starts during context capture', async () => {
    const { packet, lane, sessionKey } = fixture();
    const entered = deferred<void>();
    const capture = deferred<object>();
    h.capture.mockImplementationOnce(() => { entered.resolve(); return capture.promise; });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await entered.promise;
    expect((await steer(packet.id)).status).toBe(200);
    capture.resolve({});
    await completion;
    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'afterCapture')).status).toBe(200);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.queueReviewContinuation).not.toHaveBeenCalled();
  });

  it('still reports an evidenced read-only completion as complete', async () => {
    const { packet, lane, sessionKey } = fixture();
    packet.launchContext = { source: 'cli', presentation: 'split',
      repoContext: 'transient', workMode: 'read-only' };
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      repoPath: lane.repoPath, packets: [packet] });
    const entered = deferred<void>();
    h.probe.mockImplementation(() => {
      entered.resolve();
      return Promise.resolve({ noChangesProduced: true });
    });
    h.capture.mockResolvedValue({ packetId: packet.id, sessionKey, selfReview: { passed: true, decision: 'finding_ready',
      outcome: 'Inspection complete', evidence: ['Observed result'], residual: 'No changes required' } });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await entered.promise;
    let settled = false;
    void completion.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    await completion;
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseState).toBe('released');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('does not let a delayed planning transcript park a newly steered turn', async () => {
    const { packet, lane, sessionKey } = fixture();
    packet.huddle = true;
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: lane.repoPath, packets: [packet] });
    const probeEntered = deferred<void>();
    h.probe.mockImplementation(() => {
      probeEntered.resolve();
      return Promise.resolve({ noChangesProduced: true });
    });
    const transcriptEntered = deferred<void>();
    const transcript = deferred<Array<{ role: string; text: string }>>();
    h.transcript.mockImplementationOnce(() => { transcriptEntered.resolve(); return transcript.promise; });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await probeEntered.promise;
    await vi.waitFor(() => expect(h.transcript).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await transcriptEntered.promise;
    expect((await steer(packet.id)).status).toBe(200);
    transcript.resolve([{ role: 'assistant', text: 'Implementation plan: inspect and verify.' }]);
    await completion;
    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'afterPlan')).status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.blockedReason).not.toBe('huddle_ready');
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('still holds a current failed turn with partial work for input', async () => {
    const { lane, sessionKey } = fixture();
    await handleAgentCompletion(sessionKey, 'failed', dependencies);
    expect(getLane(lane.id)).toMatchObject({ status: 'awaiting_input',
      lastEventLabel: 'agent_failed_work_present' });
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it.each([
    ['queue', 'completed'], ['queue', 'failed'], ['cap', 'completed'], ['cap', 'failed'],
  ] as const)('preserves an explicit %s hold before a %s completion without an operator-stop flag', async (hold, outcome) => {
    const { packet, lane, sessionKey } = fixture(hold === 'queue' ? { queueState: 'held' } : { capHit: true });
    const before = readOrchestratorControlPlaneState().packets.find(entry => entry.id === packet.id)!;
    expect(Boolean(before.operatorStopped)).toBe(false);
    expect(before.queueState).toBe(hold === 'queue' ? 'held' : 'queued');
    expect(Boolean(before.spendTelemetry?.capHit)).toBe(hold === 'cap');
    expect(packetRecoveryStopReason(packet.id)).toBe(hold === 'queue' ? 'packet_held' : 'spend_cap_hit');
    expect(await handleAgentCompletion(sessionKey, outcome, dependencies)).toEqual({ superseded: true });
    closeDb();
    expect(readOrchestratorControlPlaneState().packets.find(entry => entry.id === packet.id)).toEqual(before);
    expect(getLane(lane.id)?.status).toBe('running');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.perform).not.toHaveBeenCalled();
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(dependencies.queueReviewContinuation).not.toHaveBeenCalled();
    expect(dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
  });

  it.each(['queue', 'cap'] as const)('preserves a %s hold arriving during verification without settling its watcher', async hold => {
    const { packet, lane, sessionKey, runId } = fixture();
    expect(packetRecoveryStopReason(packet.id)).toBeNull();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey, runId);
    await delayed.entered;
    const state = readOrchestratorControlPlaneState();
    const current = state.packets.find(entry => entry.id === packet.id)!;
    if (hold === 'queue') current.queueState = 'held';
    else current.spendTelemetry = { capHit: true, costUsd: null, inputTokens: 1, outputTokens: 0,
      costSource: 'unknown', updatedAt: new Date().toISOString() };
    writeOrchestratorControlPlaneState(state);
    const held = readOrchestratorControlPlaneState().packets.find(entry => entry.id === packet.id)!;
    expect(Boolean(held.operatorStopped)).toBe(false);
    expect(held.queueState).toBe(hold === 'queue' ? 'held' : 'queued');
    expect(Boolean(held.spendTelemetry?.capHit)).toBe(hold === 'cap');
    expect(packetRecoveryStopReason(packet.id)).toBe(hold === 'queue' ? 'packet_held' : 'spend_cap_hit');
    closeDb();
    delayed.resolve(verified);
    expect(await completion).toBe(true);
    expect(readOrchestratorControlPlaneState().packets.find(entry => entry.id === packet.id)).toEqual(held);
    expect(getLane(lane.id)?.status).toBe('running');
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.perform).not.toHaveBeenCalled();
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(dependencies.queueReviewContinuation).not.toHaveBeenCalled();
    expect(dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
    expect(getWatchedAgents().find(entry => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it.each(['push', 'poll'] as const)('verifies the current exited steer through %s without admitting automatic recovery', async observer => {
    const { packet, lane, sessionKey, finishRun, readSession } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    const runId = finishRun();
    expect(packetRecoveryStopReason(packet.id)).toBeNull();
    expect(packetAutomaticRecoveryHoldReason(packet.id)).toBe('packet_terminal');
    expect(await readOwnedRecoveryState(sessionKey)).toMatchObject({ owned: true, runId, outcome: 'finished',
      packetHoldReason: 'packet_terminal', automaticRecoveryAllowed: false });
    if (observer === 'push') expect(await ingestAgentCompletionSignal(sessionKey, runId)).toBe(true);
    else {
      // Exercise the real poll and its unchanged 15-second finish grace.
      vi.setSystemTime(Date.now() + 31_000);
      await runSupervisorTickForTesting();
      expect(h.verify).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 16_000);
      await runSupervisorTickForTesting();
    }
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(dependencies.enqueueAutoReview).toHaveBeenCalledTimes(1);
    expect(packetAutomaticRecoveryHoldReason(packet.id)).toBe('packet_terminal');
    expect(await readOwnedRecoveryState(sessionKey)).toMatchObject({ owned: true, runId, outcome: 'finished',
      packetHoldReason: 'packet_terminal', automaticRecoveryAllowed: false });
    expect(() => assertAutomaticRecoveryGeneration(readSession(), runId)).toThrow('Automatic recovery refused: packet_terminal');
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(readOrchestratorControlPlaneState().packets.find(entry => entry.id === packet.id)?.releaseState).toBe('pending');
  });

  it.each([
    ['missing', 'push'], ['missing', 'poll'], ['released', 'push'], ['released', 'poll'], ['archived', 'push'], ['archived', 'poll'],
  ] as const)('keeps %s owner refusal through the %s completion observer', async (terminal, observer) => {
    const { packet, lane, sessionKey, runId } = fixture();
    const state = readOrchestratorControlPlaneState();
    if (terminal === 'missing') state.packets = [];
    else {
      const current = state.packets.find(entry => entry.id === packet.id)!;
      current.status = terminal;
      if (terminal === 'released') {
        current.releaseState = 'released';
        current.releaseStatePayload = { source: 'read_only_completed', evidenceKind: 'read_only_no_merge_required' };
      } else current.archivedAt = new Date().toISOString();
    }
    writeOrchestratorControlPlaneState(state);
    closeDb();
    const saved = readOrchestratorControlPlaneState();
    const savedBytes = readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8');
    if (terminal === 'missing') expect(saved.packets).toEqual([]);
    else expect(saved.packets.find(entry => entry.id === packet.id)?.status).toBe(terminal);
    expect(await readOwnedCompletionState(sessionKey)).toMatchObject({ owned: true, packetHoldReason: expect.any(String), automaticRecoveryAllowed: false });
    if (observer === 'push') expect(await ingestAgentCompletionSignal(sessionKey, runId)).toBe(true);
    else {
      vi.setSystemTime(Date.now() + 31_000); await runSupervisorTickForTesting();
      vi.setSystemTime(Date.now() + 16_000); await runSupervisorTickForTesting();
    }
    expect(readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8')).toBe(savedBytes);
    expect(getLane(lane.id)?.status).toBe('running');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.perform).not.toHaveBeenCalled();
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(getWatchedAgents().find(entry => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
  });

  it('does not re-verify an already-reviewable owned turn on a duplicate exit signal', async () => {
    const { packet, lane, sessionKey, runId } = fixture({ reviewable: true });
    expect(packetRecoveryStopReason(packet.id)).toBeNull();
    expect(await ingestAgentCompletionSignal(sessionKey, runId)).toBe(true);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
  });

  it('wires the server callback to this production completion path', () => {
    const source = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    const start = source.indexOf('async onAgentCompletion(');
    const callback = source.slice(start, source.indexOf('onAgentRetry(', start));
    expect(callback).toContain("import('@/lib/supervisor/agent-completion')");
    expect(callback).toContain('handleAgentCompletion(surfaceId, outcome, {');
    expect(callback).not.toContain('setLaneStatus(');
    const bridgeStart = source.indexOf('async function triggerHeadlessSprintTick(');
    const bridge = source.slice(bridgeStart, source.indexOf('\nasync function ', bridgeStart + 1));
    expect(bridge).toContain('triggerHeadlessSprintTick()');
    expect(bridge).not.toContain('releasePacketIds');
    const stallStart = source.indexOf('async function forceCodexSelfReviewToReview(');
    const stall = source.slice(stallStart, source.indexOf('\nasync function ', stallStart + 1));
    expect(stall).toContain("import('@/lib/supervisor/force-self-review')");
    expect(stall).toContain('await forceSelfReviewToReview(surfaceId, lane, decision, {');
    expect(stall).toContain('triggerHeadlessSprintTick,');
  });
});
