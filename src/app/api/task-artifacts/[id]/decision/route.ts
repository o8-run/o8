export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '@/app/api/orchestrator/_utils';
import { getMissionCardView, submitCardDecision, TaskArtifactError } from '@/lib/task-artifacts/service';
import { TASK_ARTIFACT_ID_PATTERN } from '@/lib/task-artifacts/types';

/**
 * Mission cards (#5468), the `card.decision` message.
 *
 * POST /api/task-artifacts/[id]/decision  { actionId, entityIds?, nonce, routing? }
 *   Operator or enrolled device only, like every task artifact action. The
 *   decision is recorded in the artifact receipt ledger and delivered through
 *   the artifact's own path: a packet steer, the lead's composer queue when the
 *   client sends its chat routing, or the operator's own thread turn.
 * GET  /api/task-artifacts/[id]/decision — the card's derived state and receipt.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!TASK_ARTIFACT_ID_PATTERN.test(id)) return operatorError('invalid_request', 'Invalid card id.', 400);
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role === 'worker') {
    return operatorError('forbidden', 'Card decisions are operator-only; a dispatched worker cannot decide a card.', 403);
  }
  if (ctx.role !== 'operator' && ctx.role !== 'device') {
    return operatorError('unauthorized', 'Deciding a card requires the operator credential or an enrolled device.', 401);
  }
  const body = asRecord(await parseJsonBody(request));
  if (!body) return operatorError('invalid_request', 'Invalid JSON body.', 400);
  try {
    const result = await submitCardDecision(id, {
      actionId: body.actionId,
      entityIds: body.entityIds,
      nonce: body.nonce,
      actor: ctx.role,
      routing: body.routing,
    });
    if (result.accepted) return operatorSuccess(result);
    return NextResponse.json({ ok: false, error: { code: result.code, message: result.reason }, result: { ...result, card: await getMissionCardView(id) } }, { status: 422 });
  } catch (error) {
    if (error instanceof TaskArtifactError) return operatorError(error.code, error.message, error.status, error.details);
    return operatorError('decision_failed', error instanceof Error ? error.message : String(error), 500);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!TASK_ARTIFACT_ID_PATTERN.test(id)) return operatorError('invalid_request', 'Invalid card id.', 400);
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role !== 'operator' && ctx.role !== 'device') {
    return operatorError('unauthorized', 'Reading a card requires the operator credential.', 401);
  }
  const card = await getMissionCardView(id);
  if (!card) return operatorError('not_found', `Card ${id} not found.`, 404);
  return operatorSuccess({ card });
}
