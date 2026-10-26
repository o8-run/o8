import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bundleServers } from '../scripts/lib/server-bundles.mjs';
import { stagePackagedNativeAddons } from './helpers/packaged-native-addons';
import { runRecordedSession, type RecordedSession } from '../scripts/lib/ws-parity-session';
import { startParityReference } from './fixtures/ws-parity-server';
import { cutoverClient, cutoverHealth, publishCutoverMutation, waitForTransport } from './fixtures/ws-cutover-client';

const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
const bundleRoot = mkdtempSync(join(tmpdir(), 'o8-cutover-bundle-'));
const entry = join(bundleRoot, 'ws-server.mjs');
const startCutoverReference = (options: Parameters<typeof startParityReference>[0]) =>
  startParityReference({ ...options, entry });
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked',
    '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  // Use the production build and launcher once, rather than retranspiling the
  // complete source graph in every fresh worker. State and workers stay isolated.
  bundleServers({ root: process.cwd(), outDir: bundleRoot });
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: bundleRoot });
  cpSync('src/lib/lane/orchestrator.md', join(bundleRoot, 'orchestrator.md'));
}, 120_000);

it('keeps the TypeScript transport and protocol with the flag off', async () => {
  const server = await startCutoverReference({ o8d: false, binary });
  try {
    expect((await cutoverHealth(server)).delivery).toBeUndefined();
    const recording = JSON.parse(readFileSync('tests/fixtures/ws-parity/control.json', 'utf8')) as RecordedSession;
    await runRecordedSession(recording, { ...server, fixtureUrl: server.apiUrl });
  } finally { await server.stop(); }
});

it.each(['control', 'replay', 'gap', 'incompatible'])('serves the live %s recording through o8d', async (name) => {
  const server = await startCutoverReference({ o8d: true, binary });
  try {
    const health = await fetch(server.url.replace('ws:', 'http:').replace('/ws', '/health')).then((r) => r.json());
    expect(health.delivery?.transport).toBe('o8d');
    const recording = JSON.parse(readFileSync(`tests/fixtures/ws-parity/${name}.json`, 'utf8')) as RecordedSession;
    expect(await runRecordedSession(recording, { ...server, fixtureUrl: server.apiUrl })).toMatchObject({ closes: expect.any(Number) });
  } finally {
    await server.stop();
  }
});

it('rejects unmarked private upgrades after HTTP keepalive, even with spoofed peer headers', async () => {
  const server = await startCutoverReference({ o8d: true, binary });
  const endpoint = new URL(server.url);
  const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
  try {
    await once(socket, 'connect');
    let response = '';
    socket.on('data', (data) => { response += data.toString(); });
    const closed = once(socket, 'close');
    socket.write('GET /health HTTP/1.1\r\nHost: fixture\r\nConnection: keep-alive\r\n\r\n'
      + `GET /ws?token=${server.token} HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\n`
      + 'Upgrade:websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'x-o8d-bridge: forged\r\nx-o8d-peer: 127.0.0.1\r\n\r\n');
    await closed;
    expect(response.includes('401 Unauthorized')).toBe(true);
    expect(response.includes('101 Switching Protocols')).toBe(false);
  } finally { socket.destroy(); await server.stop(); }
});

it('falls back when the binary is missing, through the unchanged app URL', async () => {
  const server = await startCutoverReference({ o8d: true, binary: join(process.cwd(), 'missing-o8d-fixture') });
  try {
    await waitForTransport(server, 'typescript');
    const client = await cutoverClient(server.url, server.token);
    try {
      await publishCutoverMutation(server, 'missing-binary');
      await client.delivered('missing-binary');
    } finally { await client.close(); }
  } finally { await server.stop(); }
});

it('bounds the producer pipe and replays an oversized publication after falling back', async () => {
  const started = performance.now();
  const server = await startCutoverReference({ o8d: true, binary, logLimit: 400 });
  try {
    const first = await cutoverClient(server.url, server.token);
    await publishCutoverMutation(server, 'pipe-overflow', 1024 * 1024 + 1);
    await waitForTransport(server, 'typescript');
    // Background publications must not evict the cutover event before resubscribe.
    for (let index = 0; index < 6; index++) await publishCutoverMutation(server, `during-handoff-${index}`);
    const fallback = await cutoverClient(server.url, server.token, { since: first.since, epoch: first.epoch });
    try {
      await fallback.delivered('pipe-overflow');
      const replayed = fallback.events().filter((event) => event.data?.mutation?.mutationId === 'pipe-overflow');
      expect(replayed).toHaveLength(1);
      expect(replayed[0].data?.mutation?.note).toHaveLength(1024 * 1024 + 1);
      const elapsed = performance.now() - started;
      console.info(`Oversized replay completed in ${Math.round(elapsed)} ms`);
      expect(elapsed).toBeLessThan(3_000);
    } finally { await fallback.close(); await first.close(); }
  } finally { await server.stop(); }
});

it('completes accepted HTTP ingress across a pipe-triggered handoff to TypeScript', async () => {
  const server = await startCutoverReference({ o8d: true, binary, logLimit: 400 });
  const first = await cutoverClient(server.url, server.token);
  const body = JSON.stringify({ kind: 'mutation', mutation: { mutationId: 'accepted-before-drain',
    source: 'server', action: 'cutover-fixture', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' } });
  const request = httpRequest(new URL('/internal/realtime', server.url.replace(/^ws/, 'http')), {
    method: 'POST', agent: false, headers: { Authorization: `Bearer ${server.token}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Expect: '100-continue', Connection: 'close' },
  });
  const completed = new Promise<number | null>((resolve) => {
    request.once('error', () => resolve(null));
    request.once('response', (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? null));
    });
  });
  try {
    request.flushHeaders();
    // The real TS HTTP server's Continue proves it accepted this request.
    await once(request, 'continue');
    await publishCutoverMutation(server, 'drain-trigger', 1024 * 1024 + 1);
    await waitForTransport(server, 'typescript');
    await new Promise((resolve) => setTimeout(resolve, 400));
    request.end(body);
    expect(await completed).toBe(202);
    const fallback = await cutoverClient(server.url, server.token, { since: first.since, epoch: first.epoch });
    try {
      await fallback.delivered('accepted-before-drain');
      expect(fallback.events().filter((event) => event.data?.mutation?.mutationId === 'accepted-before-drain')).toHaveLength(1);
    } finally { await fallback.close(); }
  } finally { request.destroy(); await first.close(); await server.stop(); }
});

it('replays every event across exit, TS fallback publication and a Rust restart', async () => {
  const server = await startCutoverReference({ o8d: true, binary, logLimit: 400 });
  try {
    const first = await cutoverClient(server.url, server.token);
    const resume = { since: first.since, epoch: first.epoch };
    const rust = await waitForTransport(server, 'o8d');
    for (let index = 0; index < 10; index += 1) await publishCutoverMutation(server, `before-${index}`);
    await first.delivered('before-9');
    process.kill(rust.pid!, 'SIGKILL');
    await waitForTransport(server, 'typescript');
    const fallback = await cutoverClient(server.url, server.token, resume);
    for (let index = 0; index < 10; index += 1) await publishCutoverMutation(server, `outage-${index}`);
    await fallback.delivered('outage-9');
    await waitForTransport(server, 'o8d', 2);
    const restarted = await cutoverClient(server.url, server.token, resume);
    try {
      for (let index = 0; index < 10; index += 1) await publishCutoverMutation(server, `after-${index}`);
      await restarted.delivered('after-9');
      const ids = restarted.events().flatMap((event) => event.data?.mutation ? [event.data.mutation.mutationId] : []);
      expect(ids).toEqual(['before', 'outage', 'after'].flatMap((phase) => Array.from({ length: 10 }, (_, index) => `${phase}-${index}`)));
      expect(restarted.epoch).toBe(resume.epoch);
    } finally {
      await restarted.close();
      await fallback.close();
      await first.close();
    }
  } finally { await server.stop(); }
});
