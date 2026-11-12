export const dynamic = 'force-dynamic';

import { packetHasRecordedPr } from '@/lib/artifacts/worker-binding';
import { NextResponse } from 'next/server';
import { mirrorProofToPr } from '@/lib/artifacts/pr-mirror';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getLane } from '@/lib/lane/registry';

/**
 * POST /api/panel/artifacts/mirror — mirror a packet/lane's before/after proof
 * stills onto a GitHub PR (#1147 Phase 2). Body: { repoSlug, prNumber, packetId? | laneId? }.
 * Loopback-gated by the /api/panel/ middleware prefix. Best-effort: returns a
 * structured result; mirrorProofToPr never throws.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const repoSlug = typeof body.repoSlug === 'string' ? body.repoSlug.trim() : '';
  const prNumber = Number(body.prNumber);
  const packetId = typeof body.packetId === 'string' && body.packetId.trim() ? body.packetId.trim() : null;
  const laneId = typeof body.laneId === 'string' && body.laneId.trim() ? body.laneId.trim() : null;

  if (!repoSlug || !Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'Provide repoSlug ("owner/repo") and a positive integer prNumber.' }, { status: 400 });
  }
  if (!packetId && !laneId) {
    return NextResponse.json({ error: 'Provide packetId or laneId.' }, { status: 400 });
  }
  const principal = resolveRequestPrincipalContext(request);
  const ownershipRefusal = workerPacketRefusal(
    principal,
    packetId || (laneId ? getLane(laneId)?.packetId : null),
  ) || (laneId ? workerPacketRefusal(principal, getLane(laneId)?.packetId) : null);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  if (principal.role === 'worker') {
    const recorded = principal.packetId && packetHasRecordedPr(principal.packetId, prNumber, repoSlug);
    if (!recorded) {
      return NextResponse.json({ ok: false, error: { code: 'worker_packet_mismatch',
        message: 'The destination must be a recorded PR for the caller packet.' } }, { status: 403 });
    }
  }

  const result = await mirrorProofToPr({ repoSlug, prNumber, packetId, laneId });
  return NextResponse.json(result, { status: result.mirrored ? 200 : 422 });
}
