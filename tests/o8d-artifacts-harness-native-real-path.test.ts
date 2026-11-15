import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let repo: string;
const device = 'workspace-port-fixture-device';
const worker = 'workspace-port-fixture-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
function call(method: string, path: string, token = server.token, body?: unknown, relay = false) {
  return fetch(`${origin}${path}`, { method,
    headers: { ...forged, ...(relay ? { 'x-o8-relay-forward': '1' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  repo = join(server.directory, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 180_000);
afterAll(async () => { await server?.stop(); });
async function refuses(method: string, path: string) {
  for (const relay of [false, true]) for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
    expect((await call(method, path, token, method === 'POST' ? {} : undefined, relay)).status,
      `${method} ${path} ${token || 'anonymous'} relay=${relay}`).toBe(status);
  }
}

vi.mock('@/lib/harness/route', () => { throw new Error('Next loaded the stateful harness owner'); });

it.each(['/api/task-artifacts'])('keeps %s operator-only', async path => {
  for (const method of ['GET', 'POST']) await refuses(method, path);
});

it('persists task artifacts through the operator transport', async () => {
  const created = await call('POST', '/api/task-artifacts', server.token, {
    title: 'Rank fixes', html: '<p>Choose a fix</p>',
    actions: [{ name: 'rank', schema: { fields: { winner: { type: 'string', required: true } } } }],
    threadId: 'thoughts-fixture', repoPath: repo,
  });
  expect(created.status).toBe(201);
  const { result: { artifact } } = await created.json();
  const listing = await call('GET', `/api/task-artifacts?threadId=thoughts-fixture&repoPath=${encodeURIComponent(repo)}`);
  expect(listing.status).toBe(200);
  expect((await listing.json()).result.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ artifact: expect.objectContaining({ id: artifact.id }) })]));

});

it('stores harness measurements in SQLite and reads them back with Next stopped', async () => {
  await refuses('POST', '/api/harness');
  const measured = await call('POST', '/api/harness', server.token, {
    action: 'harness_measure', repoPath: repo, componentKey: 'fixture-component', modelId: 'fixture-model',
    baselineScore: 0.4, enabledScore: 0.7, sampleCount: 10, evidence: { fixture: true },
  });
  expect(measured.status).toBe(200);
  const body = await measured.json();
  expect(body.ok).toBe(true);
  const status = await call('POST', '/api/harness', server.token, {
    action: 'harness_status', repoPath: repo, componentKey: 'fixture-component', modelId: 'fixture-model',
  });
  expect(status.status).toBe(200);
  expect((await status.json()).result.measurements).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: body.result.measurement.id, baselineScore: 0.4, enabledScore: 0.7 }),
  ]));
  const saved = { ...process.env };
  try {
    process.env.O8_NEXT_O8D = '1';
    process.env.O8_WS_PORT = new URL(origin).port;
    const { NextRequest } = await import('next/server');
    const next = await import('@/app/api/harness/route');
    const forwarded = await next.POST(new NextRequest('http://127.0.0.1/api/harness', {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'harness_status', repoPath: repo, componentKey: 'fixture-component', modelId: 'fixture-model' }),
    }));
    expect(forwarded.status).toBe(200);
    expect((await forwarded.json()).result.measurements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: body.result.measurement.id }),
    ]));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
