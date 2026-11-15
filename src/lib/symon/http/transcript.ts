import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getSymonBrain } from '@/lib/symon/durable/brain';

/** One thread's user and assistant text, oldest first (#3455). */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const key = request.nextUrl.searchParams.get('key')?.trim() ?? '';
  if (!key || key.length > 320) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 100);
  let brain;
  try {
    brain = await getSymonBrain();
  } catch {
    return NextResponse.json({ ok: false, error: 'brain_unavailable' }, { status: 503 });
  }
  const transcript = await brain.transcript(key, Number.isFinite(limit) ? limit : 100);
  if (!transcript) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true, key, transcript });
}
