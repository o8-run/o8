import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listZombieLaneCandidates, reapZombieLanes } from '@/lib/lane/reaper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as { force?: unknown } | null;
  const force = body?.force === true;
  if (!force) {
    const candidates = await listZombieLaneCandidates();
    return NextResponse.json({ ok: true, candidates }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  const reaped = await reapZombieLanes({ source: 'manual', force: true });
  return NextResponse.json({ ok: true, candidates: reaped.map((item) => item.candidate), reaped }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
