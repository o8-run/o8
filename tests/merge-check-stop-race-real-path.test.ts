import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { LaneCommandResult } from '@/lib/lane/types';

const h = vi.hoisted(() => ({
  rerunWithFeedback: vi.fn(),
  terminateManagedRuns: vi.fn(),
  verify: vi.fn(),
  stopStateReadFault: false,
}));

vi.mock('@/lib/lane/rebase-verify', () => ({ runLaneRebaseVerify: h.verify }));
vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>();
  return { ...actual, rerunWithFeedback: h.rerunWithFeedback };
});
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: h.terminateManagedRuns,
}));
vi.mock('@/lib/lane/packet-stop-hold', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/packet-stop-hold')>();
  return {
    ...actual,
    // Narrow fault injection for the unreadable-stop-state path. Off unless a
    // test arms it after the real Stop has persisted.
    packetSteerHoldReason: (...args: Parameters<typeof actual.packetSteerHoldReason>) => {
      if (h.stopStateReadFault) throw new Error('injected unreadable operator-stop state');
      return actual.packetSteerHoldReason(...args);
    },
  };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-stop-race-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { dispatch } = await import('@/lib/lane/commands');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { recordOrchestratorReview, listApprovalsForContext } = await import('@/lib/approvals/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');

const FAILURE_OUTPUT =
  'src/broken.ts(1,14): error TS2322: Type number is not assignable to type string (merge-stop-race sentinel).';

const gitDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  gitDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo) };
}

async function makeWorktree(repo: string, packetId: string) {
  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({
    agentType: 'codex',
    taskName: packetId,
    branchName: `inline/${packetId}`,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  return worktree;
}

function packetFixture(
  id: string,
  repoPath: string,
  retries: number,
  queueState: 'queued' | 'held',
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: 'Stop-race packet',
    summary: 'Stop-race packet',
    status: queueState === 'held' ? 'blocked' : 'running',
    queueState,
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: null,
    recoveryCount: 0,
    typecheckAutoRetries: retries,
    leaseWaitAutoRetries: 0,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
  } as OrchestratorPacket;
}

async function setupPacket(packetId: string, retries: number, queueState: 'queued' | 'held') {
  const { repo } = makeRepo(packetId);
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    repoPath: repo,
    packets: [packetFixture(packetId, repo, retries, queueState)],
  });
  const worktree = await makeWorktree(repo, packetId);
  writeFileSync(join(worktree.path, 'packet.txt'), 'packet change\n');
  commitAll(worktree.path, 'packet change');

  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  const bound = readOrchestratorControlPlaneState();
  bound.packets[0].lane = { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath: lane.repoPath,
    worktreePath: lane.worktreePath, runtime: 'codex', sessionKey: lane.sessionKey };
  writeOrchestratorControlPlaneState(bound);
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewedHeadSha: git(worktree.path, ['rev-parse', 'HEAD']),
  });
  return { repo, worktree, lane };
}

function mergeInput(lane: ReturnType<typeof createLane>) {
  return {
    lane,
    command: { verb: 'merge' as const, laneId: lane.id, actor: 'system' as const },
    actor: 'system' as const,
    gateResult: { passed: true, violations: [] },
    repoActionLeaseMaxWaitMs: 5_000,
    createLaneActionApproval: async (
      _lane: unknown,
      _actor: unknown,
      input: { note: string },
    ) => ({ ok: false as const, laneId: lane.id, note: input.note }),
  };
}

function armPausedVerify() {
  let releaseVerify: ((result: unknown) => void) | undefined;
  let released = false;
  let signalBoundary: (() => void) | undefined;
  const atBoundary = new Promise<void>((resolve) => { signalBoundary = resolve; });
  h.verify.mockImplementation((_input: unknown) => {
    signalBoundary?.();
    return new Promise((resolve) => {
      releaseVerify = (result) => { released = true; resolve(result); };
    });
  });
  return {
    atBoundary,
    fail(output: string) {
      if (!releaseVerify) throw new Error('Verification boundary was never reached.');
      releaseVerify({ ok: false, kind: 'typecheck', output, checks: [] });
    },
    settle(output: string) {
      if (releaseVerify && !released) {
        releaseVerify({ ok: false, kind: 'typecheck', output, checks: [] });
      }
    },
  };
}

function findReview(packetId: string, laneId: string) {
  return listApprovalsForContext({ packetId, laneId })
    .find((approval) => approval.toolName === 'orchestrator_review');
}

/** Bounded wait for a detach-side lane event; no race timing guesses. */
async function waitForLaneEvent(
  laneId: string,
  predicate: (event: ReturnType<typeof getLaneEvents>[number]) => boolean,
  timeoutMs = 5_000,
) {
  const startedAt = Date.now();
  for (;;) {
    const found = getLaneEvents(laneId, 200).find(predicate);
    if (found) return found;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the expected lane event.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run the real stop interleaving: pause at verify, stop, then release the older failure. */
async function runStoppedInterleaving(packetId: string, retries: number, beforeRelease?: () => void) {
  const { repo, worktree, lane } = await setupPacket(packetId, retries, 'queued');
  const headBefore = git(worktree.path, ['rev-parse', 'HEAD']);
  const baseBefore = git(repo, ['rev-parse', 'main']);
  const reviewBefore = findReview(packetId, lane.id);
  const boundary = armPausedVerify();
  let mergePromise: Promise<LaneCommandResult> | undefined;
  let mergeResult: LaneCommandResult | undefined;
  let mergeError: unknown;
  let stop: Awaited<ReturnType<typeof dispatch>> | undefined;
  let interleavingError: unknown;

  try {
    mergePromise = performWorktreeSideMerge(mergeInput(lane));
    await Promise.race([
      boundary.atBoundary,
      mergePromise.then(() => {
        throw new Error('merge returned before reaching the verification boundary');
      }),
    ]);
    stop = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });
    expect(stop.ok, stop.note).toBe(true);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true,
      queueState: 'held', lane: { laneId: lane.id, sessionKey: lane.sessionKey } });
    beforeRelease?.();
    boundary.fail(FAILURE_OUTPUT);
  } catch (error) {
    interleavingError = error;
  } finally {
    // Always settle the deferred verification so cleanup is deterministic, but
    // never hide an unexpected production error from the merge path.
    boundary.settle(FAILURE_OUTPUT);
    if (mergePromise) {
      try {
        mergeResult = await mergePromise;
      } catch (error) {
        mergeError = error;
      }
    }
  }
  if (interleavingError) {
    throw interleavingError instanceof Error ? interleavingError : new Error(String(interleavingError));
  }
  if (mergeError) {
    throw mergeError instanceof Error ? mergeError : new Error(String(mergeError));
  }

  return {
    repo,
    worktree,
    laneId: lane.id,
    retries,
    stop,
    mergeResult,
    laneAfter: getLane(lane.id),
    packet: readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId),
    reviewBefore,
    reviewAfter: findReview(packetId, lane.id),
    events: getLaneEvents(lane.id, 200),
    headBefore,
    baseBefore,
  };
}

beforeAll(async () => {
  // Keep the storage governor's reserve out of the way; the merge path is what is under test.
  await updateOperatorDefaults({
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

beforeEach(() => {
  h.verify.mockReset();
  h.rerunWithFeedback.mockReset();
  h.terminateManagedRuns.mockReset();
  h.terminateManagedRuns.mockResolvedValue({ targeted: 0, confirmed: 0, failures: [] });
  h.stopStateReadFault = false;
});

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  __resetIdempotencyStoreForTests();
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('late merge verification after an operator stop', () => {
  for (const retries of [0, 1]) {
    it(`keeps the stopped lane paused and un-superseded (retry budget ${retries})`, async () => {
      const packetId = `pkt-stop-race-${retries}`;
      const obs = await runStoppedInterleaving(packetId, retries);

      expect.soft(obs.stop?.ok).toBe(true);
      expect.soft(h.terminateManagedRuns).toHaveBeenCalledWith(packetId);
      // The returned failed-merge result must reflect the preserved Stop, not a
      // thrown error that happens to leave matching persisted state.
      expect.soft(obs.mergeResult?.ok).toBe(false);
      expect.soft(obs.mergeResult?.reason).toBe('operator_stopped');
      expect.soft(obs.mergeResult?.note ?? '').not.toContain('Auto-rerun dispatched');
      expect.soft(obs.laneAfter?.status).toBe('paused');
      expect.soft(obs.laneAfter?.lastEventLabel).toBe('operator_stopped');
      expect.soft(obs.packet?.operatorStopped).toBe(true);
      expect.soft(obs.packet?.queueState).toBe('held');
      expect.soft(obs.packet?.blockedReason).toBe('operator_stopped');
      // A stopped packet's failure budget must not move.
      expect.soft(obs.packet?.typecheckAutoRetries).toBe(retries);
      // The saved durable approval keeps its identity, audit, and approved state.
      expect.soft(obs.reviewBefore?.id).toBeTruthy();
      expect.soft(obs.reviewAfter?.id).toBe(obs.reviewBefore?.id);
      expect.soft(obs.reviewAfter?.status).toBe('approved');
      expect.soft(obs.reviewAfter?.args?.reviewSuperseded).not.toBe(true);
      expect.soft(obs.reviewAfter?.audit?.some((event) => event.type === 'orchestrator_review')).toBe(true);
      // The late completion dispatches no worker and leaves evidence.
      expect.soft(h.rerunWithFeedback).not.toHaveBeenCalled();
      expect.soft(obs.events.some((event) => (
        typeof event.payload.output === 'string' && event.payload.output.includes(FAILURE_OUTPUT)
      ))).toBe(true);
      expect.soft(git(obs.worktree.path, ['rev-parse', 'HEAD'])).toBe(obs.headBefore);
      expect.soft(git(obs.repo, ['rev-parse', 'main'])).toBe(obs.baseBefore);
    }, 60_000);
  }

  it('retains bounded failure recovery for a packet with no newer stop', async () => {
    const packetId = 'pkt-stop-race-control';
    const { lane } = await setupPacket(packetId, 1, 'queued');
    h.verify.mockResolvedValue({ ok: false, kind: 'typecheck', output: FAILURE_OUTPUT, checks: [] });

    const result = await performWorktreeSideMerge(mergeInput(lane));

    expect.soft(result.ok).toBe(false);
    expect.soft(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
    expect.soft(getLaneEvents(lane.id, 200).some((event) => (
      event.verb === 'typecheck_escalation'
      && typeof event.payload.output === 'string'
      && event.payload.output.includes(FAILURE_OUTPUT)
    ))).toBe(true);
    expect.soft(h.rerunWithFeedback).not.toHaveBeenCalled();
  }, 60_000);

  it('keeps a Stop that lands during rerun dispatch and does not reopen the lane on a late rejection', async () => {
    const packetId = 'pkt-stop-race-dispatch-reject';
    const { lane } = await setupPacket(packetId, 0, 'queued');
    h.verify.mockResolvedValue({ ok: false, kind: 'typecheck', output: FAILURE_OUTPUT, checks: [] });

    let signalDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { signalDispatch = resolve; });
    let settleRerun: ((error?: Error) => void) | undefined;
    h.rerunWithFeedback.mockImplementation(() => new Promise<void>((resolve, reject) => {
      settleRerun = (error?: Error) => { if (error) reject(error); else resolve(); };
      signalDispatch();
    }));

    let result: LaneCommandResult | undefined;
    let stopOk: boolean | undefined;
    let dispatchFailure: ReturnType<typeof getLaneEvents>[number] | undefined;
    let mergeError: unknown;
    try {
      result = await performWorktreeSideMerge(mergeInput(lane));
      await dispatchStarted;
      stopOk = (await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' })).ok;
      settleRerun?.(new Error('late rerun rejection'));
    } catch (error) {
      mergeError = error;
    } finally {
      // Settle the detached rerun continuation on every path so it can never
      // outlive the fixture, then wait for its diagnostic before afterEach
      // deletes the owned state.
      settleRerun?.(new Error('fixture teardown'));
      dispatchFailure = await waitForLaneEvent(lane.id, (event) => (
        typeof event.payload.dispatchError === 'string'
      )).catch(() => undefined);
    }
    if (mergeError) throw mergeError;

    expect.soft(result?.ok).toBe(false);
    expect.soft(stopOk).toBe(true);
    expect.soft(dispatchFailure?.payload.reason).toBe('rerun_dispatch_failed_after_stop');
    expect.soft(h.rerunWithFeedback).toHaveBeenCalledTimes(1);
    expect.soft(h.rerunWithFeedback).toHaveBeenCalledWith(expect.objectContaining({ preserveOperatorStop: true }));
    expect.soft(getLane(lane.id)?.status).toBe('paused');
    expect.soft(getLane(lane.id)?.lastEventLabel).toBe('operator_stopped');
    expect.soft(readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId)?.operatorStopped).toBe(true);
  }, 60_000);

  it('withholds recovery and preserves the stopped state when the stop read fails', async () => {
    const packetId = 'pkt-stop-race-unreadable';
    let obs: Awaited<ReturnType<typeof runStoppedInterleaving>> | undefined;
    try {
      // Real Stop persists first; only then does a narrow injected read fault
      // make the durable stop state unreadable for the late failure.
      obs = await runStoppedInterleaving(packetId, 0, () => { h.stopStateReadFault = true; });
    } finally {
      h.stopStateReadFault = false;
    }
    if (!obs) throw new Error('stop interleaving did not complete');

    expect.soft(obs.mergeResult?.ok).toBe(false);
    expect.soft(obs.mergeResult?.reason).toBe('operator_stop_state_unavailable');
    expect.soft(obs.mergeResult?.note ?? '').not.toContain('Auto-rerun dispatched');
    expect.soft(obs.laneAfter?.status).toBe('paused');
    expect.soft(obs.laneAfter?.lastEventLabel).toBe('operator_stopped');
    expect.soft(obs.packet?.operatorStopped).toBe(true);
    expect.soft(obs.packet?.queueState).toBe('held');
    expect.soft(obs.packet?.blockedReason).toBe('operator_stopped');
    expect.soft(obs.packet?.typecheckAutoRetries).toBe(0);
    expect.soft(obs.reviewAfter?.id).toBe(obs.reviewBefore?.id);
    expect.soft(obs.reviewAfter?.status).toBe('approved');
    expect.soft(obs.reviewAfter?.args?.reviewSuperseded).not.toBe(true);
    expect.soft(h.rerunWithFeedback).not.toHaveBeenCalled();
    expect.soft(obs.events.some((event) => (
      event.payload.reason === 'operator_stop_state_unavailable'
      && typeof event.payload.output === 'string'
      && event.payload.output.includes(FAILURE_OUTPUT)
    ))).toBe(true);
    expect.soft(git(obs.worktree.path, ['rev-parse', 'HEAD'])).toBe(obs.headBefore);
    expect.soft(git(obs.repo, ['rev-parse', 'main'])).toBe(obs.baseBefore);
  }, 60_000);
});
