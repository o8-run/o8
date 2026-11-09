import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Symon's commentary reader and broadcast spectators over the native transport with Next stopped.
// The middleware admits the operator ws-token and an active spectator token for GET; the handler
// re-checks the principal from the bearer. Commentary is redacted at read time, so a spectator
// gets the same redacted page natively as in-process, and the operator token never leaves.
it.skipIf(process.platform === 'win32')('serves broadcast commentary natively to the operator and spectators only (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-broadcast-commentary-')));
  const device = 'broadcast-commentary-fixture-device-0123456789abcdef';
  const worker = 'broadcast-commentary-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = '/api/broadcast/commentary?limit=10';
    const call = (headers: Record<string, string>) => fetch(`${origin}${path}`, { headers });

    // Middleware floor over native (forged loopback markers are inert under the unverified-proxy stamp).
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await call(forged)).status).toBe(401); // anonymous
    expect((await call({ ...forged, authorization: `Bearer ${device}` })).status).toBe(403); // enrolled device
    expect((await call({ ...forged, authorization: `Bearer ${worker}` })).status).toBe(403); // dispatched worker

    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const { getSqlite } = await import('@/lib/db');
    const { getSpectatorTokenStore } = await import('@/lib/broadcast/spectator-token-store');
    const handler = await import('@/app/api/broadcast/commentary/route');
    const spectator = getSpectatorTokenStore().mint({ label: 'commentary fixture' }).bearer;

    // Commentary rows: plain narration, a bare operator token, and a bearer header.
    const insert = getSqlite().prepare(`
      INSERT INTO broadcast_events (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'commentary', 'symon', NULL, ?, NULL, NULL, '{}', ?)
    `);
    for (const text of ['Fixture narration: the lane finished.', server.token, `header Bearer ${server.token}`]) {
      insert.run(`commentary-fixture-${randomUUID()}`, text, new Date().toISOString());
    }

    for (const bearer of [spectator, server.token]) {
      const headers = { authorization: `Bearer ${bearer}` };
      const native = await call(headers);
      const ts = await handler.GET(new NextRequest(`http://127.0.0.1${path}`, { headers }));
      const body = await native.text();
      expect([native.status, JSON.parse(body)]).toEqual([ts.status, await ts.json()]);
      expect(native.status).toBe(200);
      const page = JSON.parse(body) as { commentary: Array<{ text: string }> };
      expect(page.commentary.map(entry => entry.text)).toEqual(expect.arrayContaining([
        'Fixture narration: the lane finished.', '[redacted-token]', 'header Bearer [redacted]',
      ]));
      expect(body).not.toContain(server.token);
    }
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
