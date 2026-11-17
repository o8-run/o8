import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { o8dBinaryPath, o8dStartsByDefault } from '@/lib/ws-server/o8d-binary';
import { beforeAll, describe, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const targetDir = resolve('crates/o8d/target/session-reads');
const binary = resolve(process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug',
  process.platform === 'win32' ? 'o8d.exe' : 'o8d'));
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked',
    '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
  { maxBuffer: 64 * 1024 * 1024 });
  accessSync(binary, constants.X_OK);
}, 900_000);

describe('default daemon through the real WS server', () => {
  it.each([
    ['default', binary, 'o8d'],
    [false, binary, undefined],
    ['default', resolve('package.json'), undefined],
    ['default', resolve('missing-o8d-fixture'), undefined],
    [true, resolve('missing-o8d-fixture'), 'typescript'],
  ] as const)('flag %s with %s serves %s', async (o8d, executable, transport) => {
    const server = await startParityReference({ o8d, binary: executable });
    try {
      const response = await fetch(server.url.replace('ws:', 'http:').replace('/ws', '/health'));
      expect(response.status).toBe(200);
      const health = await response.json();
      // Existing bridge status is emitted by the production health route.
      expect(health.delivery?.transport).toBe(transport);
      if (transport === 'o8d') {
        expect(health.delivery.pid).toBeGreaterThan(0);
        process.kill(health.delivery.pid, 'SIGKILL');
        await expect.poll(async () => {
          const recovered = await fetch(server.url.replace('ws:', 'http:').replace('/ws', '/health')).catch(() => null);
          return recovered ? (await recovered.json()).delivery?.transport : null;
        }, { timeout: 1_500, interval: 25 }).toBe('typescript');
      }
    } finally { await server.stop(); }
  }, 90_000);
});

it('resolves the bundled helper before source fallback and honors explicit overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8d-discovery-'));
  try {
    const resources = join(directory, 'Contents/Resources/server');
    const helpers = join(directory, 'Contents/MacOS');
    mkdirSync(resources, { recursive: true });
    mkdirSync(helpers, { recursive: true });
    const shipped = join(helpers, 'o8d');
    const moduleUrl = pathToFileURL(join(resources, 'ws-server.js')).href;
    writeFileSync(shipped, '', { mode: 0o755 });
    expect(o8dBinaryPath({}, moduleUrl)).toBe(shipped);
    expect(o8dBinaryPath({ O8D_BINARY: binary }, moduleUrl)).toBe(binary);
    expect(o8dStartsByDefault({}, moduleUrl)).toBe(true);
    rmSync(shipped);
    expect(o8dBinaryPath({}, moduleUrl)).toBe(resolve('crates/o8d/target/release/o8d'));
    // A daemon built in a source checkout is found, but does not start the bridge unasked.
    expect(o8dStartsByDefault({}, moduleUrl)).toBe(false);
    expect(o8dStartsByDefault({ O8D_BINARY: binary }, moduleUrl)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
