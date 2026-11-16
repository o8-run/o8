export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { phoneToolServer } from '@/lib/symon/execution/server';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const confirmationId = typeof body?.confirmationId === 'string' ? body.confirmationId : '';
  const allow = typeof body?.allow === 'boolean' ? body.allow : null;
  const terminal = body?.terminal === 'expired' || body?.terminal === 'preempted'
    ? body.terminal
    : undefined;
  const invalidTerminal = body?.terminal !== undefined && terminal === undefined;
  if (!sessionId || !callId || !confirmationId || allow === null || invalidTerminal || (allow && terminal)) {
    return NextResponse.json({ ok: false, error: 'bad_request' });
  }

  return NextResponse.json(phoneToolServer.decide({
    sessionId,
    callId,
    confirmationId,
    allow,
    ...(terminal ? { terminal } : {}),
  }));
}
