import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelOrWorkerAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getLane, getLaneEvents } from '@/lib/lane/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelOrWorkerAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const lane = getLane(id);
  if (!lane) {
    return NextResponse.json({ ok: false, note: 'Lane not found.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), lane.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  const url = new URL(req.url);
  const eventsLimit = parseInt(url.searchParams.get('events') ?? '50', 10);
  const events = getLaneEvents(id, eventsLimit);

  return NextResponse.json({ lane, events }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
