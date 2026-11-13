import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getSymonBrain } from '@/lib/symon/durable/brain';

const VOICE_KEY = /^voice:[A-Za-z0-9_-]{1,120}$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{1,160}$/;

/**
 * Records voice transcript lines into a `voice:` thread of the Symon store
 * (#3455), so voice sessions appear with the other threads. Writes only; the
 * model is not asked. A repeated request id records nothing new.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { key?: unknown; requestId?: unknown; entries?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const entries = Array.isArray(body?.entries) ? body.entries : null;
  const valid = entries && entries.length > 0 && entries.length <= 20 && entries.every((entry) => entry
    && typeof entry === 'object'
    && ((entry as { role?: unknown }).role === 'user' || (entry as { role?: unknown }).role === 'assistant')
    && typeof (entry as { text?: unknown }).text === 'string'
    && ((entry as { text: string }).text.trim().length > 0)
    && (entry as { text: string }).text.length <= 8_000);
  if (!VOICE_KEY.test(key) || !REQUEST_ID.test(requestId) || !valid) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  try {
    const brain = await getSymonBrain();
    await brain.record({
      key,
      source: 'voice',
      title: 'Voice',
      requestId: `voice:${requestId}`,
      entries: entries as Array<{ role: 'user' | 'assistant'; text: string }>,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'brain_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
