import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FixturePlanStore, createPlanFixture } from './helpers/chatgpt-plan-fixture';
import { bindVerifiedDesktopSession, readDesktopPlanBinding } from '@/lib/auth/desktop-plan-binding';
import { readSignInEpoch } from '@/lib/github-broker/managed';
import { getDataDir } from '@/lib/data-dir-migration';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { createApproval, getApproval } from '@/lib/approvals/store';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { handleNativeHttp } from '@/lib/ws-server/native-http-routes';
import { forwardToNext, registeredFrontDoorRoute } from '@/lib/ws-server/api-front-door';

const boundary = vi.hoisted(() => ({ service: null as unknown, clerkKeys: null as unknown }));
// Replace external credential/issuer boundaries only: the service, principal,
// middleware, routes, approvals, grants and continuation stream remain real.
vi.mock('@/lib/chatgpt-plan/service', async original => ({
  ...await original<typeof import('@/lib/chatgpt-plan/service')>(), getChatGPTPlanService: () => boundary.service,
}));
vi.mock('jose', async original => {
  const actual = await original<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: (url: URL, options: unknown) => url.hostname === 'approval-clerk.example.invalid'
    ? (...args: Parameters<ReturnType<typeof createLocalJWKSet>>) => (boundary.clerkKeys as ReturnType<typeof createLocalJWKSet>)(...args)
    : actual.createRemoteJWKSet(url, options as never) };
});

const owner = 'user_approval_fixture';
const device = 'approval-fixture-device';
let directory: string;
let fixture: Awaited<ReturnType<typeof createPlanFixture>>;
let listener: Server;
let origin: string;
let token: string;
let session: string;
let deadNext: URL;
let hits: string[];
let apiCalls: Record<string, unknown>[];

const headers = () => ({ authorization: `Bearer ${token}`, 'x-clerk-session-token': session, 'content-type': 'application/json' });
const control = (method: string, body?: unknown) => fetch(origin + '/api/panel/models/chatgpt', {
  method, headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}),
});
async function card(provider: 'chatgpt' | 'openai', tabId: string) {
  const selection = await fixture.service.selection(owner);
  return createApproval({ source: 'llm-chat', runtime: 'chat', agent: 'Fixture', sessionKey: `llm-chat:${tabId}`,
    title: 'Edit fixture', description: 'Edit fixture', summary: 'Edit fixture', risk: 'medium',
    ...(provider === 'chatgpt' ? { toolName: 'write_file', args: { path: 'fixture.txt', content: 'bounded test edit' } } : {}),
    continuation: { kind: 'llm-chat', tabId, provider, model: provider === 'chatgpt' ? 'fixture-plan-model' : 'gpt-4o',
      repoPath: directory, messages: [{ role: 'user', content: 'Complete the approved fixture edit.' }],
      ...(provider === 'chatgpt' ? { planOwner: owner, planAccountId: selection.accountId,
        planGeneration: selection.generation, planDesktopEpoch: selection.desktopEpoch } : {}) } });
}
async function connectDirectly() {
  const start = await fixture.service.start(owner);
  expect((await fixture.authorize(start)).status).toBe(200);
  await fixture.service.finish(owner, start.attemptId);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'o8-approval-front-door-'));
  // The production rotation lock is OS-user-global, independent of profile.
  vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
  execFileSync('git', ['init', '--quiet', directory]);
  fixture = await createPlanFixture(new FixturePlanStore(directory));
  boundary.service = fixture.service;
  const pair = await generateKeyPair('RS256');
  boundary.clerkKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'approval-clerk', alg: 'RS256' }] });
  session = await new SignJWT({ sid: 'session_approval_fixture', azp: 'https://o8.run' })
    .setProtectedHeader({ alg: 'RS256', kid: 'approval-clerk' }).setIssuer('https://approval-clerk.example.invalid')
    .setSubject(owner).setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(pair.privateKey);
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', `pk_live_${Buffer.from('approval-clerk.example.invalid$').toString('base64')}`);
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-api-key');
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  vi.stubEnv('O8_NEXT_O8D', '0');
  token = getOrCreateWsToken();
  bindVerifiedDesktopSession(owner, 'session_approval_fixture', readSignInEpoch(), readDesktopPlanBinding()?.generation ?? null);
  await writeFile(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: directory }]));
  await writeFile(join(getDataDir(), 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  hits = []; apiCalls = [];
  // Reserve then close a port: fallback reaches an absent Next, never a stub.
  const absent = createServer();
  await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
  deadNext = new URL(`http://127.0.0.1:${(absent.address() as { port: number }).port}`);
  await new Promise<void>(resolve => absent.close(() => resolve()));
  listener = createServer((req, res) => {
    void (async () => {
      hits.push(`${req.method} ${req.url}`);
      const port = (listener.address() as { port: number }).port;
      // Same dispatch/fallback boundary used by src/ws-server.ts.
      if (registeredFrontDoorRoute(new URL(req.url!, origin).pathname, req.method!)
        && await handleNativeHttp(req, res, port, false, req.socket.remoteAddress ?? null)) return;
      forwardToNext(req, res, deadNext, port, req.socket.remoteAddress ?? null);
    })().catch(error => { res.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = String((listener.address() as { port: number }).port);
  origin = `http://127.0.0.1:${port}`;
  for (const name of ['PORT', 'O8_API_PORT', 'O8_WS_PORT']) vi.stubEnv(name, port);
  vi.stubEnv('NEXT_ORIGIN', deadNext.origin);
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1' || (url.hostname === 'localhost' && url.port === port)) return nativeFetch(input, init);
    // The phone's existing API-paid continuation; no external provider call.
    if (url.href === 'https://api.openai.com/v1/chat/completions') {
      apiCalls.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"Phone fixture answer"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected external request: ${url.origin}`);
  });
  await connectDirectly();
});
afterEach(async () => {
  await fixture?.service.disconnect(owner);
  await fixture?.close();
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('resumes the desktop plan approval through the public proxy with Next absent', async () => {
  const approval = await card('chatgpt', 'desktop-plan');
  fixture.control.responseMode = 'approval'; fixture.control.toolName = 'write_file';
  const response = await fetch(origin + '/api/panel/approvals', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'approve', id: approval.id }) });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(body.assistantMessage, JSON.stringify(body)).toMatchObject({ content: expect.stringContaining('Fixture plan answer') });
  expect(hits).toContain('POST /api/v2/proxy/llm');
  expect(await readFile(join(directory, 'fixture.txt'), 'utf8')).toBe('bounded test edit');
  expect(getApproval(approval.id)?.resolution?.continuationStatus).toBe('completed');
  expect(fixture.calls.filter(call => call.path === '/v1/responses')).toHaveLength(2);
  expect(fixture.calls.filter(call => call.path === '/v1/responses').every(call => call.authorization === 'Bearer fixture-access-0' && call.body.model === 'fixture-plan-model')).toBe(true);
  expect(apiCalls).toHaveLength(0);
});

it('resumes the phone API-paid chat on the same proxy and keeps plan approval desktop-only', async () => {
  const approval = await card('openai', 'phone-api');
  const phone = (approvalId: string) => fetch(origin + '/api/mobile/action', { method: 'POST',
    headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json', 'x-o8-relay-forward': '1' },
    body: JSON.stringify({ action: 'approve', sessionKey: `llm-chat:phone-api`, approvalId }) });
  const response = await phone(approval.id);
  expect(response.status).toBe(200);
  expect(readPersistedLlmChat('phone-api')?.history.messages.at(-1)?.content).toBe('Phone fixture answer');
  expect(hits).toContain('POST /api/v2/proxy/llm');
  expect(apiCalls).toHaveLength(1);
  expect(apiCalls[0].model).toBe('gpt-4o');
  const held = await card('chatgpt', 'phone-plan-held');
  expect((await phone(held.id)).status).toBe(409);
  expect(getApproval(held.id)?.status).toBe('pending');
  // A relay/device cannot access the newly registered desktop control route,
  // even with a valid signed account JWT or forged loopback peer header.
  const denied = await fetch(origin + '/api/panel/models/chatgpt', { headers: {
    ...headers(), authorization: `Bearer ${device}`, 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.1',
  } });
  expect(denied.status).toBe(403);
});

it.each(['select', 'disconnect'])('%s aborts an in-flight plan stream in the public route owner', async action => {
  fixture.control.responseMode = 'hold';
  const response = await fetch(origin + '/api/v2/proxy/llm', { method: 'POST', headers: headers(),
    body: JSON.stringify({ provider: 'chatgpt', model: 'fixture-plan-model', disableTools: true, messages: [{ role: 'user', content: 'Fixture' }] }) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('Fixture plan answer');
  const selection = await fixture.service.selection(owner);
  const result = action === 'select' ? await control('POST', { action, accountId: selection.accountId }) : await control('DELETE');
  expect(result.status).toBe(200);
  await expect.poll(() => fixture.control.heldResponsesClosed).toBe(1);
  let tail = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  expect(tail).not.toContain('[DONE]');
});

it('keeps OAuth start, loopback callback, attempt lookup and finish in the public owner', async () => {
  const started = await control('POST', { action: 'start' });
  expect(started.status).toBe(200);
  const attempt = await started.json();
  expect((await fixture.authorize(attempt)).status).toBe(200);
  const status = await fetch(origin + `/api/panel/models/chatgpt?attemptId=${attempt.attemptId}`, { headers: headers() });
  expect(status.status).toBe(200);
  expect((await status.json()).state).toBe('ready');
  expect((await control('POST', { action: 'finish', attemptId: attempt.attemptId })).status).toBe(200);
  expect((await control('GET')).status).toBe(200);
});
