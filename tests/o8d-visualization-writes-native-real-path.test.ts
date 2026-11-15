// @o8-test-browser
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let auth: { worker: string; readOnly: string; device: string };
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const html = '<!doctype html><html><body><h1>Fixture</h1></body></html>';
function call(path: string, token: string, body: unknown, relay = false) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { ...forged,
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(relay ? { 'x-o8-relay-forward': '1' } : {}) }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true,
    entry: 'tests/fixtures/visualization-native-entry.mjs', startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  auth = JSON.parse(readFileSync(join(server.directory, 'fixture-auth.json'), 'utf8'));
}, 120_000);
afterAll(async () => { await server?.stop(); });

for (const path of ['/api/visualizations', '/api/visualizations/preview']) {
  it(`gates ${path} and binds the worker target before rendering`, async () => {
    for (const relay of [false, true]) {
      for (const [token, status] of [['', 401], ['wrong', 401], [auth.device, 403], [auth.readOnly, 403]] as const) {
        expect((await call(path, token, { packetId: 'packet-a', title: 'Fixture', html }, relay)).status).toBe(status);
      }
      for (const target of [{ packetId: 'packet-b' }, { threadId: 'thoughts-other' }, { repoPath: server.directory }]) {
        const refused = await call(path, auth.worker, { ...target, title: 'Fixture', html }, relay);
        expect(refused.status).toBe(403);
      }
    }
    // Exercise each real handler after admission without launching a browser for this matrix.
    const invalid = path.endsWith('/preview') ? { width: 1 } : { height: 1 };
    for (const token of [auth.worker, server.token]) {
      const accepted = await call(path, token, { packetId: 'packet-a', title: 'Fixture', html, ...invalid });
      expect(accepted.status).toBe(400);
      expect((await accepted.json()).error.code).toBe(path.endsWith('/preview') ? 'invalid_width' : 'invalid_height');
    }
  });
}
it('publishes for the operator and worker and refuses a revision of another packet', async () => {
  const other = await call('/api/visualizations', server.token, { packetId: 'packet-b', title: 'Other', html });
  expect(other.status).toBe(201);
  const otherId = (await other.json()).result.visualization.id;
  const refused = await call('/api/visualizations', auth.worker, { packetId: 'packet-a', title: 'Own', html, revisionOf: otherId });
  expect(refused.status).toBe(404);
  const own = await call('/api/visualizations', auth.worker, { packetId: 'packet-a', title: 'Own', html });
  expect(own.status).toBe(201);
  const ownId = (await own.json()).result.visualization.id;
  const read = await fetch(`${origin}/api/visualizations/${ownId}`, { headers: { authorization: `Bearer ${auth.worker}` } });
  expect(read.status).toBe(200);
  const foreignRead = await fetch(`${origin}/api/visualizations/${otherId}`, { headers: { authorization: `Bearer ${auth.worker}` } });
  expect(foreignRead.status).toBe(404);
}, 120_000);
it('returns the real preview image or the existing browser-unavailable response', async () => {
  const response = await call('/api/visualizations/preview', auth.worker, { packetId: 'packet-a', html, width: 320 });
  const body = await response.json();
  if (response.status === 503) expect(body.error.code).toBe('preview_unavailable');
  else {
    expect(response.status).toBe(200);
    expect(body.result).toMatchObject({ image: expect.any(String), mimeType: 'image/png', width: 320, height: expect.any(Number), layouts: expect.any(Array) });
  }
}, 120_000);
