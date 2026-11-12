import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

it('keeps spectator truth reads and loopback preview resources narrowly granted through o8d', async () => {
  const saved = { ...process.env };
  const preview = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/css' }).end('body { color: blue; }'));
  preview.listen(0, '127.0.0.1');
  await once(preview, 'listening');
  const address = preview.address();
  if (!address || typeof address === 'string') throw new Error('missing preview port');
  const target = `http://127.0.0.1:${address.port}/style.css`;
  const server = await startParityReference({ o8d: true, nativeHttp: true });
  try {
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const device = 'reads-fixture-device';
    const worker = 'reads-fixture-worker';
    writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
    writeFileSync(join(server.directory, 'worker-token'), worker);
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: server.directory, CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { getSpectatorTokenStore } = await import('@/lib/broadcast/spectator-token-store');
    const spectator = getSpectatorTokenStore().mint({ repoGrants: [server.directory] });
    const call = (path: string, token = '', extra: Record<string, string> = {}, method = 'GET') => fetch(`${origin}${path}`, {
      method, headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    });
    const truth = '/api/orchestrator/truth?kind=packet&packetId=fixture-missing';
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      expect((await call(truth, token)).status).toBe(status);
      expect((await call(truth, token, { 'x-o8-relay-forward': '1' })).status).toBe(status);
    }
    const read = await call(truth, spectator.bearer);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ answers: [], nextCursor: null });
    expect((await call(truth, server.token)).status).toBe(200);
    expect((await call(truth, spectator.bearer, {}, 'HEAD')).status).toBe(200);
    expect((await call(truth, spectator.bearer, {}, 'POST')).status).toBe(403);
    expect((await call('/api/browser/proxy', spectator.bearer)).status).toBe(403);
    const path = `/api/browser/proxy?url=${encodeURIComponent(target)}`;
    expect((await call(path)).status).toBe(200);
    for (const token of ['', 'wrong']) {
      expect((await call(path, token, { 'x-o8-relay-forward': '1' })).status).toBe(401);
    }
    for (const originHeader of ['null', 'https://example.invalid', 'malformed']) {
      expect((await call(path, '', { origin: originHeader })).status).toBe(401);
    }
    expect((await call(path, '', { origin: 'tauri://localhost' })).status).toBe(200);
    const expires = String(Date.now() + 60_000);
    const access = `${expires}.${createHmac('sha256', server.token).update(JSON.stringify(['preview-resource', new URL(target).origin, expires])).digest('hex')}`;
    const granted = `${path}&previewResource=${access}`;
    expect((await call(granted, '', { origin: 'null' })).status).toBe(200);
    expect((await call(granted)).status).toBe(200);
    expect((await call(granted, '', { origin: 'null' }, 'HEAD')).status).toBe(200);
    const otherTarget = `http://127.0.0.1:${address.port + 1}/style.css`;
    expect((await call(`/api/browser/proxy?url=${encodeURIComponent(otherTarget)}&previewResource=${access}`, '', { origin: 'null' })).status).toBe(401);
    expect((await call(`${path}&previewResource=0.${'0'.repeat(64)}`, '', { origin: 'null' })).status).toBe(401);
    expect((await call(granted, '', { origin: 'https://example.invalid' })).status).toBe(401);
    expect((await call(granted, '', { origin: 'null', 'x-o8-relay-forward': '1' })).status).toBe(401);
    expect((await call(`${path}&previewResource=${access}bad`, '', { origin: 'null' })).status).toBe(401);
    expect((await call(`/api/browser/proxy?url=${encodeURIComponent(origin)}`, server.token)).status).toBe(400);
    expect((await call('/api/browser/proxy?url=https://example.invalid', server.token)).status).toBe(400);
    expect((await call(path, server.token, {}, 'POST')).status).toBe(405);
    for (const token of [device, worker]) expect((await call(path, token, { 'x-o8-relay-forward': '1' })).status).toBe(403);
  } finally {
    await server.stop();
    await new Promise<void>(resolve => preview.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 180_000);
