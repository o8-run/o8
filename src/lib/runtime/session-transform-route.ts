import { NextRequest, NextResponse } from 'next/server';

import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import {
  dismissUnresolvedSessionTransform,
  getSessionTransformState,
  performSessionTransform,
  SessionTransformError,
  type SessionTransformRequest,
} from '@/lib/runtime/session-transforms';
import type { RuntimeId, RuntimeSessionTransformAction } from '@/lib/runtimes/types';
import {
  readSessionTransformCatalog,
  readSessionTransformIntents,
} from '@/lib/runtime/session-transform-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = new Set<RuntimeSessionTransformAction>(['import', 'checkpoint', 'fork', 'rewind']);
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function noStore<T>(payload: T, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE,
  });
}

interface SessionTransformPostBody {
  action: RuntimeSessionTransformAction | 'dismiss_pending';
  runtimeId: RuntimeId;
  sessionKey: string;
  checkpointId?: string;
  expectedCatalogVersion: number;
  intentId?: string;
  providerOutcome?: 'no_continuation';
  clientMutationId: string;
}

function canonicalPostBody(payload: SessionTransformPostBody) {
  return JSON.stringify({
    action: payload.action,
    runtimeId: payload.runtimeId,
    sessionKey: payload.sessionKey,
    checkpointId: payload.checkpointId,
    expectedCatalogVersion: payload.expectedCatalogVersion,
    intentId: payload.intentId,
    providerOutcome: payload.providerOutcome,
  });
}

export async function GET(request: NextRequest) {
  const runtimeId = request.nextUrl.searchParams.get('runtimeId')?.trim() as RuntimeId | undefined;
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  if (!runtimeId) return noStore({ error: 'runtimeId is required' }, 400);
  try {
    return noStore(await getSessionTransformState(runtimeId, sessionKey));
  } catch (error) {
    return noStore({
      error: error instanceof Error ? error.message : 'Unable to read session transform state.',
      reason: 'catalog_unavailable',
      retryable: true,
    }, 503);
  }
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as (
    Partial<Omit<SessionTransformRequest, 'action'>> & {
      action?: RuntimeSessionTransformAction | 'dismiss_pending';
      intentId?: string;
      providerOutcome?: 'no_continuation';
      clientMutationId?: string;
    }
  ) | null;
  const action = payload?.action;
  const runtimeId = payload?.runtimeId?.trim() as RuntimeId | undefined;
  const sessionKey = payload?.sessionKey?.trim();
  const clientMutationId = payload?.clientMutationId?.trim();
  if (!action || (!ACTIONS.has(action as RuntimeSessionTransformAction) && action !== 'dismiss_pending') || !runtimeId || !sessionKey) {
    return noStore({
      error: 'action, runtimeId, and sessionKey are required.',
      reason: 'invalid_request',
      retryable: false,
    }, 400);
  }
  if (!clientMutationId) {
    return noStore({
      error: 'clientMutationId is required.',
      reason: 'invalid_request',
      retryable: false,
    }, 400);
  }
  const postBody: SessionTransformPostBody = {
    action,
    runtimeId,
    sessionKey,
    checkpointId: payload?.checkpointId?.trim() || undefined,
    expectedCatalogVersion: payload?.expectedCatalogVersion as number,
    intentId: payload?.intentId?.trim() || undefined,
    providerOutcome: payload?.providerOutcome,
    clientMutationId,
  };
  const canonicalBody = canonicalPostBody(postBody);
  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'runtime_session_transform',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return noStore({
        error: 'clientMutationId was already used for a different session transform.',
        reason: 'mutation_conflict',
        retryable: false,
        clientMutationId,
      }, 409);
    }
    if (binding.status === 'unavailable') {
      return noStore({
        error: 'The persisted idempotency store is unavailable; the session was not transformed.',
        reason: 'catalog_unavailable',
        retryable: true,
        clientMutationId,
      }, 503);
    }
    const verb = `runtime_session_transform.${action}`;
    const scopeId = `${runtimeId}:${sessionKey}`;
    const executeTransform = async () => {
      if (action === 'dismiss_pending') {
        if (!postBody.intentId || postBody.providerOutcome !== 'no_continuation') {
          throw new SessionTransformError(
            'invalid_request',
            'intentId and providerOutcome=no_continuation are required.',
            400,
          );
        }
        return dismissUnresolvedSessionTransform({
          runtimeId,
          sessionKey,
          intentId: postBody.intentId,
          expectedCatalogVersion: postBody.expectedCatalogVersion,
          providerOutcome: postBody.providerOutcome,
        });
      }
      return performSessionTransform({
        action,
        runtimeId,
        sessionKey,
        checkpointId: postBody.checkpointId,
        expectedCatalogVersion: postBody.expectedCatalogVersion,
        clientMutationId,
      });
    };
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({
        verb,
        scopeId,
        clientKey: clientMutationId,
        body: canonicalBody,
      }),
      verb,
      scopeId,
      reconcileUnresolved: action === 'dismiss_pending'
        ? async () => {
            const matchingIntent = (await readSessionTransformIntents()).find((intent) => (
              intent.id === postBody.intentId
              && intent.runtimeId === runtimeId
              && intent.originalSessionKey === sessionKey
            ));
            if (matchingIntent) return null;
            const catalog = await readSessionTransformCatalog();
            return {
              ok: true as const,
              action: 'dismiss_pending' as const,
              runtimeId,
              sessionKey,
              catalogVersion: catalog.version,
              note: 'Recovered the completed unresolved-transform dismissal.',
            };
          }
        : executeTransform,
    }, executeTransform);
    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        action,
        runtimeId,
        sessionKey,
        clientMutationId,
        status: outcomeUnknown ? 'outcome_unknown' : 'in_progress',
        inProgress: true,
        replayed: true,
        outcomeUnknown: outcomeUnknown || undefined,
        note: outcomeUnknown
          ? 'The prior session transform process ended before its receipt was persisted, and provider recovery could not prove the outcome. The exact mutation remains quarantined and was not repeated. Inspect the pending transform before taking another action.'
          : 'An identical session transform is already in progress; it was not executed twice.',
      }, {
        status: outcomeUnknown ? 409 : 202,
        headers: { ...NO_STORE, 'x-o8-idempotency-replayed': '1' },
      });
    }
    const recoveredReplay = 'recovered' in outcome.result && outcome.result.recovered === true;
    const replayed = outcome.replayed || recoveredReplay;
    return NextResponse.json({
      ...outcome.result,
      clientMutationId,
      replayed: replayed || undefined,
      persistenceDegraded: outcome.persistenceDegraded || undefined,
    }, {
      headers: {
        ...NO_STORE,
        ...(replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
      },
    });
  } catch (error) {
    if (error instanceof SessionTransformError) {
      return noStore({
        error: error.message,
        reason: error.reason,
        retryable: error.retryable,
        clientMutationId,
      }, error.status);
    }
    return noStore({
      error: error instanceof Error ? error.message : 'Unable to transform provider session.',
      reason: 'provider_error',
      retryable: false,
      clientMutationId,
    }, 500);
  }
}
