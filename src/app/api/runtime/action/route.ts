import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { performLegacyRuntimeActionViaAgentControl } from '@/lib/agent-control/service';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import type { RuntimeActionRequest } from '@/lib/runtime/actions';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import { EffortPinRejectionError, type EffortPinErrorCode } from '@/lib/orchestrator/effort-pin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OUTCOME_UNKNOWN_MESSAGE = 'The action outcome is unknown; inspect the session before using a new mutation id.';

type RuntimeActionResult = Awaited<ReturnType<typeof performLegacyRuntimeActionViaAgentControl>>;
type RuntimeActionReceipt =
  | { kind: 'result'; result: RuntimeActionResult & { code?: EffortPinErrorCode } }
  | { kind: 'outcome_unknown'; message: string };

function runtimeActionIdempotencyBody(payload: RuntimeActionRequest): string {
  return JSON.stringify({
    action: payload.action,
    surfaceId: payload.surfaceId,
    message: payload.message,
    runId: payload.runId,
    cwd: payload.cwd,
    attachments: payload.attachments,
    auditSteer: payload.auditSteer,
    steerSource: payload.steerSource,
    automaticRecoveryRunId: payload.automaticRecoveryRunId,
  });
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as RuntimeActionRequest | null;
  const action = payload?.action;
  const surfaceId = payload?.surfaceId?.trim();

  const clientMutationId = payload?.clientMutationId?.trim();

  if (!action || !surfaceId || !clientMutationId) {
    return NextResponse.json(
      { error: 'action, surfaceId, and clientMutationId are required' },
      { status: 400 },
    );
  }

  if (payload.automaticRecoveryRunId !== undefined && (typeof payload.automaticRecoveryRunId !== 'string'
    || !payload.automaticRecoveryRunId.trim() || !['steer', 'send_input'].includes(action))) {
    return NextResponse.json({ error: 'Invalid automatic recovery generation or action.' }, { status: 400 });
  }

  const canonicalBody = runtimeActionIdempotencyBody({ ...payload, surfaceId });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'runtime_action',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json(
        { error: 'clientMutationId was already used for a different runtime action.' },
        { status: 409 },
      );
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json(
        { error: 'The persisted idempotency store is unavailable; the action was not run.' },
        { status: 503 },
      );
    }
    const verb = `runtime_action.${action}`;
    const outcome = await withIdempotency<RuntimeActionReceipt>(
      {
        key: deriveIdempotencyKey({
          verb,
          scopeId: surfaceId,
          clientKey: clientMutationId,
          body: canonicalBody,
        }),
        verb,
        scopeId: surfaceId,
      },
      async () => {
        try {
          return {
            kind: 'result',
            result: await performLegacyRuntimeActionViaAgentControl({
              ...payload,
              surfaceId,
              clientMutationId,
            }),
          };
        } catch (error) {
          if (error instanceof EffortPinRejectionError) {
            return { kind: 'result', result: {
              ok: false, action, surfaceId, sessionKey: surfaceId,
              runtime: runtimeIdFromSessionKey(surfaceId) ?? 'unknown', clientMutationId,
              status: 'unavailable', note: error.message, code: error.code,
            } };
          }
          console.error('[runtime-action] control failed:', error);
          return {
            kind: 'outcome_unknown',
            message: OUTCOME_UNKNOWN_MESSAGE,
          };
        }
      },
    );
    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        action,
        surfaceId,
        sessionKey: surfaceId,
        runtime: runtimeIdFromSessionKey(surfaceId) ?? 'unknown',
        clientMutationId,
        status: outcomeUnknown ? 'unavailable' : 'queued',
        note: outcomeUnknown
          ? `The prior ${action} process ended before its receipt was persisted. The outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect the session before taking another action.`
          : `An identical ${action} action is already in progress; it was not executed twice.`,
        deduped: true,
        replayed: true,
        inProgress: true,
        outcomeUnknown: outcomeUnknown || undefined,
      }, {
        status: outcomeUnknown ? 409 : 202,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'x-o8-idempotency-replayed': '1',
        },
      });
    }

    const receipt = outcome.result;
    if (receipt.kind === 'outcome_unknown') {
      if (!outcome.replayed) {
        invalidateCommandCenterSnapshotCaches();
        invalidateInboxCache();
        await publishRealtimeMutation({
          mutation: {
            mutationId: clientMutationId,
            source: 'desktop',
            action,
            surfaceId,
            sessionKey: surfaceId,
            status: 'failed',
            note: OUTCOME_UNKNOWN_MESSAGE,
            createdAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
          },
          refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
          sessionKeys: [surfaceId],
          fresh: false,
        }).catch((error) => console.error('[runtime-action] receipt publish failed', error));
      }
      return NextResponse.json({
        ok: false,
        error: OUTCOME_UNKNOWN_MESSAGE,
        action,
        surfaceId,
        sessionKey: surfaceId,
        runtime: runtimeIdFromSessionKey(surfaceId) ?? 'unknown',
        clientMutationId,
        status: 'unavailable',
        note: OUTCOME_UNKNOWN_MESSAGE,
        outcomeUnknown: true,
        retryable: false,
        replayed: outcome.replayed || undefined,
      }, {
        status: 409,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          ...(outcome.replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
        },
      });
    }
    const result = receipt.result;
    if (!outcome.replayed) {
      // A failed destructive control can still leave durable hold, retirement,
      // or approval state behind, so refresh operator truth for every fresh
      // terminal receipt.
      invalidateCommandCenterSnapshotCaches();
      invalidateInboxCache();
      await publishRealtimeMutation({
        mutation: {
          mutationId: clientMutationId,
          source: 'desktop',
          action,
          runtime: result.runtime,
          surfaceId,
          sessionKey: surfaceId,
          status: result.ok
            ? result.status === 'queued' ? 'queued' : 'completed'
            : 'failed',
          note: result.note,
          createdAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
        refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
        sessionKeys: [surfaceId],
        fresh: result.ok,
      }).catch((error) => console.error('[runtime-action] receipt publish failed', error));
    }
    return NextResponse.json({ ...result, replayed: outcome.replayed || undefined }, {
      status: result.ok ? 200 : 400,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        ...(outcome.replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
      },
    });
  } catch (error) {
    console.error('[api] runtime/action failed:', error);
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action,
        surfaceId,
        sessionKey: surfaceId,
        status: 'failed',
        note: 'Unable to perform runtime action',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      fresh: true,
    }).catch((publishError) => console.error('[runtime-action] failure publish failed', publishError));
    return NextResponse.json(
      {
        error: 'Unable to perform runtime action',
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  }
}
