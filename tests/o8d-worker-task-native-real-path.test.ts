import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let auth: { worker: string; deviceWorker: string; readOnly: string; device: string };
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
function call(path: string, token: string, body: unknown, relay = false) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { ...forged,
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(relay ? { 'x-o8-relay-forward': '1' } : {}) }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true,
    entry: 'tests/fixtures/worker-task-native-entry.mjs', startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  auth = JSON.parse(readFileSync(join(server.directory, 'fixture-auth.json'), 'utf8'));
}, 120_000);
afterAll(async () => { await server?.stop(); });

for (const action of ['report', 'block']) {
  it(`serves ${action} with packet ownership and the operator path`, async () => {
    const body = action === 'report' ? { event: 'progress', message: 'Checked', actor: 'user' } : { reason: 'Needs input', actor: 'user' };
    const own = `/api/tasks/packet-a/${action}`;
    const other = `/api/tasks/packet-b/${action}`;
    for (const relay of [false, true]) {
      for (const [token, status] of [['', 401], ['wrong', 401], [auth.device, 403], [auth.readOnly, 403]] as const) {
        expect((await call(own, token, body, relay)).status).toBe(status);
      }
      const refused = await call(other, auth.worker, body, relay);
      expect(refused.status, `relay=${relay}`).toBe(relay ? 401 : 403);
      if (!relay) expect(await refused.json()).toMatchObject({ error: { code: 'worker_packet_mismatch' } });
    }
    expect((await call(own, auth.worker, body)).status).toBe(200);
    expect((await call(other, server.token, body)).status).toBe(200);
  });
}
it('serves packet-bound device protocol and refuses unproven or relayed input', async () => {
  const path = '/api/devices/agent';
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const [token, status] of [['', 401], ['wrong', 401], [auth.device, 403], [auth.worker, 403], [auth.readOnly, 403], [server.token, 403]] as const) {
    expect((await call(path, token, body)).status).toBe(status);
  }
  const response = await call(path, auth.deviceWorker, body);
  expect(response.status).toBe(200);
  expect((await response.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain('o8_device');
  expect((await call(path, auth.deviceWorker, body, true)).status).toBe(403);
  // Device controls retain their separate operator endpoint.
  const operator = await fetch(`${origin}/api/panel/devices`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(operator.status).toBe(200);
});
