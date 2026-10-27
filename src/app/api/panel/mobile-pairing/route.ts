/**
 * Mobile pairing payload — the data the desktop QR code encodes.
 *
 * The native o8 mobile app (hurttlocker/o8-mobile) can't inherit the backend
 * address the way the old PWA did — the phone loads nothing from the Mac. So
 * desktop emits a QR with everything the phone needs to reach this backend:
 *
 *   { host, apiPort, wsPort, token }
 *
 * `host` prefers the Mac's Tailscale IPv4 so the phone keeps working away from
 * local Wi-Fi, with LAN IPv4 as a fallback. `token` is the ws-token already
 * trusted by `src/middleware.ts` as a `Bearer` credential for non-loopback
 * callers — pairing only delivers it, the auth model is unchanged.
 *
 * Gated under `/api/panel/*` middleware: the desktop webview calls it from
 * loopback (passes automatically); a cross-origin caller would already need
 * the token to get here.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { pickMobilePairingHosts, type ReachableMobileHostKind } from '@/lib/panel/lan-ip';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { mobileE2eeEnabled } from '@/lib/mobile/e2ee-flag';
import { createEnrollCode } from '@/lib/mobile/device-registry';
import { getServerIdentityPublicKey } from '@/lib/mobile/e2ee-identity';
import { lanAccessEnabled } from '@/lib/panel/listen-host';

interface MobilePairingResponse {
  /** Protocol version the phone reads to pick the enroll vs legacy-token path. */
  v: 1;
  /** Mac's preferred host (hosts[0]) — null when no reachable interface is found. */
  host: string | null;
  hostKind: ReachableMobileHostKind | null;
  /**
   * Every address the phone might reach this Mac at, preference order
   * (override → Tailscale → LAN). The phone probes these on scan and pairs
   * with the first that answers.
   */
  hosts: string[];
  apiPort: number;
  wsPort: number;
  /**
   * Whether o8's local servers accept non-loopback connections. They bind
   * 127.0.0.1 unless the operator launched o8 with O8_LAN_ACCESS=1, so when
   * this is false no advertised host is reachable from the phone directly.
   */
  lanAccess: boolean;
  /** Shared ws-token — kept during transition; a new (enroll-aware) app ignores it. */
  token: string;
  /** Single-use enroll code (E2EE mode only) — the phone POSTs it to /api/mobile/enroll. */
  enroll?: string;
  /** base64 server Ed25519 identity pub (E2EE mode only) — the phone pins it. */
  sIdent?: string;
}

export async function GET(request: NextRequest) {
  try {
    // An enrolled PHONE (per-device token, over the relay) refreshes its pairing
    // config here — but it must NEVER receive the operator ws-token: an E2EE phone
    // authenticates with its own device token and already ignores parsed.token
    // (o8-mobile refreshPairingConfig). Returning the ws-token to a device would
    // hand a scoped credential full operator authority. So a device gets host/port
    // refresh only, with token: '' (isO8Config still requires the string field) and
    // no fresh enroll code. Operator/loopback (the desktop-webview QR path) is
    // unchanged. A dispatched worker has no business pairing.
    const principal = resolveRequestPrincipal(request);
    if (principal === 'worker') {
      return NextResponse.json({ error: 'A dispatched worker cannot read pairing config.' }, { status: 403 });
    }
    const isDevice = principal === 'device';

    const { apiPort, wsPort } = resolvePortInfo();
    const pairingHosts = pickMobilePairingHosts();
    const primary = pairingHosts[0] ?? { host: null, kind: null };
    const payload: MobilePairingResponse = {
      v: 1,
      host: primary.host,
      hostKind: primary.kind,
      hosts: pairingHosts
        .map((h) => h.host)
        .filter((h): h is string => h !== null),
      apiPort,
      wsPort,
      lanAccess: lanAccessEnabled(),
      // Operator/loopback QR needs the real ws-token; a device gets an empty
      // string (its own device token authenticates it, and its client ignores
      // this field) so the operator credential never crosses to a device.
      token: isDevice ? '' : getOrCreateWsToken(),
    };
    // E2EE mode — additionally carry a one-time enroll code + the pinned server
    // identity for the desktop QR only. A device is already enrolled; minting a
    // fresh enroll code on every pairing refresh would be wasteful and risky.
    if (mobileE2eeEnabled() && !isDevice) {
      payload.enroll = createEnrollCode(Date.now());
      payload.sIdent = getServerIdentityPublicKey();
    }
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build pairing payload' },
      { status: 500 },
    );
  }
}
