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

vi.mock('@/lib/runtime/session-transform-route', () => { throw new Error('Next loaded the stateful owner'); });

it.each(['/api/orchestrator/workspace/maintenance', '/api/orchestrator/workspace/preservation', '/api/runtime/session-transform'])('keeps %s operator-only', async path => {
  for (const method of ['GET', 'POST']) await refuses(method, path);
});

it('preserves the reviewed cleanup plan and validates recovery and transforms', async () => {
  const maintenance = '/api/orchestrator/workspace/maintenance';
  expect((await call('POST', '/api/panel/repos', server.token, { action: 'add', localPath: repo })).status).toBe(201);
  const preview = await call('POST', maintenance, server.token, { action: 'preview', repoPath: repo });
  expect(preview.status).toBe(200);
  const { result: { plan } } = await preview.json();
  expect(plan.id).toEqual(expect.any(String));
  expect((await call('GET', `${maintenance}?planId=${plan.id}`)).status).toBe(200);
  expect((await call('POST', maintenance, server.token, { action: 'execute', planId: plan.id, fingerprint: 'wrong', selection: [] })).status).toBe(409);
  expect((await call('GET', '/api/orchestrator/workspace/preservation')).status).toBe(400);
  expect((await call('POST', '/api/orchestrator/workspace/preservation', server.token, {})).status).toBe(400);
  expect((await call('GET', '/api/runtime/session-transform')).status).toBe(400);
  const state = await call('GET', '/api/runtime/session-transform?runtimeId=codex');
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ runtimeId: 'codex', sessionKey: null, checkpoints: [], receipts: [] });
  expect((await call('POST', '/api/runtime/session-transform', server.token, {})).status).toBe(400);
});

it('forwards Next session transforms without loading runtime adapters in Next', async () => {
  const saved = { ...process.env };
  try {
    process.env.O8_NEXT_O8D = '1';
    process.env.O8_WS_PORT = new URL(origin).port;
    const { NextRequest } = await import('next/server');
    const next = await import('@/app/api/runtime/session-transform/route');
    const response = await next.GET(new NextRequest('http://127.0.0.1/api/runtime/session-transform', {
      headers: { authorization: `Bearer ${server.token}` },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'runtimeId is required' });
    const post = await next.POST(new NextRequest('http://127.0.0.1/api/runtime/session-transform', {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}',
    }));
    expect(post.status).toBe(400);
    expect(await post.json()).toMatchObject({ reason: 'invalid_request', retryable: false });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
