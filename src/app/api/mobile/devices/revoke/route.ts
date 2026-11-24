/**
 * Revoke a paired device. Operator-only (gated like the rest
 * of /api/mobile/*). Marks the device revoked + rewrites the active-token-hash
 * file, so the device's HTTP calls fail at the middleware immediately and its
 * next WS reconnect is refused. (Force-closing a LIVE WS connection lands with
 * the Stage-2 channel work.)
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { revokeDevice } from '@/lib/mobile/device-registry';
import { notifyMobileDevicesChanged } from '@/lib/mobile/relay-connector-sync';

interface RevokeBody {
  deviceId?: unknown;
}

export async function POST(req: NextRequest) {
  if (resolveRequestPrincipal(req) !== 'operator') {
    return NextResponse.json({ error: 'Paired-device administration is operator-only.' }, { status: 403 });
  }
  let body: RevokeBody;
  try {
    body = (await req.json()) as RevokeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId required' }, { status: 400 });
  }

  try {
    const revoked = revokeDevice(deviceId);
    // The last revoked phone stops the off-network connector.
    if (revoked) await notifyMobileDevicesChanged();
    return NextResponse.json({ revoked });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Revoke failed' },
      { status: 500 },
    );
  }
}
