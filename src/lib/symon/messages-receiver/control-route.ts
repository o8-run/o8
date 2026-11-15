import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readIMessageAccessSettings, setIMessageBridgeEnabled } from '@/lib/symon/imessage-access-settings';
import { ownsMessagesReceiver } from './owner';
import { getMessagesReceiver } from '@/lib/symon/messages-receiver/loop';
import { configureMessagesReceiver, isMessagesHandle } from '@/lib/symon/messages-receiver/receiver';

/** o8's own Messages receiver for Symon (#3454): state and authorized handles. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (process.platform === 'darwin' && !ownsMessagesReceiver()) {
    return NextResponse.json({ ok: false, error: 'receiver_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, ...getMessagesReceiver().status() });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (process.platform === 'darwin' && !ownsMessagesReceiver()) {
    return NextResponse.json({ ok: false, error: 'receiver_unavailable' }, { status: 503 });
  }
  const body = await request.json().catch(() => null) as { enabled?: unknown; handles?: unknown } | null;
  if (typeof body?.enabled !== 'boolean' || !Array.isArray(body.handles)
    || body.handles.length > 20 || !body.handles.every(isMessagesHandle)) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  if (body.enabled && body.handles.length === 0) {
    return NextResponse.json({ ok: false, error: 'handles_required' }, { status: 400 });
  }
  try {
    // One receiver answers at a time, so a message is never answered twice.
    if (body.enabled && readIMessageAccessSettings().enabled) setIMessageBridgeEnabled(false);
    configureMessagesReceiver({ enabled: body.enabled, handles: body.handles });
  } catch {
    return NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...getMessagesReceiver().status() });
}
