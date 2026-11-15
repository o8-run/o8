import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getSymonBrain } from '@/lib/symon/durable/brain';

/** Recent Symon threads from every source, newest first (#3455). */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 50);
  try {
    const brain = await getSymonBrain();
    return NextResponse.json({ ok: true, conversations: await brain.list(Number.isFinite(limit) ? limit : 50) });
  } catch {
    return NextResponse.json({ ok: false, error: 'brain_unavailable' }, { status: 503 });
  }
}
