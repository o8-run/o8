/**
 * Durable terminal writers for claimed auto-review queue rows.
 *
 * Every claimed row must end with a reviewer turn, an explicit skip receipt,
 * or a failure. A bare `completed` row with no receipt is never acceptable.
 *
 * Each writer is scoped to rows that are still active. A row already settled by
 * another path — supersession when HEAD drifted, reclamation of an abandoned
 * claim — keeps the receipt that explains it rather than having it overwritten
 * by whichever continuation happens to finish last.
 */

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { getLane } from './registry';
import { surfaceReviewQueueBlocker } from './review-queue-blocker';

export const MAX_REVIEW_ATTEMPTS = 5;

interface ClaimedReview {
  reviewId: string;
  claimOwner: string;
}

export function markReviewCompleted(input: ClaimedReview): boolean {
  const result = getSqlite().prepare(
    `UPDATE review_queue
     SET status = 'completed', last_error = NULL, claimed_at = NULL, claim_owner = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).run(input.reviewId, input.claimOwner);
  return result.changes === 1;
}

/** Persist why a claimed row ended without running a reviewer turn. */
export function markReviewSkipped(input: {
  reviewId: string;
  claimOwner: string;
  laneId: string;
  reason: string;
}): boolean {
  const result = getSqlite().prepare(
    `UPDATE review_queue
     SET status = 'completed', last_error = ?, claimed_at = NULL, claim_owner = NULL,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).run(`Skipped: ${input.reason}`, input.reviewId, input.claimOwner);
  if (result.changes !== 1) return false;

  const lane = getLane(input.laneId);
  recordLaneEvent(input.laneId, 'review_skipped', 'system', {
    packetId: lane?.packetId ?? null,
    reviewId: input.reviewId,
    reason: input.reason,
  });
  return true;
}

/** Put a claimed row back without spending the packet-failure budget. */
export function markReviewDeferred(input: {
  reviewId: string;
  claimOwner: string;
  laneId: string;
  reason: string;
}): boolean {
  const result = getSqlite().prepare(
    `UPDATE review_queue
     SET status = 'pending', last_error = ?, claimed_at = NULL, claim_owner = NULL,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).run(`Deferred: ${input.reason}`, input.reviewId, input.claimOwner);
  if (result.changes !== 1) return false;

  const lane = getLane(input.laneId);
  recordLaneEvent(input.laneId, 'review_deferred', 'system', {
    packetId: lane?.packetId ?? null,
    reviewId: input.reviewId,
    reason: input.reason,
  });
  return true;
}

export function markReviewFailed(
  input: ClaimedReview & { laneId: string; error: string; attempts: number; held?: boolean },
): boolean {
  const db = getSqlite();
  if (input.held || input.attempts >= MAX_REVIEW_ATTEMPTS) {
    const result = db.prepare(
      `UPDATE review_queue
       SET status = 'failed', last_error = ?, attempts = ?, claimed_at = NULL, claim_owner = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
    ).run(input.error, input.attempts, input.reviewId, input.claimOwner);
    if (result.changes !== 1) return false;
    surfaceReviewQueueBlocker({
      laneId: input.laneId,
      reviewId: input.reviewId,
      reason: input.error,
      attempts: input.attempts,
    });
    return true;
  } else {
    const result = db.prepare(
      `UPDATE review_queue
       SET status = 'pending', last_error = ?, attempts = ?, claimed_at = NULL, claim_owner = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
    ).run(input.error, input.attempts, input.reviewId, input.claimOwner);
    return result.changes === 1;
  }
}
