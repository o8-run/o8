import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { O8_RELAY_FORWARD_HEADER } from '@/lib/connect/web-machine-surface';
import { getWsBase } from '@/lib/panel/api-port';

type Handler = (request: Request) => Promise<Response>;

/**
 * The loopback page origin a browser used to reach Next. The WS listener sees
 * its own Host, so a handler that embeds or allows the caller's page (a device
 * viewer, a task preview) reads the origin Next checked from this header.
 */
export const O8_PAGE_ORIGIN_HEADER = 'x-o8-page-origin';

type Options = {
  /** Route-specific context only; never caller-address or transport attestation headers. */
  requestHeaders?: ReadonlyArray<'cookie' | 'x-tab-id' | 'x-cortex-repo-path'>;
  /** Checks the caller's page on the Next side: its origin to forward, or a refusal. */
  pageOrigin?: (request: Request) => string | Response;
};

/**
 * Some handlers keep per-process state (an installer, a pending request). With
 * the native transport on, the WS process owns that state (#5422), so the Next
 * route forwards to it and never keeps a second copy. The WS listener runs the
 * same bearer gate again; only the caller's credential, account header, body
 * and a remote-caller marker travel, never a local-address header.
 */
export function ownedByNativeTransport(handler: Handler, unavailable: () => Response, options: Options = {}): Handler {
  return async request => {
    // Only this wrapper sets the page origin; a caller never supplies it.
    if (options.pageOrigin && request.headers.has(O8_PAGE_ORIGIN_HEADER)) {
      return Response.json({ error: { code: 'page_origin_refused', message: 'Open this from the app.' } }, { status: 400 });
    }
    if (process.env.O8_NEXT_O8D !== '1') return handler(request);
    const url = new URL(request.url);
    const headers = new Headers();
    if (options.pageOrigin) {
      const page = options.pageOrigin(request);
      if (page instanceof Response) return page;
      headers.set(O8_PAGE_ORIGIN_HEADER, page);
    }
    for (const name of ['authorization', 'content-type', 'x-clerk-session-token', ...(options.requestHeaders ?? [])]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    // This hop reaches the WS listener from loopback. Mark a caller Next did not
    // see as local, so the listener stamps it remote rather than loopback.
    if (!headersIndicateLoopback(name => request.headers.get(name))) headers.set(O8_RELAY_FORWARD_HEADER, '1');
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      const response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}${url.pathname}${url.search}`,
        { method: request.method, headers, body, redirect: 'manual', cache: 'no-store', signal: request.signal });
      // fetch has already decoded the body; framing headers belong to that hop.
      const forwarded = new Headers(response.headers);
      if (forwarded.has('content-encoding')) forwarded.delete('content-length');
      for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding']) forwarded.delete(name);
      return new Response(response.body, { status: response.status, headers: forwarded });
    } catch (error) {
      console.warn(`[native-owner] ${url.pathname} could not reach the WS listener:`, error instanceof Error ? error.message : error);
      return unavailable();
    }
  };
}
