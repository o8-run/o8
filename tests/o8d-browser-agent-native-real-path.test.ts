import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Browser-automation verbs over the native transport with Next stopped. POST is in
// WORKER_CAPABILITIES, so panelGateMiddleware admits the operator ws-token and a
// packet-worker token (device/spectator/anonymous are refused there); the handler
// then runs workerPacketRefusal, scoping a worker to its own packetId. The native
// answer must equal the in-process TS handler on the cases that reach it.
it.skipIf(process.platform === 'win32')('serves browser-automation verbs natively, operator- or packet-worker-scoped, and refuses the rest (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-browser-agent-')));
  const device = 'browser-agent-fixture-device-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const send = (headers: Record<string, string>, body: unknown) => fetch(`${origin}/api/browser/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Middleware gate over native: a caller with no operator/worker bearer is refused
    // before the handler (forged loopback markers are inert under unverified-proxy).
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await send(forged, { verb: 'read' })).status).toBe(401);
    expect((await send({ ...forged, authorization: `Bearer ${device}` }, { verb: 'read' })).status).toBe(403);

    // Mint a packet-bound worker credential in the child's data dir so the native
    // principal resolver (SQLite worker_tokens) sees it, and import the TS handler.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const worker = mintPacketWorkerToken('pkt-browser-fixture-a');
    const handler = await import('@/app/api/browser/agent/route');
    const parity = async (headers: Record<string, string>, body: unknown) => {
      const native = await send(headers, body);
      const ts = await handler.POST(new NextRequest('http://127.0.0.1/api/browser/agent', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
      expect([native.status, await native.json()]).toEqual([ts.status, await ts.json()]);
      return native.status;
    };
    // Operator reaches the handler; an unknown verb is rejected there (400) before any
    // eval, native == TS. This also proves the operator ws-token passes the middleware.
    expect(await parity({ authorization: `Bearer ${server.token}` }, { verb: 'teleport' })).toBe(400);
    // A packet-worker may only address its own packet: a cross-packet request is refused
    // by workerPacketRefusal (403, worker_packet_mismatch), native == TS.
    expect(await parity({ authorization: `Bearer ${worker}` }, { verb: 'read', packetId: 'pkt-browser-fixture-b' })).toBe(403);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
