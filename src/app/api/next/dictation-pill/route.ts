import { NextRequest, NextResponse } from 'next/server';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { requestNextHud, requestNextInk, requestNextPill } from '@/lib/next/browser-pipe';
import { inkReply, inkRequestValid } from '@/lib/next/spatial-ink';
import { validPlacement } from '@/lib/next/hud-placement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let enabled = false;
let hudEnabled = false;
let inkEnabled = false;

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
  const ink = !!body && typeof body === 'object' && body.surface === 'ink';
  if (!body || typeof body !== 'object' || !(ink ? ['prepare', 'arm', 'frame', 'release'] : ['prepare', 'frame', 'release']).includes(String(body.action))) {
    return NextResponse.json({ native: false }, { status: 400 });
  }
  // The draw-on-screen ink panel: its own flag, window and pointer capture.
  if (ink) {
    if (!inkRequestValid(body)) return NextResponse.json({ native: false }, { status: 400 });
    if (body.action === 'prepare' || body.action === 'arm') inkEnabled = (await getOperatorDefaults()).values.nativeSpatialInk === true;
    if (!inkEnabled) return NextResponse.json({ native: false, enabled: false });
    const pending = requestNextInk(body);
    const reply = await pending as Record<string, unknown> | null;
    return NextResponse.json({ enabled: true, absent: pending === null || reply?.absent === true, ...inkReply(reply) },
      { headers: { 'Cache-Control': 'no-store' } });
  }
  // The caret/HUD feedback panel has its own flag and window; it reports no clicks.
  const hud = body.surface === 'hud';
  if (hud && !hudPlacementValid(body.snapshot)) return NextResponse.json({ native: false }, { status: 400 });
  // Session boundaries refresh the flag; level frames use that decision.
  if (body.action === 'prepare' || body.checkSettings === true) {
    const values = (await getOperatorDefaults()).values;
    if (hud) hudEnabled = values.nativeDictationHud === true;
    else enabled = values.nativeDictationPill === true;
  }
  if (!(hud ? hudEnabled : enabled)) return NextResponse.json({ native: false, enabled: false });
  if (hud) {
    const pending = requestNextHud(body);
    const reply = await pending as { ok?: boolean; absent?: boolean } | null;
    return NextResponse.json({ enabled: true, native: reply?.ok === true, absent: pending === null || reply?.absent === true },
      { headers: { 'Cache-Control': 'no-store' } });
  }
  const pending = requestNextPill(body);
  const reply = await pending as { ok?: boolean; absent?: boolean; finishSession?: number | null; actions?: unknown } | null;
  const actions = capsuleActions(reply?.actions);
  return NextResponse.json({ enabled: true, native: reply?.ok === true, absent: pending === null || reply?.absent === true,
    ...(typeof reply?.finishSession === 'number' ? { finishSession: reply.finishSession } : {}),
    ...(actions.length ? { actions } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

const ACTIONS: Record<string, string> = {
  pause: 'speaking', stop: 'speaking', speed: 'speaking', interrupt: 'working', 'voice-stop': 'voice', 'workers-expand': 'workers',
  'ask-close': 'ask', 'ask-copy': 'ask', 'ask-active': 'ask',
};
/** Frames the edit chip can be drawn under; a revert names one of them and its chip. */
const CHIP_FRAMES = new Set(['requesting-mic', 'recording', 'transcribing', 'polishing', 'success', 'error', 'speaking', 'working', 'voice', 'workers', 'extras', 'ask']);

/** Click intents from the native panel; only well-formed capsule intents pass. */
function capsuleActions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item: Record<string, unknown> | null): Record<string, unknown>[] => {
    if (!item || typeof item !== 'object' || typeof item.session !== 'number' || typeof item.action !== 'string') return [];
    if (item.action === 'revert') {
      if (!CHIP_FRAMES.has(String(item.state)) || !Number.isSafeInteger(item.edit)) return [];
      return [{ session: item.session, state: item.state, action: 'revert', value: null, edit: item.edit }];
    }
    if (!Object.hasOwn(ACTIONS, item.action) || ACTIONS[item.action] !== item.state) return [];
    const value = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null;
    if (item.action === 'speed' && value === null) return [];
    // An Ask intent names the thread revision it was drawn for; a copy also names the answer.
    if (item.action.startsWith('ask-')) {
      if (typeof item.ref !== 'string' || !/^\d{1,15}$/.test(item.ref)) return [];
      if (item.action === 'ask-copy' && !Number.isSafeInteger(value)) return [];
      return [{ session: item.session, state: item.state, action: item.action, value, ref: item.ref }];
    }
    return [{ session: item.session, state: item.state, action: item.action, value }];
  });
}

/** A HUD frame's placement, when present, must be a sane desktop rectangle. */
function hudPlacementValid(snapshot: unknown) {
  const hud = snapshot && typeof snapshot === 'object' ? (snapshot as { hud?: unknown }).hud : undefined;
  const placement = hud && typeof hud === 'object' ? (hud as { placement?: unknown }).placement : undefined;
  if (placement === undefined) return true;
  return !!placement && typeof placement === 'object' && validPlacement(placement as Record<'x' | 'y' | 'width' | 'height', unknown>);
}
