import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY
  ?? join(process.env.CARGO_TARGET_DIR ?? 'crates/o8d/target', 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');

it('serves live owner state and fresh timings through native GETs with Next stopped', async () => {
  if (!existsSync(binary)) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  const directory = mkdtempSync(join(tmpdir(), 'o8-cortex-transport-'));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let owner: ReturnType<typeof spawn> | undefined;
  try {
    server = await startParityReference({ o8d: true, binary, nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const read = async (path: string) => {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server!.token}` } });
      expect(response.status, path).toBe(200);
      return response.json();
    };
    expect((await read('/api/cortex/diagnostics')).timing.totalSamples).toBe(0);
    owner = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
      'tests/fixtures/cortex-state-owner.ts'], { env: { ...process.env,
      HOME: directory, USERPROFILE: directory, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let errors = '';
    owner.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-4000); });
    owner.stdout!.resume();
    await expect.poll(() => existsSync(join(directory, 'owner-result.json')), { timeout: 20_000 }).toBe(true);
    expect(errors).toBe('');
    await expect.poll(async () => (await read('/api/cortex/diagnostics')).timing.totalSamples, { timeout: 10_000 }).toBe(1);
    const diagnostic = await read('/api/cortex/diagnostics');
    expect(diagnostic.timing).toMatchObject({ totalSamples: 1, p95Ms: 43,
      byLabel: [{ label: 'fixture.owner.process', samples: 1 }] });
    expect(diagnostic.processCwdProbe.emptyRequestSkips).toBe(1);
    await Promise.all(['a', 'b'].map(label => promisify(execFile)(process.execPath,
      ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/cortex-state-owner.ts', '--timings-only', label],
      { env: { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory } })));
    const concurrent = await read('/api/cortex/diagnostics');
    expect(concurrent.timing.totalSamples).toBe(51);
    expect(concurrent.timing.byLabel).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'fixture.producer.a', samples: 25 }),
      expect.objectContaining({ label: 'fixture.producer.b', samples: 25 }),
    ]));
    writeFileSync(join(directory, 'finish-owner'), '');
    for (const path of ['/api/cortex/diagnostics']) {
      expect((await fetch(origin + path)).status).toBe(401);
      const refused = await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${server.token}` } });
      expect(refused.status).toBe(405);
      expect(refused.headers.get('allow')).toBe('GET');
    }
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const closed = once(owner, 'close');
      if (process.platform !== 'win32' && owner.pid) process.kill(-owner.pid, 'SIGTERM');
      else owner.kill('SIGTERM');
      await closed;
    }
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
