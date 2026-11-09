import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelOrWorkerAuth } from '@/lib/auth/packet-worker-auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getLane } from '@/lib/lane/registry';
import { recordLaneHeartbeat } from '@/lib/lane/reaper';
import { checkSessionBindingFault } from '@/lib/lane/session-binding-fault';
import { heartbeatAgentPresence } from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelOrWorkerAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), getLane(id)?.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }
  const body = await req.json().catch(() => null) as { heartbeatAt?: unknown } | null;
  const heartbeatAt = typeof body?.heartbeatAt === 'number' && Number.isFinite(body.heartbeatAt)
    ? body.heartbeatAt
    : Date.now();
  const lane = recordLaneHeartbeat(id, heartbeatAt);
  if (!lane) {
    return NextResponse.json({ ok: false, note: 'Lane not found.' }, { status: 404 });
  }

  // #1502 — a live worker heartbeating with no session binding is running into
  // the void (empty transcript, silent-exit misfire). Raise the fault once.
  checkSessionBindingFault(id);
  heartbeatAgentPresence(lane, heartbeatAt);

  return NextResponse.json({
    ok: true,
    lane,
    heartbeatAt,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
