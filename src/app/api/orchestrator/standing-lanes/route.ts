import { bindIdempotencyClientMutation, deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';
import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { standingLaneAction } from '@/lib/lane/standing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ ok: false, error: { code: 'operator_required', message: 'Standing lane control requires the operator credential.' } }, { status: 403 });
  }
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string') {
    return NextResponse.json({ ok: false, error: { code: 'invalid_request', message: 'action is required.' } }, { status: 400 });
  }
  try {
    if (['list', 'status', 'transcript'].includes(input.action)) {
      return NextResponse.json({ ok: true, result: await standingLaneAction(input.action, input) });
    }
    const clientKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (!clientKey) return NextResponse.json({ ok: false, error: { code: 'idempotency_key_required', message: 'idempotencyKey is required.' } }, { status: 400 });
    const body = JSON.stringify(input);
    const binding = bindIdempotencyClientMutation({ namespace: 'standing_lane', clientKey, body });
    if (binding.status !== 'bound' && binding.status !== 'matched') {
      if (binding.status === 'conflict') throw new Error('idempotencyKey was already used for a different lane action.');
      if (binding.status === 'unavailable') throw new Error('Idempotency store is unavailable.');
    }
    const key = deriveIdempotencyKey({ verb: 'standing_lane', scopeId: input.laneId ?? input.repoPath ?? '', clientKey, body });
    const outcome = await withIdempotency({ key, verb: 'standing_lane', scopeId: input.laneId ?? input.repoPath ?? '' },
      () => standingLaneAction(input.action, input));
    if (outcome.inProgress) throw new Error('Standing lane action is already in progress; inspect status before retrying.');
    return NextResponse.json({ ok: true, result: outcome.result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { code: 'standing_lane_refused', message: error instanceof Error ? error.message : 'Standing lane action failed.' } }, { status: 409 });
  }
}
