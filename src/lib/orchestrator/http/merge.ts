import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { loadMergeModule } from '@/lib/orchestrator/operator-mission-service/merge-warmup';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { withSynchronousWorktreeCleanup } from '@/lib/orchestrator/worktree-cleanup';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '@/app/api/orchestrator/_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// #2 Stage 5 — idempotency + synchronous worktree-cleanup live HERE now (was in
// the MCP approve_and_merge handler, MCP-process-local). Server-side means every
// client — MCP, the `o8 packet approve-merge` CLI, future mobile — inherits the
// same dedupe + clean-tree-on-return guarantee through this one route.
//
// #1513 — migrated off the in-memory `idempotency-cache.ts` (deleted) onto the
// persisted reserve→finalize store the other control verbs use. The old cache's
// "a restart forgets in-flight merges so the operator retries immediately"
// property is preserved by the store's dead-pid reservation reaper (see
// `reapDeadIdempotencyReservations` in db/index.ts): a LIVE in-flight merge is
// still deduped, a restart-orphaned one is immediately retryable.

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }

  // #2 Stage 5b — worker-context governance. When the caller is a dispatched
  // worker we do NOT merge: raise an operator approval card and return a clean
  // pending status. The operator clears it (o8 inbox approve), which dispatches
  // the lane-merge continuation through the full gate. A human operator call
  // falls through and merges directly.
  //
  // Worker context is derived from the request PRINCIPAL (the local-worker token
  // its CLI presents), not just the self-asserted `requestedByWorker` body flag —
  // otherwise a worker could omit the flag and take the direct-merge path
  // (SECURITY_AUDIT_2026-07-02 §HIGH-4). The body flag is retained as an
  // additional signal for older CLIs.
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return operatorError('forbidden', 'Merging packets requires an operator or dispatched-worker credential.', 403);
  }
  const ownershipRefusal = workerPacketRefusal(principal, packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }
  const isWorkerContext = record.requestedByWorker === true || principal.role === 'worker';
  if (isWorkerContext) {
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packetId);
    if (!lane) {
      return operatorError('lane_not_found', `No lane found for packet ${packetId}.`, 404);
    }
    try {
      const { raiseWorkerMergeApproval } = await import('@/lib/lane/commands');
      const result = await raiseWorkerMergeApproval(lane, {
        commitMessage: typeof record.commitMessage === 'string' ? record.commitMessage.trim() || undefined : undefined,
        expectedHeadSha: typeof record.expectedHeadSha === 'string' ? record.expectedHeadSha.trim() || undefined : undefined,
      });
      return operatorSuccess({
        merged: false,
        status: 'pending_operator_approval',
        approvalId: result.approvalId ?? null,
        laneId: result.laneId,
        note: result.note,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to raise merge approval.';
      return operatorError('approval_failed', message, 500, error);
    }
  }

  // #1513 — persisted idempotency. A client timeout+retry of approve_and_merge
  // (a merge outlasts the 15s client budget) must not merge twice. The caller
  // mints one key per deliberate invocation and reuses the serialized body on
  // transport retries; a later deliberate merge gets a fresh key and reruns
  // gates instead of replaying an earlier refusal.
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  if (!clientKey) {
    return operatorError('idempotency_key_required', 'idempotencyKey is required to merge a packet.', 400);
  }
  const commitMessage = typeof record.commitMessage === 'string' && record.commitMessage.trim()
    ? record.commitMessage.trim()
    : undefined;
  const expectedHeadSha = typeof record.expectedHeadSha === 'string' && record.expectedHeadSha.trim()
    ? record.expectedHeadSha.trim()
    : undefined;
  const canonicalBody = JSON.stringify({ packetId, commitMessage, expectedHeadSha });
  const key = deriveIdempotencyKey({
    verb: 'approve_and_merge',
    scopeId: packetId,
    clientKey,
    body: canonicalBody,
  });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'approve_and_merge',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_key_conflict',
        'idempotencyKey was already used for a different packet merge.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_store_unavailable',
        'The persisted idempotency store is unavailable; the packet was not merged.',
        503,
      );
    }
    const { approveAndMergePacket } = await loadMergeModule();
    const outcome = await withIdempotency(
      { key, verb: 'approve_and_merge', scopeId: packetId },
      // #622 — guarantee a clean working tree before control returns to any client.
      () => withSynchronousWorktreeCleanup(packetId, () => approveAndMergePacket({
        packetId,
        commitMessage,
        expectedHeadSha,
        // This value is derived from the authenticated request principal, not
        // the body. Under the surface posture it satisfies only the redundant
        // dispatcher-review hop; the lane merge gate still runs normally.
        actor: 'user',
      })),
    );
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet merge') ?? operatorSuccess(replayShape(outcome), 202);
    if (outcome.result.reason?.startsWith('review_run_')) {
      return operatorError(outcome.result.reason, outcome.result.note ?? 'Review run evidence policy refused the merge.', 409);
    }
    return operatorSuccess(replayShape(outcome));
  } catch (error) {
    const { isHeadShaMismatchError } = await loadMergeModule();
    if (isHeadShaMismatchError(error)) {
      return NextResponse.json({
        ok: false,
        error: {
          code: 'head_sha_mismatch',
          message: error.message,
        },
        currentHeadSha: error.currentHeadSha,
        expectedHeadSha: error.expectedHeadSha,
      }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }
    const message = error instanceof Error ? error.message : 'Unable to approve and merge packet.';
    return operatorError('merge_failed', message, 500, error);
  }
}
