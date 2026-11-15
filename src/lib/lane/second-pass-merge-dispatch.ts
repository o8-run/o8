/**
 * Recorded merge dispatch after a blind second pass agrees (#1856).
 *
 * `markSecondPassAgreed()` and the merge `dispatch()` used to be two adjacent
 * statements with nothing between them written to the ledger. When the merge
 * did not happen — process ended, or the dispatch returned `ok:false` and the
 * result was only console-logged — the lane parked in `reviewing` forever with
 * a fully-authorizing approval and no `merge` event, no failure, no reason.
 *
 * Agreement and dispatch are now one recorded transition: an attempt event is
 * written BEFORE the dispatch (so a crash between the two leaves a trace that
 * reconciliation can act on) and a failure event plus a durable operator
 * blocker are written when the dispatch does not merge.
 */

import { prFirstMergeRefusal } from './pr-first-delivery';
import { randomUUID } from 'node:crypto';

import { isStaleApprovalExpiryResolution } from '@/lib/approvals/expiry';
import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { getLane } from './registry';
import { surfaceReviewQueueBlocker } from './review-queue';
import type { Lane } from './types';

export type SecondPassMergeTrigger = 'second_pass_agreed' | 'stall_reconcile';

export interface SecondPassMergeDispatchResult {
  ok: boolean;
  note: string;
  /** True only when this call won the durable claim and invoked dispatch. */
  dispatched: boolean;
  /** Set when the merge routed to an operator approval card instead of merging. */
  approvalId: string | null;
}

const MERGE_DISPATCH_STALE_MS = 60_000;
const MAX_MERGE_DISPATCH_ATTEMPTS = 3;

type MergeDispatchClaim =
  | { kind: 'claimed'; attemptId: string; attempt: number }
  | { kind: 'in_flight' | 'settled_success'; reason: string }
  | { kind: 'settled_failure'; reason: string; routedApprovalId: string | null }
  | { kind: 'exhausted' | 'unavailable'; reason: string };

interface MergeDispatchLedgerRow {
  verb:
    | 'merge_dispatch_attempted'
    | 'merge_dispatch_succeeded'
    | 'merge_dispatch_deferred'
    | 'merge_dispatch_failed';
  payload_json: string;
  timestamp: string;
}

export type MergeDispatchRecovery = 'branch_probe_unknown' | 'fetch_unreachable' | 'typecheck_auto_retry';

export function readMergeDispatchRecovery(reason: string | undefined): MergeDispatchRecovery | null {
  return reason === 'branch_probe_unknown'
    || reason === 'fetch_unreachable'
    || reason === 'typecheck_auto_retry'
    ? reason
    : null;
}

function routedApprovalExpiredByStaleTtl(approvalId: string): boolean {
  const row = getSqlite().prepare(
    'SELECT status, resolution_json FROM approvals WHERE id = ?',
  ).get(approvalId) as { status: string; resolution_json: string | null } | undefined;
  return Boolean(row && isStaleApprovalExpiryResolution(row.status, row.resolution_json));
}

function claimMergeDispatch(input: {
  lane: Lane;
  approvalId: string;
  reviewedHeadSha: string;
  trigger: SecondPassMergeTrigger;
}): MergeDispatchClaim {
  const sqlite = getSqlite();
  try {
    return sqlite.transaction((): MergeDispatchClaim => {
      const rows = sqlite.prepare(`
        SELECT verb, payload_json, timestamp FROM lane_events
        WHERE lane_id = ? AND verb IN (
          'merge_dispatch_attempted', 'merge_dispatch_succeeded',
          'merge_dispatch_deferred', 'merge_dispatch_failed'
        ) ORDER BY rowid ASC
      `).all(input.lane.id) as MergeDispatchLedgerRow[];
      let attempts = 0;
      let pendingAt: number | null = null;
      let recoveredExpiredRoutedApprovalId: string | null = null;
      let outcome: {
        kind: 'success' | 'failure';
        reason: string;
        routedApprovalId: string | null;
      } | null = null;
      for (const row of rows) {
        let payload: {
          approvalId?: unknown;
          reason?: unknown;
          routedApprovalId?: unknown;
        };
        try {
          payload = JSON.parse(row.payload_json) as typeof payload;
        } catch {
          continue;
        }
        if (payload.approvalId !== input.approvalId) continue;
        if (row.verb === 'merge_dispatch_attempted') {
          attempts += 1;
          const parsed = Date.parse(row.timestamp);
          pendingAt = Number.isFinite(parsed) ? parsed : 0;
          outcome = null;
        } else if (row.verb === 'merge_dispatch_succeeded') {
          pendingAt = null;
          outcome = {
            kind: 'success',
            reason: 'This authorization already has a durable merge settlement.',
            routedApprovalId: null,
          };
        } else if (row.verb === 'merge_dispatch_deferred') {
          const parsed = Date.parse(row.timestamp);
          pendingAt = Number.isFinite(parsed) ? parsed : 0;
          outcome = null;
        } else {
          pendingAt = null;
          outcome = {
            kind: 'failure',
            reason: typeof payload.reason === 'string'
              ? payload.reason
              : 'This authorization already has a durable failed dispatch outcome.',
            routedApprovalId: typeof payload.routedApprovalId === 'string'
              ? payload.routedApprovalId
              : null,
          };
        }
      }
      if (outcome?.kind === 'success') {
        return { kind: 'settled_success', reason: outcome.reason };
      }
      if (outcome?.kind === 'failure') {
        if (
          outcome.routedApprovalId
          && routedApprovalExpiredByStaleTtl(outcome.routedApprovalId)
        ) {
          recoveredExpiredRoutedApprovalId = outcome.routedApprovalId;
        } else {
          return {
            kind: 'settled_failure',
            reason: outcome.reason,
            routedApprovalId: outcome.routedApprovalId,
          };
        }
      }
      if (pendingAt !== null && Date.now() - pendingAt < MERGE_DISPATCH_STALE_MS) {
        return { kind: 'in_flight', reason: 'A merge dispatch attempt is still inside its recovery grace period.' };
      }
      if (attempts >= MAX_MERGE_DISPATCH_ATTEMPTS) {
        const reason = `Merge dispatch for approval ${input.approvalId} produced no durable outcome after ${attempts} attempts.`;
        recordLaneEvent(input.lane.id, 'merge_dispatch_failed', 'system', {
          packetId: input.lane.packetId ?? null,
          approvalId: input.approvalId,
          reviewedHeadSha: input.reviewedHeadSha,
          trigger: input.trigger,
          reason,
          attempts,
          exhausted: true,
        });
        return { kind: 'exhausted', reason };
      }

      const attempt = attempts + 1;
      const attemptId = `merge-dispatch-${randomUUID()}`;
      recordLaneEvent(input.lane.id, 'merge_dispatch_attempted', 'system', {
        packetId: input.lane.packetId ?? null,
        approvalId: input.approvalId,
        reviewedHeadSha: input.reviewedHeadSha,
        trigger: input.trigger,
        attemptId,
        attempt,
        recoveredExpiredRoutedApprovalId,
      });
      return { kind: 'claimed', attemptId, attempt };
    }).immediate();
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `Merge dispatch ledger could not be claimed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function dispatchSecondPassMerge(input: {
  lane: Lane;
  approvalId: string;
  reviewedHeadSha: string;
  trigger: SecondPassMergeTrigger;
}): Promise<SecondPassMergeDispatchResult> {
  const { lane, approvalId, reviewedHeadSha, trigger } = input;
  const claim = claimMergeDispatch(input);
  if (claim.kind !== 'claimed') {
    const needsBlocker = claim.kind === 'exhausted'
      || claim.kind === 'unavailable'
      || (claim.kind === 'settled_failure' && !claim.routedApprovalId);
    const currentLane = needsBlocker ? getLane(lane.id) : null;
    if (
      needsBlocker
      && currentLane
      && currentLane.status !== 'completed'
      && currentLane.status !== 'archived'
      && currentLane.status !== 'awaiting_orchestrator'
      && currentLane.status !== 'awaiting_human'
    ) {
      surfaceReviewQueueBlocker({
        laneId: lane.id,
        reviewId: `second-pass-merge:${approvalId}`,
        reason: claim.reason,
        attempts: claim.kind === 'exhausted' ? MAX_MERGE_DISPATCH_ATTEMPTS : 0,
      });
    }
    return {
      ok: claim.kind === 'settled_success',
      note: claim.reason,
      dispatched: false,
      approvalId: claim.kind === 'settled_failure' ? claim.routedApprovalId : null,
    };
  }

  let policyRefused = false;
  let ok = false;
  let note = '';
  let routedApprovalId: string | null = null;
  let recovery: MergeDispatchRecovery | null = null;
  try {
    const prOnlyNote = await prFirstMergeRefusal(lane);
    policyRefused = Boolean(prOnlyNote);
    const { dispatch } = await import('@/lib/lane/commands');
    const mergeResult = prOnlyNote ? { ok: false, note: prOnlyNote, reason: 'pr_only', approvalId: null }
      : await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    ok = mergeResult.ok;
    note = mergeResult.note ?? '';
    routedApprovalId = mergeResult.approvalId ?? null;
    recovery = ok ? null : readMergeDispatchRecovery(mergeResult.reason);
    if (ok) {
      const settledLane = getLane(lane.id);
      const mergeSha = 'mergeSha' in mergeResult && typeof mergeResult.mergeSha === 'string'
        ? mergeResult.mergeSha
        : null;
      if (settledLane?.status === 'completed' || settledLane?.status === 'archived' || mergeSha) {
        recordLaneEvent(lane.id, 'merge_dispatch_succeeded', 'system', {
          packetId: lane.packetId ?? null,
          approvalId,
          reviewedHeadSha,
          trigger,
          attemptId: claim.attemptId,
          attempt: claim.attempt,
          mergeSha,
          status: settledLane?.status ?? null,
          note: note || null,
        });
        console.log(`[auto-review] Merge dispatched for lane ${lane.id} (${trigger}); note=${note}`);
        return { ok: true, note, dispatched: true, approvalId: routedApprovalId };
      }
      ok = false;
      note = `Merge dispatch returned ok:true but lane ${lane.id} remained ${settledLane?.status ?? 'missing'} with no merge receipt.`;
    }
  } catch (error) {
    ok = false;
    note = error instanceof Error ? error.message : String(error);
  }

  if (!ok && !routedApprovalId && recovery) {
    recordLaneEvent(lane.id, 'merge_dispatch_deferred', 'system', {
      packetId: lane.packetId ?? null,
      approvalId,
      reviewedHeadSha,
      trigger,
      attemptId: claim.attemptId,
      attempt: claim.attempt,
      recovery,
      note: note || null,
    });
    console.warn(
      `[auto-review] Merge dispatch for lane ${lane.id} entered ${recovery}; retry remains bounded by the dispatch ledger.`,
    );
    return { ok: false, note, dispatched: true, approvalId: null };
  }

  const reason = `Second-pass agreement at HEAD ${reviewedHeadSha} did not merge: ${note || 'the merge dispatch returned no reason.'}`;
  recordLaneEvent(lane.id, 'merge_dispatch_failed', 'system', {
    packetId: lane.packetId ?? null,
    approvalId,
    reviewedHeadSha,
    trigger,
    attemptId: claim.attemptId,
    attempt: claim.attempt,
    note: note || null,
    reason,
    // A merge routed to an operator approval card already parked the lane in a
    // durable, operator-actionable state — the card IS the outcome. Only a
    // dispatch that produced no outcome at all needs the queue blocker to move
    // the lane out of the live-looking `reviewing` state.
    routedApprovalId,
  });
  if (!routedApprovalId) {
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass-merge:${approvalId}`,
      reason,
      attempts: 0,
    });
  }
  console.warn(`[auto-review] ${reason}`);
  return { ok, note, dispatched: !policyRefused, approvalId: routedApprovalId };
}
