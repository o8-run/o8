import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let reference: Awaited<ReturnType<typeof startParityReference>>;
let api: Server;
let base = '';
let socket: WebSocket;
let heartbeat: ReturnType<typeof setInterval>;
const frames: Array<{ kind?: string; payload?: Record<string, unknown> }> = [];
const target = { binding: 'bound-chat', nonce: 'voice-one', threadId: 'thoughts-voice-thread', repoPath: '' };
beforeAll(async () => {
  // Cold production imports can exceed 30s; request/503 deadlines stay unchanged.
  reference = await startParityReference({ nativeHttp: true, preload: resolve('tests/fixtures/voice-host-runtime.cjs'), startupTimeoutMs: 60_000 });
  target.repoPath = reference.directory;
  vi.stubEnv('CORTEX_REALTIME_INTERNAL_ORIGIN', reference.url.replace('ws:', 'http:').replace('/ws', ''));
  vi.stubEnv('WS_TOKEN', reference.token);
  const path = resolve('src/app/api/next/voice-host/route.ts');
  const route = existsSync(path) ? await import(path) : null;
  api = createServer(async (req, res) => {
    if (!route) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await route[req.method ?? 'GET'](new NextRequest(base + req.url, {
      method: req.method, headers: { 'content-type': 'application/json' },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const address = api.address(); if (!address || typeof address === 'string') throw new Error('No address');
  base = `http://127.0.0.1:${address.port}`;
  socket = new WebSocket(`${reference.url}?token=${reference.token}`);
  socket.on('message', raw => frames.push(JSON.parse(String(raw))));
  await once(socket, 'open');
}, 60_000);
afterAll(async () => {
  clearInterval(heartbeat); socket?.terminate();
  if (api?.listening) await new Promise<void>(done => api.close(() => done()));
  await reference?.stop(); vi.unstubAllEnvs();
});
const post = (body: unknown) => fetch(`${base}/api/next/voice-host`, { method: 'POST', body: JSON.stringify(body) });
const native = (path: string, body: unknown) => fetch(reference.url.replace('ws:', 'http:').replace('/ws', path), {
  method: 'POST', headers: { authorization: `Bearer ${reference.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function seed() {
  const response = await native('/api/v2/chat-history', { tabId: target.threadId, repoPath: target.repoPath, backend: 'codex', messages: [] });
  expect(response.status).toBe(200);
}
async function enqueue(id: string, text: string) {
  const response = await native('/api/orchestrator/composer-queue', { id, repoPath: target.repoPath, threadId: target.threadId, intent: 'send-next',
    payload: { text, wireMessage: text, images: [], routing: { backend: 'codex', model: 'gpt-5.4', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } },
  });
  expect(await response.json()).toMatchObject({ item: { id } });
  expect(response.status).toBe(200);
}
async function ui(kind: string, payload: Record<string, unknown>) {
  return fetch(reference.url.replace('ws:', 'http:').replace('/ws', '/internal/next/voice-host'), {
    method: 'POST', headers: { authorization: `Bearer ${reference.token}` }, body: JSON.stringify({ action: 'publish', kind, payload }),
  });
}
it('keeps desktop commands and the generic relay out of the voice transport', async () => {
  expect((await post({ action: 'publish', kind: 'open-settings', payload: {} })).status).toBe(400);
  const generic = await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '/internal/ui-command'), {
    method: 'POST', headers: { authorization: `Bearer ${reference.token}` },
    body: JSON.stringify({ kind: 'open-settings', payload: {} }),
  });
  expect(generic.status).toBe(404);
  expect(frames.some(frame => frame.kind === 'open-settings')).toBe(false);
});
it('headless requests fail promptly without starting a provider', async () => {
  const started = Date.now();
  const response = await post({ action: 'start', requestId: 'start-one', ...target, source: 'byok' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: 'VOICE_HOST_UNAVAILABLE' });
  expect(Date.now() - started).toBeLessThan(2500);
  const native = await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '/api/next/voice-host'), { headers: { authorization: `Bearer ${reference.token}` } });
  expect(native.status).toBe(503);
  expect(await native.json()).toMatchObject({ code: 'VOICE_HOST_UNAVAILABLE' });
});
it('routes ready, start, delegate, acceptance and stop through the actual WS bridge', async () => {
  expect((await post({ action: 'ready', hostId: 'host-one' })).status).toBe(200);
  heartbeat = setInterval(() => { void post({ action: 'ready', hostId: 'host-one' }); }, 4000);
  expect((await post({ action: 'start', requestId: 'start-one', ...target, source: 'byok' })).status).toBe(202);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ action: 'start', ...target }) })));
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-one', text: 'Inspect the build.' })).status).toBe(200);
  await seed();
  await enqueue('next-voice-one-fixture-turn', 'Inspect the fixture.');
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-one', queueItemId: 'next-voice-one-fixture-turn' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ action: 'accepted', delegationId: 'delegate-one', queueItemId: 'next-voice-one-fixture-turn' }) })));
  // The client cannot fabricate a terminal outcome.
  expect((await post({ action: 'terminal', ...target, delegationId: 'delegate-one', voiceTerminal: { queueItemId: 'next-voice-one-fixture-turn', outcome: 'completed', text: 'invented' } })).status).toBe(409);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-one', transcriptUserMessageId: 'review-user-assistant-queued-next-voice-one-fixture-turn', voiceTerminal: expect.objectContaining({ queueItemId: 'next-voice-one-fixture-turn', outcome: 'completed', text: 'Verified fixture answer.' }),
  }) })), { timeout: 15_000 });
  expect(readFileSync(resolve(reference.directory, 'chat-history', `${target.threadId}.json`), 'utf8')).toContain('Verified fixture answer.');
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-long', text: 'Read the long result.' })).status).toBe(200);
  await enqueue('next-voice-one-fixture-long', 'fixture-long-result');
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-long', queueItemId: 'next-voice-one-fixture-long' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-long', voiceTerminal: expect.objectContaining({ outcome: 'completed', text: 'x'.repeat(50_000) }),
  }) })), { timeout: 15_000 });

  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-held', text: 'Hold this request.' })).status).toBe(200);
  await enqueue('next-voice-one-fixture-held', 'fixture-held');
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-held', queueItemId: 'next-voice-one-fixture-held' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-held', voiceTerminal: expect.objectContaining({ queueItemId: 'next-voice-one-fixture-held', outcome: 'held' }),
  }) })), { timeout: 15_000 });
  expect(frames).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ delegationId: 'delegate-held', voiceTerminal: expect.objectContaining({ outcome: 'completed' }) }) }));
  const removed = await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '/api/orchestrator/composer-queue'), {
    method: 'DELETE', headers: { authorization: `Bearer ${reference.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...target, id: 'next-voice-one-fixture-held' }),
  });
  expect(removed.status).toBe(200);
  // A terminal persisted before acceptance is replayed from the exact item.
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-failed', text: 'Inspect this failure.' })).status).toBe(200);
  await enqueue('next-voice-one-fixture-failed', 'fixture-failed');
  await vi.waitFor(() => {
    const saved = JSON.parse(readFileSync(resolve(reference.directory, 'chat-history', `${target.threadId}.json`), 'utf8'));
    expect(saved.messages.find((row: { id: string }) => row.id === 'assistant-queued-next-voice-one-fixture-failed')?.receipt?.terminal?.outcome).toBe('failed');
  }, { timeout: 15_000 });
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-failed', queueItemId: 'next-voice-one-fixture-failed' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-failed', voiceTerminal: expect.objectContaining({ queueItemId: 'next-voice-one-fixture-failed', outcome: 'failed' }),
  }) })));
  expect((await post({ action: 'stop', requestId: 'stop-one', ...target })).status).toBe(202);
});
it('relays the host Caps Lock tap to o8 next only from the leased host', async () => {
  expect((await ui('voice-host-state', { hostId: 'host-one', action: 'voice-toggle' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ hostId: 'host-one', action: 'voice-toggle' }) })));
  expect((await ui('voice-host-state', { hostId: 'host-other', action: 'voice-toggle' })).status).toBe(409);
  expect(frames).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ hostId: 'host-other' }) }));
});
it('rejects stale delegation and retains the exact existing internal bearer gate', async () => {
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, nonce: 'stale', delegationId: 'late', text: 'No' })).status).toBe(409);
  const response = await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '/internal/next/voice-host'), {
    method: 'POST', headers: { authorization: 'Bearer wrong-token' }, body: JSON.stringify({ action: 'ready', hostId: 'bad' }),
  });
  expect(response.status).toBe(401);
});

it('keeps the real server alive when an authenticated internal POST disconnects mid-body', async () => {
  const origin = reference.url.replace('ws:', 'http:').replace('/ws', '');
  const request = httpRequest(`${origin}/internal/next/voice-host`, {
    method: 'POST', headers: { authorization: `Bearer ${reference.token}` },
  });
  request.on('error', () => {});
  request.write('{"action":');
  await new Promise(resolveDone => setTimeout(resolveDone, 50));
  request.destroy();
  await new Promise(resolveDone => setTimeout(resolveDone, 50));
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  const malformed = await fetch(`${origin}/internal/next/voice-host`, { method: 'POST',
    headers: { authorization: `Bearer ${reference.token}` }, body: '{', signal: AbortSignal.timeout(1500) });
  expect(malformed.status).toBe(400);
});
