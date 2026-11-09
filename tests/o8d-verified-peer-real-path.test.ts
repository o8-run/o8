import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// o8d attests the TCP peer on each relayed HTTP request (#5576), so a native route sees the
// caller's real address, as Next's production wrapper stamps it. A loopback caller regains the
// loopback trust Next grants; every boundary can only take that trust away.
const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY
  ?? join(process.cwd(), 'crates/o8d/target/debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
const worker = 'verified-peer-fixture-worker-0123456789abcdef';
let server: Awaited<ReturnType<typeof startParityReference>>;
let directory: string;
let origin: string;
let port: number;

beforeAll(async () => {
  if (!process.env.O8D_BINARY && !process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked',
    '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-verified-peer-')));
  writeFileSync(join(directory, 'worker-token'), worker);
  server = await startParityReference({ o8d: true, binary, nativeHttp: true, directory, startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  port = Number(new URL(origin).port);
  // Every request below crosses the Rust relay, not the TypeScript fallback listener.
  expect((await (await fetch(`${origin}/health`)).json()).delivery.transport).toBe('o8d');
}, 300_000);

afterAll(async () => {
  await server?.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** One raw HTTP request, so a test controls the request line and the Host header itself. */
function raw(head: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(head));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { received += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? 0)));
  });
}

it.skipIf(process.platform === 'win32')('admits a loopback worker through the attested peer, as Next does', async () => {
  // problem-dossiers checks requirePanelAuth in its handler: a worker passes only from loopback.
  const forged = { 'x-o8-client-addr': '203.0.113.5', 'x-o8d-peer': '203.0.113.5', 'x-o8d-bridge': 'forged' };
  const response = await fetch(`${origin}/api/panel/problem-dossiers`, { headers: { authorization: `Bearer ${worker}`, ...forged } });
  expect(response.status).toBe(200);
});

it.skipIf(process.platform === 'win32')('gives a loopback request without Host no loopback trust', async () => {
  // setup/identity is a loopback read. Without Host the gate would infer the public port, so
  // only the stamp's own Host requirement keeps an HTTP/1.0 caller from loopback trust.
  expect(await raw('GET /api/setup/identity HTTP/1.0\r\n\r\n')).toBe(401);
  expect(await raw(`GET /api/setup/identity HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`)).toBe(200);
});

it.skipIf(process.platform === 'win32')('stamps a same-host relay of a remote caller as remote', async () => {
  const relayed = { 'x-o8-relay-forward': '1', 'x-o8-relay-surface': 'web-machine' };
  expect((await fetch(`${origin}/api/setup/identity`)).status).toBe(200);
  expect((await fetch(`${origin}/api/setup/identity`, { headers: relayed })).status).toBe(401);
  const dossiers = (headers: Record<string, string>) => fetch(`${origin}/api/panel/problem-dossiers`,
    { headers: { authorization: `Bearer ${worker}`, ...headers } });
  expect((await dossiers(relayed)).status).toBe(401);
  expect((await dossiers({})).status).toBe(200);
});
