import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import vectors from './fixtures/composer-queue/v1.8-vectors.json';
import mixedPrefix from './fixtures/composer-queue/v1.12-vectors.json';
import { composerWsIdentity } from '@/lib/ws-server/composer-ws-identity';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { O8dProducer } from '@/lib/ws-server/o8d-producer';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

const binary = process.env.O8D_TEST_BINARY;
if (!binary) console.info('SKIP composer owner proofs: set O8D_TEST_BINARY to an already-built compatible o8d. No build is started.');
const payload: ComposerQueuePayload = { text: 'Fixture words', wireMessage: 'Fixture words', images: [], routing: {
  backend: 'codex', model: 'fixture-model', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false,
} };
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() > end) throw Error('Composer owner proof deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
describe.skipIf(!binary)('real TS client and Rust composer owner', () => {
  let root: string, data: string, repo: string, origin: string;
  let daemon: ChildProcess, producer: O8dProducer, upstream: Server, classic: Server;
  let queue: typeof import('@/lib/orchestrator/composer-queue');
  let db: typeof import('@/lib/db');
  let unbind: (() => void) | undefined;
  let replaceProducer: () => Promise<void>;
  const notices: unknown[] = [];
  const token = 'composer-owner-disposable-credential';
  const target = () => ({ repoPath: repo, threadId: 'thoughts-owner-proof' });
  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/tmp/o8-cq-rust-')); data = join(root, '.o8'); repo = join(root, 'repo');
    mkdirSync(data); mkdirSync(repo); mkdirSync(join(data, 'chat-history'));
    writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
    for (const threadId of ['thoughts-owner-proof', 'thoughts-boot-proof']) writeFileSync(join(data, 'chat-history', `${threadId}.json`), JSON.stringify({ repoPath: repo, messages: [] }));
    for (const [name, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
      CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), WS_TOKEN: token, O8_API_FRONT_DOOR: '1' })) vi.stubEnv(name, value);
    const reservation = createServer(); const publicPort = await listen(reservation); await new Promise<void>(resolve => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${publicPort}`;
    vi.stubEnv('O8_WS_PORT', String(publicPort)); vi.stubEnv('O8_API_PORT', String(publicPort));
    db = await import('@/lib/db'); db.getSqlite();
    queue = await import('@/lib/orchestrator/composer-queue');
    const { NextRequest } = await import('next/server');
    const route = await import('@/app/api/orchestrator/composer-queue/route');
    const historyRoute = await import('@/app/api/v2/chat-history/route');
    const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
    const key = randomUUID(), epoch = randomUUID();
    upstream = createServer((request, response) => {
      void (async () => {
        if (request.url === '/internal/realtime') {
          expect(request.headers.authorization).toBe(`Bearer ${token}`);
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          notices.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(202).end(); return;
        }
        if (request.headers['x-o8d-bridge'] !== `${key}:${epoch}`) { response.writeHead(401).end(); return; }
        if (!await handleNativeHttp(request, response, publicPort, true, '127.0.0.1')) response.writeHead(404).end();
      })().catch(error => { response.writeHead(500).end(String(error)); });
    });
    const upstreamPort = await listen(upstream);
    const socket = join(data, 'p.sock');
    daemon = spawn(binary!, ['--experimental-ws', '--listen', `127.0.0.1:${publicPort}`, '--producer-socket', socket], {
      env: { ...process.env, HOME: root, O8D_BRIDGE_KEY: key, O8D_NATIVE_OWNED: '1', O8D_SESSION_DATA_DIR: data,
        O8D_SESSION_DB_PATH: join(data, 'cortex-ide.db'), O8D_SERVER_VERSION: 'composer-owner-fixture',
        O8_BOOT_ID: randomUUID(), O8_INSTANCE_ID: randomUUID() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = ''; daemon.stdout!.resume(); daemon.stderr!.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-16_384); });
    await until(() => { if (daemon.exitCode !== null) throw Error(`o8d preflight exit ${daemon.exitCode}: ${diagnostic}`); return existsSync(socket); });
    const { O8dProducer: Producer } = await import('@/lib/ws-server/o8d-producer');
    replaceProducer = async () => {
      producer?.stop(); producer = new Producer(socket, key, `127.0.0.1:${upstreamPort}`, epoch, () => undefined); await producer.start();
    };
    await replaceProducer();
    expect(producer.status.pid, diagnostic).toBeGreaterThan(0);
    classic = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
        const method = request.method as 'GET' | 'POST' | 'PATCH' | 'DELETE';
        const next = new NextRequest(`http://localhost${request.url}`, { method, headers,
          ...(method !== 'GET' ? { body: Buffer.concat(chunks).toString() } : {}) });
        const result = request.url === '/api/v2/chat-history' ? await historyRoute.PATCH(next) : await route[method](next);
        response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
      })().catch(error => response.writeHead(500).end(String(error)));
    });
    await listen(classic);
  });
  afterAll(async () => {
    unbind?.(); producer?.stop();
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { const exit = once(daemon, 'exit'); daemon.kill(); await exit; }
    for (const server of [upstream, classic]) if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    db?.closeDb(); vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true });
  });
  it('fences stale executor A after B reclaims, with no stale mutation or notice', async () => {
    const { bindComposerOwnerProducer } = await import('@/lib/orchestrator/composer-owner-client');
    unbind = bindComposerOwnerProducer((method, params) => producer.composerRequest(method, params));
    const id = 'native-fence-proof';
    await queue.enqueueComposerSend({ ...target(), id, intent: 'steer-now', payload });
    const a = await queue.claimComposerSteer(id); expect(a.claimToken).toBeTruthy();
    await queue.deferComposerSteer(id, 'Known pre-admit refusal.', a.claimToken!);
    const b = await queue.claimNextComposerSend(target()); expect(b.claimToken).not.toBe(a.claimToken);
    await until(() => notices.length === 4);
    expect(await queue.admitComposerSend(id, a.claimToken!)).toBe(false);
    expect(await queue.settleComposerSend(id, { status: 'applied' }, a.claimToken!)).toBe(false);
    expect(await queue.deferComposerSteer(id, 'Late A.', a.claimToken!)).toBe(false);
    await expect(queue.assertComposerSendClaim(id, a.claimToken!)).rejects.toThrow('cancelled or held');
    expect(await producer.composerRequest('get', { id, claimToken: b.claimToken! })).toMatchObject({
      item: { status: 'dispatching', admittedAt: null }, attempt: { tokenMatches: true, admitted: false },
    });
    expect(notices).toHaveLength(4);
    expect(await queue.admitComposerSend(id, b.claimToken!)).toBe(true);
    expect(await queue.settleComposerSend(id, { status: 'applied' }, b.claimToken!)).toBe(true);
    await until(() => notices.length === 6);
    expect(notices).toHaveLength(6);
    unbind(); unbind = undefined;
  });
  it('does not recover a live claim when the producer object is recreated in the same process', async () => {
    const beforeNotices = notices.length;
    const id = 'same-process-boot-proof';
    const target = { repoPath: repo, threadId: 'thoughts-boot-proof' };
    await producer.composerRequest('enqueue', { id, target, intent: 'send-next', payloadJson: JSON.stringify(payload) });
    const claim = await producer.composerRequest('claim', { target, intent: 'send-next' });
    expect(claim.claimToken).toBeTruthy();
    await replaceProducer();
    expect(await producer.composerRequest('get', { id, claimToken: claim.claimToken! })).toMatchObject({
      item: { status: 'dispatching', admittedAt: null }, attempt: { tokenMatches: true, admitted: false },
    });
    expect(await producer.composerRequest('settle', { id, claimToken: claim.claimToken!, status: 'held', reason: 'Fixture complete.' })).toEqual({ changed: true });
    await until(() => notices.length >= beforeNotices + 3);
    expect(notices).toHaveLength(beforeNotices + 3);
  });
  it.each([{ name: 'canonical v1.8', vector: vectors.ingress }, { name: 'mixed prefix v1.12', vector: mixedPrefix }])('stores private image references, rebuilds the wire and hides synthetic rows: $name', async ({ vector }) => {
    const wire = { ...JSON.parse(vector.wireJson), repoPath: repo };
    const mutationId = wire.clientMutationId;
    const identity = composerWsIdentity(repo, wire.threadId, mutationId);
    const wireJson = JSON.stringify(wire);
    const { validateComposerImageAttachments } = await import('@/lib/mobile/composer-image-validation');
    const images = validateComposerImageAttachments(wire.attachments).map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri }));
    const wsSelection = { backend: 'codex', model: 'fixture-model', thinkingEffort: 'high' };
    const before = notices.length;
    await producer.composerRequest('enqueue', { id: identity.id, target: { repoPath: repo, threadId: identity.syntheticThreadId }, intent: 'send-next',
      payloadJson: JSON.stringify({ ...payload, images, wsSelection }), ingress: { kind: 'ws', clientMutationId: mutationId, wireJson } });
    const row = db.getSqlite().prepare('SELECT ingress_json, ingress_hash FROM composer_send_queue WHERE id=?').get(identity.id) as { ingress_json: string; ingress_hash: string };
    expect(JSON.parse(row.ingress_json)).toEqual({ ...vector.ingressJsonValue, repoPath: repo });
    expect(row.ingress_json).not.toContain(images[0].dataUri);
    expect(row.ingress_hash).toBe(createHash('sha256').update(wireJson).digest('hex'));
    const claim = await producer.composerRequest('claim', { id: identity.id, intent: 'ingress' });
    expect(JSON.parse(claim.ingress!.wireJson)).toEqual(wire);
    expect((await producer.composerRequest('list', {})).items.some(item => item.id === identity.id)).toBe(false);
    expect((await producer.composerRequest('listTargets', {})).targets.some(target => target.threadId === identity.syntheticThreadId)).toBe(false);
    expect((await producer.composerRequest('listTranscript', { target: { repoPath: repo, threadId: identity.syntheticThreadId } })).items).toEqual([]);
    await producer.composerRequest('admit', { id: identity.id, claimToken: claim.claimToken! });
    await producer.composerRequest('settle', { id: identity.id, claimToken: claim.claimToken!, status: 'applied' });
    const terminal = db.getSqlite().prepare('SELECT ingress_json,payload_json FROM composer_send_queue WHERE id=?').get(identity.id) as { ingress_json: string | null; payload_json: string };
    expect(terminal.ingress_json).toBeNull(); expect(JSON.parse(terminal.payload_json)).toMatchObject({ images: [], wsSelection });
    expect(notices).toHaveLength(before);
  });
  it('keeps the classic route shapes through internal HTTP without a second producer', async () => {
    const classicOrigin = `http://127.0.0.1:${(classic.address() as { port: number }).port}`;
    const generation = producer.status.generation;
    const call = (method: string, body: unknown) => fetch(`${classicOrigin}/api/orchestrator/composer-queue`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const input = { ...target(), id: 'classic-native-proof', intent: 'send-next', payload };
    const first = await call('POST', input); expect(first.status).toBe(200); const item = (await first.json()).item;
    const duplicate = await call('POST', input); expect(duplicate.status).toBe(200); expect((await duplicate.json()).item.sequence).toBe(item.sequence);
    const conflict = await call('POST', { ...input, payload: { ...payload, text: 'Different' } });
    expect(conflict.status).toBe(400); expect((await conflict.json()).error).toBe('This queue identity already belongs to another message.');
    const promoted = await call('PATCH', { ...target(), id: input.id }); expect(promoted.status).toBe(200);
    expect((await promoted.json()).item.intent).toBe('steer-now');
    const cancelled = await call('DELETE', { ...target(), id: input.id }); expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ ok: true });
    expect(producer.status.generation).toBe(generation);
  });
  it('refuses an unauthenticated internal call and producer-only methods over HTTP', async () => {
    const body = JSON.stringify({ v: 1, method: 'listTargets', params: {} });
    const denied = await fetch(`${origin}/internal/composer-queue`, { method: 'POST', body }); expect(denied.status).toBe(401);
    const fenced = await fetch(`${origin}/internal/composer-queue`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ v: 1, method: 'claim', params: { target: target(), intent: 'send-next' } }) });
    expect((await fenced.json()).error.code).toBe('invalid');
  });
  it('reverts a real inbox commit if an owner enqueue lands between the pre-read and commit', async () => {
    const ownerClient = await import('@/lib/orchestrator/composer-owner-client');
    const { inboxSubject, readInboxState } = await import('@/lib/inbox/store');
    const parking = await import('@/lib/inbox/workspace-parking');
    const park = vi.spyOn(parking, 'startSettledWorkspaceParking').mockImplementation(() => {});
    let reads = 0;
    unbind = ownerClient.bindComposerOwnerProducer(async (method, params) => {
      const result = await producer.composerRequest(method, params);
      if (method === 'list' && ++reads === 1) {
        // Real native commit after the captured empty read, before the TS transaction.
        await producer.composerRequest('enqueue', { id: 'queued-during-inbox-commit', target: target(), intent: 'send-next', payloadJson: JSON.stringify(payload) });
      }
      return result;
    });
    try {
      const response = await fetch(`http://127.0.0.1:${(classic.address() as { port: number }).port}/api/v2/chat-history`, {
        method: 'PATCH', body: JSON.stringify({ tabId: target().threadId, inboxAction: 'settle' }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('Thread has a queued message.');
      expect(reads).toBe(2);
      expect(readInboxState(inboxSubject('conversation', target().threadId, repo)).settledOverride).toBe('active');
      expect(park).not.toHaveBeenCalled();
    } finally { unbind(); unbind = undefined; park.mockRestore(); }
  });
  it('returns 503/Retry-After through classic when the owner is down and never writes locally', async () => {
    const before = db.getSqlite().prepare('SELECT * FROM composer_send_queue ORDER BY sequence').all();
    const exit = once(daemon, 'exit'); daemon.kill(); await exit;
    const response = await fetch(`http://127.0.0.1:${(classic.address() as { port: number }).port}/api/orchestrator/composer-queue`, {
      method: 'POST', body: JSON.stringify({ ...target(), id: 'owner-down-proof', intent: 'send-next', payload }),
    });
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('1');
    expect(db.getSqlite().prepare('SELECT * FROM composer_send_queue ORDER BY sequence').all()).toEqual(before);
  });
});
