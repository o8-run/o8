import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { O8dBridge } from '@/lib/ws-server/o8d-bridge';

// The WS listener's wiring on o8d's private upstream (ws-server.ts): the bridge decides which
// peer a request may claim, and the native routes stamp x-o8-client-addr from it (#5576).
const worker = 'native-verified-peer-worker-0123456789abcdef';
let upstream: Server;
let bridge: O8dBridge;
let port: number;
let key: string;

beforeAll(async () => {
  const { getDataDir } = await import('@/lib/data-dir-migration');
  writeFileSync(join(getDataDir(), 'worker-token'), worker);
  const { O8dBridge } = await import('@/lib/ws-server/o8d-bridge');
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  upstream = createServer((req, res) => {
    void handleNativeHttp(req, res, port, bridge.bridged(req), bridge.clientAddress(req))
      .then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  bridge = new O8dBridge(upstream, 0, 'fixture-epoch');
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as AddressInfo).port;
  // Only o8d holds this per-process key; the test plays o8d's part with it.
  key = (bridge as unknown as { key: string }).key;
});

afterAll(async () => {
  upstream?.closeAllConnections();
  await new Promise<void>(resolve => upstream ? upstream.close(() => resolve()) : resolve());
});

const call = (path: string, bearer: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${bearer}`, ...headers } });

it('trusts a relayed peer only with the bridge key and one IP literal', async () => {
  // problem-dossiers admits a worker in its handler only from loopback (requirePanelAuth).
  const dossiers = (headers: Record<string, string>) => call('/api/panel/problem-dossiers', worker, headers);
  expect((await dossiers({ 'x-o8d-bridge': key, 'x-o8d-peer': '127.0.0.1' })).status).toBe(200);
  expect((await dossiers({ 'x-o8d-bridge': 'forged', 'x-o8d-peer': '127.0.0.1' })).status).toBe(401);
  expect((await dossiers({ 'x-o8d-bridge': key, 'x-o8d-peer': 'unverified-proxy' })).status).toBe(401);
  expect((await dossiers({ 'x-o8d-bridge': key, 'x-o8d-peer': '127.0.0.1, 10.0.0.5' })).status).toBe(401);
  expect((await dossiers({ 'x-o8-client-addr': '127.0.0.1' })).status).toBe(401);
});

it('refuses a packet worker from a remote peer on its lane diff', async () => {
  const { getDataDir } = await import('@/lib/data-dir-migration');
  const { createLane } = await import('@/lib/lane/registry');
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const lane = createLane({ repoPath: getDataDir(), branch: 'fixture-unresolved-', runtime: 'codex', packetId: 'fixture-verified-peer' });
  const token = mintPacketWorkerToken(lane.packetId!);
  const diff = (peer: string) => call(`/api/lanes/${lane.id}/diff`, token, { 'x-o8d-bridge': key, 'x-o8d-peer': peer });
  // From loopback the worker reaches its own lane's handler (an unresolved branch is 409).
  expect((await diff('127.0.0.1')).status).toBe(409);
  // A packet token alone no longer stands in for a loopback address.
  expect((await diff('203.0.113.5')).status).toBe(401);
});

it('never upgrades a request that carries an HTTP stamp', () => {
  const request = (headers: IncomingHttpHeaders) => ({ headers, socket: { localPort: port } }) as unknown as IncomingMessage;
  expect(bridge.allowsUpgrade(request({ 'x-o8d-bridge': key, 'x-o8d-peer': '127.0.0.1' }))).toBe(true);
  expect(bridge.allowsUpgrade(request({ 'x-o8d-bridge': key, 'x-o8d-peer': '127.0.0.1', 'x-o8d-relay': 'http' }))).toBe(false);
  expect(bridge.allowsUpgrade(request({ 'x-o8d-bridge': key, 'x-o8d-peer': '127.0.0.1', 'x-o8d-relay': '' }))).toBe(false);
});

it('stamps the caller like the production wrapper and only ever removes loopback trust', async () => {
  const { nativeClientAddr } = await import('@/lib/ws-server/native-http-routes');
  const stamp = (address: string | null, headers: Record<string, string>, method = 'GET', target = '/api/x') =>
    nativeClientAddr(address, name => headers[name] ?? null, method, target, 3101);
  const local = { host: '127.0.0.1:3101' };
  expect(stamp(null, local)).toEqual({ address: 'unverified-proxy', relaySurface: null });
  expect(stamp('127.0.0.1', local)).toEqual({ address: '127.0.0.1', relaySurface: null });
  expect(stamp('::ffff:127.0.0.1', local).address).toBe('::ffff:127.0.0.1');
  expect(stamp('192.168.1.20', { host: '192.168.1.20:3101', 'x-o8-relay-forward': '1' }).address).toBe('192.168.1.20');
  expect(stamp('127.0.0.1', { ...local, 'x-o8-relay-forward': '1', 'x-o8-relay-surface': 'web-machine' }))
    .toEqual({ address: 'o8-relay-forward', relaySurface: 'web-machine' });
  expect(stamp('127.0.0.1', { ...local, 'x-o8-relay-forward': '1', 'x-o8-relay-surface': 'other' }))
    .toEqual({ address: 'o8-relay-forward', relaySurface: null });
  expect(stamp('127.0.0.1', { 'x-o8-relay-surface': 'web-machine', ...local }).relaySurface).toBeNull();
  for (const unverified of [
    stamp('127.0.0.1', {}),
    stamp('127.0.0.1', { host: 'evil.example:3101' }),
    stamp('127.0.0.1', { host: '127.0.0.1:3999' }),
    stamp('127.0.0.1', local, 'GET', 'http://evil.example/api/x'),
    stamp('127.0.0.1', { ...local, origin: 'https://evil.example' }, 'POST'),
    nativeClientAddr('127.0.0.1', name => (local as Record<string, string>)[name] ?? null, 'GET', '/api/x', undefined),
  ]) expect(unverified).toEqual({ address: 'unverified-proxy', relaySurface: null });
});

it('marks a Next caller that Next did not see as local when it forwards to the WS listener', async () => {
  const received: IncomingHttpHeaders[] = [];
  const listener = createServer((req, res) => { received.push(req.headers); res.end('{}'); });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', String((listener.address() as AddressInfo).port));
  try {
    const { ownedByNativeTransport } = await import('@/lib/ws-server/native-owner');
    const forward = ownedByNativeTransport(async () => new Response('local'), () => new Response(null, { status: 503 }));
    const { NextRequest } = await import('next/server');
    const request = (clientAddr: string) => new NextRequest('http://127.0.0.1:3000/api/tts', {
      headers: { host: '127.0.0.1:3000', 'x-o8-client-addr': clientAddr, authorization: 'Bearer fixture' } });
    expect((await forward(request('127.0.0.1'))).status).toBe(200);
    expect((await forward(request('203.0.113.5'))).status).toBe(200);
    expect((await forward(request('o8-relay-forward'))).status).toBe(200);
    expect(received.map(headers => headers['x-o8-relay-forward'] ?? null)).toEqual([null, '1', '1']);
    expect(received.every(headers => headers['x-o8-client-addr'] === undefined)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});
