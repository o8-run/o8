import { NextRequest, NextResponse } from 'next/server';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { PREVIEW_DOCUMENT_CSP } from '@/lib/panel/preview-proxy-security';

export const dynamic = 'force-dynamic';

/** Local preview documents navigate at their source origin without app authority. */

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
  try {
    // redirect:'manual' — never follow a redirect server-side. A followed
    // redirect escapes the localhost allow-list (→ metadata/external/own-API
    // SSRF). On a 3xx, revalidate the resolved Location (#1644): a target
    // that passes the same localhost/own-port gate stays INSIDE the proxy
    // (document remains same-origin + grabbable); anything else is refused
    // before the browser can follow it.
    const upstream = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html,*/*' } });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      let resolved: string | null = null;
      try {
        resolved = location ? new URL(location, url).toString() : null;
      } catch {
        resolved = null;
      }
      if (!resolved || !LOCAL_TARGET.test(resolved) || targetsOwnPort(resolved)) {
        return NextResponse.json(
          { error: 'redirect target is not permitted by the browser proxy policy' },
          { status: 400 },
        );
      }
      const proxied = new URL('/api/browser/proxy', request.nextUrl.origin);
      proxied.searchParams.set('url', resolved);
      return NextResponse.redirect(proxied, 302);
    }
    // Origin-sensitive auth frameworks (Clerk, etc.) break when proxied to a
    // different origin — their frontend API rejects the mismatched origin and
    // the SPA renders blank. Detect the marker and hand the iframe the DIRECT
    // url so it loads at its REAL origin (renders + interactive for the human;
    // cross-origin, so the agent grab can't reach it — an inherent tradeoff).
    if (upstream.headers.has('x-clerk-auth-status') || upstream.headers.has('x-clerk-auth-reason')) {
      return NextResponse.redirect(url, 302);
    }
    const type = upstream.headers.get('content-type') ?? 'text/html';
    const contentType = type.toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      const body = await upstream.arrayBuffer();
      return new NextResponse(body, { status: upstream.status, headers: {
        'content-type': type,
        'content-security-policy': PREVIEW_DOCUMENT_CSP,
        'x-content-type-options': 'nosniff',
      } });
    }
    return NextResponse.redirect(url, 302);
  } catch (error) {
    // The server RESPONDED but we couldn't proxy it (most often a Clerk-style
    // auth redirect loop our cookieless fetch can't satisfy) — hand the iframe
    // the direct url so the browser, which HAS the cookies, renders it.
    const code = (error as { cause?: { code?: string } } | null)?.cause?.code;
    const serverDown = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
    if (!serverDown) {
      return NextResponse.redirect(url, 302);
    }
    return new NextResponse(
      `<!doctype html><body style="font-family:system-ui;padding:24px;font-size:13px;color:#555">Could not reach ${url.replace(/</g, '&lt;')} — is that server running?</body>`,
      { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}
