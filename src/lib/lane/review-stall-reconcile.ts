/**
 * Review-stall reconciliation (#1856).
 *
 * Two silent-park paths violate the same invariant — an actionable review
 * state disappeared between adjacent in-memory statements with no durable
 * outcome — so both are reconciled on the way in, not left to a restart:
 *
 *   A. Authorized but never merged. An approval that authorizes the current
 *      HEAD (approved, second pass agreed) with no recorded merge dispatch.
 *      Re-fires the merge through the recorded dispatch, so the retry itself
 *      leaves an attempt/failure receipt.
 *
 *   B. Successor review never ran. A current-HEAD approval still awaiting its
 *      blind second pass while the lane's latest queue row is terminal — the
 *      shape a skipped or cancelled job leaves behind. Requeues it, and after
 *      a bounded number of requeues surfaces a durable blocker instead of
 *      looping forever.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { listLanes } from './registry';
import { assessDurableApprovedReview } from './durable-review-approval';
import { findPendingSecondPassApproval } from './review-verdict-recency';
import { enqueueLaneReview } from './review-queue';
import { surfaceReviewQueueBlocker } from './review-queue-blocker';
import { laneReviewHeadSha, settleSupersededReviewAttempts } from './review-attempt-head';
import { dispatchSecondPassMerge } from './second-pass-merge-dispatch';
import type { Lane } from './types';

/** How many times reconciliation may requeue a stalled successor review before escalating. */
const MAX_RECONCILE_REQUEUES = 3;

export interface ReviewStallReconcileResult {
  scanned: number;
  mergesDispatched: number;
  reviewsRequeued: number;
  blockersSurfaced: number;
  /** Attempts settled because they were pinned to a HEAD that has been replaced. */
  attemptsSuperseded: number;
}

function hasActiveQueueRow(laneId: string): boolean {
  try {
    return getSqlite().prepare(
      `SELECT id FROM review_queue
       WHERE lane_id = ? AND status IN ('pending', 'in_progress') LIMIT 1`,
    ).get(laneId) !== undefined;
  } catch {
    // Unreadable queue must not trigger a duplicate enqueue.
    return true;
  }
}

function countReconciledRequeues(laneId: string, approvalId: string): number {
  try {
    const rows = getSqlite().prepare(`
      SELECT payload_json FROM lane_events
      WHERE lane_id = ? AND verb = 'review_requeue_reconciled'
      ORDER BY rowid DESC
      LIMIT 50
    `).all(laneId) as { payload_json: string }[];
    return rows.filter((row) => {
      try {
        return (JSON.parse(row.payload_json) as { approvalId?: unknown }).approvalId === approvalId;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return MAX_RECONCILE_REQUEUES;
  }
}

async function isAgreedSecondPassApproval(approvalId: string): Promise<boolean> {
  try {
    const { getApproval } = await import('@/lib/approvals/store');
    const approval = getApproval(approvalId);
    return approval?.args?.requiresSecondPass === true
      && approval.args?.secondPassAgreed === true;
  } catch {
    return false;
  }
}

async function reconcileLane(
  lane: Lane,
  result: ReviewStallReconcileResult,
): Promise<void> {
  // Settle first. Path B below early-returns on `hasActiveQueueRow()`, and an
  // attempt pinned to a HEAD the steer already replaced still counts as active
  // — so the dead row hid the very lane this reconciler exists to repair.
  result.attemptsSuperseded += settleSupersededReviewAttempts({
    lane,
    currentHeadSha: laneReviewHeadSha(lane),
    reason: 'HEAD moved past the commit this review was claimed for',
  });

  // A — fully authorized, never dispatched.
  //
  // Deliberately narrow: only an approval that REQUIRED a blind second pass
  // and got agreement is auto-dispatched here, because that is the path whose
  // merge is supposed to fire automatically. A plain approved review still
  // merges through the orchestrator's explicit approve_and_merge, and firing
  // it from reconciliation would merge packets nobody dispatched.
  const durable = await assessDurableApprovedReview(lane);
  if (durable.approved && durable.approvalId && await isAgreedSecondPassApproval(durable.approvalId)) {
    const { normalizeHeadSha, readHeadSha } = await import('@/lib/lane/head-sha-lock');
    const headSha = normalizeHeadSha(await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath));
    if (!headSha) return;
    const dispatch = await dispatchSecondPassMerge({
      lane,
      approvalId: durable.approvalId,
      reviewedHeadSha: headSha,
      trigger: 'stall_reconcile',
    });
    if (dispatch.dispatched) result.mergesDispatched += 1;
    return;
  }

  // B — current-HEAD approval still awaiting its blind second pass, with no
  // queue row left to run it.
  if (hasActiveQueueRow(lane.id)) return;
  const pending = await findPendingSecondPassApproval(lane);
  if (!pending) return;

  const requeues = countReconciledRequeues(lane.id, pending.approval.id);
  if (requeues >= MAX_RECONCILE_REQUEUES) {
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${pending.approval.id}`,
      reason: `Blind second-pass review for HEAD ${pending.reviewedHeadSha} was requeued ${requeues} times and never produced a reviewer turn.`,
      attempts: requeues,
    });
    result.blockersSurfaced += 1;
    return;
  }

  const queued = enqueueLaneReview(lane, { afterInProgress: true });
  recordLaneEvent(lane.id, 'review_requeue_reconciled', 'system', {
    packetId: lane.packetId ?? null,
    approvalId: pending.approval.id,
    reviewedHeadSha: pending.reviewedHeadSha,
    reviewId: queued.reviewId,
    queued: queued.queued,
    requeue: requeues + 1,
  });
  result.reviewsRequeued += 1;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

/** HEAD and its reflog for a worktree, read from files: a commit, reset or checkout changes them. */
function worktreeHeadStamp(worktree: string): string {
  let gitDir = join(worktree, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (pointer) gitDir = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
    }
  } catch {
    return '-';
  }
  let head = '';
  try { head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim(); } catch { /* missing */ }
  return `${head}:${fileStamp(join(gitDir, 'logs', 'HEAD'))}`;
}

/**
 * Everything a stall pass reads, as one string: lanes and lane events, the
 * review queue, approvals, and the HEAD of each reviewing lane's worktree.
 */
export function reviewStallInputs(): string {
  const db = getSqlite();
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM lanes) AS lanes,
      (SELECT COALESCE(MAX(rowid), 0) FROM lane_events) AS events,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM review_queue) AS queue
  `).get() as Record<string, string | number>;
  const reviewing = db.prepare(`
    SELECT id, worktree_path, repo_path, packet_id, session_key FROM lanes WHERE status = 'reviewing' ORDER BY id
  `).all() as Array<{ id: string; worktree_path: string | null; repo_path: string; packet_id: string | null; session_key: string | null }>;
  // Only the approvals a pass reads (by lane, packet or session), through their
  // indexes: scanning the whole table reads every stored diff.
  const approvals = reviewing.map((lane) => {
    const found = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS at FROM approvals
      WHERE lane_id = ? OR packet_id = ? OR session_key = ?
    `).get(lane.id, lane.packet_id ?? '', lane.session_key ?? '') as { n: number; at: number };
    return `${found.n}:${found.at}`;
  });
  const heads = reviewing.map((lane, index) => (
    `${lane.id}=${worktreeHeadStamp(lane.worktree_path || lane.repo_path)}/${approvals[index]}`
  ));
  return [row.lanes, row.events, row.queue, ...heads].join('|');
}

export async function reconcileReviewStalls(): Promise<ReviewStallReconcileResult> {
  const result: ReviewStallReconcileResult = {
    scanned: 0,
    mergesDispatched: 0,
    reviewsRequeued: 0,
    blockersSurfaced: 0,
    attemptsSuperseded: 0,
  };

  const lanes = listLanes().filter((lane) => lane.status === 'reviewing');
  for (const lane of lanes) {
    result.scanned += 1;
    try {
      await reconcileLane(lane, result);
    } catch (error) {
      console.warn(
        `[review-stall] Reconciliation failed for lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
