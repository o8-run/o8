import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
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

it('serves the persisted worktree conflict report with Next stopped and operator auth', async () => {
  await refuses('GET', '/api/worktrees/conflicts');
  expect((await call('GET', '/api/worktrees/conflicts')).status).toBe(400);
  for (const deep of [false, true]) {
    const response = await call('GET', `/api/worktrees/conflicts?repo=${encodeURIComponent(repo)}&deep=${deep}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ files: [], safe: true, conflictCount: 0, warningCount: 0, mergeOrder: [] });
  }
});
