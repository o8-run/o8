import { NextRequest, NextResponse } from 'next/server';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { GET as proxyPreview } from '@/app/api/panel/proxy/route';

export const dynamic = 'force-dynamic';

/** Local preview documents share the panel proxy's opaque, cookieless delivery. */

const LOCAL_TARGET = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i;

/**
 * Deny targeting o8's OWN api/ws ports. Without this, browser/proxy is an SSRF
 * that launders a request into the loopback-gated API: the internal fetch
 * originates from 127.0.0.1, so the middleware trusts it as loopback and the
 * gate is bypassed (SECURITY_AUDIT_2026-07-02 §CRIT-3, Chain A/B).
 */
function targetsOwnPort(url: string): boolean {
  try {
    const { apiPort, wsPort } = resolvePortInfo();
    const port = parseInt(new URL(url).port || '80', 10);
    return port === apiPort || port === wsPort;
  } catch {
    // Unparseable → treat as suspicious and deny.
    return true;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url') ?? '';
  if (!LOCAL_TARGET.test(url)) {
    return NextResponse.json({ error: 'localhost targets only' }, { status: 400 });
  }
  if (targetsOwnPort(url)) {
    return NextResponse.json({ error: 'cannot proxy the o8 server itself' }, { status: 400 });
  }
  return proxyPreview(request);
}
