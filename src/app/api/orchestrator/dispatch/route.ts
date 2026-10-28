import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { RepoDispatchAdmissionError } from '@/lib/lane/repo-preflight';
import {
  dispatchMission,
  MissionNotFoundError,
  prepareMissionDispatch,
  resolveMissionDispatchTarget,
} from '@/lib/orchestrator/operator-mission-service';
import { DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { PacketStorageAdmissionError } from '@/lib/orchestrator/storage-admission';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { DispatchRegistryConflictError } from '@/lib/orchestrator/operator-mission-service/dispatch-registry-publication';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { formatDispatchableRuntimeChoices, isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function repoAdmissionErrorResponse(error: RepoDispatchAdmissionError) {
  const { admission } = error;
  return NextResponse.json({
    ok: false,
    error: {
      code: 'repo_dispatch_blocked',
      message: admission.message,
      failedCheck: admission.failedCheck,
      correctiveAction: admission.correctiveAction,
      nextAction: admission.correctiveAction,
    },
  }, {
    status: 400,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

/**
 * #4965 failure 1: a lifecycle-lock hold (dispatchPacketLaunch throws
 * PacketStorageAdmissionError with state:'held') must surface as a recoverable
 * card — a named reason and a retry — not a bare HTTP 500 that the operator
 * reads as "still loading". 409 keeps the real message visible (operatorError
 * masks any status >= 500 as "o8 API error (n)").
 */
function admissionHeldResponse(error: PacketStorageAdmissionError) {
  const { state } = error.receipt;
  // Some admission reasons are free-form strings that interpolate a caught
  // error (e.g. `post_launch_accounting_failed: <error>`), which can carry an
  // internal path or message. Expose only the stable enum-like prefix to the
  // client — it is a better machine-readable signal and leaks no internal text.
  const reason = error.receipt.reason.split(':')[0].trim();
  let message: string;
  let nextAction: 'retry_packet' | 'reset_packet' | 'wait';
  if (reason === 'launch_in_progress') {
    message = 'This packet generation is already launching. Retry once the current launch settles.';
    nextAction = 'wait';
  } else if (reason === 'launch_effect_unknown') {
    message = 'The prior launch owner ended before its result was reconciled. Reset the packet, then dispatch again.';
    nextAction = 'reset_packet';
  } else {
    message = `Dispatch is held (${reason}). Retry the packet once the hold clears.`;
    nextAction = 'retry_packet';
  }
  return NextResponse.json({
    ok: false,
    error: { code: 'dispatch_held', message, reason, state, nextAction },
  }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

/**
 * Single translator for every known dispatch failure, shared by the wait:true
 * and wait:false branches so they cannot diverge (the divergence is exactly how
 * #4965 failure 1 slipped through: PacketStorageAdmissionError was handled by
 * neither branch, and DispatchPreflightError was missing from wait:false).
 * Returns null for an unrecognized error so the caller emits the generic 500.
 */
function dispatchErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof RepoDispatchAdmissionError) return repoAdmissionErrorResponse(error);
  if (error instanceof PacketStorageAdmissionError) return admissionHeldResponse(error);
  if (error instanceof EffortPinRejectionError) return operatorError(error.code, error.message, 400);
  if (error instanceof DispatchRegistryConflictError) return operatorError('dispatch_registry_conflict', error.message, 409);
  if (error instanceof DispatchPreflightError) {
    return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
      runtime: error.status.runtime,
      house: error.status.house,
      installed: error.status.installed,
      authenticated: error.status.authenticated,
      unavailableReason: error.status.unavailableReason,
    });
  }
  if (error instanceof MissionNotFoundError) return operatorError('not_found', error.message, 404);
  return null;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  if (body === null) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const record = asRecord(body) ?? {};
  const missionId = typeof record.missionId === 'string' && record.missionId.trim()
    ? record.missionId.trim()
    : undefined;
  let requestedRuntime: OrchestratorRuntime | undefined;
  if (record.runtime !== undefined) {
    if (!isDispatchableRuntime(record.runtime)) {
      return operatorError('invalid_request', `runtime must be one of: ${formatDispatchableRuntimeChoices()}.`, 400);
    }
    requestedRuntime = record.runtime;
  }
  let targetMissionId: string;
  try {
    targetMissionId = resolveMissionDispatchTarget(missionId);
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      return operatorError('not_found', error.message, 404);
    }
    const message = error instanceof Error ? error.message : 'Unable to resolve the mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }

  // dispatchMission awaits the full worker launch (Codex spawn + worktree
  // creation), which can take minutes — blocking the HTTP response that whole
  // time. `wait:false` (the CLI default) fires the launch on the persistent Next
  // server and returns once it's initiated; callers track progress via
  // `/api/orchestrator/status`. `wait` defaults to true so the MCP dispatch_mission
  // tool keeps its synchronous dispatched-count contract.
  // #1497 — persisted idempotency. Dispatch is naturally REPEATABLE (dispatch
  // again after queuing more work), so unlike steer/rerun we engage the guard
  // ONLY when a client supplies an explicit idempotencyKey (its retry-dedup
  // intent). Absent a key, behaviour is unchanged — no derived-hash guard that
  // would wrongly block a legitimate re-dispatch within the TTL window.
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  const wait = record.wait !== false;
  const canonicalBody = JSON.stringify({ missionId: targetMissionId, wait, runtime: requestedRuntime });
  if (clientKey) {
    const binding = bindIdempotencyClientMutation({
      namespace: 'dispatch_mission',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'idempotencyKey was used for another dispatch request.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The dispatch receipt store is unavailable.', 503);
    }
  }
  const idemKey = clientKey
    ? deriveIdempotencyKey({
        verb: 'dispatch_mission',
        scopeId: targetMissionId,
        clientKey,
        body: canonicalBody,
      })
    : null;
  if (!wait) {
    // Persist the dispatch admission before finalizing the accepted receipt.
    // Runtime launch remains asynchronous, but an API-process exit can no
    // longer lose the explicit held -> queued transition; the headless loop
    // resumes it from durable mission state after restart.
    try {
      if (idemKey) {
        const outcome = await withIdempotency(
          { key: idemKey, verb: 'dispatch_mission', scopeId: targetMissionId },
          async () => {
            const admitted = await prepareMissionDispatch({ missionId: targetMissionId, runtime: requestedRuntime });
            if (admitted.blocked) {
              return { initiated: false, async: true, missionId: targetMissionId, blocked: true };
            }
            void dispatchMission({ missionId: targetMissionId, runtime: requestedRuntime }).catch((error) => {
              console.error('[orchestrator] async dispatch failed:', error instanceof Error ? error.message : error);
            });
            return { initiated: true, async: true, missionId: targetMissionId, status: 'queued', queued: admitted.queued,
              note: 'Dispatch admitted; this response does not confirm a worker launch. Check mission status.' };
          },
        );
        if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission dispatch') ?? operatorSuccess(replayShape(outcome), 202);
        return operatorSuccess(replayShape(outcome));
      }
      const admitted = await prepareMissionDispatch({ missionId: targetMissionId, runtime: requestedRuntime });
      if (admitted.blocked) {
        return operatorError(
          'dispatch_blocked',
          'The mission has an active lifecycle hold and was not dispatched.',
          409,
        );
      }
      void dispatchMission({ missionId: targetMissionId, runtime: requestedRuntime }).catch((error) => {
        console.error('[orchestrator] async dispatch failed:', error instanceof Error ? error.message : error);
      });
      return operatorSuccess({ initiated: true, async: true, missionId: targetMissionId, status: 'queued', queued: admitted.queued,
        note: 'Dispatch admitted; this response does not confirm a worker launch. Check mission status.' });
    } catch (error) {
      const translated = dispatchErrorResponse(error);
      if (translated) return translated;
      const message = error instanceof Error ? error.message : 'Unable to dispatch mission.';
      return operatorError('dispatch_failed', message, 500, error);
    }
  }

  try {
    if (idemKey) {
      const outcome = await withIdempotency(
        {
          key: idemKey,
          verb: 'dispatch_mission',
          scopeId: targetMissionId,
          reconcileUnresolved: () => dispatchMission({ missionId: targetMissionId, runtime: requestedRuntime }),
        },
        () => dispatchMission({ missionId: targetMissionId, runtime: requestedRuntime }),
      );
      if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission dispatch') ?? operatorSuccess(replayShape(outcome), 202);
      return operatorSuccess(replayShape(outcome));
    }
    const result = await dispatchMission({ missionId: targetMissionId, runtime: requestedRuntime });
    return operatorSuccess(result);
  } catch (error) {
    const translated = dispatchErrorResponse(error);
    if (translated) return translated;
    const message = error instanceof Error ? error.message : 'Unable to dispatch mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }
}
