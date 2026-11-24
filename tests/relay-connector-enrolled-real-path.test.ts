import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-relay-enrolled-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { writeCachedEntitlement } = await import('@/lib/entitlement/license');
const { createEnrollCode, listDevices } = await import('@/lib/mobile/device-registry');
const { relayConnectorRunning, stopRelayConnector, syncRelayConnector } = await import('@/lib/mobile/relay-connector');
const { handleRelayConnectorSyncRequest } = await import('@/lib/mobile/relay-connector-sync');
const enroll = await import('@/app/api/mobile/enroll/route');
const revoke = await import('@/app/api/mobile/devices/revoke/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { NextRequest } = await import('next/server');

let relay: WebSocketServer;
let wsServer: Server;
const dials: number[] = [];

beforeAll(async () => {
  // A paid plan with a cached license: before this change the connector dialed at boot.
  expect(writeCachedEntitlement({ plan: 'pro', licenseKey: 'fixture-license', status: 'active', expiresAt: null })).toBe(true);
  vi.stubEnv('O8_PLAN', '');
  vi.stubEnv('O8_RELAY_CONNECTOR', 'on');
  relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => relay.once('listening', resolve));
  relay.on('connection', () => dials.push(Date.now()));
  const address = relay.address();
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind');
  vi.stubEnv('O8_RELAY_URL', `ws://127.0.0.1:${address.port}`);

  // The ws-server's internal endpoint, as the enroll and revoke routes reach it.
  const token = getOrCreateWsToken();
  wsServer = createServer((req, res) => {
    if (!handleRelayConnectorSyncRequest(req, res, (r) => r.headers.authorization === `Bearer ${token}`, syncRelayConnector)) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const wsAddress = wsServer.address();
  if (!wsAddress || typeof wsAddress === 'string') throw new Error('ws fixture did not bind');
  vi.stubEnv('WS_PORT', String(wsAddress.port));
  vi.stubEnv('O8_WS_PORT', String(wsAddress.port));
});

afterAll(async () => {
  stopRelayConnector();
  for (const socket of relay.clients) socket.terminate();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('the relay connector follows enrolled phones', () => {
  it('stays off with no phone, starts on the first enroll, and stops on the last revoke', async () => {
    expect(syncRelayConnector()).toBe(false);
    await settle();
    expect(relayConnectorRunning()).toBe(false);
    expect(dials).toEqual([]);

    const code = createEnrollCode(Date.now());
    const enrolled = await enroll.POST(new NextRequest('http://127.0.0.1/api/mobile/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enroll: code, identityPublicKey: 'fixture-phone-key', deviceLabel: 'Fixture phone' }),
    }));
    expect(enrolled.status, await enrolled.clone().text()).toBe(200);
    await settle();
    expect(relayConnectorRunning()).toBe(true);
    expect(dials.length).toBe(1);

    const [device] = listDevices();
    const revoked = await revoke.POST(new NextRequest('http://127.0.0.1/api/mobile/devices/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ deviceId: device!.id }),
    }));
    expect(revoked.status).toBe(200);
    await settle();
    expect(relayConnectorRunning()).toBe(false);
    expect(relay.clients.size).toBe(0);
  });

  it('stays off under O8_NO_PHONE_HOME=1 even with a phone enrolled', async () => {
    const code = createEnrollCode(Date.now());
    const enrolled = await enroll.POST(new NextRequest('http://127.0.0.1/api/mobile/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enroll: code, identityPublicKey: 'fixture-phone-key-2' }),
    }));
    expect(enrolled.status).toBe(200);
    await settle();
    expect(relayConnectorRunning()).toBe(true);
    const before = dials.length;

    vi.stubEnv('O8_NO_PHONE_HOME', '1');
    expect(syncRelayConnector()).toBe(false);
    await settle();
    expect(relayConnectorRunning()).toBe(false);
    expect(relay.clients.size).toBe(0);
    expect(dials.length).toBe(before);
  });
});
