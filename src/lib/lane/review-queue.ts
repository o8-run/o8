import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from '@/lib/lane/events';
import type { Lane } from '@/lib/lane/types';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  settleSupersededReviewAttempts,
} from './review-attempt-head';
import { REVIEW_CONCURRENCY_LIMIT } from './review-concurrency';
import { notifyCorrectnessReviewQueued } from './packet-explainer-queue';
import { assertCorrectionReviewOwner, bindCorrectionReview, CorrectionReviewBlocked, prepareCorrectionReview, settledCorrectionReplay } from '@/lib/orchestrator/correction-review';
import { getLane } from './registry';
import { surfaceReviewQueueBlocker } from './review-queue-blocker';

export { surfaceReviewQueueBlocker } from './review-queue-blocker';

/** Repair a lost enqueue acknowledgement or a completion that beat delivery's
 * receipt write. Reuse the normal drain, without retrying the author's turn. */
export function recoverCorrectionReviewEnqueues(): void {
  const rows = getSqlite().prepare(`SELECT c.correction_id, c.lane_id FROM correction_reviews c
    JOIN lanes l ON l.id = c.lane_id AND l.status = 'reviewing'
    WHERE c.review_id IS NULL AND EXISTS (SELECT 1 FROM worker_correction_deliveries d
      WHERE d.correction_id = c.correction_id AND d.status = 'delivered')
    AND NOT EXISTS (SELECT 1 FROM correction_reviews newer WHERE newer.packet_id = c.packet_id AND newer.rowid > c.rowid)
    ORDER BY c.created_at LIMIT 64`).all() as Array<{ correction_id: string; lane_id: string }>;
  for (const row of rows) {
    const lane = getLane(row.lane_id);
    if (lane?.status !== 'reviewing') continue;
    try { enqueueLaneReview(lane); }
    catch (error) {
      surfaceReviewQueueBlocker({ laneId: lane.id, reviewId: `correction:${row.correction_id}`, attempts: 0,
        reason: error instanceof Error ? error.message : 'Correction re-review could not be queued.' });
    }
  }
}

interface ActiveQueuedReview {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface EnqueueLaneReviewOptions {
  /** Explicit request_review after inspection may replace a terminal attempt. */
  retryCorrection?: boolean;
  /**
   * A review already running may be locked to the previous HEAD. Leave one
   * pending successor behind so the current-head approval gets its own turn.
   */
  afterInProgress?: boolean;
  /**
   * Worktree HEAD this enqueue is for. Read from the lane when omitted; pass it
   * explicitly when the caller already resolved it (or in tests with no git).
   */
  headSha?: string;
}

export interface EnqueueLaneReviewResult {
  reviewId: string;
  queued: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Attempts settled as superseded because they were pinned to an older HEAD. */
  supersededAttempts: number;
}

/**
 * The single chokepoint every review enqueue passes through.
 *
 * It resolves the lane's CURRENT HEAD first and settles any active attempt
 * pinned to a different commit. Without that step a steer that landed a
 * successor commit left the old attempt occupying the lane's one active-row
 * slot: this function answered "Review already in progress" forever, the
 * successor HEAD never got a turn, and the stall reconciler skipped the lane
 * because the dead row still counted as live (#1844 / #1856 recurrence).
 */
export function enqueueLaneReview(
  lane: Lane,
  options: EnqueueLaneReviewOptions = {},
): EnqueueLaneReviewResult {
  // Optional explainers yield before any correctness claim is inspected or
  // created. Existing pending/in-progress reviews deserve the same priority as
  // a brand-new row.
  notifyCorrectnessReviewQueued();
  const db = getSqlite();
  const currentHeadSha = normalizeAttemptHeadSha(options.headSha) ?? laneReviewHeadSha(lane);
  const replay = settledCorrectionReplay(lane, currentHeadSha);
  if (replay) return { reviewId: replay.review_id!, queued: false, status: 'completed', supersededAttempts: 0 };
  const correction = prepareCorrectionReview(lane, currentHeadSha);
  const supersededAttempts = settleSupersededReviewAttempts({
    lane,
    currentHeadSha,
    reason: 'HEAD moved past the commit this review was claimed for',
  });

  return db.transaction((): EnqueueLaneReviewResult => {
    // Recheck durable ownership after Git, then create and associate one queue row
    // atomically. A restart can never leave a generic review without its findings.
    if (correction) {
      assertCorrectionReviewOwner(lane, correction);
      const linked = db.prepare(`SELECT q.id, q.status FROM correction_reviews c
        JOIN review_queue q ON q.id = c.review_id WHERE c.correction_id = ?`).get(correction.correction_id) as ActiveQueuedReview | undefined;
      if (linked) {
        if (linked.status === 'pending' || linked.status === 'in_progress') return { reviewId: linked.id, queued: false, status: linked.status, supersededAttempts };
        if (!options.retryCorrection) throw new CorrectionReviewBlocked('Correction review needs inspection. Once the hold is cleared, explicitly request review to create a fresh attempt.');
      }
    }

    const active = db.prepare(
      `SELECT id, status FROM review_queue
       WHERE lane_id = ? AND status IN ('pending', 'in_progress')
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at ASC`,
    ).all(lane.id) as ActiveQueuedReview[];
    const pending = active.find((review) => review.status === 'pending');
    if (pending) {
      if (correction) bindCorrectionReview(correction, pending.id);
      console.log(`[auto-review] Review already queued for lane ${lane.id}`);
      return { reviewId: pending.id, queued: false, status: 'pending', supersededAttempts };
    }
    const inProgress = active.find((review) => review.status === 'in_progress');
    if (inProgress && !options.afterInProgress) {
      if (correction) throw new Error('A prior reviewer is still active. Wait for its claim to settle before re-reviewing the correction.');
      console.log(`[auto-review] Review already in progress for lane ${lane.id}`);
      return { reviewId: inProgress.id, queued: false, status: 'in_progress', supersededAttempts };
    }

    const reviewId = `review-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, datetime('now'), datetime('now'))`,
    ).run(reviewId, lane.id, lane.repoPath, currentHeadSha ?? null);
    if (correction) bindCorrectionReview(correction, reviewId);

    const queued = db.prepare(
      `SELECT COUNT(*) AS count FROM review_queue
       WHERE status IN ('pending', 'in_progress')`,
    ).get() as { count: number };
    recordLaneEvent(lane.id, 'review_queued', 'system', {
      packetId: lane.packetId ?? null,
      reviewId,
      state: 'queued',
      queueDepth: queued.count,
      concurrencyLimit: REVIEW_CONCURRENCY_LIMIT,
      ...(correction ? { correctionId: correction.correction_id, originalApprovalId: JSON.parse(correction.source_json).approvalId,
        authorRunId: correction.run_id, correctedHeadSha: correction.head_sha, previousReviewId: correction.review_id } : {}),
    });

    console.log(`[auto-review] Enqueued review ${reviewId} for lane ${lane.id} (${lane.label})`);
    return { reviewId, queued: true, status: 'pending' as const, supersededAttempts };
  })();
}
