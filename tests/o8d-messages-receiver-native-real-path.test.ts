import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const path = '/api/panel/symon/messages-receiver';
const device = 'messages-fixture-device';
const worker = 'messages-fixture-worker';
const spectator = 'messages-fixture-spectator';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1' };
function call(method: string, token = server.token, body?: unknown) {
  return fetch(`${origin}${path}`, { method, headers: { ...forged, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  writeFileSync(join(server.directory, 'broadcast-spectator-tokens'), createHash('sha256').update(spectator).digest('hex'));
}, 120_000);
afterAll(async () => { await server?.stop(); });

it('serves WS receiver controls with Next stopped, without enabling Messages', async () => {
  const response = await call('GET');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, enabled: false, handles: [] });
  const saved = await call('POST', server.token, { enabled: false, handles: ['+15555550100'] });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ ok: true, enabled: false, handles: ['+15555550100'] });
  expect(JSON.parse(readFileSync(join(server.directory, 'symon/messages-receiver.json'), 'utf8')).enabled).toBe(false);
});
it('preserves the control route auth matrix despite forged local headers', async () => {
  for (const method of ['GET', 'POST']) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [spectator, 403]] as const) {
      expect((await call(method, token, method === 'POST' ? { enabled: false, handles: [] } : undefined)).status).toBe(status);
    }
  }
});
it.each(['1', undefined])('Next forwards to WS without creating receiver state (flag %s)', async flag => {
  vi.stubEnv('O8_NEXT_O8D', flag);
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  try {
    const { GET, POST } = await import('@/app/api/panel/symon/messages-receiver/route');
    const response = await GET(new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${server.token}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handles: ['+15555550100'] });
    const saved = await POST(new Request(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, handles: ['+15555550100'] }) }));
    expect(saved.status).toBe(200);
    expect((globalThis as { __o8MessagesReceiver?: unknown }).__o8MessagesReceiver).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});

it('WS startup owns the install lock only on macOS', () => {
  const claimed = execFileSync(process.execPath, ['--require=tsx/cjs', '-e',
    "console.log(require('./src/lib/symon/messages-receiver/owner.ts').claimMessagesReceiver());"],
  { env: { ...process.env, CORTEX_IDE_DATA_DIR: server.directory }, encoding: 'utf8' }).trim();
  expect(claimed).toBe(process.platform === 'darwin' ? 'false' : 'true');
});

it('keeps receiver controls in WS with the transport flag unset', async () => {
  const preload = join(server.directory, 'receiver-legacy-mode.cjs');
  writeFileSync(preload, 'delete process.env.O8_NEXT_O8D;');
  const legacy = await startParityReference({ o8d: true, nativeHttp: true, preload });
  try {
    await legacy.stopNext();
    const url = legacy.url.replace('ws:', 'http:').replace('/ws', '');
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${legacy.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, enabled: false });
  } finally { await legacy.stop(); }
}, 120_000);
