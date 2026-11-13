import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getSymonBrain } from '@/lib/symon/durable/brain';

const APP_KEY = /^app:[A-Za-z0-9_-]{1,120}$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const WAIT_MS = 45_000;

/**
 * Continue a Symon thread from the o8 app (#3455), or start an app thread
 * under an `app:` key. The answer stays in o8; a messaging thread continued
 * here is not sent back to the phone. A repeated request id returns the same
 * turn.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { key?: unknown; requestId?: unknown; text?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!key || key.length > 320 || !REQUEST_ID.test(requestId) || !text || text.length > 8_000) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  let brain;
  try {
    brain = await getSymonBrain();
  } catch {
    return NextResponse.json({ ok: false, error: 'brain_unavailable' }, { status: 503 });
  }
  const existing = await brain.summary(key);
  if (!existing && !APP_KEY.test(key)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  const outcome = await brain.send({
    key,
    source: existing?.source ?? 'app',
    title: existing?.title ?? 'o8',
    requestId: `app:${requestId}`,
    text,
  }, WAIT_MS);
  if (outcome.state === 'pending') return NextResponse.json({ ok: true, state: 'processing' }, { status: 202 });
  if (outcome.state === 'failed') return NextResponse.json({ ok: true, state: 'failed', text: outcome.message });
  return NextResponse.json({ ok: true, state: 'done', text: outcome.text });
}
