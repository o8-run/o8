/**
 * Real-path regressions for #1856 — the two silent-park review transitions.
 *
 * Both drive the PRODUCTION queue/drain path (`drainReviewQueue`) and the
 * production reconciler (`reconcileReviewStalls`) against persisted rows, not
 * the guards in isolation:
 *
 *   1. A second pass that agreed must leave a durable merge-attempt receipt,
 *      and a missed dispatch must be recovered on the way in.
 *   2. Cancelling one review must not suppress a successor review on the same
 *      lane, and every claimed queue row must end with a turn receipt or an
 *      explicit skip/failure receipt.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mergeResult: { ok: true, laneId: '', note: 'merged' } as {
    ok: boolean;
    laneId: string;
    note: string;
    approvalId?: string;
    reason?: string;
  },
  settleSuccessfulDispatch: true,
  dispatch: vi.fn(),
  reviewerCalls: [] as Array<{ laneId: string; threadId: string; surface: string }>,
}));

vi.mock('@/lib/lane/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/commands')>();
  h.dispatch.mockImplementation(async (command: { laneId: string }) => {
    const result = { ...h.mergeResult, laneId: command.laneId };
    if (result.ok && h.settleSuccessfulDispatch) {
      const { setLaneStatus } = await import('@/lib/lane/registry');
      setLaneStatus(command.laneId, 'completed', 'system', 'merged');
    }
    return result;
  });
  return { ...actual, dispatch: h.dispatch };
});

vi.mock('@/lib/lane/review-quota-fallback', async () => {
  const { finishReviewTurn, startReviewTurn } = await import('@/lib/lane/review-turn-state');
  return {
    runReviewerTurnWithQuotaFallback: vi.fn(async (input: {
      laneId: string;
      threadId: string;
      surface: string;
      backend?: string;
    }) => {
      h.reviewerCalls.push({
        laneId: input.laneId,
        threadId: input.threadId,
        surface: input.surface,
      });
      const reviewTurnId = startReviewTurn({
        laneId: input.laneId,
        threadId: input.threadId,
        backend: 'claude',
        surface: input.surface,
      });
      finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome: 'completed' });
      return {
        ok: true,
        backend: 'claude' as const,
        text: 'Reviewed. No blocking findings.',
        errors: [] as string[],
        fallback: null,
        reviewTurnId,
      };
    }),
  };
});

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-data-'));
const repoDirs: string[] = [];
writeFileSync(join(dataDir, 'ws-token'), 'review-stall-ws-token-0123456789ab\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const {
  createApproval,
  getApproval,
  markSecondPassAgreed,
  resolveApproval,
} = await import('@/lib/approvals/store');
const { STALE_APPROVAL_EXPIRY_NOTE } = await import('@/lib/approvals/expiry');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { cancelAutoReviewForLane, isReviewAttemptCancelled } = await import('@/lib/lane/review-cancellation');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { enqueueLaneReview } = await import('@/lib/lane/review-queue');
const { reconcileReviewStalls } = await import('@/lib/lane/review-stall-reconcile');
const { rearmPendingSecondPassApproval } = await import('@/lib/lane/blind-second-pass-review');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absolutePath = join(repoDir, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repoDir, ['add', '--', path]);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function createRepo(): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-repo-'));
  repoDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  return repoDir;
}

/**
 * The high-risk classifier keys on `db` paths, so a review on this file is the
 * shape that requires a blind second pass — the state the defect parks in.
 */
function commitHighRiskChange(repoDir: string, slug: string): string {
  return commitFile(
    repoDir,
    `src/lib/db/${slug}-fixture.ts`,
    `export const ${slug.replace(/-/g, '')}Fixture = true;\n`,
    'high-risk change',
  );
}

function laneEventVerbs(laneId: string): string[] {
  return getLaneEvents(laneId, 200).map((event) => event.verb);
}

function eventsWithVerb(laneId: string, verb: string) {
  return getLaneEvents(laneId, 200).filter((event) => event.verb === verb);
}

/**
 * The drain claims the globally-oldest pending row per tick, so a test that
 * wants a specific row processed must tick until that row settles. Bounded,
 * and it is still the production drain doing the claiming.
 */
async function drainUntilSettled(reviewId: string, maxTicks = 8): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const row = getSqlite().prepare(
      'SELECT status FROM review_queue WHERE id = ?',
    ).get(reviewId) as { status: string } | undefined;
    if (row && row.status !== 'pending' && row.status !== 'in_progress') return;
    await drainReviewQueue();
  }
}

function queueRows(laneId: string) {
  return getSqlite().prepare(
    'SELECT id, status, attempts, last_error FROM review_queue WHERE lane_id = ? ORDER BY created_at ASC',
  ).all(laneId) as Array<{ id: string; status: string; attempts: number; last_error: string | null }>;
}

/**
 * The ledger invariant from the root-cause addendum: a claimed row may never
 * reach `completed` with attempts=0 / last_error=NULL and no event behind it.
 * A turn receipt is linked by the review id embedded in the turn thread id.
 */
function assertEveryTerminalRowCarriesAReceipt(laneId: string): void {
  const turnThreadIds = eventsWithVerb(laneId, 'review_turn_started')
    .map((event) => String(event.payload.threadId ?? ''));
  const skipReviewIds = new Set(
    eventsWithVerb(laneId, 'review_skipped').map((event) => String(event.payload.reviewId ?? '')),
  );

  for (const row of queueRows(laneId)) {
    if (row.status !== 'completed' && row.status !== 'failed') continue;
    const hasTurn = turnThreadIds.some((threadId) => threadId.includes(row.id));
    const hasExplicitReceipt = skipReviewIds.has(row.id) || Boolean(row.last_error);
    expect(
      hasTurn || hasExplicitReceipt,
      `review_queue row ${row.id} ended '${row.status}' with no turn receipt and no skip/failure receipt`,
    ).toBe(true);
  }
}

async function approveHighRiskHead(input: {
  packetId: string;
  laneId: string;
  headSha: string;
}): Promise<string> {
  const review = await submitPacketReview({
    packetId: input.packetId,
    findings: [],
    approved: true,
    reviewedHeadSha: input.headSha,
  });
  const approvalId = review.auditApprovalId;
  if (!approvalId) throw new Error('review did not persist an approval receipt');
  expect(getApproval(approvalId)?.args?.requiresSecondPass).toBe(true);
  return approvalId;
}

beforeEach(() => {
  // These cases exercise automatic direct integration after operator opt-in.
  getSqlite().prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('project-merge-mode:default', 'direct', Date.now());
  h.dispatch.mockClear();
  h.reviewerCalls.length = 0;
  h.mergeResult = { ok: true, laneId: '', note: 'merged' };
  h.settleSuccessfulDispatch = true;
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  for (const repoDir of repoDirs) rmSync(repoDir, { recursive: true, force: true });
});

describe('missed merge dispatch after second-pass agreement (#1856)', () => {
  it('recovers an authorized current HEAD whose merge was never dispatched, through the drain', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/missed-merge']);
    const packetId = 'pkt-missed-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/missed-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'missed merge fixture',
      packetId,
      sessionKey: 'test-runtime:missed-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'missed-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });

    // The exact observed state: agreement persisted, the dispatch on the next
    // line left no trace at all.
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE lane_id = ?",
    ).run(lane.id);

    const authorized = await assessDurableApprovedReview(getLane(lane.id)!);
    expect(authorized.approved).toBe(true);
    expect(authorized.approvalId).toBe(approvalId);
    expect(laneEventVerbs(lane.id)).not.toContain('merge');
    expect(laneEventVerbs(lane.id)).not.toContain('merge_dispatch_attempted');

    // Production drain tick — reconciliation runs on the way in.
    await drainReviewQueue();

    const attempts = eventsWithVerb(lane.id, 'merge_dispatch_attempted');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.payload).toMatchObject({
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'stall_reconcile',
    });
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'merge', laneId: lane.id }),
    );
    expect(eventsWithVerb(lane.id, 'merge_dispatch_succeeded')).toHaveLength(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(0);

    // Idempotent: the durable success receipt is the guard, so a second
    // reconcile must not re-dispatch the same authorization.
    h.dispatch.mockClear();
    await reconcileReviewStalls();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
  });

  it('reclaims a stale attempted-only dispatch after a process interruption', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/interrupted-merge']);
    const packetId = 'pkt-interrupted-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/interrupted-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'interrupted merge fixture',
      packetId,
      sessionKey: 'test-runtime:interrupted-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'interrupted-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);

    const interrupted = (await import('@/lib/lane/events')).recordLaneEvent(
      lane.id,
      'merge_dispatch_attempted',
      'system',
      {
        packetId,
        approvalId,
        reviewedHeadSha: headSha,
        trigger: 'second_pass_agreed',
        attemptId: 'merge-dispatch-interrupted',
        attempt: 1,
      },
    );
    getSqlite().prepare(
      'UPDATE lane_events SET timestamp = ? WHERE id = ?',
    ).run(new Date(Date.now() - 120_000).toISOString(), interrupted.id);

    await reconcileReviewStalls();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const attempts = eventsWithVerb(lane.id, 'merge_dispatch_attempted');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.payload).toMatchObject({ approvalId, attempt: 2 });
    expect(eventsWithVerb(lane.id, 'merge_dispatch_succeeded')).toHaveLength(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(0);
  });

  it('reissues a merge dispatch whose operator card expired under the stale TTL', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/expired-operator-card']);
    const packetId = 'pkt-expired-operator-card';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/expired-operator-card',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'expired operator card fixture',
      packetId,
      sessionKey: 'test-runtime:expired-operator-card',
    });
    const headSha = commitHighRiskChange(repoDir, 'expired-operator-card');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', last_error = 'fixture: second pass already settled' WHERE lane_id = ?",
    ).run(lane.id);
    const routed = createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'merge dispatcher',
      sessionKey: lane.sessionKey!,
      title: `Dispatcher review ${lane.id}`,
      description: 'Operator merge decision',
      summary: 'Operator merge decision',
      risk: 'high',
      policyRuleId: 'surface-dispatcher-review',
      args: {
        approvalRoute: 'dispatcher',
        dispatcherSurface: 'operator',
        dispatcherId: 'cli',
      },
      continuation: { kind: 'lane', laneId: lane.id, verb: 'merge' },
    });
    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(lane.id, 'merge_dispatch_attempted', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'second_pass_agreed',
      attemptId: 'merge-dispatch-expired-card',
      attempt: 1,
    });
    recordLaneEvent(lane.id, 'merge_dispatch_failed', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'second_pass_agreed',
      attemptId: 'merge-dispatch-expired-card',
      attempt: 1,
      reason: 'Merge routed to an operator card.',
      routedApprovalId: routed.id,
    });
    resolveApproval(routed.id, 'reject', 'system', STALE_APPROVAL_EXPIRY_NOTE);

    await reconcileReviewStalls();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const attempts = eventsWithVerb(lane.id, 'merge_dispatch_attempted');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.payload).toMatchObject({
      approvalId,
      attempt: 2,
      recoveredExpiredRoutedApprovalId: routed.id,
    });
    expect(eventsWithVerb(lane.id, 'merge_dispatch_succeeded')).toHaveLength(1);
  });

  it('does not reissue a merge card that the operator rejected', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/operator-rejected-card']);
    const packetId = 'pkt-operator-rejected-card';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/operator-rejected-card',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'operator rejected card fixture',
      packetId,
      sessionKey: 'test-runtime:operator-rejected-card',
    });
    const headSha = commitHighRiskChange(repoDir, 'operator-rejected-card');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', last_error = 'fixture: second pass already settled' WHERE lane_id = ?",
    ).run(lane.id);
    const routed = createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'merge dispatcher',
      sessionKey: lane.sessionKey!,
      title: `Rejected dispatcher review ${lane.id}`,
      description: 'Operator merge decision',
      summary: 'Operator merge decision',
      risk: 'high',
      policyRuleId: 'surface-dispatcher-review',
      args: {
        approvalRoute: 'dispatcher',
        dispatcherSurface: 'operator',
        dispatcherId: 'cli',
      },
      continuation: { kind: 'lane', laneId: lane.id, verb: 'merge' },
    });
    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(lane.id, 'merge_dispatch_attempted', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      attemptId: 'merge-dispatch-operator-rejected',
      attempt: 1,
    });
    recordLaneEvent(lane.id, 'merge_dispatch_failed', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      attemptId: 'merge-dispatch-operator-rejected',
      attempt: 1,
      reason: 'Merge routed to an operator card.',
      routedApprovalId: routed.id,
    });
    resolveApproval(routed.id, 'reject', 'desktop', 'Operator declined the merge.');

    await reconcileReviewStalls();

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_succeeded')).toHaveLength(0);
  });

  it.each([
    ['fetch_unreachable', 'the base branch fetch is temporarily unavailable'],
    ['typecheck_auto_retry', 'a fresh worker is repairing the post-rebase typecheck'],
  ] as const)('records %s as deferred recovery instead of a terminal blocker', async (reason, note) => {
    const repoDir = createRepo();
    const slug = reason.replace(/_/g, '-');
    git(repoDir, ['checkout', '-q', '-b', `inline/${slug}`]);
    const packetId = `pkt-${slug}`;
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: `inline/${slug}`,
      baseBranch: 'main',
      runtime: 'codex',
      label: `${slug} fixture`,
      packetId,
      sessionKey: `test-runtime:${slug}`,
    });
    const headSha = commitHighRiskChange(repoDir, slug);
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    h.mergeResult = { ok: false, laneId: lane.id, note, reason };

    await reconcileReviewStalls();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    const deferred = eventsWithVerb(lane.id, 'merge_dispatch_deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.payload).toMatchObject({ approvalId, attempt: 1, recovery: reason });
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(0);
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(0);
    expect(getLane(lane.id)?.status).toBe('reviewing');
  });

  it('retries a deferred fetch recovery after its lease, then settles success', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/deferred-fetch-retry']);
    const packetId = 'pkt-deferred-fetch-retry';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/deferred-fetch-retry',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'deferred fetch retry fixture',
      packetId,
      sessionKey: 'test-runtime:deferred-fetch-retry',
    });
    const headSha = commitHighRiskChange(repoDir, 'deferred-fetch-retry');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    h.mergeResult = {
      ok: false,
      laneId: lane.id,
      note: 'origin fetch unavailable',
      reason: 'fetch_unreachable',
    };

    await reconcileReviewStalls();
    await reconcileReviewStalls();
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    const deferred = eventsWithVerb(lane.id, 'merge_dispatch_deferred')[0]!;
    getSqlite().prepare(
      'UPDATE lane_events SET timestamp = ? WHERE id = ?',
    ).run(new Date(Date.now() - 120_000).toISOString(), deferred.id);
    h.mergeResult = { ok: true, laneId: lane.id, note: 'merged after fetch recovered' };

    await reconcileReviewStalls();

    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(2);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_succeeded')).toHaveLength(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(0);
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(0);
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it('rejects ok:true when dispatch produces no durable merge settlement', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/false-success']);
    const packetId = 'pkt-false-success';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/false-success',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'false success fixture',
      packetId,
      sessionKey: 'test-runtime:false-success',
    });
    const headSha = commitHighRiskChange(repoDir, 'false-success');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    h.settleSuccessfulDispatch = false;
    h.mergeResult.reason = 'fetch_unreachable';

    await reconcileReviewStalls();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    const failures = eventsWithVerb(lane.id, 'merge_dispatch_failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.reason)).toContain('remained reviewing with no merge receipt');
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it('repairs a crash between the failed-dispatch receipt and its blocker', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/failure-before-blocker']);
    const packetId = 'pkt-failure-before-blocker';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/failure-before-blocker',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'failure before blocker fixture',
      packetId,
      sessionKey: 'test-runtime:failure-before-blocker',
    });
    const headSha = commitHighRiskChange(repoDir, 'failure-before-blocker');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(lane.id, 'merge_dispatch_attempted', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'second_pass_agreed',
      attemptId: 'merge-dispatch-failed-before-blocker',
      attempt: 1,
    });
    recordLaneEvent(lane.id, 'merge_dispatch_failed', 'system', {
      packetId,
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'second_pass_agreed',
      attemptId: 'merge-dispatch-failed-before-blocker',
      attempt: 1,
      reason: 'dispatch failed before blocker persistence',
      routedApprovalId: null,
    });

    await reconcileReviewStalls();

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(1);
    const blockers = eventsWithVerb(lane.id, 'review_queue_blocked');
    expect(blockers).toHaveLength(1);
    expect(String(blockers[0]!.payload.reason)).toContain('failed before blocker persistence');
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it('surfaces a blocker instead of deferring merge recovery forever', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/exhausted-merge']);
    const packetId = 'pkt-exhausted-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/exhausted-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'exhausted merge fixture',
      packetId,
      sessionKey: 'test-runtime:exhausted-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'exhausted-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    const { recordLaneEvent } = await import('@/lib/lane/events');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const event = recordLaneEvent(lane.id, 'merge_dispatch_attempted', 'system', {
        packetId,
        approvalId,
        reviewedHeadSha: headSha,
        trigger: 'stall_reconcile',
        attemptId: `merge-dispatch-exhausted-${attempt}`,
        attempt,
      });
      getSqlite().prepare(
        'UPDATE lane_events SET timestamp = ? WHERE id = ?',
      ).run(new Date(Date.now() - 120_000).toISOString(), event.id);
      const deferred = recordLaneEvent(lane.id, 'merge_dispatch_deferred', 'system', {
        packetId,
        approvalId,
        reviewedHeadSha: headSha,
        trigger: 'stall_reconcile',
        attemptId: `merge-dispatch-exhausted-${attempt}`,
        attempt,
        recovery: 'fetch_unreachable',
      });
      getSqlite().prepare(
        'UPDATE lane_events SET timestamp = ? WHERE id = ?',
      ).run(new Date(Date.now() - 120_000).toISOString(), deferred.id);
    }

    await reconcileReviewStalls();

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(3);
    const failures = eventsWithVerb(lane.id, 'merge_dispatch_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({ approvalId, exhausted: true, attempts: 3 });
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it('leaves a durable failure receipt when the recovered dispatch does not merge', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/failed-merge']);
    const packetId = 'pkt-failed-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/failed-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'failed merge fixture',
      packetId,
      sessionKey: 'test-runtime:failed-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'failed-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE lane_id = ?",
    ).run(lane.id);

    h.mergeResult = { ok: false, laneId: lane.id, note: 'rebase conflict on main' };
    await reconcileReviewStalls();

    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    const failures = eventsWithVerb(lane.id, 'merge_dispatch_failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.reason)).toContain('rebase conflict on main');
    // Nothing parks silently: the lane leaves the live-looking reviewing state
    // and carries an operator-actionable blocker.
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });
});

describe('stale review cancellation must not suppress a successor (#1856)', () => {
  it('runs a successor review on a lane whose earlier review was cancelled', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/cancelled-successor']);
    const packetId = 'pkt-cancelled-successor';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/cancelled-successor',
      baseBranch: 'main',
      runtime: 'claude-code',
      label: 'cancelled successor fixture',
      packetId,
      sessionKey: 'test-runtime:cancelled-successor',
    });
    commitHighRiskChange(repoDir, 'cancelled-successor');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    // Attempt 1 is claimed, then cancelled mid-flight.
    const first = enqueueLaneReview(getLane(lane.id)!);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'in_progress' WHERE id = ?",
    ).run(first.reviewId);
    cancelAutoReviewForLane(lane.id, 'merged_by_ancestry');
    expect(isReviewAttemptCancelled(first.reviewId)).toBe(true);

    // A later current-HEAD approval re-arms a successor on the SAME lane.
    const headSha = git(repoDir, ['rev-parse', 'HEAD']);
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    const rearmed = await rearmPendingSecondPassApproval(getLane(lane.id)!, {
      approvalId,
      reviewedHeadSha: headSha,
    });
    expect(rearmed.scheduled).toBe(true);

    const successor = queueRows(lane.id).find((row) => row.status === 'pending');
    expect(successor, 'the successor review row should be pending').toBeDefined();
    expect(isReviewAttemptCancelled(successor!.id)).toBe(false);

    // Production drain — the successor must actually start.
    await drainUntilSettled(successor!.id);

    expect(h.reviewerCalls.some((call) => call.threadId.includes(successor!.id))).toBe(true);
    const started = eventsWithVerb(lane.id, 'review_turn_started');
    expect(started.length).toBeGreaterThan(0);
    expect(started.some((event) => String(event.payload.threadId ?? '').includes(successor!.id))).toBe(true);

    // And no row anywhere on this lane ended terminal without a receipt.
    assertEveryTerminalRowCarriesAReceipt(lane.id);
  });

  it('persists an explicit skip receipt when a claimed review never runs its turn', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/skipped-receipt']);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/skipped-receipt',
      baseBranch: 'main',
      runtime: 'claude-code',
      label: 'skipped receipt fixture',
      packetId: 'pkt-skipped-receipt',
      sessionKey: 'test-runtime:skipped-receipt',
    });
    commitHighRiskChange(repoDir, 'skipped-receipt');
    // Not reviewing — performAutoReview cannot run a turn for this row.
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');
    const queued = enqueueLaneReview(getLane(lane.id)!);

    await drainUntilSettled(queued.reviewId);

    const row = queueRows(lane.id).find((candidate) => candidate.id === queued.reviewId);
    expect(row?.status).toBe('completed');
    expect(row?.last_error).toContain('Skipped:');
    const skips = eventsWithVerb(lane.id, 'review_skipped');
    expect(skips).toHaveLength(1);
    expect(String(skips[0]!.payload.reason)).toContain('no longer reviewing');
    expect(h.reviewerCalls).toHaveLength(0);
    assertEveryTerminalRowCarriesAReceipt(lane.id);
  });
});


it('PR-first agreed review settles through drain and stall reconciliation without dispatch or retry', async () => {
  const repoDir = createRepo();
  git(repoDir, ['checkout', '-q', '-b', 'inline/pr-first-agreement']);
  const packetId = 'pkt-pr-first-agreement';
  const lane = createLane({ repoPath: repoDir, worktreePath: repoDir, branch: 'inline/pr-first-agreement', baseBranch: 'main', runtime: 'codex', packetId, projectId: 'pr-first-review-project' });
  const headSha = commitHighRiskChange(repoDir, 'pr-first-agreement');
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
  markSecondPassAgreed(approvalId);
  await drainReviewQueue();
  await reconcileReviewStalls();
  await reconcileReviewStalls();
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
  expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(1);
  expect(JSON.stringify(eventsWithVerb(lane.id, 'merge_dispatch_failed'))).toContain('Branch retained');
  expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
});
