import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';

/**
 * In-handler loopback trust. Delegates to the SHARED loopback-request logic so
 * it cannot diverge from the middleware gate: socket truth (`x-o8-client-addr`,
 * stamped by the bundled server and unspoofable) wins when present, otherwise a
 * loopback Host header (dev fallback).
 *
 * The previous implementation read `origin === req.nextUrl.origin` and trusted
 * `sec-fetch-site: same-origin|none` with no loopback-Host requirement — both
 * client-forgeable, so a non-browser LAN client bypassed it with one header
 * (SECURITY_AUDIT_2026-07-02 §HIGH-1). Every route touching state is also gated
 * by src/middleware.ts (default-deny); this stays as defense-in-depth.
 */
export function isTrustedPanelRequest(req: NextRequest) {
  return headersIndicateLoopback((name) => req.headers.get(name));
}

/** Constant-time token comparison (length leak is fine — the token is fixed-size). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requirePanelAuth(req: NextRequest): NextResponse | null {
  if (isTrustedPanelRequest(req)) {
    return null;
  }

  const panelApiToken = getOrCreateWsToken().trim();
  const auth = req.headers.get('authorization');
  const token = (auth?.startsWith('Bearer ') ? auth.slice(7) : '')?.trim() ?? '';
  if (!panelApiToken || !tokenMatches(token, panelApiToken)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
