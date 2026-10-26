import { NextRequest, NextResponse } from 'next/server';
import { PREVIEW_PROXY_ROUTE } from '@/lib/panel/preview';
import { isSensitivePreviewRequestHeader, parseLocalPreviewTarget, PREVIEW_DOCUMENT_CSP } from '@/lib/panel/preview-proxy-security';
import { createPreviewResourceAccess, hasPreviewResourceAccess, PREVIEW_RESOURCE_KEY } from '@/lib/panel/preview-resource-access';
import { rewritePreviewModule } from '@/lib/panel/rewrite-preview-module';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const FRAME_BUSTING_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
];
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
function parseLocalTarget(targetUrl: string | null): URL | null {
  return parseLocalPreviewTarget(targetUrl);
}

function isSameLocalApp(candidate: URL, target: URL): boolean {
  return (
    candidate.protocol === target.protocol
    && candidate.port === target.port
    && LOCAL_HOSTS.has(candidate.hostname)
    && LOCAL_HOSTS.has(target.hostname)
  );
}

function isSkippableReference(value: string): boolean {
  return (
    !value
    || value.startsWith('#')
    || value.startsWith('about:')
    || value.startsWith('blob:')
    || value.startsWith('data:')
    || value.startsWith('javascript:')
    || value.startsWith('mailto:')
    || value.startsWith('tel:')
    || value.startsWith(PREVIEW_PROXY_ROUTE)
  );
}

function buildProxyUrl(targetUrl: string, access?: string): string {
  return `${PREVIEW_PROXY_ROUTE}?url=${encodeURIComponent(targetUrl)}${access ? `&${PREVIEW_RESOURCE_KEY}=${encodeURIComponent(access)}` : ''}`;
}

function resolveProxyCandidate(value: string, currentUrl: URL): string | null {
  if (isSkippableReference(value)) return null;

  try {
    const resolved = value.startsWith('//')
      ? new URL(`${currentUrl.protocol}${value}`)
      : new URL(value, currentUrl);

    return isSameLocalApp(resolved, currentUrl) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function rewriteAssetReference(value: string, currentUrl: URL, access?: string): string {
  const candidate = resolveProxyCandidate(value, currentUrl);
  return candidate ? buildProxyUrl(candidate, access) : value;
}

function rewriteCssText(css: string, currentUrl: URL, access?: string): string {
  const rewrittenUrls = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote: string, rawValue: string) => {
    const rewritten = rewriteAssetReference(rawValue.trim(), currentUrl, access);
    if (rewritten === rawValue.trim()) return match;
    return `url(${quote}${rewritten}${quote})`;
  });

  return rewrittenUrls.replace(/@import\s+(?!url\()(["'])([^"']+)\1/gi, (match, quote: string, rawValue: string) => {
    const rewritten = rewriteAssetReference(rawValue.trim(), currentUrl, access);
    if (rewritten === rawValue.trim()) return match;
    return `@import ${quote}${rewritten}${quote}`;
  });
}

function rewriteHtml(html: string, currentUrl: URL, appOrigin: string, xhtml: boolean, access: string): string {
  const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  // Static resources stay cookieless through the same confined proxy. The
  // response sandbox, rather than this compatibility script, enforces isolation.
  const rewritten = html.replace(/<base\b[^>]*>/gi, '').replace(
    /\b(src|href|action|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_match, name: string, _quoted: string, double: string | undefined, single: string | undefined) => {
      const value = double ?? single ?? '';
      const candidate = resolveProxyCandidate(value.replaceAll('&amp;', '&'), currentUrl);
      return `${name}="${escapeAttribute(candidate ? appOrigin + buildProxyUrl(candidate, access) : value)}"`;
    },
  );
  const source = `(() => {
    const base = ${JSON.stringify(currentUrl.toString()).replaceAll('<', '\\u003c')};
    const origin = ${JSON.stringify(appOrigin)};
    const proxy = ${JSON.stringify(PREVIEW_PROXY_ROUTE)};
    const access = ${JSON.stringify(`&${PREVIEW_RESOURCE_KEY}=${encodeURIComponent(access)}`)};
    function resolve(value) {
      const url = new URL(String(value), base);
      return url.origin === new URL(base).origin ? origin + proxy + '?url=' + encodeURIComponent(url.href) + access : url.href;
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input instanceof Request) return nativeFetch(new Request(resolve(input.url), input), { ...init, credentials: 'omit' });
      return nativeFetch(resolve(input), { ...init, credentials: 'omit' });
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) { return nativeOpen.call(this, method, resolve(url), ...rest); };
  })();`;
  const bootstrap = `<script>${xhtml ? `//<![CDATA[\n${source}\n//]]>` : source}</script>`;
  return /<head\b[^>]*>/i.test(rewritten)
    ? rewritten.replace(/<head\b[^>]*>/i, match => match + bootstrap)
    : bootstrap + rewritten;
}

function buildUpstreamHeaders(req: NextRequest, targetUrl: URL): Headers {
  const headers = new Headers();

  req.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lowerKey)) return;
    if (isSensitivePreviewRequestHeader(lowerKey)) return;
    if (lowerKey.startsWith('sec-')) return;
    if (lowerKey.startsWith('x-forwarded-')) return;

    if (lowerKey === 'origin') {
      headers.set('origin', targetUrl.origin);
      return;
    }

    if (lowerKey === 'referer') {
      headers.set('referer', targetUrl.toString());
      return;
    }

    headers.set(key, value);
  });

  headers.set('accept-encoding', 'identity');
  if (!headers.has('accept')) headers.set('accept', '*/*');
  return headers;
}

async function proxyRequest(req: NextRequest): Promise<NextResponse> {
  const targetUrl = parseLocalTarget(req.nextUrl.searchParams.get('url'));

  if (!targetUrl) {
    return NextResponse.json(
      { error: 'Invalid url param. Only localhost, 127.0.0.1, 0.0.0.0, and ::1 are allowed.' },
      { status: 400 },
    );
  }

  try {
    const resourceRead = hasPreviewResourceAccess(req.nextUrl);
    // Resource reads may reuse a grant, but cannot extend its lifetime.
    const access = resourceRead
      ? req.nextUrl.searchParams.get(PREVIEW_RESOURCE_KEY)!
      : createPreviewResourceAccess(targetUrl);
    const body = BODYLESS_METHODS.has(req.method)
      ? undefined
      : await req.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, targetUrl),
      body,
      redirect: 'manual',
    });

    const headers = new Headers(upstream.headers);
    FRAME_BUSTING_RESPONSE_HEADERS.forEach((key) => headers.delete(key));
    headers.set('content-security-policy', PREVIEW_DOCUMENT_CSP);
    headers.set('x-content-type-options', 'nosniff');
    // Opaque sandbox documents need anonymous CORS for module and data loads.
    headers.set('access-control-allow-origin', '*');
    headers.delete('access-control-allow-credentials');
    headers.set('cache-control', 'no-store');
    headers.set('referrer-policy', 'no-referrer');
    headers.delete('set-cookie');
    headers.delete('clear-site-data');
    headers.delete('service-worker-allowed');

    const location = headers.get('location');
    if (location) {
      let destination: URL | null = null;
      try { destination = parseLocalTarget(new URL(location, targetUrl).toString()); } catch { /* refused below */ }
      if (!destination) {
        return NextResponse.json({ error: 'redirect target is not permitted by the preview proxy policy' }, { status: 400 });
      }
      if (resourceRead && destination.origin !== targetUrl.origin) {
        return NextResponse.json({ error: 'preview resource redirect changes origin' }, { status: 400 });
      }
      headers.set('location', buildProxyUrl(destination.toString(), resourceRead ? req.nextUrl.searchParams.get(PREVIEW_RESOURCE_KEY)! : undefined));
    }

    if (req.method === 'HEAD' || (upstream.status >= 300 && upstream.status < 400)) {
      return new NextResponse(null, { status: upstream.status, headers });
    }

    const contentType = (headers.get('content-type') ?? '').toLowerCase();

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      // Cookies are shared across ports. Never navigate the browser directly to
      // the source: that would bypass request and response cookie stripping.
      const html = rewriteHtml(await upstream.text(), targetUrl, req.nextUrl.origin, contentType.includes('application/xhtml+xml'), access);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new NextResponse(html, { status: upstream.status, headers });
    }

    if (contentType.includes('text/css')) {
      const css = rewriteCssText(await upstream.text(), targetUrl, access);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new NextResponse(css, { status: upstream.status, headers });
    }

    if (/(?:java|ecma)script/.test(contentType)) {
      const source = await rewritePreviewModule(await upstream.text(), value => {
        const candidate = resolveProxyCandidate(value, targetUrl);
        return candidate ? req.nextUrl.origin + buildProxyUrl(candidate, access) : value;
      });
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new NextResponse(source, { status: upstream.status, headers });
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return NextResponse.json(
      { error: `Proxy error: ${error instanceof Error ? error.message : 'unknown'}` },
      { status: 502 },
    );
  }
}

export const dynamic = 'force-dynamic';

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const OPTIONS = proxyRequest;
export const HEAD = proxyRequest;
