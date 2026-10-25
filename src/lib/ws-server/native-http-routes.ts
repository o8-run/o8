/** Shell transport work: reuse surface handlers on the opt-in WS listener without Next. */
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import { panelGateMiddleware } from '@/middleware';
import { matchNativeHttpRoute } from './native-http-registry';
export { nativeSurfaceRoutes } from './native-http-registry';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const REQUEST_LIMIT = 16 * 1024 * 1024;

/** Returns false for unregistered paths so the existing listener keeps its behavior. */
export async function handleNativeHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.url?.startsWith('/api/')) return false;
  const abort = new AbortController();
  const disconnected = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', disconnected);
  try {
    const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
    const match = matchNativeHttpRoute(url.pathname);
    if (!match) return false;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    // The Rust HTTP relay does not attest the original peer. Its loopback
    // upstream socket must never grant a local-only capability to a caller.
    // Require the existing bearer gate even for local-only producer reads.
    headers.set('x-o8-client-addr', 'unverified-proxy');
    headers.delete('x-o8d-peer');
    headers.delete('x-o8d-bridge');
    const init = { method: req.method, headers, signal: abort.signal };
    const gate = panelGateMiddleware(new NextRequest(url, init));
    let response: Response;
    if (gate.headers.get('x-middleware-next') !== '1') response = gate;
    else if (!match.route.methods.includes(req.method ?? 'GET')) {
      response = Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: match.route.methods.join(', ') } });
    } else {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > REQUEST_LIMIT) break;
        chunks.push(Buffer.from(chunk));
      }
      if (size > REQUEST_LIMIT) response = Response.json({ error: 'Request exceeds 16 MiB' }, { status: 413 });
      else {
        const handlers = await match.route.load() as Record<string, Handler>;
        const request = new NextRequest(url, { ...init, ...(size ? { body: Buffer.concat(chunks) } : {}) });
        if (request.method === 'GET' && match.route.path === '/api/lanes/[id]/diff') {
          const { resolvePacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
          const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '').trim();
          if (bearer && resolvePacketWorkerToken(bearer)) {
            // Preserve local packet-worker admission only after the bearer gate
            // and authoritative token lookup. The handler checks ownership again.
            request.headers.set('x-o8-client-addr', '127.0.0.1');
          }
        }
        response = await handlers[req.method ?? 'GET'](request, { params: Promise.resolve(match.params!) });
      }
    }
    if (res.destroyed) { await response.body?.cancel(); return true; }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
        }
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    }
    res.end();
    return true;
  } catch {
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"Native route unavailable"}');
    }
    return true;
  } finally {
    req.resume();
    res.off('close', disconnected);
  }
}
