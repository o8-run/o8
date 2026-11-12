import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// A forwarded Next request must never import either local stateful implementation.
vi.mock('@/lib/cortex/knowledge/sources-route', () => { throw new Error('Next loaded the knowledge owner'); });
vi.mock('@/app/api/panel/operator-defaults/handler', () => { throw new Error('Next loaded the settings owner'); });
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let folder: string;
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
afterAll(async () => { vi.unstubAllEnvs(); if (folder) rmdirSync(folder); await server?.stop(); });

it('keeps source admission operator-only and the existing settings device grant', async () => {
  for (const path of ['/api/cortex/sources', '/api/panel/operator-defaults?include=values']) {
    for (const method of ['GET', 'POST']) {
      for (const [token, status] of [['', 401], ['wrong-token', 401], [device, 403], [worker, 403]] as const) {
        // Settings grants device reads; its knowledge-source writes require the operator.
        if (path.includes('operator-defaults') && (token === device && method === 'GET')) continue;
        const response = await fetch(request(path, method, token, method === 'POST' ? { knowledgeSources: [] } : undefined));
        expect(response.status, `${method} ${path} ${token}`).toBe(status);
      }
    }
  }
  expect((await fetch(request('/api/panel/operator-defaults?include=values', 'GET', device))).status).toBe(200);
  expect((await fetch(request('/api/panel/operator-defaults', 'POST', worker, { knowledgeSources: [] }))).status).toBe(403);
  expect((await fetch(request('/api/cortex/sources'))).status).toBe(200);
});

it('shares reconciliation and listing through the WS owner without loading a local Next copy', async () => {
  const sources = await import('@/app/api/cortex/sources/route');
  const settings = await import('@/app/api/panel/operator-defaults/route');
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'o8-owner-notes-')));
  const added = await sources.POST(request('/api/cortex/sources', 'POST', server.token, { action: 'add', path: folder }));
  expect(added.status, await added.clone().text()).toBe(200);
  const source = (await added.json()).sources[0];
  expect(source).toMatchObject({ path: folder, facts: 0 });
  const values = await settings.GET(request('/api/panel/operator-defaults?include=values'));
  expect(values.status).toBe(200);
  const data = await values.json();
  expect(data.values.knowledgeSources).toContainEqual(expect.objectContaining({ id: source.id }));
  rmdirSync(folder);
  const refresh = await sources.POST(request('/api/cortex/sources', 'POST', server.token, { action: 'refresh' }));
  expect(refresh.status).toBe(200);
  await expect.poll(async () => (await (await sources.GET(request('/api/cortex/sources'))).json()).sources[0].state).toBe('error');
  expect((await (await fetch(request('/api/cortex/sources'))).json()).sources[0].state).toBe('error');
  folder = '';
  const removed = await settings.POST(request('/api/panel/operator-defaults?include=native', 'POST', server.token, { knowledgeSources: [], settingsTomlRevision: data.settingsToml.revision }));
  expect(removed.status, await removed.clone().text()).toBe(200);
  const listed = await sources.GET(request('/api/cortex/sources'));
  expect(await listed.json()).toEqual({ sources: [] });
});
