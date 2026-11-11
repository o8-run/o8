import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let dossierId: string;
let db: Database.Database;
const device = 'dossier-fixture-device';
const worker = 'dossier-fixture-worker';
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  const seed = await promisify(execFile)(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    const { enqueueInboxItem } = require('./src/lib/supervisor/inbox.ts');
    const { listProblemDossiers } = require('./src/lib/problems/dossiers.ts');
    for (const packetId of ['fixture-a', 'fixture-b', 'fixture-c']) enqueueInboxItem({
      repoPath: process.env.CORTEX_IDE_DATA_DIR, packetId, kind: 'verification_failed',
      payload: { verificationKind: 'typecheck', error: 'fixture repeated failure' },
    });
    console.log('seed ' + listProblemDossiers({ includeSuppressed: true })[0].id);
    require('./src/lib/db/index.ts').closeDb();
  `], { env: { ...process.env, HOME: server.directory, O8_DATA_DIR: server.directory,
    CORTEX_IDE_DATA_DIR: server.directory, CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db') }, timeout: 30_000 });
  dossierId = seed.stdout.split('\n').find(line => line.startsWith('seed '))!.slice(5);
  db = new Database(join(server.directory, 'cortex-ide.db'), { readonly: true });
}, 120_000);
afterAll(async () => { db?.close(); await server?.stop(); });
const post = (body: unknown, token = server.token) => fetch(`${origin}/api/panel/problem-dossiers`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-o8-client-addr': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }, body: JSON.stringify(body),
});
const persisted = () => db.prepare('SELECT status, suppression_reason FROM problem_dossiers WHERE id = ?').get(dossierId);
it('refuses lesser principals before changing a persisted dossier', async () => {
  const before = persisted();
  for (const [token, status] of [['', 401], ['wrong-token', 401], ['o8ro_fixture', 403], [device, 403], [worker, 403]] as const) {
    expect((await post({ action: 'suppress', dossierId, clientMutationId: 'forbidden' }, token)).status).toBe(status);
  }
  expect(persisted()).toEqual(before);
});
it('records and replays an operator decision through o8d with Next stopped', async () => {
  const body = { action: 'suppress', dossierId, clientMutationId: 'fixture-suppress', reason: 'fixture decision', cooldownDays: 2 };
  const response = await post(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, clientMutationId: body.clientMutationId });
  expect(persisted()).toEqual({ status: 'suppressed', suppression_reason: 'fixture decision' });
  const replay = await post(body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
  expect((await post({ ...body, reason: 'changed decision' })).status).toBe(409);
  expect(persisted()).toEqual({ status: 'suppressed', suppression_reason: 'fixture decision' });
  const listing = await fetch(`${origin}/api/panel/problem-dossiers?includeSuppressed=true`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(listing.status).toBe(200);
  expect((await listing.json()).dossiers).toEqual(expect.arrayContaining([expect.objectContaining({ id: dossierId, status: 'suppressed' })]));
});
it('keeps malformed decisions refused', async () => {
  expect((await post({ action: 'suppress', dossierId })).status).toBe(400);
  expect((await post({ action: 'unknown', dossierId, clientMutationId: 'invalid' })).status).toBe(400);
});
