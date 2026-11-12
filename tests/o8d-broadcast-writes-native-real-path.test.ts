import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

it('serves broadcast writes with Next stopped and scopes worker posts to their packet', async () => {
  const saved = { ...process.env };
  const server = await startParityReference({ o8d: true, nativeHttp: true });
  try {
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const device = 'broadcast-fixture-device';
    const unbound = 'broadcast-fixture-unbound';
    writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
    writeFileSync(join(server.directory, 'worker-token'), unbound);
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: server.directory, CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const worker = mintPacketWorkerToken('broadcast-packet');
    const { createLane } = await import('@/lib/lane/registry');
    createLane({ repoPath: server.directory, branch: 'fixture', runtime: 'codex', packetId: 'broadcast-packet', label: '[automation] Fixture' });
    const call = (name: string, token: string, body: unknown, relay = false) => fetch(`${origin}/api/broadcast/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
        'x-o8-client-addr': '127.0.0.1', ...(relay ? { 'x-o8-relay-forward': '1' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    for (const name of ['post', 'automation-say', 'tokens']) {
      for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [unbound, 403]] as const) {
        expect((await call(name, token, {})).status).toBe(status);
        expect((await call(name, token, {}, true)).status).toBe(status);
      }
    }
    const body = { kind: 'commentary', actor: 'fixture', text: 'Fixture update' };
    const posted = await call('post', worker, body);
    expect(posted.status).toBe(201);
    expect((await posted.json()).event.refs.packetId).toBe('broadcast-packet');
    expect((await call('post', worker, { ...body, refs: { packetId: 'other' } })).status).toBe(403);
    expect((await call('post', worker, { kind: 'focus', title: 'Forbidden' })).status).toBe(403);
    const attention = await call('automation-say', worker, { text: 'Fixture attention' });
    expect(attention.status).toBe(200);
    expect((await attention.json()).schema).toBe('o8/broadcast.automation-say/v1');
    expect((await call('automation-say', server.token, {})).status).toBe(403);
    expect((await call('tokens', worker, { action: 'mint' })).status).toBe(403);
    const mint = await call('tokens', server.token, { action: 'mint' });
    expect(mint.status).toBe(200);
    const minted = await mint.json();
    expect(minted.schema).toBe('o8/broadcast.token.mint/v1');
    expect((await call('tokens', minted.bearer, { action: 'mint' })).status).toBe(403);
    expect((await call('post', minted.bearer, body)).status).toBe(403);
    expect((await call('post', server.token, body)).status).toBe(201);
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_PORT: new URL(origin).port });
    for (const name of ['post', 'automation-say', 'tokens']) {
      const next = await ({ post: () => import('@/app/api/broadcast/post/route'), 'automation-say': () => import('@/app/api/broadcast/automation-say/route'), tokens: () => import('@/app/api/broadcast/tokens/route') }[name]!)();
      const forwarded = await next.POST(new Request(`http://127.0.0.1/api/broadcast/${name}`, { method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' },
        body: JSON.stringify(name === 'post' ? body : name === 'tokens' ? { action: 'revoke', id: minted.token.id } : {}) }));
      expect(forwarded.status).toBe(name === 'post' ? 201 : name === 'tokens' ? 200 : 403);
    }
  } finally {
    await server.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 180_000);
