import { nextFairReview, recordFairReviewClaim } from './review-scheduling';
/**
 * Review-queue claim + recovery, split out of `auto-review.ts`.
 *
 * These two run BEFORE any review does, and neither one depends on the review
 * execution below them — which is exactly why the recovery half must not sit
 * behind the drain's in-flight guard. A reviewer turn that never settles used
 * to pin that guard for the life of the process, disabling reclamation and
 * stall reconciliation along with it: the one hung attempt silently switched
 * off every path built to notice a hung attempt.
 */

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { LaneGitMetadataError } from './lane-git';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  reclaimAbandonedReviewAttempts,
  reviewAttemptOwnerId,
} from './review-attempt-head';
import { getLane, setLaneStatus } from './registry';
import { reconcileReviewStalls, reviewStallInputs } from './review-stall-reconcile';
import { isReviewerSessionBusyMessage } from './review-transient-failure';

/** Stall reconciliation is git-touching, so it runs on a slower cadence than the drain. */
const STALL_RECONCILE_INTERVAL_MS = 30_000;

let lastStallReconcileAt = 0;
/**
 * A stall pass reads lanes, lane events, the review queue, approvals and each
 * reviewing lane's HEAD, branch and base refs; with 4 reviewing lanes it cost
 * ~300 ms CPU and 36 git spawns every 30 s while nothing changed. Skip it while
 * those inputs match the ones read after the last pass.
 */
let lastStallInputs: string | null = null;

function getDb() {
  return getSqlite();
}

export interface QueuedReview {
  id: string;
  lane_id: string;
  repo_path: string;
  attempts: number;
  head_sha: string | null;
  claim_owner: string;
  updated_at?: string;
}

/**
 * Claim the next pending row, stamping the lease (`claimed_at` + `claim_owner`)
 * and the HEAD the attempt is pinned to. Both are what make an abandoned or
 * superseded claim recoverable without a process restart — a claim that only
 * the claiming process could settle is exactly how a row sat `in_progress`
 * forever while every later enqueue bounced off it.
 */
function unkeyedHeadSha(row: Pick<QueuedReview, 'lane_id' | 'repo_path'>): string | undefined {
  const lane = getLane(row.lane_id);
  try {
    return laneReviewHeadSha(lane ?? { worktreePath: null, repoPath: row.repo_path });
  } catch (error) {
    if (!(error instanceof LaneGitMetadataError)) throw error;
    console.warn(`[auto-review] Lane ${row.lane_id} Git metadata is not trusted; claiming its review unkeyed.`);
    return undefined;
  }
}

function claimNextReviewLocked(): QueuedReview | null {
  const db = getDb();
  const fairId = nextFairReview();
  if (fairId === null) return null;
  const row = fairId === undefined ? db.prepare(
    `SELECT id, lane_id, repo_path, attempts, head_sha, updated_at FROM review_queue
     WHERE status = 'pending' ORDER BY updated_at ASC, created_at ASC LIMIT 1`,
  ).get() as QueuedReview | undefined : db.prepare(
    `SELECT id, lane_id, repo_path, attempts, head_sha, updated_at FROM review_queue WHERE id = ? AND status = 'pending'`,
  ).get(fairId) as QueuedReview | undefined;

  if (!row) return null;

  // A row enqueued before v46 (or on a lane whose HEAD was unreadable then) is
  // keyed at claim time instead, so drift from here on is still detectable.
  // A keyed row needs no Git read, and a lane whose Git metadata cannot be
  // trusted stays unkeyed, so one broken lane cannot stop every later review.
  const headSha = normalizeAttemptHeadSha(row.head_sha) ?? unkeyedHeadSha(row) ?? null;

  const claimOwner = reviewAttemptOwnerId();
  const claimed = db.prepare(
    `UPDATE review_queue
     SET status = 'in_progress', head_sha = ?, claimed_at = datetime('now'), claim_owner = ?,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).run(headSha, claimOwner, row.id);
  if (claimed.changes !== 1) return null;

  recordFairReviewClaim(row);
  return { ...row, head_sha: headSha, claim_owner: claimOwner };
}

export function claimNextReview(): QueuedReview | null {
  return getDb().transaction(claimNextReviewLocked).immediate();
}

/** True only while this exact claim generation still owns the queue row. */
export function isReviewClaimCurrent(review: Pick<QueuedReview, 'id' | 'claim_owner'>): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM review_queue
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).get(review.id, review.claim_owner);
  return Boolean(row);
}

interface TransientFailedReviewRow {
  id: string;
  lane_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
}

const INTERRUPTED_TRANSIENT_RECOVERY_ERROR =
  'Skipped: Lane is no longer reviewing (awaiting_human).';

interface ReviewRecoveryLineageEvent {
  verb: string;
  payload: Record<string, unknown>;
}

function reviewRecoveryLineageEvents(laneId: string): ReviewRecoveryLineageEvent[] {
  const rows = getDb().prepare(
    `SELECT verb, payload_json FROM lane_events
     WHERE lane_id = ?
       AND verb IN ('review_queue_blocked', 'wedge_timeout',
                    'review_transient_recovered', 'review_skipped')
     ORDER BY timestamp ASC`,
  ).all(laneId) as Array<{ verb: string; payload_json: string }>;

  return rows.map((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      return {
        verb: row.verb,
        payload: payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {},
      };
    } catch {
      return { verb: row.verb, payload: {} };
    }
  });
}

/**
 * Prove that an `awaiting_human` lane was escalated solely because this exact
 * review row exhausted on reviewer contention. A generic human-owned lane must
 * never be resumed automatically; the blocker + wedge receipts make this a
 * narrow reversal of the stale alarm created by the failure being repaired.
 *
 * v0.1.707 could requeue the row without clearing that alarm, after which the
 * drain claimed and skipped it. `requireInterruptedRecovery` recognizes only
 * that exact receipt chain so affected installs can heal on their next boot.
 */
function isStaleTransientReviewAlarm(input: {
  laneId: string;
  reviewId: string;
  laneStatus: string;
  laneLastEventLabel: string | null;
  requireInterruptedRecovery: boolean;
}): boolean {
  if (
    input.laneStatus !== 'awaiting_human'
    || input.laneLastEventLabel !== 'orchestrator_wedge_timeout'
  ) {
    return false;
  }

  const events = reviewRecoveryLineageEvents(input.laneId);
  const blockerIndex = events.findLastIndex((event) => (
    event.verb === 'review_queue_blocked'
    && event.payload.reviewId === input.reviewId
    && isReviewerSessionBusyMessage(event.payload.reason)
  ));
  if (blockerIndex < 0) return false;

  const wedgeIndex = events.findIndex((event, index) => (
    index > blockerIndex
    && event.verb === 'wedge_timeout'
    && event.payload.from === 'awaiting_orchestrator'
    && event.payload.to === 'awaiting_human'
    && event.payload.blockedReason === 'orchestrator_wedge_timeout'
  ));
  if (wedgeIndex < 0) return false;
  if (!input.requireInterruptedRecovery) return true;

  const recoveredIndex = events.findIndex((event, index) => (
    index > wedgeIndex
    && event.verb === 'review_transient_recovered'
    && event.payload.reviewId === input.reviewId
  ));
  if (recoveredIndex < 0) return false;

  return events.some((event, index) => (
    index > recoveredIndex
    && event.verb === 'review_skipped'
    && event.payload.reviewId === input.reviewId
    && event.payload.reason === 'Lane is no longer reviewing (awaiting_human).'
  ));
}

/**
 * Repair rows created before reviewer contention had a structured outcome.
 * Only the exact known busy condition is eligible; real reviewer failures stay
 * failed and visible to the operator.
 */
async function recoverTransientReviewFailures(): Promise<number> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, lane_id, status, attempts, last_error FROM review_queue
     WHERE status = 'failed'
        OR (status = 'completed' AND last_error = ?)`,
  ).all(INTERRUPTED_TRANSIENT_RECOVERY_ERROR) as TransientFailedReviewRow[];
  let recovered = 0;

  for (const row of rows) {
    const lane = getLane(row.lane_id);
    if (!lane) continue;
    const staleHumanAlarm = isStaleTransientReviewAlarm({
      laneId: lane.id,
      reviewId: row.id,
      laneStatus: lane.status,
      laneLastEventLabel: lane.lastEventLabel,
      requireInterruptedRecovery: row.status === 'completed',
    });
    const interruptedRecovery = row.status === 'completed'
      && row.last_error === INTERRUPTED_TRANSIENT_RECOVERY_ERROR
      && staleHumanAlarm;
    const legacyBusyFailure = row.status === 'failed'
      && isReviewerSessionBusyMessage(row.last_error);
    if (!legacyBusyFailure && !interruptedRecovery) continue;

    const currentHeadSha = laneReviewHeadSha(lane) ?? null;
    const reason = interruptedRecovery
      ? 'Stale awaiting-human alarm interrupted transient review recovery'
      : row.last_error?.trim() || 'Reviewer session busy';
    const restoreReviewing = (
      lane.status === 'awaiting_orchestrator'
      && lane.lastEventLabel === 'review_queue_failed'
    ) || staleHumanAlarm;
    // A human-owned or otherwise non-reviewing lane without the exact stale
    // alarm proof must stay untouched. Requeueing it would only let the drain
    // claim and skip the row again, erasing the durable failure receipt.
    if (lane.status !== 'reviewing' && !restoreReviewing) continue;
    const result = db.prepare(
      `UPDATE review_queue
       SET status = 'pending', attempts = 0, last_error = ?, head_sha = ?,
           claimed_at = NULL, claim_owner = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = ? AND last_error = ?`,
    ).run(`Deferred after restart: ${reason}`, currentHeadSha, row.id, row.status, row.last_error);
    if (result.changes !== 1) continue;

    if (restoreReviewing) {
      setLaneStatus(lane.id, 'reviewing', 'system', 'review_queue_transient_recovered');
    }
    let releaseRepaired = false;
    if (lane.packetId) {
      const { repairUnprovenPacketRelease } = await import('@/lib/orchestrator/packet-release-repair');
      releaseRepaired = await repairUnprovenPacketRelease(lane.packetId, lane.id);
    }
    recordLaneEvent(lane.id, 'review_transient_recovered', 'system', {
      packetId: lane.packetId ?? null,
      reviewId: row.id,
      previousAttempts: row.attempts,
      reason,
      currentHeadSha,
      releaseRepaired,
      previousStatus: row.status,
      laneRestoredFrom: restoreReviewing ? lane.status : null,
    });
    recovered += 1;
  }
  return recovered;
}

let recoveryPassInFlight = false;

/**
 * Reclaim abandoned claims, then reconcile stalled lanes. Exported so real-path
 * tests can drive the recovery half without claiming a review.
 */
export async function runReviewRecoveryPass(): Promise<void> {
  if (recoveryPassInFlight) return;
  recoveryPassInFlight = true;
  try {
    try {
      await recoverTransientReviewFailures();
    } catch (error) {
      console.warn('[auto-review] Transient review recovery failed:', error);
    }

    try {
      reclaimAbandonedReviewAttempts();
    } catch (error) {
      console.warn('[auto-review] Abandoned review attempt reclamation failed:', error);
    }

    // Reconcile before claiming: a lane whose merge dispatch was missed, or
    // whose successor review was skipped, has no queue row left to carry it,
    // so nothing downstream would ever look at it again.
    const now = Date.now();
    if (now - lastStallReconcileAt >= STALL_RECONCILE_INTERVAL_MS) {
      lastStallReconcileAt = now;
      let unchanged = false;
      try {
        unchanged = lastStallInputs !== null && reviewStallInputs() === lastStallInputs;
      } catch {
        // Unreadable inputs: run the pass.
      }
      if (!unchanged) {
        try {
          await reconcileReviewStalls();
          // Read after the pass so its own writes are not taken for a change.
          lastStallInputs = reviewStallInputs();
        } catch (error) {
          lastStallInputs = null;
          console.warn('[auto-review] Review stall reconciliation failed:', error);
        }
      }
    }
  } finally {
    recoveryPassInFlight = false;
  }
}
