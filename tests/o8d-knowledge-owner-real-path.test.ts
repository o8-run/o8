import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// A forwarded Next request must never import the local stateful implementation.
vi.mock('@/app/api/panel/operator-defaults/handler', () => { throw new Error('Next loaded the settings owner'); });
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const device = 'knowledge-owner-device';
const worker = 'knowledge-owner-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1' };
function request(path: string, method = 'GET', token = server.token, body?: unknown) {
  return new NextRequest(`${origin}${path}`, { method, headers: { ...forged, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  vi.stubEnv('O8_NEXT_WINDOW_OWNER', 'ws');
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_API_PORT', new URL(origin).port);
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await server?.stop(); });

it('keeps source admission operator-only and the existing settings device grant', async () => {
  for (const path of ['/api/panel/operator-defaults?include=values']) {
    for (const method of ['GET', 'POST']) {
      for (const [token, status] of [['', 401], ['wrong-token', 401], [device, 403], [worker, 403]] as const) {
        // Settings grants device reads; its knowledge-source writes require the operator.
        if (token === device && method === 'GET') continue;
        const response = await fetch(request(path, method, token, method === 'POST' ? { knowledgeSources: [] } : undefined));
        expect(response.status, `${method} ${path} ${token}`).toBe(status);
      }
    }
  }
  expect((await fetch(request('/api/panel/operator-defaults?include=values', 'GET', device))).status).toBe(200);
  expect((await fetch(request('/api/panel/operator-defaults', 'POST', worker, { knowledgeSources: [] }))).status).toBe(403);
});
