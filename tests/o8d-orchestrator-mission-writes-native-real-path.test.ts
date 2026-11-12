import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

vi.mock('@/lib/orchestrator/http/create-mission', () => { throw new Error('Next initialized the create-mission owner'); });
vi.mock('@/lib/orchestrator/http/dispatch', () => { throw new Error('Next initialized the dispatch owner'); });
vi.mock('@/lib/orchestrator/http/propose-spec', () => { throw new Error('Next initialized the propose-spec owner'); });
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const device = 'orchestrator-writes-device';
const worker = 'orchestrator-writes-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const routes = [['/api/orchestrator/create-mission', 'POST'], ['/api/orchestrator/dispatch', 'POST'], ['/api/orchestrator/propose-spec', 'POST']] as const;
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 180_000);
afterAll(async () => { await server?.stop(); });

it.each(routes)('keeps %s %s operator-only with Next stopped', async (path, method) => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      const response = await fetch(`${origin}${path}`, { method, headers: { ...forged, ...(relay ? { 'x-o8-relay-forward': '1' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: 'null' } : {}) });
      expect(response.status, `${token} relay=${relay}`).toBe(status);
    }
  }
});
it.each(routes)('executes the real %s %s validation in the WS owner', async (path, method) => {
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: 'null' } : {}) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: expect.any(String), message: expect.any(String) } });
});
it('forwards Next calls without initializing any local handler or process state', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_API_PORT', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  try {
    {
      const next = await import('@/app/api/orchestrator/create-mission/route');
      const response = await next.POST(new NextRequest('http://127.0.0.1/api/orchestrator/create-mission', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: 'null' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: expect.any(String) } });
    }
    {
      const next = await import('@/app/api/orchestrator/dispatch/route');
      const response = await next.POST(new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: 'null' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: expect.any(String) } });
    }
    {
      const next = await import('@/app/api/orchestrator/propose-spec/route');
      const response = await next.POST(new NextRequest('http://127.0.0.1/api/orchestrator/propose-spec', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: 'null' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: expect.any(String) } });
    }
  } finally { vi.unstubAllEnvs(); }
});
