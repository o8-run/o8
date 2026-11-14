import { NextRequest, NextResponse } from 'next/server';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { requestNextPill } from '@/lib/next/browser-pipe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let enabled = false;

/** Existing API authorization applies; this route grants no voice/control authority. */
export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > 8192) {
    return NextResponse.json({ native: false }, { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8192) { await reader.cancel(); return NextResponse.json({ native: false }, { status: 413 }); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ native: false }, { status: 400 }); }
  if (!body || typeof body !== 'object' || !['prepare', 'frame', 'release'].includes(String(body.action))) {
    return NextResponse.json({ native: false }, { status: 400 });
  }
  // Session boundaries refresh the flag; level frames use that decision.
  if (body.action === 'prepare' || body.checkSettings === true) {
    enabled = (await getOperatorDefaults()).values.nativeDictationPill === true;
  }
  if (!enabled) return NextResponse.json({ native: false, enabled: false });
  const pending = requestNextPill(body);
  const reply = await pending as { ok?: boolean; absent?: boolean; finishSession?: number | null; actions?: unknown } | null;
  const actions = capsuleActions(reply?.actions);
  return NextResponse.json({ enabled: true, native: reply?.ok === true, absent: pending === null || reply?.absent === true,
    ...(typeof reply?.finishSession === 'number' ? { finishSession: reply.finishSession } : {}),
    ...(actions.length ? { actions } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

const ACTIONS: Record<string, string> = { pause: 'speaking', stop: 'speaking', speed: 'speaking', interrupt: 'working', 'voice-stop': 'voice' };

/** Click intents from the native panel; only well-formed capsule intents pass. */
function capsuleActions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item: Record<string, unknown> | null) => {
    if (!item || typeof item !== 'object' || typeof item.session !== 'number' || typeof item.action !== 'string') return [];
    if (!Object.hasOwn(ACTIONS, item.action) || ACTIONS[item.action] !== item.state) return [];
    const value = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null;
    if (item.action === 'speed' && value === null) return [];
    return [{ session: item.session, state: item.state, action: item.action, value }];
  });
}
