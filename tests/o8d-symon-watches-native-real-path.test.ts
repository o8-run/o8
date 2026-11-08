import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Symon's watch tool (src-tauri symon_watch.rs), served by the WS listener with
// Next stopped. Both processes share the watch rows: a watch registered natively
// is the TS handler's watch, and a plan claimed by one cannot be claimed again.
it.skipIf(process.platform === 'win32')('serves Symon watches natively with Next stopped, on the same rows as TS', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-symon-watches-')));
  const device = 'symon-watches-fixture-device-0123456789abcdef';
  const worker = 'symon-watches-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport.
    for (const [method, path] of [['GET', '/api/symon/watches'], ['POST', '/api/symon/watches'], ['GET', '/api/symon/watches/x'],
      ['PATCH', '/api/symon/watches/x'], ['DELETE', '/api/symon/watches/x']] as const) {
      expect([method, path, (await call(method, path, {}, method === 'GET' || method === 'DELETE' ? undefined : {})).status]).toEqual([method, path, 401]);
      for (const token of [device, worker]) {
        const status = (await call(method, path, { authorization: `Bearer ${token}` }, method === 'GET' || method === 'DELETE' ? undefined : {})).status;
        expect([method, path, status]).toEqual([method, path, 403]);
      }
    }

    // The TS handlers in this process, on the same data directory.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
    delete process.env.O8_DATA_DIR;
    const collection = await import('@/app/api/symon/watches/route');
    const item = await import('@/app/api/symon/watches/[id]/route');
    const local = (method: string, path: string, body?: unknown) => new Request(`http://127.0.0.1${path}`, {
      method, headers: { ...operator, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const watch = { sessionId: 'fixture-session', condition: { text: 'the fixture build finishes', source: 'managed_run' },
      then: { kind: 'plan', say: 'The build finished; checking it.', steps: [{ tool: 'o8_status' }] } };
    const created = await call('POST', '/api/symon/watches', operator, watch);
    expect(created.status).toBe(200);
    const { watch: record } = await created.json() as { watch: { id: string } };
    const encoded = encodeURIComponent(record.id);

    // The collection and the watch read the same rows through both processes.
    const list = '/api/symon/watches?sessionId=fixture-session';
    const nativeList = await (await call('GET', list, operator)).json() as { watches: Array<{ id: string }> };
    expect(nativeList.watches.map(entry => entry.id)).toContain(record.id);
    expect(nativeList).toEqual(await (await collection.GET(local('GET', list))).json());
    const peek = await (await call('GET', `/api/symon/watches/${encoded}`, operator)).json();
    expect(peek).toEqual(await (await item.GET(local('GET', `/api/symon/watches/${encoded}`), params(record.id))).json());

    // The automation scheduler parks a fired plan; stand in for it on the shared row.
    const db = new Database(join(directory, 'cortex-ide.db'));
    try { db.prepare('UPDATE automations SET symon_parked_at = ? WHERE id = ?').run(Date.now(), record.id); } finally { db.close(); }
    // One claim wins across processes: the native claim takes the plan, the TS claim then gets none.
    const claimed = await (await call('GET', `/api/symon/watches/${encoded}?claim=1`, operator)).json() as { plan: unknown; planError: string | null };
    expect([claimed.plan !== null, claimed.planError]).toEqual([true, null]);
    const second = await (await item.GET(local('GET', `/api/symon/watches/${encoded}?claim=1`), params(record.id))).json() as typeof claimed;
    expect(second.plan).toBeNull();
    expect(second.planError).toBeTruthy();

    // Settle and cancel natively; TS sees the same watch afterwards.
    expect((await call('PATCH', `/api/symon/watches/${encoded}`, operator, { runOutcome: 'approved' })).status).toBe(200);
    expect((await call('DELETE', `/api/symon/watches/${encoded}`, operator)).status).toBe(200);
    const after = await (await call('GET', `/api/symon/watches/${encoded}`, operator)).json();
    expect(after).toEqual(await (await item.GET(local('GET', `/api/symon/watches/${encoded}`), params(record.id))).json());
    expect((await call('GET', '/api/symon/watches/watch_missing', operator)).status).toBe(404);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
