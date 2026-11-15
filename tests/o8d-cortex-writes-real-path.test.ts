import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let worker: string;
beforeAll(async () => {
  const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  server = await startParityReference({ o8d: true, binary, nativeHttp: true, startupTimeoutMs: 120_000 });
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  await server.stopNext();
  await expect(fetch(server.apiUrl + '/api/setup/identity')).rejects.toThrow();
  expect((await (await fetch(origin + '/health')).json()).delivery.transport).toBe('o8d');
  worker = execFileSync(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    const { createLane } = require('./src/lib/lane/registry.ts');
    const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
    const lane = createLane({ repoPath: process.env.CORTEX_IDE_DATA_DIR, branch: 'fixture-cortex-', runtime: 'codex', packetId: 'fixture-cortex-writes' });
    console.log('WORKER=' + mintPacketWorkerToken(lane.packetId));
    require('./src/lib/db/index.ts').closeDb();
  `], { encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: server.directory, CORTEX_IDE_DATA_DIR: server.directory,
    CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token } })
    .split('\n').find(line => line.startsWith('WORKER='))!.slice(7);
}, 180_000);
afterAll(async () => { await server?.stop(); });

const paths = ['/api/cortex/cross-repo-proposals', '/api/cortex/directives'];
it.each(paths)('keeps POST %s operator-only with Next stopped', async path => {
  const device = 'cortex-write-fixture-device-token-0123456789';
  writeFileSync(join(server.directory, 'mobile-device-tokens'), `${createHash('sha256').update(device).digest('hex')}\n`);
  for (const [bearer, status] of [[undefined, 401], ['fixture-invalid', 401], ['o8ro_fixture', 403], [device, 403], [worker, 403]] as const) {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    }, body: '{}' });
    expect(response.status).toBe(status);
    await response.arrayBuffer();
  }
});

it('persists a directive through o8d with Next stopped', async () => {
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const saved = await post(paths[1], { id: 'native-directive', title: 'Native directive', scope: 'global', body: 'Keep the accepted rule.' });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ ok: true, id: 'native-directive' });
  expect(readFileSync(join(server.directory, 'directives/native-directive.md'), 'utf8')).toContain('Keep the accepted rule.');
  const listed = await fetch(origin + paths[1], { headers });
  expect(listed.status).toBe(200);
  expect((await listed.json()).directives).toContainEqual(expect.objectContaining({ id: 'native-directive', body: 'Keep the accepted rule.' }));
});

it('persists proposal decisions through o8d with Next stopped', async () => {
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const accepted = await post(paths[0], { action: 'accept', directiveId: 'native-directive', originRepoId: 'fixture-origin' });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ ok: true, recordedAt: expect.any(String) });
  expect(readFileSync(join(server.directory, 'directive-origins.json'), 'utf8')).toContain('fixture-origin');
  const dismissed = await post(paths[0], { action: 'dismiss', directiveId: 'native-directive', targetRepoId: 'fixture-target' });
  expect(dismissed.status).toBe(200);
  expect(await dismissed.json()).toMatchObject({ ok: true, snoozedUntil: expect.any(String) });
  expect(readFileSync(join(server.directory, 'cross-repo-snooze.json'), 'utf8')).toContain('fixture-target');
});
