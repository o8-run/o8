import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import templates from '../crates/o8d/route-templates.json';
import { registeredFrontDoorRoute, forwardToNext } from '@/lib/ws-server/api-front-door';
import { handleNativeHttp } from '@/lib/ws-server/native-http-routes';
import { startParityReference } from './fixtures/ws-parity-server';

it.each([
  ['GET', '/api/orchestrator/claim-unbacked'],
])('retires %s %s while preserving its unmatched Next-off response', async (method, path) => {
  const absent = createServer();
  await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
  const next = new URL(`http://127.0.0.1:${(absent.address() as { port: number }).port}`);
  await new Promise<void>(resolve => absent.close(() => resolve()));
  const listener = createServer((req, res) => {
    void (async () => {
      const port = req.socket.localPort!;
      if (registeredFrontDoorRoute(path, method) && await handleNativeHttp(req, res, port, false, req.socket.remoteAddress ?? null)) return;
      forwardToNext(req, res, next, port, req.socket.remoteAddress ?? null);
    })().catch(error => res.writeHead(500).end(String(error)));
  });
  try {
    vi.stubEnv('O8_API_FRONT_DOOR', '1'); vi.stubEnv('O8_NEXT_O8D', '0');
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(listener.address() as { port: number }).port}${path}`, { method });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Next upstream unavailable' });
    expect(registeredFrontDoorRoute(path, method)).toBe(false);
    expect(templates).not.toContain(path);
  } finally {
    listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});

it('preserves live claim_unbacked delivery and packet-tail replay without the HTTP reader', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-claim-tail-')));
  let producer: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let socket: WebSocket | undefined;
  let db: typeof import('@/lib/db') | undefined;
  try {
    producer = await startParityReference({ directory: root, productFrontDoor: true, nativeHttp: true, o8d: false });
    await producer.stopNext();
    for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR']) vi.stubEnv(key, root);
    vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'cortex-ide.db'));
    for (const key of ['O8_API_PORT', 'O8_WS_PORT']) vi.stubEnv(key, new URL(producer.url).port);
    vi.stubEnv('WS_TOKEN', producer.token);
    db = await import('@/lib/db');
    const { createLane } = await import('@/lib/lane/registry');
    const { recordLaneEvent } = await import('@/lib/lane/events');
    const { getPacketTailBatch } = await import('@/lib/lane/packet-tail');
    const lane = createLane({ repoPath: root, branch: 'fixture', runtime: 'codex', packetId: 'claim-tail-fixture' });
    const frames: Array<{ type?: string; verb?: string; payload?: unknown }> = [];
    socket = new WebSocket(producer.url + '?token=' + encodeURIComponent(producer.token));
    socket.on('message', data => frames.push(JSON.parse(String(data))));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'packet-tail-subscribe', packetId: 'claim-tail-fixture' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'subscribed')).toBe(true));
    const payload = { packetId: 'claim-tail-fixture', receiptId: 'fixture-receipt', claims: ['tests'], verificationOutputPresent: false };
    recordLaneEvent(lane.id, 'claim_unbacked', 'system', payload);
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'lane-event', verb: 'claim_unbacked', payload })));
    expect((await getPacketTailBatch({ packetId: 'claim-tail-fixture' })).events)
      .toContainEqual(expect.objectContaining({ verb: 'claim_unbacked', payload }));
    const unmatched = await fetch(producer.url.replace('ws:', 'http:').replace('/ws', '')
      + '/api/orchestrator/claim-unbacked?laneId=' + encodeURIComponent(lane.id),
    { headers: { authorization: 'Bearer ' + producer.token } });
    expect(unmatched.status).toBe(502);
    expect(await unmatched.json()).toEqual({ error: 'Next upstream unavailable' });
  } finally {
    socket?.terminate(); await producer?.stop(); db?.closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);
