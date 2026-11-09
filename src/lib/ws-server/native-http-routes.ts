/** Shell transport work: reuse surface handlers on the opt-in WS listener without Next. */
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import { panelGateMiddleware } from '@/middleware';
import { mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { matchNativeHttpRoute } from './native-http-registry';
import { nativeSessionReadsEnabled } from './native-session-reads';
import { markNativeCortexReader } from '@/lib/cortex/owner-process';
import { isLoopbackAddress } from '@/lib/auth/loopback-request';
import { O8_RELAY_FORWARD_HEADER, O8_RELAY_FORWARD_MARKER, O8_RELAY_SURFACE_HEADER, O8_WEB_MACHINE_SURFACE } from '@/lib/connect/web-machine-surface';
import { browserWriteAllowed, isAllowedLocalHost, requestTargetAllowed } from '../../../scripts/lib/http-request-boundary.cjs';
export { nativeSurfaceRoutes } from './native-http-registry';

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const REQUEST_LIMIT = 16 * 1024 * 1024;

/**
 * The x-o8-client-addr stamp for a native request, matching the production
 * wrapper's: the caller's real address, with every boundary able only to
 * remove loopback trust. No address (an unattested relay) is never loopback.
 */
export function nativeClientAddr(clientAddress: string | null, get: (name: string) => string | null,
  method: string, target: string, publicPort: number | undefined): { address: string; relaySurface: string | null } {
  if (!clientAddress) return { address: 'unverified-proxy', relaySurface: null };
  if (!isLoopbackAddress(clientAddress)) return { address: clientAddress, relaySurface: null };
  // A same-host relay (the mobile connector, a Next route forwarding here)
  // replays a remote caller, so its request is remote, never loopback.
  if (get(O8_RELAY_FORWARD_HEADER) === '1') {
    return { address: O8_RELAY_FORWARD_MARKER,
      relaySurface: get(O8_RELAY_SURFACE_HEADER) === O8_WEB_MACHINE_SURFACE ? O8_WEB_MACHINE_SURFACE : null };
  }
  const host = get('host');
  if (!host || publicPort === undefined || !isAllowedLocalHost(host, publicPort) || !requestTargetAllowed(target, publicPort)
    || !browserWriteAllowed(method, get, 'http:')) return { address: 'unverified-proxy', relaySurface: null };
  return { address: clientAddress, relaySurface: null };
}

/** Returns false for unregistered paths so the existing listener keeps its behavior. */
export async function handleNativeHttp(req: IncomingMessage, res: ServerResponse, publicPort = req.socket.localPort,
  authenticatedBridge = false, clientAddress: string | null = null): Promise<boolean> {
  markNativeCortexReader();
  if (!req.url?.startsWith('/api/')) return false;
  const abort = new AbortController();
  const disconnected = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', disconnected);
  try {
    // o8d relays from the public port to a private listener and keeps the
    // client's Host, so the gate must compare Host with the public port.
    const url = new URL(req.url, `http://127.0.0.1:${publicPort}`);
    const match = matchNativeHttpRoute(url.pathname, req.method) ?? matchNativeHttpRoute(url.pathname);
    if (!match) return false;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    // The listener passes the caller's real address: o8d's attested peer on its
    // private upstream, never the relay's own loopback socket.
    const stamp = nativeClientAddr(clientAddress, name => headers.get(name), req.method ?? 'GET', req.url, publicPort);
    headers.set('x-o8-client-addr', stamp.address);
    headers.delete(O8_RELAY_SURFACE_HEADER);
    if (stamp.relaySurface) headers.set(O8_RELAY_SURFACE_HEADER, stamp.relaySurface);
    headers.delete('x-o8d-peer');
    headers.delete('x-o8d-bridge');
    headers.delete('x-o8d-relay');
    const init = { method: req.method, headers, signal: abort.signal };
    const gate = panelGateMiddleware(new NextRequest(url, init));
    let response: Response;
    let admission = false;
    if (gate.headers.get('x-middleware-next') !== '1') response = gate;
    else if (authenticatedBridge && nativeSessionReadsEnabled()
      && req.method === 'GET' && req.headers['x-o8d-session-read'] === 'authorize'
      && ['/api/mobile/orchestrator/threads', '/api/mobile/history', '/api/v2/chat-history', '/api/orchestrator/composer-queue'].includes(url.pathname)) {
      // Admission only. Keep the middleware and queue's existing defense-in-depth
      // gate authoritative; the bridge credential cannot authorize a principal.
      const denied = url.pathname === '/api/orchestrator/composer-queue'
        ? (await import('@/lib/panel/auth')).requirePanelAuth(new NextRequest(url, init)) : null;
      response = denied ?? new Response(null, { status: 204 });
      admission = !denied;
    } else if (!match.route.methods.includes(req.method ?? 'GET')) {
      response = Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: match.route.methods.join(', ') } });
    } else if (match.route.path === '/api/runtime/archive' && typeof mutationWorkspace({ url: url.href }) !== 'string') {
      response = Response.json({ error: 'An absolute workspace is required for native archive' }, { status: 400 });
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
        response = await handlers[req.method ?? 'GET'](request, { params: Promise.resolve(match.params!) });
      }
    }
    if (res.destroyed) { await response.body?.cancel(); return true; }
    const responseHeaders = Object.fromEntries(response.headers);
    // A tunnelled client socket closes after each response so the next request
    // is classified and stamped again. An admission comes only from o8d's own pooled
    // backhaul client with the bridge key on every request, so it may stay open.
    if (admission) res.removeHeader('connection');
    else if (process.env.O8_WS_O8D === '1') responseHeaders.connection = 'close';
    res.writeHead(response.status, responseHeaders);
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
