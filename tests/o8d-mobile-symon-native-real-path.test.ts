import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const device = 'symon-fixture-device';
const worker = 'symon-fixture-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const routes = [
  ['GET', '/api/mobile/symon'], ['POST', '/api/mobile/symon'],
  ['POST', '/api/mobile/symon/confirm'],
] as const;
function call(method: string, path: string, token: string, relay = false) {
  return fetch(`${origin}${path}`, { method, headers: { ...forged,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(relay ? { 'x-o8-relay-forward': '1' } : {}), 'content-type': 'application/json' },
  ...(method === 'GET' ? {} : { body: '{}' }) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => { await server?.stop(); });

it.each(routes)('%s %s keeps its credential gate with Next stopped', async (method, path) => {
  for (const relay of [false, true]) {
    for (const token of ['', 'wrong', worker, ...(path === '/api/mobile/symon' ? [] : [device])]) {
      expect((await call(method, path, token, relay)).status).toBe(token === worker || token === device ? 403 : 401);
    }
  }
  const result = await call(method, path, server.token);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ ok: false, error: expect.any(String) });
  if (path === '/api/mobile/symon') {
    const phone = await call(method, path, device, true);
    expect(phone.status).toBe(200);
    expect(await phone.json()).toMatchObject({ ok: false, error: expect.any(String) });
  }
}, 30_000);

it('keeps Next entry points free of bridge and turn state', () => {
  for (const path of ['', '/confirm']) {
    const source = readFileSync(join(process.cwd(), `src/app/api/mobile/symon${path}/route.ts`), 'utf8');
    expect(source).toContain('ownedByNativeTransport');
    expect(source).not.toMatch(/globalThis|new O8WebviewClient|getSymonBrain/);
  }
});

it('forwards every Next entry point to the WS owner without local bridge state', async () => {
  const saved = { native: process.env.O8_NEXT_O8D, port: process.env.O8_WS_PORT };
  process.env.O8_NEXT_O8D = '1';
  process.env.O8_WS_PORT = new URL(origin).port;
  const local = globalThis as { __o8BrowserAgentClient?: unknown; };
  try {
    const relay = await import('@/app/api/mobile/symon/route');
    const confirm = await import('@/app/api/mobile/symon/confirm/route');
    for (const [method, path] of routes) {
      const handler = method === 'GET' ? relay.GET : path.endsWith('/confirm') ? confirm.POST : relay.POST;
      const response = await handler(new Request(`${origin}${path}`, { method,
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', host: new URL(origin).host },
        ...(method === 'GET' ? {} : { body: '{}' }) }));
      expect(response.status).toBe(200);
    }
    expect(local.__o8BrowserAgentClient).toBeUndefined();
  } finally {
    if (saved.native === undefined) delete process.env.O8_NEXT_O8D; else process.env.O8_NEXT_O8D = saved.native;
    if (saved.port === undefined) delete process.env.O8_WS_PORT; else process.env.O8_WS_PORT = saved.port;
  }
}, 30_000);
