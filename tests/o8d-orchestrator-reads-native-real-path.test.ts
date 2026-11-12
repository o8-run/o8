import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// A Next import must never initialize the inventory's process-local caches in native mode.
vi.mock('@/lib/threads/route', () => { throw new Error('Next initialized the thread owner'); });
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
const device = 'orchestrator-reads-device';
const worker = 'orchestrator-reads-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const paths = ['/api/orchestrator/history?threadId=thoughts-fixture', '/api/orchestrator/workspace/retention?packetId=fixture-packet', '/api/panel/threads?model=invalid'];

let directory: string;
beforeAll(async () => {
  // Seed the repository, lane and history before the server starts, so its
  // registry and lane reads never race the fixture's writes.
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-orchestrator-reads-')));
  vi.stubEnv('O8_DATA_DIR', directory);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'cortex-ide.db'));
  const { addRepo } = await import('@/lib/repos/registry');
  await addRepo(directory);
  const { createLane } = await import('@/lib/lane/registry');
  createLane({ packetId: 'fixture-packet', repoPath: directory, runtime: 'codex', branch: 'main', baseBranch: 'main' });
  mkdirSync(join(directory, 'chat-history'), { recursive: true });
  writeFileSync(join(directory, 'chat-history', 'thoughts-fixture.json'), JSON.stringify({ title: 'Native history', messages: [{ id: 'm1', role: 'user', content: 'Saved on disk', timestamp: 1 }] }));
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  server = await startParityReference({ o8d: true, nativeHttp: true, startupTimeoutMs: 120_000, directory });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
}, 180_000);
afterAll(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it.each(paths)('keeps bearer grants unchanged for %s with Next stopped', async path => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      const response = await fetch(`${origin}${path}`, { headers: { ...forged, ...(relay ? { 'x-o8-relay-forward': '1' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      expect(response.status, `${token} relay=${relay}`).toBe(status);
    }
  }
});
it('reads persisted history through the native listener', async () => {
  const response = await fetch(`${origin}${paths[0]}`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema: 'o8/orchestrator.history/v1', ok: true, thread: { title: 'Native history' }, count: 1, timeline: [{ content: 'Saved on disk' }] });
});
it('returns real thread validation shapes', async () => {
  for (const [path, body] of [ [paths[2], { error: 'Use grouping A, B or C.' }]] as const) {
    const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject(body);
  }
});
it('reads persisted retention and the thread inventory', async () => {
  const headers = { authorization: `Bearer ${server.token}` };
  const retention = await fetch(`${origin}${paths[1]}`, { headers });
  expect(retention.status).toBe(200);
  expect(await retention.json()).toMatchObject({ ok: true, result: { schema: 'o8/workspace-retention/v1', packetId: 'fixture-packet', holds: [] } });
  const threads = await fetch(`${origin}/api/panel/threads`, { headers });
  expect(threads.status).toBe(200);
  expect(await threads.json()).toMatchObject({ schema: 'o8/project.threads/v1', tasks: expect.any(Array) });
}, 60_000);
it('forwards Next thread requests without loading its local inventory handler', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_API_PORT', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  try {
    const next = await import('@/app/api/panel/threads/route');
    const response = await next.GET(new NextRequest(`http://127.0.0.1${paths[2]}`, { headers: { authorization: `Bearer ${server.token}` } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Use grouping A, B or C.' });
  } finally { vi.unstubAllEnvs(); }
});

it('keeps retention writes operator-only and executes their real validation', async () => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [server.token, 400]] as const) {
      const response = await fetch(`${origin}/api/orchestrator/workspace/retention`, { method: 'POST', headers: { ...forged, ...(relay ? { 'x-o8-relay-forward': '1' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(status);
    }
  }
});
