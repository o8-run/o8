import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { composerWsIdentity } from '@/lib/ws-server/composer-ws-identity';
const binary = process.env.O8D_TEST_BINARY;
if (!binary) console.info('SKIP composer owner proofs: set O8D_TEST_BINARY to an already-built compatible o8d. No build is started.');
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 15000;
  while (!check()) { if (Date.now() > end) throw Error(label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
it.skipIf(!binary)('admits the real authenticated WS path once, preserves the first selection and replays on reconnect', async () => {
  const root = realpathSync(mkdtempSync('/tmp/o8-cq-ws-')); const data = join(root, '.o8'); mkdirSync(data);
  const token = 'ws-parity-fixture-credential'; writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
  writeFileSync(join(data, 'fixture-owner'), 'codex-owner-proof/v1');
  const publicPort = await port(), upstreamPort = await port(), nextPort = await port();
  const socket = join(data, 'owner.sock'), key = randomUUID();
  const daemon = spawn(binary!, ['--experimental-ws', '--listen', `127.0.0.1:${publicPort}`, '--producer-socket', socket], {
    env: { ...process.env, HOME: root, O8_API_FRONT_DOOR: '1', O8D_BRIDGE_KEY: key, O8D_NATIVE_OWNED: '1',
      O8D_SESSION_DATA_DIR: data, O8D_SESSION_DB_PATH: join(data, 'cortex-ide.db'), O8D_SERVER_VERSION: 'codex-owner-fixture',
      O8_BOOT_ID: randomUUID(), O8_INSTANCE_ID: randomUUID() }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostic = ''; daemon.stdout.resume(); daemon.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-16384); });
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  const peers: WebSocket[] = [];
  let db: Database.Database | undefined;
  try {
    await until(() => { if (daemon.exitCode !== null) throw Error(`Daemon exited: ${diagnostic}`); return existsSync(socket); }, 'Owner socket missing');
    vi.stubEnv('O8D_PRODUCER_SOCKET', socket); vi.stubEnv('O8D_BRIDGE_KEY', key); vi.stubEnv('O8D_PRODUCER_UPSTREAM_PORT', String(upstreamPort));
    mkdirSync(join(data, 'chat-history'));
    const threadId = 'thoughts-codex-owner';
    const historyFile = join(data, 'chat-history', `${threadId}.json`);
    writeFileSync(historyFile, JSON.stringify({ repoPath: data, messages: [
      { id: 'previous', role: 'assistant', content: 'Previous answer.', timestamp: 1, backend: 'codex', model: 'gpt-5.5',
        receipt: { leadModel: 'gpt-5.5', effort: 'xhigh', permissionMode: 'plan', mode: 'solo', pickedMode: 'solo' } },
    ] }));
    writeFileSync(join(data, 'block-prepare'), '1');
    server = await startParityReference({ directory: data, productFrontDoor: true, nativeHttp: true, o8d: true, binary,
      fixedPorts: { api: nextPort, ws: publicPort }, preload: resolve('tests/fixtures/composer-owner-provider.cjs'), startupTimeoutMs: 60000 });
    await server.stopNext();
    db = new Database(join(data, 'cortex-ide.db'));
    const connect = async () => {
      const ws = new WebSocket(`${server!.url}?token=${token}`); peers.push(ws);
      const frames: Array<{ channel: string; event?: string; data?: Record<string, unknown> }> = [];
      ws.on('message', bytes => frames.push(JSON.parse(String(bytes)))); await once(ws, 'open'); return { ws, frames };
    };
    const first = await connect();
    const wire = { type: 'orchestrator-send', repoPath: data, threadId, backend: 'codex', surface: 'mobile', message: 'Fixture inspection.', clientMutationId: 'codex-native-once' };
    first.ws.send(JSON.stringify(wire));
    await until(() => existsSync(join(data, 'prepare-entered')), `Preparation did not reach the real executor: ${server.diagnostics().stderr}`);
    const duplicate = await connect(); duplicate.ws.send(JSON.stringify(wire));
    await until(() => duplicate.frames.some(f => f.event === 'send-ack'), 'Duplicate ACK missing');
    expect(duplicate.frames.find(f => f.event === 'send-ack')!.data).toMatchObject({ state: 'duplicate-in-progress', duplicate: true });
    expect(first.frames.some(f => f.event === 'send-ack')).toBe(false);
    writeFileSync(join(data, 'release-prepare'), '1');
    const id = composerWsIdentity(data, threadId, wire.clientMutationId).id;
    await until(() => (db!.prepare('SELECT status FROM composer_send_queue WHERE id=?').get(id) as { status: string } | undefined)?.status === 'applied', 'Ingress did not settle');
    await until(() => first.frames.some(f => f.event === 'send-ack' && f.data?.state === 'accepted')
      && first.frames.some(f => f.event === 'status' && f.data?.status === 'busy'), 'Accepted/busy frames missing');
    const accepted = first.frames.findIndex(f => f.event === 'send-ack' && f.data?.state === 'accepted');
    const busy = first.frames.findIndex(f => f.event === 'status' && f.data?.status === 'busy');
    expect(accepted).toBeGreaterThanOrEqual(0); expect(busy).toBeGreaterThan(accepted);
    const calls = () => readFileSync(join(data, 'provider-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls()).toHaveLength(1); expect(calls()[0]).toMatchObject({ repo: data, threadId, model: 'gpt-5.5', effort: 'xhigh', permissionMode: 'plan' });
    const history = JSON.parse(readFileSync(historyFile, 'utf8'));
    history.messages.push({ id: 'changed-selection', role: 'assistant', content: 'New default.', timestamp: Date.now(), backend: 'codex', model: 'gpt-other',
      receipt: { leadModel: 'gpt-other', effort: 'low', permissionMode: 'plan', mode: 'solo' } });
    writeFileSync(historyFile, JSON.stringify(history));
    const reconnect = await connect(); reconnect.ws.send(JSON.stringify(wire));
    await until(() => reconnect.frames.some(f => f.event === 'send-ack'), 'Replay ACK missing');
    expect(reconnect.frames.find(f => f.event === 'send-ack')!.data).toMatchObject({ state: 'replayed', duplicate: true });
    expect(calls()).toHaveLength(1);
    const row = db.prepare('SELECT payload_json, ingress_json FROM composer_send_queue WHERE id=?').get(id) as { payload_json: string; ingress_json: string | null };
    expect(JSON.parse(row.payload_json).wsSelection).toMatchObject({ model: 'gpt-5.5', thinkingEffort: 'xhigh' }); expect(row.ingress_json).toBeNull();
    reconnect.ws.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: data, threadId, backend: 'codex', since: 0 }));
    // A settled turn's live events are cleared from the replay buffer by design;
    // a reconnecting client reconciles from the snapshot's turn truth and the
    // persisted transcript. Prove exactly one report landed in the original thread.
    await until(() => reconnect.frames.some(f => f.event === 'status' && f.data?.snapshot === true && f.data?.threadId === threadId), 'Original-thread snapshot missing');
    const snapshot = reconnect.frames.filter(f => f.event === 'status' && f.data?.snapshot === true && f.data?.threadId === threadId).at(-1)!;
    const persisted = JSON.parse(readFileSync(historyFile, 'utf8')).messages as Array<{ id: string; role: string; content: string }>;
    const reports = persisted.filter(m => m.role === 'assistant' && m.content === 'Fixture Codex reply.');
    expect(reports).toHaveLength(1);
    expect(persisted[persisted.findIndex(m => m.id === `orch-user-${wire.clientMutationId}`) + 1]?.id).toBe(reports[0].id);
    for (const originalThread of [null, 'chat-42']) {
      const legacy = { ...wire, threadId: originalThread, clientMutationId: `legacy-${originalThread}`, message: 'Legacy fixture.' };
      const before = calls().length; const client = await connect(); client.ws.send(JSON.stringify(legacy));
      const legacyId = composerWsIdentity(data, originalThread, legacy.clientMutationId).id;
      await until(() => (db!.prepare('SELECT status FROM composer_send_queue WHERE id=?').get(legacyId) as { status: string } | undefined)?.status === 'applied', 'Legacy send did not settle');
      client.ws.send(JSON.stringify(legacy));
      await until(() => client.frames.some(f => f.event === 'send-ack' && f.data?.state === 'replayed'), 'Legacy duplicate missing');
      expect(calls()).toHaveLength(before + 1); expect(calls().at(-1).threadId).toBeNull();
      expect(existsSync(join(data, 'chat-history', `${originalThread}.json`))).toBe(false);
      const listed = await fetch(`http://127.0.0.1:${publicPort}/internal/composer-queue`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ v: 1, method: 'list', params: {} }) });
      expect((await listed.json()).result.items.some((item: { id: string }) => item.id === legacyId)).toBe(false);
    }
    const unsavedThread = 'thoughts-newly-saved';
    const unsavedFile = join(data, 'chat-history', `${unsavedThread}.json`);
    expect(existsSync(unsavedFile)).toBe(false);
    const unsaved = { ...wire, threadId: unsavedThread, clientMutationId: 'unsaved-history-retry', message: 'Create this fixture thread.' };
    const beforeUnsaved = calls().length;
    const unsavedClient = await connect(); unsavedClient.ws.send(JSON.stringify(unsaved));
    const unsavedId = composerWsIdentity(data, unsavedThread, unsaved.clientMutationId).id;
    await until(() => (db!.prepare('SELECT status FROM composer_send_queue WHERE id=?').get(unsavedId) as { status: string } | undefined)?.status === 'applied', 'Unsaved thoughts send did not settle');
    expect(existsSync(unsavedFile)).toBe(true);
    const firstTarget = (db.prepare('SELECT thread_id FROM composer_send_queue WHERE id=?').get(unsavedId) as { thread_id: string }).thread_id;
    expect(firstTarget).toMatch(/^wsi:/);
    unsavedClient.ws.send(JSON.stringify(unsaved));
    await until(() => unsavedClient.frames.some(f => f.event === 'send-ack' && f.data?.state === 'replayed'), 'Unsaved-history retry ACK missing');
    expect(calls()).toHaveLength(beforeUnsaved + 1);
    expect(calls().at(-1).threadId).toBe(unsavedThread);
    expect((db.prepare('SELECT thread_id FROM composer_send_queue WHERE id=?').get(unsavedId) as { thread_id: string }).thread_id).toBe(firstTarget);
    expect(JSON.parse(readFileSync(unsavedFile, 'utf8')).messages.filter((message: { id: string }) => message.id === `orch-user-${unsaved.clientMutationId}`)).toHaveLength(1);
  } finally {
    db?.close(); for (const peer of peers) peer.terminate(); await server?.stop();
    if (daemon.exitCode === null && daemon.signalCode === null) { const closed = once(daemon, 'exit'); daemon.kill(); await closed; }
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 90000);
