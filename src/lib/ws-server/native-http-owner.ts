/** Opt-in HTTP adapter in the process that owns WS delivery and orchestration. */
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { panelGateMiddleware } from '@/middleware';
import { resolveNativeHttpHandler } from './native-http-routes';

const LIMIT = 16 * 1024 * 1024;

async function streamEvents(response: Response, outgoing: ServerResponse) {
  const reader = response.body!.getReader();
  let bytes = 0;
  let complete = false;
  const closed = () => { void reader.cancel().catch(() => {}); };
  outgoing.once('close', closed);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.flushHeaders();
  try {
    while (!outgoing.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      if (outgoing.destroyed) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT) { outgoing.destroy(); return; }
      if (!outgoing.write(Buffer.from(chunk.value))) {
        await new Promise<void>(resolve => {
          if (outgoing.destroyed) { resolve(); return; }
          const ready = () => { outgoing.off('drain', ready); outgoing.off('close', ready); resolve(); };
          outgoing.once('drain', ready);
          outgoing.once('close', ready);
        });
      }
    }
    outgoing.end();
  } catch {
    outgoing.destroy();
  } finally {
    outgoing.off('close', closed);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function serveNativeHttp(request: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    // Never inherit client-supplied socket truth. The middleware still requires
    // an affirmative principal on every native API path, even on loopback.
    headers.set('x-o8-client-addr', request.socket.remoteAddress ?? 'unknown');
    const selected = headers.get('x-o8d-profile');
    const profile = createHash('sha256').update(realpathSync(getDataDir())).digest('hex');
    if (selected !== null && selected !== profile) {
      outgoing.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"Owner profile mismatch"}');
      return;
    }
    const url = `http://127.0.0.1:${request.socket.localPort}${request.url}`;
    // Authenticate before importing handlers or accepting a mutation body.
    const gateRequest = new NextRequest(url, { method: request.method, headers });
    const denied = panelGateMiddleware(gateRequest);
    let response: Response = denied;
    if (denied.status === 200) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > LIMIT) {
          outgoing.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"Request exceeds 16 MiB"}');
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const handler = await resolveNativeHttpHandler(gateRequest.nextUrl.pathname, request.method ?? 'GET');
      const body = Buffer.concat(chunks);
      const nextRequest = new NextRequest(url, { method: request.method, headers,
        ...(body.length ? { body } : {}) });
      response = handler ? await handler(nextRequest) : Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (response.body && response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      await streamEvents(response, outgoing);
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > LIMIT) {
      outgoing.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"Response exceeds 16 MiB"}');
      return;
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)).end(body);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json' });
    outgoing.end('{"error":"Native HTTP owner unavailable"}');
  }
}
