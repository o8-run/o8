import { request, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { isLoopbackAddress } from '@/lib/auth/loopback-request';
import { nativeClientAddr } from './native-http-routes';
export { registeredFrontDoorRoute } from './api-front-door-routes';
import { browserWriteAllowed, isAllowedLocalHost, requestTargetAllowed } from '../../../scripts/lib/http-request-boundary.cjs';

export function nextUpstream(publicPort: number, wsPort: number): URL {
  const url = new URL(process.env.NEXT_ORIGIN ?? '');
  const port = Number(url.port) || 80;
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || port === publicPort || port === wsPort) throw new Error('Front door requires a distinct private loopback NEXT_ORIGIN');
  return url;
}


const hops = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function outgoing(req: IncomingMessage, port: number, peer: string | null, upgrade = false): OutgoingHttpHeaders {
  const headers = { ...req.headers };
  const nominated = String(headers.connection ?? '').split(',').map(name => name.trim().toLowerCase());
  for (const name of [...hops, ...nominated]) delete headers[name];
  const stamp = nativeClientAddr(peer, name => typeof req.headers[name] === 'string' ? req.headers[name] as string : null,
    req.method ?? 'GET', req.url ?? '/', port);
  for (const name of Object.keys(headers)) if (name.startsWith('x-o8d-') || ['x-o8-client-addr', 'x-o8-relay-surface', 'x-o8-relay-forward'].includes(name)) delete headers[name];
  headers['x-o8-client-addr'] = stamp.address;
  // The Next wrapper only honors the restrictive marker on a loopback socket.
  if (!isLoopbackAddress(stamp.address)) headers['x-o8-relay-forward'] = '1';
  if (stamp.relaySurface) headers['x-o8-relay-surface'] = stamp.relaySurface;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = req.headers.upgrade; }
  return headers;
}

function boundary(req: IncomingMessage, port: number): number | null {
  if (!isAllowedLocalHost(req.headers.host, port) || !requestTargetAllowed(req.url, port)) return 421;
  return browserWriteAllowed(req.method ?? 'GET', name => typeof req.headers[name] === 'string' ? req.headers[name] as string : null) ? null : 403;
}

const notice = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>o8 desktop</title><body><main><h1>Use the desktop app</h1><p>o8 runs in its native desktop window.</p></main></body></html>';
export function serveFrontDoorNotice(req: IncomingMessage, res: ServerResponse, port: number): boolean {
  if (!['/', '/mobile', '/dashboard'].includes((req.url ?? '').split('?')[0]) || !['GET', 'HEAD'].includes(req.method ?? 'GET')) return false;
  const refused = boundary(req, port);
  if (refused) { res.writeHead(refused).end(); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(notice), 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : notice); return true;
}

export function forwardToNext(req: IncomingMessage, res: ServerResponse, upstream: URL, port: number, peer: string | null): void {
  const refused = boundary(req, port);
  if (refused) { res.writeHead(refused).end(); return; }
  for (const name of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) res.removeHeader(name);
  const proxy = request(upstream, { method: req.method, path: req.url, headers: outgoing(req, port, peer) }, response => {
    const nominated = String(response.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase());
    const raw: string[] = [];
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      if (![...hops, ...nominated].includes(response.rawHeaders[i].toLowerCase())) raw.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
    }
    res.writeHead(response.statusCode ?? 502, response.statusMessage, raw);
    response.on('error', () => res.destroy()); response.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"Next upstream unavailable"}'); else res.destroy(); });
  req.on('aborted', () => proxy.destroy());
  req.on('error', () => proxy.destroy());
  res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
  req.pipe(proxy);
}

export function forwardNextUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: URL, port: number, peer: string | null): void {
  const refuse = (code: number) => socket.end(`HTTP/1.1 ${code} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const denied = boundary(req, port); if (denied) { refuse(denied); return; }
  const proxy = request(upstream, { method: req.method, path: req.url, headers: outgoing(req, port, peer, true) });
  proxy.on('upgrade', (response, remote, first) => {
    let headers = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
    for (let i = 0; i < response.rawHeaders.length; i += 2) headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
    socket.write(headers + '\r\n'); if (first.length) socket.write(first); if (head.length) remote.write(head);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    remote.pipe(socket); socket.pipe(remote);
  });
  proxy.on('response', response => { response.resume(); refuse(response.statusCode ?? 502); });
  proxy.on('error', () => { if (!socket.destroyed) refuse(502); });
  socket.on('close', () => proxy.destroy()); socket.on('error', () => proxy.destroy()); proxy.end();
}
