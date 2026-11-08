import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The desktop shell's reads, served by the WS listener with Next stopped: the
// same answer as the TS handler in this process on the same data directory.
it.skipIf(process.platform === 'win32')('serves cli-usage, broadcast/why and broadcast/calendar natively with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-shell-reads-')));
  const device = 'shell-reads-fixture-device-0123456789abcdef';
  const worker = 'shell-reads-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  // Calendar attention is recorded only while the operator has broadcast voice on.
  writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify({ broadcastVoice: 'on' }));
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const call = (path: string, headers: Record<string, string> = {}, body?: unknown) => fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport: no grant for a phone or a worker.
    for (const [path, body] of [['/api/panel/cli-usage'], ['/api/broadcast/why'], ['/api/broadcast/calendar', {}]] as const) {
      expect([path, (await call(path, {}, body)).status]).toEqual([path, 401]);
      for (const token of [device, worker]) expect([path, (await call(path, { authorization: `Bearer ${token}` }, body)).status]).toEqual([path, 403]);
    }

    // The TS handlers in this process, on the same home and data directory.
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
    for (const name of ['O8_DATA_DIR', 'CODEX_HOME', 'CLAUDE_HOME']) delete process.env[name];
    const local = (path: string, body?: unknown) => new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...operator, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const { GET: usage } = await import('@/app/api/panel/cli-usage/route');
    const { GET: why } = await import('@/app/api/broadcast/why/route');
    const { POST: calendar } = await import('@/app/api/broadcast/calendar/route');

    const native = await call('/api/panel/cli-usage', operator);
    expect(native.status).toBe(200);
    const nativeUsage = await native.json() as Record<string, unknown>;
    const localUsage = await (await usage()).json() as Record<string, unknown>;
    expect(typeof nativeUsage.generatedAt).toBe('number');
    expect({ ...nativeUsage, generatedAt: 0 }).toEqual({ ...localUsage, generatedAt: 0 });

    const nativeWhy = await call('/api/broadcast/why', operator);
    expect(nativeWhy.status).toBe(200);
    expect(await nativeWhy.json()).toEqual(await (await why(local('/api/broadcast/why'))).json());

    const start = Date.now() + 5 * 60_000;
    const event = { eventId: 'fixture-standup', title: 'Fixture standup', calendar: 'Work', startLocal: '10:00',
      endLocal: '10:30', startEpochMs: start, endEpochMs: start + 30 * 60_000, allDay: false };
    const recorded = await (await call('/api/broadcast/calendar', operator, event)).json() as { ok: boolean; result: { status: string; eventId: string } };
    expect([recorded.ok, recorded.result.status]).toEqual([true, 'recorded']);
    // The TS handler sees the native write: the same event is a duplicate there.
    const again = await (await calendar(local('/api/broadcast/calendar', event))).json() as typeof recorded;
    expect([again.result.status, again.result.eventId]).toEqual(['duplicate', recorded.result.eventId]);
    const db = new Database(join(directory, 'cortex-ide.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM broadcast_events WHERE id = ?').get(recorded.result.eventId)).toEqual({ n: 1 });
    } finally { db.close(); }
    const invalid = await call('/api/broadcast/calendar', operator, { title: 'missing fields' });
    expect(invalid.status).toBe(400);
    const localInvalid = await calendar(local('/api/broadcast/calendar', { title: 'missing fields' }));
    expect(await invalid.json()).toEqual(await localInvalid.json());
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
