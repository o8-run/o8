import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('serves the CLI and worker receipt URL with stored actions and the existing bearer boundary, without Next', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8D_NATIVE_SESSION_READS', '0');
  const { getDataDir } = await import('@/lib/data-dir-migration');
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  const { enrollDevice } = await import('@/lib/mobile/device-registry');
  const { insertTaskArtifact, insertTaskArtifactAction } = await import('@/lib/task-artifacts/store');
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  const directory = getDataDir();
  const operator = getOrCreateWsToken();
  const worker = 'receipt-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'worker-token'), worker);
  const device = enrollDevice({ identityPublicKey: 'receipt-fixture-key' }).deviceToken;
  const artifactId = `tart-${randomUUID()}`;
  const target = { kind: 'thread' as const, repoPath: directory, threadId: 'thoughts-receipt-fixture', packetId: null, laneId: null, sessionKey: null };
  const timestamp = '2026-11-18T00:00:00.000Z';
  insertTaskArtifact({ id: artifactId, schemaVersion: 1, title: 'Receipt fixture', html: '<p>Fixture</p>', target,
    originHead: null, headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: timestamp, updatedAt: timestamp });
  const receipt = { id: `tact-${randomUUID()}`, artifactId, action: 'submit', nonce: 'receipt-fixture-nonce', payloadHash: 'fixture-hash',
    payload: { note: 'delivered fixture response' }, target, actor: 'operator', delivery: 'delivered' as const, deliveryNote: null, createdAt: timestamp, deliveredAt: timestamp };
  insertTaskArtifactAction(receipt);
  // A single WS-dispatch listener. No Next server or fallback listener exists.
  const server = createServer((request, response) => {
    void handleNativeHttp(request, response, undefined, false, request.socket.remoteAddress ?? null)
      .then(handled => { if (!handled) response.writeHead(404).end(); })
      .catch(() => response.writeHead(500).end());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const path = `/api/task-artifacts/${encodeURIComponent(artifactId)}/actions`;
    const read = (token?: string, extra: Record<string, string> = {}) => fetch(origin + path, { headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
    } });
    const allowed = await read(operator);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true, result: { actions: [receipt] } });
    for (const [token, status] of [[undefined, 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      expect((await read(token, { 'x-o8-client-addr': '127.0.0.1' })).status).toBe(status);
    }
    const relayed = await read(operator, { 'x-o8-relay-forward': '1' });
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toMatchObject({ result: { actions: [receipt] } });
    expect((await fetch(origin + '/api/task-artifacts/invalid/actions', { headers: { authorization: `Bearer ${operator}` } })).status).toBe(400);
    expect((await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${operator}` } })).status).toBe(405);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
