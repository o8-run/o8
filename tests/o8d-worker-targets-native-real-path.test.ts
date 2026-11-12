import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
let server: Awaited<ReturnType<typeof startParityReference>>;
let directory: string;
let origin: string;
let operator: string;
let seeded: { own: string; other: string; worker: string; noPr: string };
const device = 'worker-target-device-fixture';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-native-worker-targets-')));
  mkdirSync(join(directory, 'native-checkout'));
  mkdirSync(join(directory, 'native-foreign'));
  await promisify(execFile)('git', ['init', '--quiet', join(directory, 'native-foreign')]);
  const result = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    (async () => {
      const { seedWorkerTargets } = require('./tests/fixtures/worker-targets.ts');
      const seeded = await seedWorkerTargets(process.env.CORTEX_IDE_DATA_DIR);
      require('./src/lib/lane/registry.ts').updateLane(seeded.own, { worktreePath: require('node:path').join(process.env.CORTEX_IDE_DATA_DIR, 'native-checkout') });
      console.log('seed ' + JSON.stringify(seeded));
      require('./src/lib/db/index.ts').closeDb();
    })();
  `], { env: { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
    CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') } });
  seeded = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('seed '))!.slice(5));
  server = await startParityReference({ directory, o8d: true, nativeHttp: true, startupTimeoutMs: 120_000 });
  await server.stopNext();
  operator = server.token;
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
}, 180_000);
afterAll(async () => { await server?.stop(); });
async function call(path: string, body?: unknown, token = seeded.worker, extra: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { ...forged, ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
}
it('retains the credential and remote caller gates on each native target', async () => {
  for (const [path, body] of [
    ['/api/tasks/packet-a', undefined], ['/api/panel/artifacts', { packetId: 'packet-a' }],
    ['/api/panel/artifacts/mirror', { packetId: 'packet-a' }], ['/api/panel/managed-runs', { packetId: 'packet-a' }],
  ] as const) {
    for (const [token, status] of [['', 401], ['wrong-token', 401], [device, 403]] as const) {
      expect((await call(path, body, token)).status, path).toBe(status);
      expect((await call(path, body, token, { 'x-o8-relay-forward': '1' })).status, path).toBe(status);
    }
    const remoteBody = body ? { packetId: 'packet-b', repoSlug: 'fixture/other', prNumber: 22,
      bytesBase64: 'eA==', mimeType: 'video/mp4', kind: 'video' } : undefined;
    expect((await call(path, remoteBody, seeded.worker, { 'x-o8-relay-forward': '1' })).status, path)
      .toBe(body ? 403 : 401);
  }
});
it('checks the task against the caller packet', async () => {
  expect((await call('/api/tasks/packet-b')).status).toBe(403);
  expect((await call('/api/tasks/packet-a')).status).toBe(200);
  expect((await call('/api/tasks/packet-b', undefined, operator)).status).toBe(200);
}, 120_000);
it('checks every artifact association against the caller packet', async () => {
  const body = { packetId: 'packet-a', bytesBase64: 'eA==', mimeType: 'video/mp4', kind: 'video' };
  expect((await call('/api/panel/artifacts', { ...body, laneId: seeded.other })).status).toBe(403);
  expect((await call('/api/panel/artifacts', { ...body, packetId: 'packet-b', laneId: seeded.own })).status).toBe(403);
  expect((await call('/api/panel/artifacts', { ...body, laneId: 'missing' })).status).toBe(403);
  const accepted = await call('/api/panel/artifacts', { ...body, laneId: seeded.own });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ artifactId: expect.any(String), url: expect.any(String) });
  expect((await call('/api/panel/artifacts', { ...body, packetId: 'packet-b', laneId: seeded.other }, operator)).status).toBe(200);
});
it('checks the managed run lane against the caller packet', async () => {
  const body = { id: 'targetfixture', session: 'cortex-run-targetfixture', command: 'fixture', cwd: join(directory, 'native-checkout'), packetId: 'packet-a' };
  expect((await call('/api/panel/managed-runs', { ...body, laneId: seeded.other })).status).toBe(403);
  expect((await call('/api/panel/managed-runs', { ...body, laneId: 'missing' })).status).toBe(403);
  const accepted = await call('/api/panel/managed-runs', { ...body, laneId: seeded.own });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ run: { packetId: 'packet-a', laneId: seeded.own } });

});
it('checks the recorded packet PR destination', async () => {
  const body = { packetId: 'packet-a', repoSlug: 'fixture/own', prNumber: 11 };
  expect((await call('/api/panel/artifacts/mirror', { ...body, repoSlug: 'fixture/other', prNumber: 22 })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, repoSlug: 'fixture/other' })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, prNumber: 22 })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, packetId: 'packet-no-pr' }, seeded.noPr)).status).toBe(403);
  const response = await call('/api/panel/artifacts/mirror', body);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ mirrored: false, reason: 'no proof screenshots for this packet/lane' });
  expect((await call('/api/panel/artifacts/mirror', { ...body, packetId: 'packet-b' }, operator)).status).toBe(422);
});
it('keeps the paired read methods on the native owner', async () => {
  const artifacts = await call('/api/panel/artifacts?packetId=packet-a', undefined, operator);
  expect(artifacts.status).toBe(200);
  expect((await artifacts.json()).artifacts).toHaveLength(1);
  const runs = await call('/api/panel/managed-runs');
  expect(runs.status).toBe(200);
  expect(await runs.json()).toMatchObject({ schema: 'o8/managed-runs/v1', runs: expect.any(Array) });
});

it('accepts the artifact upload size range and retains the default for other routes', async () => {
  const body = { packetId: 'packet-a', kind: 'video', mimeType: 'video/mp4' };
  const accepted = await call('/api/panel/artifacts', { ...body, bytesBase64: Buffer.alloc(17 * 1024 * 1024, 120).toString('base64') });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ artifactId: expect.any(String) });
  const oversized = await call('/api/panel/artifacts', { ...body, bytesBase64: Buffer.alloc(25 * 1024 * 1024 + 1, 120).toString('base64') });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: 'Artifact too large (max 25 MB).' });
  const other = await call('/api/panel/managed-runs', { padding: 'x'.repeat(16 * 1024 * 1024 - 13) });
  expect(other.status).toBe(413);
  expect(await other.json()).toMatchObject({ error: 'Request exceeds 16 MiB' });
}, 120_000);

it.each([
  ['foreign', 'native-foreign', false, 403],
  ['own', 'native-checkout', false, 200],
  ['latest', 'native-checkout', true, 200],
] as const)('enforces the native managed-run directory: %s', async (name, folder, omitLane, status) => {
  const id = `nativedirectory${name}`;
  const cwd = join(directory, folder);
  const response = await call('/api/panel/managed-runs', {
    id, session: `cortex-run-${id}`, command: 'fixture', cwd, packetId: 'packet-a',
    ...(omitLane ? {} : { laneId: seeded.own }),
  });
  expect(response.status).toBe(status);
  const sqlite = new Database(join(directory, 'cortex-ide.db'), { readonly: true });
  try {
    const events = sqlite.prepare('SELECT event_type, repo_path FROM automation_source_events WHERE source_kind = ? AND source_id = ?').all('managed_run', id);
    if (status === 403) {
      expect(await response.json()).toMatchObject({ error: 'managed_run_directory_outside_checkout' });
      expect(events).toEqual([]);
      const runs = await call('/api/panel/managed-runs');
      expect((await runs.json()).runs.some((run: { id: string }) => run.id === id)).toBe(false);
    } else {
      expect(await response.json()).toMatchObject({ run: { cwd, packetId: 'packet-a', laneId: seeded.own } });
      expect(events).toContainEqual({ event_type: 'started', repo_path: directory });
    }
  } finally { sqlite.close(); }
});
