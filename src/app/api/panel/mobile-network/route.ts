import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { isLoopbackAddress } from '@/lib/auth/loopback-request';
import { savedLanAccess, savePhoneNetwork, runningPhoneNetwork } from '@/lib/panel/mobile-network';

export const dynamic = 'force-dynamic';

function allowed(request: Request): boolean {
  // Require socket truth from the server wrapper, never Host or forwarded headers.
  const peer = request.headers.get('x-o8-client-addr');
  return process.env.O8_PACKAGED_APP === '1' && !!peer && isLoopbackAddress(peer) && resolveRequestPrincipal(request) === 'operator';
}

async function state() {
  return { ok: true, enabled: savedLanAccess(), running: await runningPhoneNetwork(),
    overridden: process.env.O8_LAN_ACCESS !== undefined };
}

export async function GET(request: Request) {
  if (!allowed(request)) return NextResponse.json({ error: 'Local operator required.' }, { status: 403 });
  return NextResponse.json(await state());
}

export async function POST(request: Request) {
  if (!allowed(request)) return NextResponse.json({ error: 'Local operator required.' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean.' }, { status: 400 });
  }
  try {
    savePhoneNetwork(body.enabled);
    return NextResponse.json(await state());
  } catch {
    return NextResponse.json({ error: 'Could not save phone access.' }, { status: 500 });
  }
}
