import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const path = '/api/mobile/symon/tool';
const device = 'symon-tool-device';
const worker = 'symon-tool-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
function call(method: string, token: string, relay = false, body: unknown = {}) {
  return fetch(`${origin}${path}`, { method, headers: { ...forged,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(relay ? { 'x-o8-relay-forward': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => { await server?.stop(); });

it.each(['POST', 'DELETE'])('%s holds the operator gate with Next stopped', async method => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      expect((await call(method, token, relay)).status).toBe(status);
    }
  }
  const response = await call(method, server.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: false });
});

it('retains the active-session scope refusal', async () => {
  const response = await call('POST', server.token, false, { sessionId: 'missing-session', callId: 'call', tool: 'read_file', args: {}, dryRun: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: false, result: { error: 'session_scope_invalid' } });
});

it('forwards Next calls to the WS owner without a local bridge client', async () => {
  const saved = { native: process.env.O8_NEXT_O8D, port: process.env.O8_WS_PORT };
  process.env.O8_NEXT_O8D = '1';
  process.env.O8_WS_PORT = new URL(origin).port;
  try {
    const handlers = await import('@/app/api/mobile/symon/tool/route');
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await handlers[method](new Request(`${origin}${path}`, { method,
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', host: new URL(origin).host }, body: '{}' }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false });
    }
    // A real tool body must survive the hop: the owner reaches its session-scope check.
    const scoped = await handlers.POST(new Request(`${origin}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', host: new URL(origin).host },
      body: JSON.stringify({ sessionId: 'missing-session', callId: 'call', tool: 'read_file', args: {}, dryRun: true }) }));
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({ ok: false, result: { error: 'session_scope_invalid' } });
    expect((globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient).toBeUndefined();
  } finally {
    if (saved.native === undefined) delete process.env.O8_NEXT_O8D; else process.env.O8_NEXT_O8D = saved.native;
    if (saved.port === undefined) delete process.env.O8_WS_PORT; else process.env.O8_WS_PORT = saved.port;
  }
});
