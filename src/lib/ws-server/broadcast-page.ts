import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import assets from '../broadcast/static/assets.json';

const fingerprint = createHash('sha256').update(assets.javascript).update(assets.css).digest('hex').slice(0, 16);
const assetRoot = `/broadcast/assets/${fingerprint}`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>o8 Broadcast</title><link rel="stylesheet" href="${assetRoot}.css"><script defer src="${assetRoot}.js"></script></head><body><div id="broadcast-root"><h1>Broadcast</h1><p>Live governed activity from the o8 ledger</p></div><noscript>Enable JavaScript to view live broadcast activity.</noscript></body></html>`;
// React's style props and motion require inline styles, but never inline scripts.
// Next's frame policy is preserved; every other source is narrowed to this origin.
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** Mount before native HTTP / Next fallback. No API routes or owner state. */
export function serveBroadcastPage(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  const asset = path === `${assetRoot}.js` ? assets.javascript : path === `${assetRoot}.css` ? assets.css : null;
  if (path !== '/broadcast' && path !== '/broadcast/' && asset === null) return false;
  const headers = {
    'Cache-Control': asset === null ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Length': 0 }).end();
    return true;
  }
  const body = asset ?? html;
  res.writeHead(200, {
    ...headers,
    'Content-Type': asset === null ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
