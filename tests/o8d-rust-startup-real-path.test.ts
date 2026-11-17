import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { firstDifference, generateRequests, mismatchReceipt, normalize, seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY
  ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
const paths = ['/api/panel/ws-info', '/api/setup/identity'] as const;
const headersToCompare = ['content-type', 'cache-control', 'access-control-allow-origin', 'allow'];
type Running = Awaited<ReturnType<typeof startParityReference>>;

beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  const { stdout } = await promisify(execFile)('df', ['-Pk', '/']);
  const availableKiB = Number(stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]);
  if (!(availableKiB >= 15 * 1024 * 1024)) throw new Error('Startup parity build requires 15 GiB free');
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml',
    '--features', 'experimental-session-reads', '--target-dir', targetDir], { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

async function listen() {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function freePort() { const listener = await listen(); await close(listener.server); return listener.port; }
async function start(directory: string, enabled: boolean, fixedPorts: { api: number; ws: number }, filePorts = false,
  identityEnv?: { O8_INSTANCE_ID?: string; O8_BOOT_ID?: string }) {
  const server = await startParityReference({ directory, binary, nativeHttp: true, o8d: true,
    nativeSessionReads: enabled, fixedPorts, startupFilePorts: filePorts, identityEnv });
  await server.stopNext();
  return server;
}
async function read(server: Running, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${server.token}`, ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  const body = await response.json() as unknown;
  return { native: response.headers.get('x-o8d-native-session-read') === '1',
    wire: normalize({ status: response.status, body,
      headers: Object.fromEntries(headersToCompare.map(name => [name, response.headers.get(name)])) }) };
}
function equal(expected: unknown, actual: unknown, path: string) {
  const difference = firstDifference(expected, actual);
  if (difference) throw new Error(`Startup parity ${path}: ${difference}`);
}

it('records TS startup reads, replays 500 shared-generator requests per route natively, and preserves headers/auth', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-startup-parity-')));
  const fixedPorts = { api: await freePort(), ws: await freePort() };
  const live = await listen();
  const dead = await freePort();
  let server: Running | undefined;
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'instance-id'), 'fixture-startup-instance\n', { mode: 0o600 });
    writeFileSync(join(directory, 'boot-id'), 'fixture-startup-boot\n', { mode: 0o600 });
    const savedIds = ['instance-id', 'boot-id'].map(name => readFileSync(join(directory, name), 'utf8'));
    const corpus: Array<{ path: string; expected: unknown }> = [];
    const refusals: Array<{ path: string; headers: Record<string, string>; method?: string; expected?: unknown }> = [];
    for (const path of paths) {
      for (const credential of ['', 'wrong', 'o8ro_fixture']) refusals.push({ path, headers: {
        authorization: credential ? `Bearer ${credential}` : '', 'x-o8d-session-read': 'authorize',
        'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1',
      } });
      refusals.push({ path, headers: { host: 'fixture.invalid', authorization: '' } });
      refusals.push({ path, method: 'POST', headers: { origin: 'https://fixture.invalid' } });
    }
    const portCases = [String(live.port), `+${live.port}tail`, '65536', '0', '-1', 'invalid', String(dead)];
    const portExpected: unknown[] = [];
    for (const enabled of [false, true]) {
      server = await start(directory, enabled, fixedPorts);
      for (const path of paths) {
        // Neither handler accepts query parameters; reuse the shared seeded
        // generator with an empty parameter profile instead of inventing one.
        for (const generated of generateRequests({ path, parameters: [], count: 500 })) {
          const request = generated.path;
          const result = await read(server, request);
          if (!enabled) {
            expect(result.native).toBe(false);
            corpus.push({ path: request, expected: result.wire });
          } else {
            if (!result.native) throw new Error(`Native route was not reached: ${path}`);
            const difference = mismatchReceipt(generated, corpus.find(record => record.path === request)!.expected, result.wire);
            expect(difference, difference ? JSON.stringify(difference) : undefined).toBeNull();
          }
        }
      }
      for (const [index, value] of portCases.entries()) {
        writeFileSync(join(directory, 'ws-port'), value);
        const result = await read(server, paths[0]);
        if (!enabled) portExpected.push(result.wire);
        else { expect(result.native).toBe(true); equal(portExpected[index], result.wire, paths[0]); }
        expect((result.wire as { body: { wsPort: number } }).body.wsPort)
          .toBe(index < 2 ? live.port : fixedPorts.ws);
      }
      for (const refusal of refusals) {
        const result = await read(server, refusal.path, refusal.headers, refusal.method);
        expect(result.native).toBe(false);
        if (!enabled) refusal.expected = result.wire;
        else equal(refusal.expected, result.wire, refusal.path);
      }
      expect(['instance-id', 'boot-id'].map(name => readFileSync(join(directory, name), 'utf8'))).toEqual(savedIds);
      await server.stop(); server = undefined;
    }
  } finally { await server?.stop(); await close(live.server); rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

it('matches file-cache asymmetry and defers changed api-port or missing IDs/credentials to TS', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-startup-cache-')));
  const fixedPorts = { api: await freePort(), ws: await freePort() };
  const live = await listen();
  const dead = await freePort();
  let server: Running | undefined;
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'instance-id'), 'fixture-cache-instance\n');
    writeFileSync(join(directory, 'boot-id'), 'fixture-cache-boot\n');
    const recorded: unknown[] = [];
    for (const enabled of [false, true]) {
      writeFileSync(join(directory, 'api-port'), String(fixedPorts.api));
      writeFileSync(join(directory, 'ws-port'), String(fixedPorts.ws));
      server = await start(directory, enabled, fixedPorts, true);
      const sequence = async () => {
        const result: unknown[] = [];
        for (const filePort of [live.port, dead]) {
          writeFileSync(join(directory, 'ws-port'), `${filePort}suffix`);
          for (const path of paths) {
            const response = await read(server!, path);
            expect(response.native).toBe(enabled);
            result.push(response.wire);
          }
        }
        return result;
      };
      const responses = await sequence();
      if (!enabled) recorded.push(...responses); else equal(recorded, responses, 'port-cache sequence');
      if (enabled) {
        // Changing only ws-port keeps identity on its cached value. Changing
        // api-port invalidates native authority; TS alone updates its cache.
        const apiPath = join(directory, 'api-port');
        const oldMtime = statSync(apiPath).mtimeMs;
        writeFileSync(apiPath, `${fixedPorts.api}changed`);
        utimesSync(apiPath, new Date(oldMtime + 2_000), new Date(oldMtime + 2_000));
        for (const path of paths) expect((await read(server, path)).native).toBe(false);
      }
      await server.stop(); server = undefined;
    }
    // A fresh launch restores authority, then files disappear after startup.
    writeFileSync(join(directory, 'api-port'), String(fixedPorts.api));
    writeFileSync(join(directory, 'ws-port'), String(fixedPorts.ws));
    server = await start(directory, true, fixedPorts, true);
    unlinkSync(join(directory, 'boot-id'));
    const fallback = await read(server, paths[1]);
    expect(fallback.native).toBe(false);
    expect(readFileSync(join(directory, 'boot-id'), 'utf8').trim()).not.toBe('');
    // Compare the body saved by the TS writer against a flag-off replay.
    await server.stop(); server = await start(directory, false, fixedPorts, true);
    equal(fallback.wire, (await read(server, paths[1])).wire, paths[1]);
    await server.stop(); server = await start(directory, true, fixedPorts, true);
    const before = await read(server, paths[0]);
    unlinkSync(join(directory, 'ws-token'));
    const missingToken = await read(server, paths[0]);
    expect(missingToken.native).toBe(false);
    equal(before.wire, missingToken.wire, paths[0]);
  } finally { await server?.stop(); await close(live.server); rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

it('uses trimmed ID environment overrides without creating identity files', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-startup-id-env-')));
  const fixedPorts = { api: await freePort(), ws: await freePort() };
  let server: Running | undefined;
  try {
    await seedSessionFixture(directory);
    server = await start(directory, true, fixedPorts, false,
      { O8_INSTANCE_ID: ' \ufefffixture-env-instance\n', O8_BOOT_ID: ' fixture-env-boot ' });
    const response = await read(server, paths[1]);
    if (!response.native) throw new Error(`Native route was not reached: ${paths[1]}`);
    expect((response.wire as { body: unknown }).body).toMatchObject({
      product: 'o8', instanceId: 'fixture-env-instance', bootId: 'fixture-env-boot',
      apiPort: fixedPorts.api, wsPort: fixedPorts.ws,
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(directory, 'instance-id'))).toBe(false);
    expect(existsSync(join(directory, 'boot-id'))).toBe(false);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
