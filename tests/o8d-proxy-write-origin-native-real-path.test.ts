import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { panelGateMiddleware } from '@/middleware';
import { startParityReference } from './fixtures/ws-parity-server';

it('keeps opaque-origin proxy writes at 403 on Next and native HTTP', async () => {
  const server = await startParityReference({ o8d: true, nativeHttp: true });
  try {
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    for (const path of ['/api/browser/proxy', '/api/panel/proxy']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const token of ['', server.token]) {
          const headers = { origin: 'null', ...(token ? { authorization: `Bearer ${token}` } : {}) };
          expect.soft(panelGateMiddleware(new NextRequest(`${origin}${path}`, { method, headers })).status,
            `Next ${method} ${path}`).toBe(403);
          expect.soft((await fetch(`${origin}${path}`, { method, headers })).status,
            `native ${method} ${path}`).toBe(403);
        }
      }
    }
  } finally { await server.stop(); }
}, 180_000);
