import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

// Only the provider and realtime publication are substituted. HTTP, queue routes,
// admission, heartbeat, transcript/media persistence and SQLite are production code.
const provider = vi.hoisted(() => ({ uncertain: false, sends: 0, attachmentBytes: 0 }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: (id: OrchestratorBackend['id']) => ({
  id, label: id, ensureSession: () => ({ sessionName: 'ledger-session', status: 'ready' }),
  peekSession: () => ({ sessionName: 'ledger-session', status: 'ready' }),
  liveSteer: async (_repo: string, _message: string, options: Parameters<NonNullable<OrchestratorBackend['liveSteer']>>[2]) => {
    options.beforeAdmit(); return { accepted: true };
  },
  sendTurn: async (_repo: string, _message: string, emit: (event: OrchestratorEvent) => void, options: OrchestratorTurnOptions) => {
    provider.sends++;
    provider.attachmentBytes += Buffer.from(options.attachments![0].dataUri.split(',')[1], 'base64').length;
    if (provider.uncertain) throw new Error('Delivery acknowledgement lost.');
    emit({ type: 'turn_receipt', leadModel: options.model!, effort: options.thinkingEffort! });
    emit({ type: 'done', sessionId: 'ledger-provider', cost: null, terminalOutcome: 'completed' });
  },
}) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => true }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-queue-ledger-')));
const data = join(root, 'data'); const repo = join(root, 'repo');
mkdirSync(repo); mkdirSync(join(data, 'chat-history'), { recursive: true });
vi.stubEnv('O8_DATA_DIR', data); vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(data, 'queue.db'));
const { getSqlite, closeDb } = await import('@/lib/db');
const queue = await import('@/lib/orchestrator/composer-queue');
const routes = await import('@/app/api/orchestrator/composer-queue/route');
const { createComposerQueueHeartbeat, runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
const target = { repoPath: repo, threadId: 'thoughts-ledger' };
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${Buffer.concat([pixel, Buffer.alloc(3 * 1024 * 1024 - pixel.length)]).toString('base64')}`;
const payload = (index: number): ComposerQueuePayload => ({ text: `Screenshot follow-up ${index}`, wireMessage: `Inspect screenshot ${index}`,
  images: [{ name: 'screenshot.png', dataUri: image }], routing: {
    backend: 'codex', model: 'selected-model', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false,
  } });
let origin = '';
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(`${origin}${req.url}`, { method: req.method,
      headers: { host: new URL(origin).host, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' },
      ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}) });
    const handler = routes[req.method as 'GET' | 'POST' | 'PATCH' | 'DELETE'];
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end(); }
});
async function api(method: string, id?: string, bodyPayload = payload(0), threadId = target.threadId, intent = 'send-next') {
  const query = new URLSearchParams({ repoPath: repo, threadId });
  return fetch(`${origin}/api/orchestrator/composer-queue?${query}`, { method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ ...target, threadId, id, intent, payload: bodyPayload }) }) });
}
async function enqueue(id: string, value = payload(0)) {
  const response = await api('POST', id, value);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).item;
}
function directoryBytes(path: string): number {
  return readdirSync(path).reduce((total, name) => {
    const child = join(path, name); const stat = statSync(child);
    return total + (stat.isDirectory() ? directoryBytes(child) : stat.size);
  }, 0);
}
function measure() {
  const db = getSqlite();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { dataBytes: directoryBytes(data), pageCount: db.pragma('page_count', { simple: true }),
    freePages: db.pragma('freelist_count', { simple: true }), pageSize: db.pragma('page_size', { simple: true }),
    ledgerBytes: (db.prepare('SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM composer_send_queue').get() as { bytes: number }).bytes };
}
function receipt(name: string, value: unknown) {
  console.info(name, JSON.stringify(value));
  if (process.env.O8_QUEUE_LEDGER_PROOF) writeFileSync(join(process.env.O8_QUEUE_LEDGER_PROOF, `${name}.json`), JSON.stringify(value, null, 2));
}
function heartbeat() {
  return createComposerQueueHeartbeat({ isBusy: () => false, readTranscript: async () => [],
    registerAbort: () => () => {}, publish: () => {} });
}
async function deliver(tick: () => void, id: string, status = 'applied') {
  tick();
  await vi.waitFor(() => expect(queue.readComposerSend(id)?.status).toBe(status), { interval: 10 });
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string' || address.port === 47100) throw new Error('Disposable dev server requires its own free port.');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue');
  provider.sends = 0; provider.attachmentBytes = 0; provider.uncertain = false;
  writeFileSync(join(data, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('delivers 20 3 MiB screenshots once, drops applied bytes, and deduplicates through HTTP after reopen', async () => {
  const baseline = measure(); const tick = heartbeat();
  // Exercise the maximum 20-message burst before draining it.
  for (let index = 0; index < 20; index++) await enqueue(`ledger-shot-${index}`, payload(index));
  const queued = measure();
  for (let index = 0; index < 20; index++) await deliver(tick, `ledger-shot-${index}`);
  const applied = measure();
  receipt('20-screenshot-ledger', { baseline, queued, applied, sends: provider.sends });
  expect(provider.sends).toBe(20); expect(provider.attachmentBytes).toBe(20 * 3 * 1024 * 1024);
  expect((await (await api('GET')).json()).items).toEqual([]);
  expect(applied.ledgerBytes).toBeLessThan(20_000);
  const audit = getSqlite().prepare('SELECT payload_hash, payload_bytes, payload_compacted_at, created_at, updated_at, admitted_at FROM composer_send_queue WHERE id = ?').get('ledger-shot-0');
  expect(audit).toMatchObject({ payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/), payload_bytes: Buffer.byteLength(JSON.stringify(payload(0))),
    payload_compacted_at: expect.any(Number), created_at: expect.any(Number), updated_at: expect.any(Number), admitted_at: expect.any(Number) });
  closeDb(); const restarted = heartbeat();
  for (let index = 0; index < 20; index++) {
    const item = await enqueue(`ledger-shot-${index}`, payload(index));
    expect(item).toMatchObject({ status: 'applied', payload: payload(index), admittedAt: expect.any(Number) });
  }
  restarted(); await new Promise(resolve => setTimeout(resolve, 25)); expect(provider.sends).toBe(20);
  expect((await api('POST', 'ledger-shot-0', { ...payload(0), text: 'Changed text' })).status).toBe(400);
  expect((await api('POST', 'ledger-shot-0', { ...payload(0), images: [{ name: 'other.png', dataUri: image }] })).status).toBe(400);
  expect((await api('POST', 'ledger-shot-0', { ...payload(0), routing: { ...payload(0).routing, effort: 'high' } })).status).toBe(400);
  writeFileSync(join(data, 'chat-history', 'thoughts-other.json'), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
  expect((await api('POST', 'ledger-shot-0', payload(0), 'thoughts-other')).status).toBe(400);
  expect(measure().ledgerBytes).toBeLessThan(20_000);
  // Freed pages must be reusable rather than adding another screenshot batch
  // to the shared database's high-water allocation.
  for (let index = 0; index < 20; index++) await enqueue(`ledger-next-${index}`, payload(index));
  for (let index = 0; index < 20; index++) await deliver(restarted, `ledger-next-${index}`);
  const secondBatch = measure();
  receipt('second-screenshot-batch', secondBatch);
  expect(provider.sends).toBe(40);
  expect(secondBatch.dataBytes - applied.dataBytes).toBeLessThan(1_000_000);
  expect(secondBatch.ledgerBytes).toBeLessThan(40_000);
}, 60_000);

it.each(['current', 'legacy'])('preserves delivered steer transcript text and media while compacting its %s receipt', async source => {
  const id = `ledger-steer-${source}`;
  expect((await api('POST', id, payload(0), target.threadId, 'steer-now')).status).toBe(200);
  if (source === 'current') await runQueuedComposerSteer(queue.claimComposerSteer(id)!);
  else {
    // Legacy steers saved text but depended on inline ledger images for media.
    writeFileSync(join(data, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'codex',
      messages: [{ id: `composer-steer-${id}`, role: 'user', content: payload(0).text, timestamp: Date.now() }] }));
    getSqlite().prepare("UPDATE composer_send_queue SET status = 'applied', admitted_at = ? WHERE id = ?").run(Date.now(), id);
  }
  closeDb(); getSqlite();
  expect(queue.readComposerSend(id)?.payload.images.length).toBe(0);
  const items = (await (await api('GET')).json()).items;
  expect(items[0]).toMatchObject({ id, status: 'applied', payload: { text: payload(0).text } });
  expect(items[0].payload.images).toHaveLength(1);
  expect(readFileSync(items[0].payload.images[0].dataUri).length).toBe(3 * 1024 * 1024);
  const normalized = await enqueue(id);
  expect(normalized).toMatchObject({ status: 'applied', payload: payload(0) });
  expect(measure().ledgerBytes).toBeLessThan(2_000);
});

it('compacts legacy applied entries at connection startup while preserving every unresolved payload and identity', async () => {
  const tick = heartbeat();
  await enqueue('ledger-legacy-applied'); await deliver(tick, 'ledger-legacy-applied');
  await enqueue('ledger-legacy-queued', payload(1));
  await enqueue('ledger-legacy-held', payload(2));
  await enqueue('ledger-legacy-dispatching', payload(3));
  await enqueue('ledger-legacy-unconfirmed', payload(4));
  const db = getSqlite();
  // Recreate the legacy persisted shape, including a receipt without admission
  // proof. A status alone must not erase a possibly unresolved payload.
  const columns = db.prepare('PRAGMA table_info(composer_send_queue)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'payload_hash')) {
    db.exec('ALTER TABLE composer_send_queue DROP COLUMN payload_hash');
    db.exec('ALTER TABLE composer_send_queue DROP COLUMN payload_bytes');
    db.exec('ALTER TABLE composer_send_queue DROP COLUMN payload_compacted_at');
  }
  db.prepare('UPDATE composer_send_queue SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload(0)), 'ledger-legacy-applied');
  db.prepare("UPDATE composer_send_queue SET status = 'held' WHERE id = ?").run('ledger-legacy-held');
  db.prepare("UPDATE composer_send_queue SET status = 'dispatching' WHERE id = ?").run('ledger-legacy-dispatching');
  db.prepare("UPDATE composer_send_queue SET status = 'applied', admitted_at = NULL WHERE id = ?").run('ledger-legacy-unconfirmed');
  const before = measure(); closeDb(); getSqlite();
  const after = measure(); receipt('legacy-ledger', { before, after });
  expect(queue.readComposerSend('ledger-legacy-applied')?.payload.images.length).toBe(0);
  expect(queue.readComposerSend('ledger-legacy-queued')).toMatchObject({ status: 'queued', payload: payload(1) });
  expect(queue.readComposerSend('ledger-legacy-held')).toMatchObject({ status: 'held', payload: payload(2) });
  expect(queue.readComposerSend('ledger-legacy-dispatching')).toMatchObject({ status: 'dispatching', payload: payload(3) });
  expect(queue.readComposerSend('ledger-legacy-unconfirmed')).toMatchObject({ status: 'applied', admittedAt: null, payload: payload(4) });
  expect((await enqueue('ledger-legacy-applied')).status).toBe('applied');
  expect((await api('POST', 'ledger-legacy-applied', payload(9))).status).toBe(400);
  closeDb(); getSqlite();
  expect(queue.readComposerSend('ledger-legacy-queued')?.payload).toEqual(payload(1));
  // An older still-running server can settle an already-hashed pending row.
  getSqlite().prepare("UPDATE composer_send_queue SET status = 'applied', admitted_at = 1 WHERE id = ?").run('ledger-legacy-queued');
  closeDb(); getSqlite();
  expect(queue.readComposerSend('ledger-legacy-queued')?.payload.images.length).toBe(0);
  expect((await enqueue('ledger-legacy-queued', payload(1))).status).toBe('applied');
});

it('retains unknown delivery bytes until cancellation resolves it, then keeps duplicate receipts', async () => {
  const tick = heartbeat(); provider.uncertain = true;
  await enqueue('ledger-unknown'); await deliver(tick, 'ledger-unknown', 'held');
  closeDb(); getSqlite();
  expect(queue.readComposerSend('ledger-unknown')).toMatchObject({ status: 'held', payload: payload(0), admittedAt: expect.any(Number) });
  expect((await enqueue('ledger-unknown')).payload).toEqual(payload(0));
  expect((await api('DELETE', 'ledger-unknown')).status).toBe(200);
  expect(queue.readComposerSend('ledger-unknown')?.payload.images.length).toBe(0);
  expect((await enqueue('ledger-unknown')).status).toBe('cancelled');
  expect(provider.sends).toBe(1);
});
