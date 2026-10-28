/**
 * Real-path regressions for the steered-review settlement race (#1844 / #1856).
 *
 * The live recurrence on v0.1.706: a same-session steer produced a successor
 * commit while an auto-review attempt was claimed. The claimed `review_queue`
 * row stayed `in_progress` with no receipt, every later enqueue answered
 * "Review already in progress", the stall reconciler skipped the lane because
 * the dead row still counted as live, and the packet read `released` with its
 * commits nowhere on `main`.
 *
 * Each test drives a production entry point against persisted state:
 *   - the real enqueue chokepoint + the real drain claim, on a real git repo;
 *   - the real restart path (`startReviewQueueDrain`);
 *   - the real merge gate (`assessDurableApprovedReview`);
 *   - the real control-plane write (`withLockedState`), which is where release
 *     truth was being derived.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorLaneBinding, OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  /** Resolvers for reviewer turns the test wants to hold open mid-flight. */
  heldTurns: [] as Array<() => void>,
  holdNextTurn: false,
  busyTurnsRemaining: 0,
  reviewedThreadIds: [] as string[],
}));

vi.mock('@/lib/lane/review-quota-fallback', async () => {
  const { finishReviewTurn, startReviewTurn } = await import('@/lib/lane/review-turn-state');
  return {
    runReviewerTurnWithQuotaFallback: vi.fn(async (input: {
      laneId: string;
      threadId: string;
      surface: string;
      expectedHeadSha?: string | null;
    }) => {
      h.reviewedThreadIds.push(input.threadId);
      if (h.busyTurnsRemaining > 0) {
        h.busyTurnsRemaining -= 1;
        return {
          ok: false,
          backend: 'codex' as const,
          text: '',
          errors: ['Codex session busy'],
          fallback: null,
          reviewTurnId: null,
          unavailableReason: 'session_busy' as const,
        };
      }
      if (h.holdNextTurn) {
        h.holdNextTurn = false;
        // The live shape: the process that claimed the row is still inside the
        // reviewer turn when the steer lands, so nothing settles the claim.
        await new Promise<void>((resolve) => { h.heldTurns.push(resolve); });
      }
      const reviewTurnId = startReviewTurn({
        laneId: input.laneId,
        threadId: input.threadId,
        backend: 'claude',
        surface: input.surface,
        expectedHeadSha: input.expectedHeadSha,
      });
      finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome: 'completed' });
      return {
        ok: true,
        backend: 'claude' as const,
        text: 'Reviewed. No blocking findings.',
        errors: [] as string[],
        fallback: null,
        reviewTurnId,
        unavailableReason: null,
      };
    }),
  };
});

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
// These fixtures own Git and review state, not installed runtime discovery.
// A host inventory probe can outlive the held-turn assertion and contaminate
// the next test's serialized review slot.
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [], runtimes: [] })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-settlement-data-'));
writeFileSync(join(dataDir, 'ws-token'), 'steer-settlement-ws-token-0123456789\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const repoDirs: string[] = [];
const heldDrains: Promise<void>[] = [];
// Drains took up to 5.2 s under load: allow 10 s per wait and 60 s for seven contention drains.
const reviewWaitTimeout = 10_000;
const contentionTestTimeout = 60_000;

const { closeDb, getSqlite } = await import('@/lib/db');
const { drainReviewQueue, startReviewQueueDrain, triggerAutoReview } = await import('@/lib/lane/auto-review');
const { reclaimAbandonedReviewAttempts } = await import('@/lib/lane/review-attempt-head');
const { runReviewRecoveryPass } = await import('@/lib/lane/review-drain-recovery');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { enqueueLaneReview } = await import('@/lib/lane/review-queue');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');
const { finishReviewTurn, startReviewTurn } = await import('@/lib/lane/review-turn-state');
const { readOrchestratorControlPlaneState, withLockedState, writeOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
const { packetTerminalState } = await import('@/lib/orchestrator/packet-state');

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absolutePath = join(repoDir, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repoDir, ['add', '--', path]);
  git(repoDir, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function createRepo(branch: string): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-settlement-repo-'));
  repoDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  git(repoDir, ['checkout', '-q', '-b', branch]);
  return repoDir;
}

function createRepoWithPacketWorktree(branch: string): {
  repoDir: string;
  worktreeDir: string;
  mainHead: string;
} {
  const rootDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-settlement-isolated-'));
  repoDirs.push(rootDir);
  const repoDir = join(rootDir, 'repo');
  const worktreeDir = join(rootDir, 'packet');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  const mainHead = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['branch', branch]);
  git(repoDir, ['worktree', 'add', '-q', worktreeDir, branch]);
  return { repoDir, worktreeDir, mainHead };
}

/** The high-risk classifier keys on `db` paths, so this is the blind-second-pass shape. */
function commitHighRiskChange(repoDir: string, slug: string): string {
  return commitFile(
    repoDir,
    `src/lib/db/${slug}-fixture.ts`,
    `export const ${slug.replace(/-/g, '')}Fixture = ${Date.now()};\n`,
    'high-risk change',
  );
}

function queueRows(laneId: string) {
  return getSqlite().prepare(
    'SELECT id, status, attempts, head_sha, last_error, claimed_at, claim_owner FROM review_queue WHERE lane_id = ? ORDER BY created_at ASC',
  ).all(laneId) as Array<{
    id: string;
    status: string;
    attempts: number;
    head_sha: string | null;
    last_error: string | null;
    claimed_at: string | null;
    claim_owner: string | null;
  }>;
}

function eventsWithVerb(laneId: string, verb: string) {
  return getLaneEvents(laneId, 300).filter((event) => event.verb === verb);
}

function packetFixture(repoPath: string, packetId: string, laneId: string, branch: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId,
    title: packetId,
    summary: packetId,
    workspaceTargetPath: repoPath,
    branchTarget: branch,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'awaiting_review',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: {
      tileId: laneId,
      tabId: laneId,
      repoPath,
      worktreePath: repoPath,
      runtime: 'codex',
      laneId,
      sessionKey: `codex-owned:${laneId}`,
    } satisfies OrchestratorLaneBinding,
  };
}

/** Settle any turn this test is holding open so the suite cannot leak a pending promise. */
function releaseHeldTurns(): void {
  while (h.heldTurns.length > 0) h.heldTurns.pop()!();
}

afterEach(async () => {
  h.holdNextTurn = false;
  releaseHeldTurns();
  await Promise.all(heldDrains.splice(0));
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  for (const repoDir of repoDirs) rmSync(repoDir, { recursive: true, force: true });
});

describe('steer during an in-progress review, followed by a successor commit (#1844)', () => {
  it('settles the old attempt, re-arms the successor HEAD, and keeps recovery running while the old turn hangs', async () => {
    const branch = 'inline/steer-settlement';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'steer settlement fixture',
      packetId: 'pkt-steer-settlement',
      sessionKey: 'codex-owned:steer-settlement',
    });
    const oldHead = commitHighRiskChange(repoDir, 'steer-settlement');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    // Real enqueue chokepoint: the row is keyed to the HEAD it will review.
    const first = enqueueLaneReview(getLane(lane.id)!);
    expect(first.queued).toBe(true);
    expect(queueRows(lane.id)[0]).toMatchObject({ id: first.reviewId, head_sha: oldHead });

    // Real drain claim; the reviewer turn is held open, so the claim never settles.
    h.holdNextTurn = true;
    const hungDrain = drainReviewQueue();
    heldDrains.push(hungDrain);
    await vi.waitFor(() => {
      expect(queueRows(lane.id)[0]!.status).toBe('in_progress');
      expect(h.heldTurns).toHaveLength(1);
    }, { timeout: reviewWaitTimeout });
    expect(queueRows(lane.id)[0]!.claimed_at).toBeTruthy();

    // The steer lands its successor commit while that attempt is still claimed.
    const successorHead = commitHighRiskChange(repoDir, 'steer-settlement-successor');
    expect(successorHead).not.toBe(oldHead);

    // The steered lane goes back to reviewing and re-enters through the real
    // trigger the review route uses.
    triggerAutoReview(getLane(lane.id)!);

    // 1. The old attempt reached a durable terminal receipt.
    const rows = queueRows(lane.id);
    const stale = rows.find((row) => row.id === first.reviewId)!;
    expect(stale.status).toBe('completed');
    expect(stale.last_error).toContain('Superseded');
    expect(stale.last_error).toContain(oldHead);
    const superseded = eventsWithVerb(lane.id, 'review_superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({
      reviewId: first.reviewId,
      reviewedHeadSha: oldHead,
      currentHeadSha: successorHead,
      previousStatus: 'in_progress',
    });

    // 2. The successor HEAD has its own independent, current-HEAD attempt.
    const successorRow = rows.find((row) => row.id !== first.reviewId);
    expect(successorRow).toBeDefined();
    expect(successorRow).toMatchObject({ status: 'pending', head_sha: successorHead });

    // 3. The replacement runs while the first backend promise is STILL hung.
    //    Recording recovery is insufficient if an in-memory boolean keeps the
    //    reviewer slot pinned until that promise returns.
    await expect(drainReviewQueue()).resolves.toBeUndefined();
    expect(h.heldTurns).toHaveLength(1);
    expect(h.reviewedThreadIds.some((threadId) => threadId.includes(successorRow!.id))).toBe(true);
    expect(queueRows(lane.id).find((row) => row.id === successorRow!.id)!.status).not.toBe('pending');

    // 4. The old continuation cannot overwrite the successor when it wakes.
    releaseHeldTurns();
    await hungDrain;
    expect(queueRows(lane.id).find((row) => row.id === first.reviewId)).toMatchObject({
      status: 'completed',
      last_error: expect.stringContaining('Superseded'),
    });
  });

  it('retries a reclaimed row under a new claim generation while its old call remains hung', async () => {
    const branch = 'inline/reclaimed-generation';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'reclaimed generation fixture',
      packetId: 'pkt-reclaimed-generation',
      sessionKey: 'codex-owned:reclaimed-generation',
    });
    commitHighRiskChange(repoDir, 'reclaimed-generation');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const queued = enqueueLaneReview(getLane(lane.id)!);

    h.holdNextTurn = true;
    const hungDrain = drainReviewQueue();
    heldDrains.push(hungDrain);
    await vi.waitFor(() => {
      expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)?.status).toBe('in_progress');
      expect(h.heldTurns).toHaveLength(1);
    }, { timeout: reviewWaitTimeout });
    const oldClaimOwner = queueRows(lane.id).find((row) => row.id === queued.reviewId)?.claim_owner;
    expect(oldClaimOwner).toBeTruthy();

    expect(reclaimAbandonedReviewAttempts({ leaseMs: 0 })).toBe(1);
    expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      claim_owner: null,
    });

    await drainReviewQueue();
    expect(h.heldTurns).toHaveLength(1);
    expect(h.reviewedThreadIds.filter((threadId) => threadId.includes(queued.reviewId))).toHaveLength(2);
    expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)?.status).toBe('completed');

    releaseHeldTurns();
    await hungDrain;
    expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)?.status).toBe('completed');
  });

  it('reclaims a claim stranded by a dead process on restart, with a durable receipt', async () => {
    const branch = 'inline/steer-stranded';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'stranded claim fixture',
      packetId: 'pkt-steer-stranded',
      sessionKey: 'codex-owned:steer-stranded',
    });
    const headSha = commitHighRiskChange(repoDir, 'steer-stranded');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    // Real enqueue, then the exact persisted shape the live incident left: a
    // row claimed by a process that is gone, with no receipt of any kind.
    const queued = enqueueLaneReview(getLane(lane.id)!);
    getSqlite().prepare(
      `UPDATE review_queue
       SET status = 'in_progress', head_sha = ?, claimed_at = datetime('now', '-2 hours'), claim_owner = 'pid:999999'
       WHERE id = ?`,
    ).run(headSha, queued.reviewId);

    // The real restart path. Before the fix it flipped the row back to pending
    // with no trace that an attempt had ever been abandoned.
    const stop = startReviewQueueDrain();
    stop();

    const abandoned = eventsWithVerb(lane.id, 'review_attempt_abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.payload).toMatchObject({
      reviewId: queued.reviewId,
      claimOwner: 'pid:999999',
    });
    const row = queueRows(lane.id).find((entry) => entry.id === queued.reviewId)!;
    expect(row.status).toBe('pending');
    expect(row.last_error).toContain('never settled');
    expect(row.claimed_at).toBeNull();

    // Hygiene, synchronously before the restart drain's first async tick: the
    // reclaimed row is genuinely runnable now, and letting it run a full
    // reviewer turn against a torn-down fixture repo outlives the test.
    getSqlite().prepare(
      `UPDATE review_queue SET status = 'completed' WHERE id = ?`,
    ).run(queued.reviewId);
    await drainReviewQueue();
  });

  it('defers repeated reviewer contention without spending the terminal attempt budget', async () => {
    const branch = 'inline/reviewer-contention';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'reviewer contention fixture',
      packetId: 'pkt-reviewer-contention',
      sessionKey: 'codex-owned:reviewer-contention',
    });
    commitHighRiskChange(repoDir, 'reviewer-contention');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const queued = enqueueLaneReview(getLane(lane.id)!);

    h.busyTurnsRemaining = 6;
    try {
      for (let index = 0; index < 6; index += 1) {
        await drainReviewQueue();
        expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
        expect(getLane(lane.id)?.status).toBe('reviewing');
      }
    } finally {
      h.busyTurnsRemaining = 0;
    }

    expect(eventsWithVerb(lane.id, 'review_deferred')).toHaveLength(6);
    await drainReviewQueue();
    expect(queueRows(lane.id).find((row) => row.id === queued.reviewId)?.status).toBe('completed');
  }, contentionTestTimeout);

  it('repairs a legacy failed-busy row after its stale alarm escalated to a human', async () => {
    const branch = 'inline/legacy-busy-restart';
    const { repoDir, worktreeDir, mainHead } = createRepoWithPacketWorktree(branch);
    const packetHead = commitHighRiskChange(worktreeDir, 'legacy-busy-restart');
    expect(packetHead).not.toBe(mainHead);
    const packetId = 'pkt-legacy-busy-restart';
    const missionId = 'mission-legacy-busy-restart';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: worktreeDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'legacy busy restart fixture',
      packetId,
      sessionKey: 'codex-owned:legacy-busy-restart',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'review_queue_failed');

    getSqlite().prepare(
      `INSERT INTO review_queue (
         id, lane_id, repo_path, status, attempts, last_error, head_sha, created_at, updated_at
       ) VALUES (?, ?, ?, 'failed', 5, 'Review turn failed: Codex session busy', NULL,
         datetime('now', '-1 minute'), datetime('now'))`,
    ).run('review-legacy-busy', lane.id, repoDir);
    recordLaneEvent(lane.id, 'review_queue_blocked', 'system', {
      packetId,
      reviewId: 'review-legacy-busy',
      reason: 'Review turn failed: Codex session busy',
      attempts: 5,
    });
    recordLaneEvent(lane.id, 'wedge_timeout', 'system', {
      from: 'awaiting_orchestrator',
      to: 'awaiting_human',
      blockedReason: 'orchestrator_wedge_timeout',
      action: 'escalate_human',
    });
    setLaneStatus(lane.id, 'awaiting_human', 'system', 'orchestrator_wedge_timeout');

    const falseRelease = packetFixture(repoDir, packetId, lane.id, branch);
    falseRelease.status = 'released';
    falseRelease.releaseState = 'released';
    falseRelease.releaseStatePayload = null;
    falseRelease.lane = {
      ...falseRelease.lane!,
      repoPath: repoDir,
      worktreePath: worktreeDir,
    };
    const registryState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: repoDir,
      packets: [falseRelease],
    };
    const now = Date.now();
    getSqlite().prepare(
      `INSERT INTO missions (
         id, repo_path, runtime, prompt, summary, constraints, packet_meta_json,
         total_waves, created_at, updated_at, archived_at, mission_state_json
       ) VALUES (?, ?, 'codex', '', '', '', '[]', 1, ?, ?, ?, ?)`,
    ).run(missionId, repoDir, now, now, now, JSON.stringify(registryState));

    h.busyTurnsRemaining = 1;
    const stopDrain = startReviewQueueDrain();
    try {
      await vi.waitFor(() => {
        expect(eventsWithVerb(lane.id, 'review_transient_recovered')).toHaveLength(1);
        expect(eventsWithVerb(lane.id, 'review_transient_recovered')[0]?.payload).toMatchObject({
          releaseRepaired: true,
        });
        expect(queueRows(lane.id).find((row) => row.id === 'review-legacy-busy')?.status).toBe('pending');
      }, { timeout: reviewWaitTimeout });
    } finally {
      stopDrain();
      h.busyTurnsRemaining = 0;
    }

    expect(queueRows(lane.id).find((row) => row.id === 'review-legacy-busy')).toMatchObject({
      status: 'pending',
      attempts: 0,
      head_sha: packetHead,
    });
    expect(getLane(lane.id)?.status).toBe('reviewing');
    const repairedPacket = readMissionRegistryEntry(missionId, { includeArchived: true })
      ?.mission.packets.find((packet) => packet.id === packetId);
    expect(repairedPacket).toMatchObject({
      status: 'awaiting_review',
      queueState: 'queued',
      releaseState: 'pending',
      releaseStatePayload: null,
    });

    await drainReviewQueue();
    expect(queueRows(lane.id).find((row) => row.id === 'review-legacy-busy')?.status).toBe('completed');
  });

  it('repairs the v0.1.707 recovery that was skipped behind the stale human alarm', async () => {
    const branch = 'inline/interrupted-busy-recovery';
    const { repoDir, worktreeDir } = createRepoWithPacketWorktree(branch);
    const packetHead = commitHighRiskChange(worktreeDir, 'interrupted-busy-recovery');
    const packetId = 'pkt-interrupted-busy-recovery';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: worktreeDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'interrupted busy recovery fixture',
      packetId,
      sessionKey: 'codex-owned:interrupted-busy-recovery',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'review_queue_failed');

    getSqlite().prepare(
      `INSERT INTO review_queue (
         id, lane_id, repo_path, status, attempts, last_error, head_sha, created_at, updated_at
       ) VALUES (?, ?, ?, 'completed', 0,
         'Skipped: Lane is no longer reviewing (awaiting_human).', ?,
         datetime('now', '-1 minute'), datetime('now'))`,
    ).run('review-interrupted-busy', lane.id, repoDir, packetHead);
    recordLaneEvent(lane.id, 'review_queue_blocked', 'system', {
      packetId,
      reviewId: 'review-interrupted-busy',
      reason: 'Review turn failed: Codex session busy',
      attempts: 5,
    });
    recordLaneEvent(lane.id, 'wedge_timeout', 'system', {
      from: 'awaiting_orchestrator',
      to: 'awaiting_human',
      blockedReason: 'orchestrator_wedge_timeout',
      action: 'escalate_human',
    });
    setLaneStatus(lane.id, 'awaiting_human', 'system', 'orchestrator_wedge_timeout');
    recordLaneEvent(lane.id, 'review_transient_recovered', 'system', {
      packetId,
      reviewId: 'review-interrupted-busy',
      previousAttempts: 5,
      reason: 'Review turn failed: Codex session busy',
      currentHeadSha: packetHead,
      releaseRepaired: true,
    });
    recordLaneEvent(lane.id, 'review_skipped', 'system', {
      packetId,
      reviewId: 'review-interrupted-busy',
      reason: 'Lane is no longer reviewing (awaiting_human).',
    });

    await runReviewRecoveryPass();

    expect(queueRows(lane.id).find((row) => row.id === 'review-interrupted-busy')).toMatchObject({
      status: 'pending',
      attempts: 0,
      head_sha: packetHead,
    });
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(eventsWithVerb(lane.id, 'review_transient_recovered')).toHaveLength(2);

    h.busyTurnsRemaining = 1;
    await drainReviewQueue();
    expect(queueRows(lane.id).find((row) => row.id === 'review-interrupted-busy')?.status).toBe('pending');
    h.busyTurnsRemaining = 0;
    await drainReviewQueue();
    expect(queueRows(lane.id).find((row) => row.id === 'review-interrupted-busy')?.status).toBe('completed');
  });

  it('does not override a genuine human-owned lane without the review-failure lineage', async () => {
    const repoDir = createRepo('inline/genuine-human-review-hold');
    const lane = createLane({
      repoPath: repoDir,
      branch: 'inline/genuine-human-review-hold',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'genuine human review hold fixture',
      packetId: 'pkt-genuine-human-review-hold',
      sessionKey: 'codex-owned:genuine-human-review-hold',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    setLaneStatus(lane.id, 'awaiting_human', 'system', 'operator_question');
    getSqlite().prepare(
      `INSERT INTO review_queue (
         id, lane_id, repo_path, status, attempts, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, 'failed', 5, 'Review turn failed: Codex session busy',
         datetime('now', '-1 minute'), datetime('now'))`,
    ).run('review-genuine-human-hold', lane.id, repoDir);

    await runReviewRecoveryPass();

    expect(getLane(lane.id)?.status).toBe('awaiting_human');
    expect(queueRows(lane.id).find((row) => row.id === 'review-genuine-human-hold')?.status).toBe('failed');
    expect(eventsWithVerb(lane.id, 'review_transient_recovered')).toHaveLength(0);
  });
});

describe('release truth requires evidence (#1844 / #1856)', () => {
  it('rejects a tool verdict when its auto-review turn was pinned to the prior HEAD', async () => {
    const branch = 'inline/turn-head-drift';
    const repoDir = createRepo(branch);
    const packetId = 'pkt-turn-head-drift';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'turn head drift fixture',
      packetId,
      sessionKey: 'codex-owned:turn-head-drift',
    });
    const reviewedHead = commitHighRiskChange(repoDir, 'turn-head-drift');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const reviewTurnId = startReviewTurn({
      laneId: lane.id,
      threadId: 'auto-review-turn-head-drift',
      backend: 'claude',
      surface: 'auto-review',
      expectedHeadSha: reviewedHead,
    });
    const successorHead = commitHighRiskChange(repoDir, 'turn-head-drift-successor');

    const verdict = await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
    });
    expect(verdict).toMatchObject({
      recorded: false,
      auditApprovalId: null,
      ignoredReason: 'review_head_drift',
    });
    expect(eventsWithVerb(lane.id, 'review_head_drift_rejected')[0]?.payload).toMatchObject({
      expectedHeadSha: reviewedHead,
      currentHeadSha: successorHead,
    });
    await expect(assessDurableApprovedReview(getLane(lane.id)!)).resolves.toMatchObject({
      approved: false,
    });
    finishReviewTurn({ laneId: lane.id, reviewTurnId, outcome: 'completed' });
  });

  it('refuses a stale approval at the merge gate once HEAD moves', async () => {
    const branch = 'inline/steer-stale-approval';
    const repoDir = createRepo(branch);
    const packetId = 'pkt-steer-stale-approval';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'stale approval fixture',
      packetId,
      sessionKey: 'codex-owned:steer-stale-approval',
    });
    const reviewedHead = commitHighRiskChange(repoDir, 'steer-stale-approval');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const review = await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: reviewedHead,
    });
    expect(review.auditApprovalId).toBeTruthy();

    // A successor commit lands after the approval was recorded.
    const successorHead = commitHighRiskChange(repoDir, 'steer-stale-approval-successor');
    expect(successorHead).not.toBe(reviewedHead);

    const gate = await assessDurableApprovedReview(getLane(lane.id)!);
    expect(gate.approved).toBe(false);
    expect(gate.approvalId).toBeNull();
    expect(gate.reason).toBe(`Review pinned to ${reviewedHead} but current HEAD is ${successorHead}.`);
  });

  it('does not mint releaseState from a lane that merely completed', async () => {
    const branch = 'inline/steer-release-truth';
    const repoDir = createRepo(branch);
    const packetId = 'pkt-steer-release-truth';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'release truth fixture',
      packetId,
      sessionKey: 'codex-owned:steer-release-truth',
    });
    commitHighRiskChange(repoDir, 'steer-release-truth');

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      packets: [packetFixture(repoDir, packetId, lane.id, branch)],
    });

    // The live shape: the lane settles `completed` through a path that never
    // touched the base branch (worktree_missing_reconciled writes exactly this).
    setLaneStatus(lane.id, 'completed', 'system', 'worktree_missing_reconciled');

    // Real control-plane write — reconciliation runs inside it.
    await withLockedState(() => {});
    const derived = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId)!;
    expect(derived.status).toBe('awaiting_review');
    expect(derived.releaseState).toBe('pending');
    expect(derived.releaseStatePayload?.source ?? null).toBeNull();
    expect(packetTerminalState(derived)).toBeNull();

    // A detached payload is still not authority. Only the atomic evidence
    // writer may move the packet into the released state.
    await withLockedState((state) => {
      const packet = state.packets.find((entry) => entry.id === packetId);
      if (packet) {
        packet.releaseStatePayload = {
          mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          releasedAt: new Date().toISOString(),
          source: 'approve_and_merge',
          headSha: null,
          evidenceKind: 'merge_command',
        };
      }
    });
    const payloadOnly = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId)!;
    expect(payloadOnly.releaseState).toBe('pending');
    expect(packetTerminalState(payloadOnly)).toBeNull();

    const incompleteProof = packetFixture(repoDir, 'pkt-incomplete-proof', lane.id, branch);
    expect(() => markPacketReleased(incompleteProof, {
      source: 'approve_and_merge',
      evidenceKind: 'merge_command',
    })).toThrow('Release evidence from approve_and_merge is incomplete.');
    expect(incompleteProof.releaseState).toBe('pending');

    await withLockedState((state) => {
      const packet = state.packets.find((entry) => entry.id === packetId);
      if (packet) {
        markPacketReleased(packet, {
          source: 'approve_and_merge',
          mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          evidenceKind: 'merge_command',
        });
      }
    });
    const proved = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId)!;
    expect(proved.releaseState).toBe('released');
    expect(proved.releaseStatePayload?.source).toBe('approve_and_merge');
    expect(packetTerminalState(proved)).toBe('released');
  });
});
