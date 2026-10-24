import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixturePlanStore, createPlanFixture } from '../../../tests/helpers/chatgpt-plan-fixture';
import { ChatGPTPlanService } from './service';
import { bindVerifiedDesktopSession, readDesktopPlanBinding } from '@/lib/auth/desktop-plan-binding';
import { readSignInEpoch } from '@/lib/github-broker/managed';
import { getDataDir } from '@/lib/data-dir-migration';

const state = vi.hoisted(() => ({ service: null as unknown, clerkKeys: null as unknown, credentialRoot: '' }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  // Production rotation locks still run, inside the owned fixture root.
  return { ...actual, homedir: () => state.credentialRoot || actual.homedir() };
});
vi.mock('jose', async (original) => {
  const actual = await original<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: (url: URL, options: unknown) => url.hostname === 'fixture-clerk.example.invalid' ? (...args: Parameters<ReturnType<typeof createLocalJWKSet>>) => (state.clerkKeys as ReturnType<typeof createLocalJWKSet>)(...args) : actual.createRemoteJWKSet(url, options as never) };
});
vi.mock('@/lib/auth/principal', async (original) => {
  const actual = await original<typeof import('@/lib/auth/principal')>();
  return { ...actual, resolveRequestPrincipalContext: (request: Request) => request.headers.get('authorization') === 'Bearer fixture-operator' ? { role: 'operator' } : actual.resolveRequestPrincipalContext(request), resolveRequestPrincipal: (request: Request) => request.headers.get('authorization') === 'Bearer fixture-operator' ? 'operator' : actual.resolveRequestPrincipal(request) };
});
vi.mock('./service', async (original) => ({ ...await original<typeof import('./service')>(), getChatGPTPlanService: () => state.service }));

let directory: string; let store: FixturePlanStore; let fixture: Awaited<ReturnType<typeof createPlanFixture>>;
let token: string;
const owner = 'user_fixture_owner';

async function call(method: 'GET' | 'POST' | 'DELETE', body?: unknown, query = '', session = token, bearer = 'fixture-operator') {
  const route = await import('@/app/api/panel/models/chatgpt/route');
  return route[method](new Request(`http://localhost/api/panel/models/chatgpt${query}`, { method, headers: { authorization: `Bearer ${bearer}`, 'x-clerk-session-token': session, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
}

async function connect() {
  const response = await call('POST', { action: 'start' }); expect(response.status).toBe(200);
  const start = await response.json();
  expect(new URL(start.authorizationUrl).searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect((await fixture.authorize(start)).status).toBe(200);
  expect((await call('GET', undefined, `?attemptId=${start.attemptId}`)).status).toBe(200);
  expect((await call('POST', { action: 'finish', attemptId: start.attemptId })).status).toBe(200);
  return start;
}

async function infer(extra: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/v2/proxy/llm/route');
  const { tabId, ...fields } = extra;
  return POST(new NextRequest('http://localhost/api/v2/proxy/llm', { method: 'POST', headers: { authorization: 'Bearer fixture-operator', 'x-clerk-session-token': token, 'Content-Type': 'application/json', ...(typeof tabId === 'string' ? { 'x-tab-id': tabId } : {}) }, body: JSON.stringify({ provider: 'chatgpt', model: 'fixture-plan-model', messages: [{ role: 'assistant', content: 'Earlier context' }, { role: 'user', content: 'Answer using my chosen plan.' }], disableTools: true, ...fields }) }));
}

describe('ChatGPT plan route and persisted lifecycle', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'o8-plan-fixture-'));
    state.credentialRoot = directory;
    store = new FixturePlanStore(directory); fixture = await createPlanFixture(store); state.service = fixture.service;
    const pair = await generateKeyPair('RS256');
    state.clerkKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'clerk-fixture', alg: 'RS256' }] });
    token = await new SignJWT({ sid: 'session_fixture', azp: 'https://o8.run' }).setProtectedHeader({ alg: 'RS256', kid: 'clerk-fixture' }).setIssuer('https://fixture-clerk.example.invalid').setSubject(owner).setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(pair.privateKey);
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', `pk_live_${Buffer.from('fixture-clerk.example.invalid$').toString('base64')}`);
    vi.stubEnv('OPENAI_API_KEY', 'fixture-api-payer-must-not-be-used');
    expect((await call('POST', { action: 'bind' })).status).toBe(200);
  });
  afterEach(async () => { vi.unstubAllGlobals(); await fixture.service.disconnect(owner); await fixture.close(); await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('signs in without a CLI, reaches the exported inference route, and restores the account and host after restart', async () => {
    await connect();
    const status = await (await call('GET')).json();
    expect(status).toMatchObject({ connected: true, planEnabled: true, models: [{ id: 'fixture-plan-model' }] });
    expect(JSON.stringify(status)).not.toMatch(/fixture-access|fixture-refresh|idToken|clientId/);
    const host = await store.hostId();
    state.service = new ChatGPTPlanService(new FixturePlanStore(directory), fixture.config);
    const response = await infer(); expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('Fixture plan answer'); expect(stream).toContain('[DONE]'); expect(stream).toContain('"costUsd":null');
    expect(await new FixturePlanStore(directory).hostId()).toBe(host);
    const request = fixture.calls.find((entry) => entry.path === '/v1/responses')!;
    expect(request.authorization).toBe('Bearer fixture-access-0');
    expect(request.body).toMatchObject({ model: 'fixture-plan-model', store: false, stream: true });
    expect(request.body).not.toHaveProperty('max_output_tokens'); expect(request.body).not.toHaveProperty('tools');
  });

  it('aborts plan inference upstream when the owner client disconnects before response headers', async () => {
    await connect();
    let waitingForHeaders = false;
    let upstreamClosed = false;
    const upstream = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models: [{ slug: 'fixture-plan-model', visibility: 'list' }] }));
        return;
      }
      request.resume();
      request.once('end', () => {
        waitingForHeaders = true;
        response.once('close', () => { upstreamClosed = true; });
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing upstream fixture port');
    const plan = new ChatGPTPlanService(store, { ...fixture.config, resource: `http://127.0.0.1:${upstreamAddress.port}/v1` });
    state.service = plan;
    const inference = vi.spyOn(plan, 'infer');
    const tokenPath = join(getDataDir(), 'ws-token');
    const previousToken = await readFile(tokenPath).catch(() => undefined);
    await writeFile(tokenPath, 'fixture-operator', { mode: 0o600 });
    const { serveNativeHttp } = await import('@/lib/ws-server/native-http-owner');
    const host = createServer((request, response) => { void serveNativeHttp(request, response); });
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
    const address = host.address();
    if (!address || typeof address === 'string') throw new Error('Missing owner fixture port');
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/v2/proxy/llm', method: 'POST',
      headers: { authorization: 'Bearer fixture-operator', 'x-clerk-session-token': token, 'Content-Type': 'application/json' } });
    let clientStatus: number | undefined;
    client.on('response', response => { clientStatus = response.statusCode; response.resume(); });
    client.on('error', () => {});
    client.end(JSON.stringify({ provider: 'chatgpt', model: 'fixture-plan-model', messages: [{ role: 'user', content: 'Fixture cancellation' }], disableTools: true }));
    try {
      await expect.poll(() => waitingForHeaders || clientStatus !== undefined, { timeout: 5_000 }).toBe(true);
      expect(clientStatus).toBeUndefined();
      expect(inference).toHaveBeenCalledOnce();
      const signal = inference.mock.calls[0][3]!;
      expect(signal.aborted).toBe(false); // A completed request body is not a disconnect.
      client.destroy();
      await expect.poll(() => signal.aborted, { timeout: 1_000 }).toBe(true);
      await expect.poll(() => upstreamClosed, { timeout: 1_000 }).toBe(true);
    } finally {
      client.destroy();
      await plan.disconnect(owner);
      host.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([host, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      if (previousToken) await writeFile(tokenPath, previousToken); else await rm(tokenPath, { force: true });
      inference.mockRestore();
    }
  });

  it('denies worker and invalid o8 identity before creating an attempt or touching provider endpoints', async () => {
    expect((await call('POST', { action: 'start' }, '', token, 'fixture-worker')).status).toBe(403);
    expect((await call('POST', { action: 'start' }, '', 'invalid-session')).status).toBe(401);
    expect(fixture.calls).toHaveLength(0);
  });

  it('binds a discovered plan selection to proxy admission and refuses a switch before sending the old transcript', async () => {
    await connect();
    const before = await (await call('GET')).json();
    expect(before.selection).toMatchObject({ accountId: before.activeId, generation: expect.any(Number), desktopEpoch: expect.any(String) });
    await fixture.service.select(owner, before.activeId);
    const response = await infer({ planAccountId: before.selection.accountId, planGeneration: before.selection.generation, planDesktopEpoch: before.selection.desktopEpoch });
    expect(response.status).toBe(409);
    expect(fixture.calls.filter((entry) => entry.path === '/v1/responses')).toHaveLength(0);
    const after = await (await call('GET')).json();
    const fresh = await infer({ planAccountId: after.selection.accountId, planGeneration: after.selection.generation, planDesktopEpoch: after.selection.desktopEpoch });
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain('[DONE]');
  });

  it('sends only explicit conversation text from a plan text chat and never gathers workspace or personalized context', async () => {
    await connect();
    const snapshot = await (await call('GET')).json();
    const context = await import('@/lib/llm/context');
    const personalized = await import('@/lib/llm/personalized-chat-ftux');
    const workspace = vi.spyOn(context, 'getWorkspaceContext');
    const prompt = vi.spyOn(context, 'buildSystemPrompt').mockReturnValue('PRIVATE_WORKSPACE_SENTINEL');
    const ftux = vi.spyOn(personalized, 'getPersonalizedChatFtuxPayload').mockImplementation(async () => { throw new Error('PRIVATE_ACCOUNT_SENTINEL'); });
    try {
      const response = await infer({ planTextOnly: true, planAccountId: snapshot.selection.accountId, planGeneration: snapshot.selection.generation, planDesktopEpoch: snapshot.selection.desktopEpoch, messages: [{ role: 'user', content: 'Add 17 and 23' }] });
      expect(response.status).toBe(200); expect(await response.text()).toContain('[DONE]');
      expect(workspace).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled(); expect(ftux).not.toHaveBeenCalled();
      const request = fixture.calls.find((entry) => entry.path === '/v1/responses')!;
      expect(request.body).toMatchObject({ input: [{ role: 'developer', content: 'You are ChatGPT in o8. Answer using only the conversation supplied by the user. This is a text-only chat without tools or workspace context.' }, { role: 'user', content: 'Add 17 and 23' }] });
      expect(request.body).not.toHaveProperty('tools');
      expect(JSON.stringify(request.body)).not.toMatch(/PRIVATE_WORKSPACE_SENTINEL|PRIVATE_ACCOUNT_SENTINEL/);
      expect((await infer({ planTextOnly: true, disableTools: false })).status).toBe(400);
      expect((await infer({ planTextOnly: true, planAccountId: snapshot.selection.accountId, planGeneration: snapshot.selection.generation, planDesktopEpoch: snapshot.selection.desktopEpoch, repoPath: directory })).status).toBe(400);
    } finally { workspace.mockRestore(); prompt.mockRestore(); ftux.mockRestore(); }
  });

  it('refuses malformed loopback targets and keeps the real sign-in callback usable', async () => {
    const start = await (await call('POST', { action: 'start' })).json();
    const redirect = new URL(new URL(start.authorizationUrl).searchParams.get('redirect_uri')!);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: redirect.hostname, port: redirect.port, path: '//[', method: 'GET' }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.setTimeout(2_000, () => request.destroy(new Error('Fixture callback timeout')));
      request.on('error', reject); request.end();
    });
    expect(status).toBe(400);
    expect((await fixture.authorize(start)).status).toBe(200);
    expect((await call('POST', { action: 'finish', attemptId: start.attemptId })).status).toBe(200);
  });

  it('rejects callback state mismatch, then rejects replay and keeps another owner out of the attempt', async () => {
    const start = await (await call('POST', { action: 'start' })).json();
    expect((await fixture.authorize(start, { state: 'wrong' })).status).toBe(400);
    expect(fixture.calls.filter((entry) => entry.path === '/token')).toHaveLength(0);
    await expect(fixture.service.attemptStatus('user_other', start.attemptId)).rejects.toMatchObject({ code: 'attempt_expired' });
    expect((await fixture.authorize(start)).status).toBe(200);
    await expect(fixture.authorize(start)).rejects.toThrow();
    expect((await call('POST', { action: 'finish', attemptId: start.attemptId })).status).toBe(200);
    await expect(fixture.service.infer('user_other', 'fixture-plan-model', {})).rejects.toMatchObject({ code: 'o8_session_changed' });
  });

  it('retains an identity-only registration and refuses plan calls when the direct scope is absent', async () => {
    fixture.control.scopes = 'openid profile email offline_access';
    await connect();
    expect(await (await call('GET')).json()).toMatchObject({ connected: true, planEnabled: false, models: [] });
    expect((await infer()).status).toBe(403);
    expect(fixture.calls.some((entry) => entry.path === '/v1/responses')).toBe(false);
  });

  it.each(['failed', 'incomplete', 'admission'])('holds %s responses with no API-payer fallback', async (mode) => {
    await connect(); fixture.control.responseMode = mode;
    const response = await infer(); const text = await response.text();
    if (mode === 'admission') expect(response.status).toBe(429);
    else { expect(text).toContain('"type":"error"'); expect(text).not.toContain('[DONE]'); }
    expect(fixture.calls.filter((entry) => entry.path === '/v1/responses')).toHaveLength(1);
  });

  it('serializes rotating refresh across separate service instances and clears a terminal revoked grant', async () => {
    await connect();
    await store.locked(owner, async () => { const record = await store.read(owner); record.registrations[0].tokens!.expiresAt = 0; await store.write(owner, record); });
    const second = new ChatGPTPlanService(new FixturePlanStore(directory), fixture.config);
    await Promise.all([fixture.service.status(owner), second.status(owner)]);
    expect(fixture.control.refreshCount).toBe(1);
    expect((await store.read(owner)).registrations[0].tokens?.refreshToken).toBe('fixture-refresh-1');
    await store.locked(owner, async () => { const record = await store.read(owner); record.registrations[0].tokens!.expiresAt = 0; await store.write(owner, record); });
    fixture.control.refreshFailure = 'invalid_grant';
    expect((await infer()).status).toBe(401);
    expect((await store.read(owner)).registrations[0].tokens).toBeNull();
  });

  it('serializes renewal through the persisted lock in two independent Node processes', async () => {
    await connect();
    await store.locked(owner, async () => { const record = await store.read(owner); record.registrations[0].tokens!.expiresAt = 0; await store.write(owner, record); });
    const run = () => promisify(execFile)(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'tests/fixtures/chatgpt-plan-refresh-worker.ts', directory, JSON.stringify(fixture.config)], { cwd: process.cwd(), timeout: 20_000 });
    const responses = await Promise.all([run(), run()]);
    expect(responses.every((entry) => entry.stdout.trim() === 'connected')).toBe(true);
    expect(fixture.control.refreshCount).toBe(1);
    expect((await store.read(owner)).registrations[0].tokens?.refreshToken).toBe('fixture-refresh-1');
  });

  it.each(['nonce', 'audience', 'returning-subject'])('refuses invalid %s identity before replacing credentials', async (variant) => {
    if (variant === 'returning-subject') await connect();
    const before = await store.read(owner);
    const start = await fixture.service.start(owner, before.activeId ?? undefined);
    if (variant === 'nonce') fixture.control.nonceOverride = 'different-nonce';
    else if (variant === 'audience') fixture.control.audience = 'different-client';
    else fixture.control.subject = 'different-subject';
    expect((await fixture.authorize(start)).status).toBe(400);
    await expect(fixture.service.finish(owner, start.attemptId)).rejects.toMatchObject({ code: 'attempt_cancelled' });
    const after = await store.read(owner);
    expect(after.activeId).toBe(before.activeId);
    if (variant === 'returning-subject') expect(after.registrations[0].tokens).toEqual(before.registrations[0].tokens);
  });

  it('disconnect invalidates pending activation and preserves registration mapping, including failed remote revocation', async () => {
    await connect(); const record = await store.read(owner);
    const pending = await fixture.service.start(owner, record.activeId!);
    fixture.control.revokeFailure = true;
    expect(await (await call('DELETE')).json()).toEqual({ revocationConfirmed: false });
    expect((await store.read(owner)).registrations[0]).toMatchObject({ clientId: 'fixture-issued-client', subject: 'fixture-openai-subject', tokens: null });
    await expect(fixture.service.finish(owner, pending.attemptId)).rejects.toMatchObject({ code: 'attempt_expired' });
    expect((await infer()).status).toBe(401);
  });

  it('invalidates captured o8 requests, pending OAuth activation, and tool admission after switching accounts', async () => {
    await connect();
    const selected = await fixture.service.selection(owner);
    const pending = await fixture.service.start(owner, selected.accountId);
    expect((await fixture.authorize(pending)).status).toBe(200);
    bindVerifiedDesktopSession('user_other', 'session_other', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    expect((await call('GET')).status).toBe(409);
    await expect(fixture.service.finish(owner, pending.attemptId)).rejects.toMatchObject({ code: 'o8_session_changed' });
    const sideEffect = vi.fn(async () => true);
    await expect(fixture.service.toolAdmission(owner, selected, sideEffect)).rejects.toMatchObject({ code: 'o8_session_changed' });
    expect(sideEffect).not.toHaveBeenCalled();
    expect((await infer()).status).toBe(409);
    bindVerifiedDesktopSession(owner, 'session_fixture', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    await expect(fixture.service.finish(owner, pending.attemptId)).rejects.toMatchObject({ code: 'attempt_cancelled' });
  });

  it('preserves uncertain rotation after locally rejecting a successful issuer response', async () => {
    await connect();
    await store.locked(owner, async () => { const record = await store.read(owner); record.registrations[0].tokens!.expiresAt = 0; await store.write(owner, record); });
    fixture.control.subject = 'wrong-subject-after-rotation';
    const status = await fixture.service.status(owner);
    expect(status).toMatchObject({ connected: true, planEnabled: false });
    expect(status.modelLoadError).toBeTruthy();
    expect((await store.read(owner)).registrations[0].tokens?.refreshUncertain).toBe(true);
    expect((await infer()).status).toBe(409);
    expect(fixture.control.refreshCount).toBe(1);
  });

  it('rejects delayed tools and continuations after switching away and back to the same o8 session', async () => {
    await connect();
    const selected = await fixture.service.selection(owner);
    bindVerifiedDesktopSession('user_other', 'session_other', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    bindVerifiedDesktopSession(owner, 'session_fixture', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    const action = vi.fn(async () => true);
    await expect(fixture.service.toolAdmission(owner, selected, action)).rejects.toMatchObject({ code: 'o8_session_changed' });
    expect(action).not.toHaveBeenCalled();
    await expect(fixture.service.infer(owner, 'fixture-plan-model', { input: [] }, undefined, selected)).rejects.toMatchObject({ code: 'o8_session_changed' });
  });

  it('preserves uncertain rotation after an issuer 5xx and leaves Disconnect available', async () => {
    await connect();
    await store.locked(owner, async () => { const record = await store.read(owner); record.registrations[0].tokens!.expiresAt = 0; await store.write(owner, record); });
    fixture.control.refreshFailure = 'server_error'; fixture.control.refreshStatus = 503;
    expect(await (await call('GET')).json()).toMatchObject({ connected: true, planEnabled: false });
    expect((await infer()).status).toBe(409);
    expect(fixture.control.refreshCount).toBe(1);
    expect((await call('DELETE')).status).toBe(200);
  });

  it('executes a declared local read through the real proxy and refuses undeclared tools without a repo', async () => {
    await connect();
    await writeFile(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: directory }]));
    fixture.control.responseMode = 'tool';
    const text = await (await infer({ disableTools: false, repoPath: directory })).text();
    expect(text).toContain('"type":"tool_result"'); expect(text).toContain('[DONE]');
    expect(fixture.calls.filter((entry) => entry.path === '/v1/responses')).toHaveLength(2);
    fixture.control.responseMode = 'tool';
    const refused = await (await infer({ disableTools: false })).text();
    expect(refused).toContain('"code":"tool_not_available"'); expect(refused).not.toContain('[DONE]');
  });

  it('persists the original owner/account binding for an approval and rejects resumption after a grant change', async () => {
    await connect(); await writeFile(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: directory }]));
    fixture.control.responseMode = 'approval'; fixture.control.toolName = 'write_file';
    const text = await (await infer({ disableTools: false, repoPath: directory, tabId: 'fixture-chat' })).text();
    expect(text).toContain('approval_required');
    await expect(readFile(join(directory, 'fixture.txt'))).rejects.toThrow();
    const approvalEvent = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'approval_required');
    const { getApproval } = await import('@/lib/approvals/store');
    expect(getApproval(approvalEvent.id)?.continuation).toMatchObject({ kind: 'llm-chat', provider: 'chatgpt', planOwner: owner, planAccountId: (await fixture.service.selection(owner)).accountId });
    await fixture.service.select(owner, (await fixture.service.selection(owner)).accountId);
    const { POST } = await import('@/app/api/panel/approvals/route');
    const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: { authorization: 'Bearer fixture-operator', 'x-clerk-session-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', id: approvalEvent.id }) }));
    expect(response.status).toBe(409); expect(getApproval(approvalEvent.id)?.status).toBe('pending');
  });

  it.each(['complete', 'cut-off'] as const)('resumes an exact approved edit with the same payer and truthfully records a %s continuation', async (mode) => {
    await connect(); await writeFile(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: directory }]));
    fixture.control.responseMode = 'approval'; fixture.control.toolName = 'write_file';
    const text = await (await infer({ disableTools: false, repoPath: directory, tabId: 'fixture-chat-approved' })).text();
    const event = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((entry) => entry.type === 'approval_required');
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'localhost' && url.pathname === '/api/v2/proxy/llm') {
        const { POST } = await import('@/app/api/v2/proxy/llm/route');
        const response = await POST(new NextRequest(url, init ? { ...init, signal: init.signal ?? undefined } : undefined));
        return mode === 'cut-off' ? new Response((await response.text()).replace('data: [DONE]\n\n', ''), { status: response.status, headers: response.headers }) : response;
      }
      return nativeFetch(input, init);
    });
    fixture.control.responseMode = 'approval';
    const { POST } = await import('@/app/api/panel/approvals/route');
    const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: { authorization: 'Bearer fixture-operator', 'x-clerk-session-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', id: event.id }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Boolean(body.assistantMessage?.isError)).toBe(mode === 'cut-off');
    if (mode === 'cut-off') expect(body.note).toMatch(/before completion/);
    else expect(body.assistantMessage.inferenceRoute).toMatchObject({ billing: 'subscription', allowanceUse: 'unknown' });
    expect(await readFile(join(directory, 'fixture.txt'), 'utf8')).toBe('bounded test edit');
    expect(fixture.calls.filter((entry) => entry.path === '/v1/responses').every((entry) => entry.authorization === 'Bearer fixture-access-0')).toBe(true);
  });

  it('holds a persisted plan approval after switching away and back without claiming it', async () => {
    await connect(); await writeFile(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: directory }]));
    fixture.control.responseMode = 'approval'; fixture.control.toolName = 'write_file';
    const text = await (await infer({ disableTools: false, repoPath: directory, tabId: 'fixture-held-approval' })).text();
    const event = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((entry) => entry.type === 'approval_required');
    bindVerifiedDesktopSession('user_other', 'session_other', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    bindVerifiedDesktopSession(owner, 'session_fixture', readSignInEpoch(), readDesktopPlanBinding()!.generation);
    const { POST } = await import('@/app/api/panel/approvals/route');
    const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: { authorization: 'Bearer fixture-operator', 'x-clerk-session-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', id: event.id }) }));
    expect(response.status).toBe(409);
    const { getApproval } = await import('@/lib/approvals/store');
    expect(getApproval(event.id)?.status).toBe('pending');
    await expect(readFile(join(directory, 'fixture.txt'))).rejects.toThrow();
  });
});
