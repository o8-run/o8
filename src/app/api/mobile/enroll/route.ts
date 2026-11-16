/**
 * Mobile device enrollment.
 *
 * The bootstrap endpoint an UNPAIRED phone calls — it has no bearer token yet,
 * so it authenticates with the single-use `enroll` code carried by the pairing
 * QR (allow-listed in src/middleware.ts as any-method; the code IS the auth).
 * Registers the device's Ed25519 identity, mints a per-device revocable token,
 * and returns it once (only its sha256 is stored) plus the pinned server identity.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { mobileE2eeEnabled } from '@/lib/mobile/e2ee-flag';
import { consumeEnrollCode, enrollDevice } from '@/lib/mobile/device-registry';
import { ServerIdentityUnavailableError, getServerIdentityPublicKey } from '@/lib/mobile/e2ee-identity';

interface EnrollBody {
  enroll?: unknown;
  identityPublicKey?: unknown;
  deviceLabel?: unknown;
}

export async function POST(req: NextRequest) {
  // Off-path: enrollment doesn't exist until the operator turns E2EE on.
  if (!mobileE2eeEnabled()) {
    return NextResponse.json({ error: 'Mobile E2EE is not enabled' }, { status: 404 });
  }

  let body: EnrollBody;
  try {
    body = (await req.json()) as EnrollBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const enroll = typeof body.enroll === 'string' ? body.enroll.trim() : '';
  const identityPublicKey = typeof body.identityPublicKey === 'string' ? body.identityPublicKey.trim() : '';
  const deviceLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel.trim() : null;

  if (!identityPublicKey) {
    return NextResponse.json({ error: 'identityPublicKey required' }, { status: 400 });
  }
  // Single-use + TTL: a valid code is consumed here so it can't be replayed.
  if (!enroll || !consumeEnrollCode(enroll, Date.now())) {
    return NextResponse.json({ error: 'Invalid or expired enroll code' }, { status: 403 });
  }

  try {
    const serverIdentityPublicKey = getServerIdentityPublicKey();
    const { deviceToken } = enrollDevice({ identityPublicKey, deviceLabel });
    return NextResponse.json({
      deviceToken,
      serverIdentityPublicKey,
    });
  } catch (error) {
    if (error instanceof ServerIdentityUnavailableError) return NextResponse.json({ error: error.message, code: 'server_identity_unavailable', retryable: true }, { status: 503, headers: { 'Retry-After': '2' } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Enrollment failed' },
      { status: 500 },
    );
  }
}
