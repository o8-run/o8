import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { repositoryCorpus, runRepositoryParity, seedRepositoryFixture, sendRepository, startRepositoryServer } from '../scripts/o8d/repository-parity';
import { normalize } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/repository-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

it('records TS branch reads and replays every response natively with Next stopped', async () => {
  expect(await runRepositoryParity(binary, false)).toMatchObject({ requests: 12, differences: 0 });
}, 180_000);

it('preserves authorization refusals and the existing branch method boundary', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-repository-auth-')));
  let server: Awaited<ReturnType<typeof startRepositoryServer>> | undefined;
  try {
    await seedRepositoryFixture(directory);
    server = await startRepositoryServer(directory, true, binary);
    const path = repositoryCorpus(directory)[5];
    for (const credential of ['', 'wrong', 'o8ro_fixture']) {
      const response = await sendRepository(server, path, { authorization: credential ? `Bearer ${credential}` : '',
        'x-o8d-native-repository-read': '1', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' });
      expect(response.status).toBe(credential.startsWith('o8ro_') ? 403 : 401);
      expect(response.native).toBe(false);
    }
    const response = await fetch(`${server.origin}/api/panel/branches`, { method: 'DELETE',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('x-o8d-native-repository-read')).toBeNull();
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it.skipIf(process.platform === 'win32')('falls back through the real registry when only the private daemon cannot start', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-repository-fallback-')));
  let server: Awaited<ReturnType<typeof startRepositoryServer>> | undefined;
  try {
    await seedRepositoryFixture(directory);
    const path = repositoryCorpus(directory)[5];
    server = await startRepositoryServer(directory, false, binary);
    const expected = await sendRepository(server, path);
    expect(expected.status).toBe(200);
    expect(expected.native).toBe(false);
    await server.stop(); server = undefined;
    const wrapper = join(directory, 'fixture-o8d-without-private-http');
    const quotedBinary = `'${binary.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--experimental-http" ]; then exit 1; fi\ndone\nexec ${quotedBinary} "$@"\n`, { mode: 0o700 });
    server = await startRepositoryServer(directory, true, wrapper);
    const actual = await sendRepository(server, path);
    expect(actual.native).toBe(false);
    expect(normalize(actual)).toEqual(normalize(expected));
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it.skipIf(process.env.O8D_PARITY_BENCH !== '1')('measures repository backend RSS and branch p50', async () => {
  const result = await runRepositoryParity(binary, true);
  expect(result.differences).toBe(0);
  expect(result.on?.rss.processes).toBeGreaterThanOrEqual(2);
  console.log(JSON.stringify(result, null, 2));
}, 240_000);
