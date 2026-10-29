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
const frames: Array<{ kind?: string; payload?: Record<string, unknown> }> = [];
const target = { binding: 'bound-chat', nonce: 'voice-one', threadId: 'thoughts-voice-thread', repoPath: '' };
beforeAll(async () => {
  reference = await startParityReference({ nativeHttp: true, preload: resolve('tests/fixtures/voice-host-runtime.cjs') });
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
  socket?.terminate();
  if (api?.listening) await new Promise<void>(done => api.close(() => done()));
  await reference?.stop(); vi.unstubAllEnvs();
});
const post = (body: unknown) => fetch(`${base}/api/next/voice-host`, { method: 'POST', body: JSON.stringify(body) });
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
  expect((await post({ action: 'start', requestId: 'start-one', ...target, source: 'byok' })).status).toBe(202);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ action: 'start', ...target }) })));
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-one', text: 'Inspect the build.' })).status).toBe(200);
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-one', userMessageId: 'orch-user-fixture-turn' })).status).toBe(200);
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ action: 'accepted', delegationId: 'delegate-one', userMessageId: 'orch-user-fixture-turn' }) })));
  // The client cannot fabricate a terminal outcome.
  expect((await post({ action: 'terminal', ...target, delegationId: 'delegate-one', voiceTerminal: { userMessageId: 'orch-user-fixture-turn', outcome: 'completed', text: 'invented' } })).status).toBe(409);
  socket.send(JSON.stringify({ type: 'orchestrator-send', repoPath: target.repoPath, threadId: target.threadId,
    backend: 'codex', message: 'Inspect the fixture.', clientMessageId: 'fixture-turn' }));
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-one', voiceTerminal: expect.objectContaining({ outcome: 'completed', text: 'Verified fixture answer.' }),
  }) })), { timeout: 15_000 });
  expect(readFileSync(resolve(reference.directory, 'chat-history', `${target.threadId}.json`), 'utf8')).toContain('Verified fixture answer.');
  expect((await ui('voice-delegate', { hostId: 'host-one', ...target, delegationId: 'delegate-long', text: 'Read the long result.' })).status).toBe(200);
  expect((await post({ action: 'accepted', ...target, delegationId: 'delegate-long', userMessageId: 'orch-user-fixture-long' })).status).toBe(200);
  socket.send(JSON.stringify({ type: 'orchestrator-send', repoPath: target.repoPath, threadId: target.threadId,
    backend: 'codex', message: 'fixture-long-result', clientMessageId: 'fixture-long' }));
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({
    action: 'terminal', delegationId: 'delegate-long', voiceTerminal: expect.objectContaining({ outcome: 'completed', text: 'x'.repeat(50_000) }),
  }) })), { timeout: 15_000 });

  expect((await post({ action: 'stop', requestId: 'stop-one', ...target })).status).toBe(202);
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
