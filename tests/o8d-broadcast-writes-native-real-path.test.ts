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
    const ownLane = createLane({ repoPath: server.directory, branch: 'fixture', runtime: 'codex', packetId: 'broadcast-packet', label: '[automation] Fixture' });
    const otherLane = createLane({ repoPath: server.directory, branch: 'other', runtime: 'codex', packetId: 'other-packet' });
    const { getSqlite } = await import('@/lib/db');
    const sqlite = getSqlite();
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
    const postedEvent = (await posted.json()).event;
    expect(postedEvent.refs.packetId).toBe('broadcast-packet');
    expect(postedEvent.actor).toBe('worker:broadcast-packet');
    const own = await call('post', worker, { ...body, refs: { laneId: ownLane.id } });
    expect(own.status).toBe(201);
    expect((await own.json()).event.refs.laneId).toBe(ownLane.id);
    expect((await call('post', worker, { ...body, refs: { laneId: otherLane.id } })).status).toBe(403);
    expect((await call('post', worker, { ...body, refs: { laneId: 'missing-lane' } })).status).toBe(403);
    const persisted = sqlite.prepare('SELECT actor, packet_id FROM broadcast_events WHERE id = ?').get(postedEvent.id);
    expect(persisted).toMatchObject({ actor: 'worker:broadcast-packet', packet_id: 'broadcast-packet' });
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
    const operatorPost = await call('post', server.token, { ...body, refs: { laneId: otherLane.id } });
    expect(operatorPost.status).toBe(201);
    expect((await operatorPost.json()).event).toMatchObject({ actor: body.actor, refs: { laneId: otherLane.id } });
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_PORT: new URL(origin).port });
    const nextPost = await import('@/app/api/broadcast/post/route');
    const forwardWorker = (refs: Record<string, string>) => nextPost.POST(new Request('http://127.0.0.1/api/broadcast/post', {
      method: 'POST', headers: { authorization: `Bearer ${worker}`, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' },
      body: JSON.stringify({ ...body, refs }),
    }));
    const forwardedWorker = await forwardWorker({ laneId: ownLane.id });
    expect(forwardedWorker.status).toBe(201);
    const forwardedEvent = (await forwardedWorker.json()).event;
    expect(forwardedEvent.refs.packetId).toBe('broadcast-packet');
    expect(forwardedEvent.actor).toBe('worker:broadcast-packet');
    expect(sqlite.prepare('SELECT packet_id, actor FROM broadcast_events WHERE id = ?').get(forwardedEvent.id))
      .toMatchObject({ packet_id: 'broadcast-packet', actor: 'worker:broadcast-packet' });
    expect((await forwardWorker({ packetId: 'other' })).status).toBe(403);
    expect((await forwardWorker({ laneId: otherLane.id })).status).toBe(403);
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
