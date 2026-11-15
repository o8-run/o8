import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
// @ts-expect-error jsdom is a test dependency without bundled declarations
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import VoiceAccount from '@/app/voice-settings/tabs/AccountTab';
import { AccountAuthorizationSync } from '@/lib/entitlement/AccountAuthorizationSync';
import type { Plan } from '@/lib/entitlement/types';

const SUBJECT = 'user_lifetime_fixture';

const serverIdentity = vi.hoisted(() => ({ userId: null as string | null }));
const gatewayStream = vi.hoisted(() => vi.fn(async function* () { yield 'Fixture response'; }));
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => serverIdentity }));
vi.mock('@/lib/chat/gateway-client', () => ({
  FREE_CHAT_MODEL_ID: 'fixture-model', PAID_CHAT_MODEL_ID: 'paid:fixture',
  missingChatGatewayEnv: () => [], resolveDeepSeekByokKey: async () => null,
  streamGatewayChat: gatewayStream,
}));
vi.mock('@/lib/llm/context', () => ({ buildSystemPrompt: () => '', getWorkspaceContext: () => ({}) }));
const fixtureAuth = vi.hoisted(() => ({
  clerkEnabled: true, isLoaded: true, signedIn: true,
  user: { id: 'user_lifetime_fixture', name: 'Account' },
}));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => fixtureAuth }));
vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ paletteId: 'light', surface: {}, workspaceGlass: false }),
}));

let dataDir: string;
let container: HTMLDivElement;
let root: Root;
let closeDom: () => void;
let closeMainDb: (() => void) | null = null;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

function founderPath() {
  return path.join(dataDir, 'founder.json');
}

function seedStaleSeat() {
  writeFileSync(founderPath(), JSON.stringify({
    operatorNumber: 99, tier: 2, syncedAt: '2026-01-01T00:00:00.000Z',
  }));
}

async function signedLicense(plan: Plan, subject = SUBJECT) {
  return new SignJWT({ plan })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(subject)
    .setExpirationTime('1h')
    .sign(signingKey);
}

function serveAccountLicense(data: {
  license: string;
  source: string;
  founder?: { operatorNumber: number; tier?: number };
}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/account/license')) {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-session' });
      return Response.json(data);
    }
    if (url.endsWith('/account/link-install')) return Response.json({});
    if (url.endsWith('/github/app/token')) return Response.json({}, { status: 503 });
    if (url.startsWith('/api/panel/entitlement?')) {
      const { GET } = await import('@/app/api/panel/entitlement/route');
      return GET(new Request(`http://localhost${url}`));
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
}

async function sync() {
  const { POST } = await import('@/app/api/panel/entitlement/sync/route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-session-token': 'fixture-session',
    },
    body: JSON.stringify({ clerkUserId: SUBJECT }),
  }));
}

async function readEntitlement() {
  const { GET } = await import('@/app/api/panel/entitlement/route');
  return (await GET(new Request(`http://localhost/api/panel/entitlement?subject=${SUBJECT}`))).json();
}


describe('lifetime seat through desktop entitlement sync (#3269)', () => {
  beforeEach(async () => {
    vi.resetModules();
    serverIdentity.userId = null;
    gatewayStream.mockClear();
    closeMainDb = null;
    fixtureAuth.user = { id: SUBJECT, name: 'Account' };
    fixtureAuth.signedIn = true;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-sync-seat-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('O8_DATA_DIR', '');
    vi.stubEnv('O8_PLAN', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
    const keys = await generateKeyPair('EdDSA');
    signingKey = keys.privateKey;
    vi.stubEnv('O8_LICENSE_PUBKEY', await exportSPKI(keys.publicKey));
    // Keep signing and verification in Node's typed-array realm while mounting
    // the real client components against an isolated browser document.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/dashboard',
    });
    closeDom = () => dom.window.close();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    closeDom();
    closeMainDb?.();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['account sync', 'voice-settings'])('evicts a different account service license through %s', async (surface) => {
    const licenseKey = await signedLicense('pro');
    writeFileSync(path.join(dataDir, 'entitlement.json'), JSON.stringify({ plan: 'pro', status: 'active', licenseKey }));
    seedStaleSeat();
    serveAccountLicense({ license: licenseKey, source: 'subscription' });
    const render = () => root.render(surface === 'voice-settings' ? createElement(VoiceAccount) : createElement(AccountAuthorizationSync, null, null));
    await act(async () => render());
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(true);
    fixtureAuth.user = { id: 'user_other_fixture', name: 'Other account' };
    await act(async () => render());
    await vi.waitFor(() => expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false));
    expect(existsSync(founderPath())).toBe(false);
    expect(fetch).toHaveBeenCalledWith('/api/panel/entitlement?subject=user_other_fixture', { cache: 'no-store' });
  });

  it.each([
    { source: 'subscription', plan: 'pro' as const },
    { source: 'founding', plan: 'founder' as const },
  ])('persists the service license for $source', async ({ source, plan }) => {
    const license = await signedLicense(plan);
    serveAccountLicense({ license, source, founder: { operatorNumber: 7, tier: 1 } });

    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, plan, source });
    expect(existsSync(founderPath())).toBe(true);
    expect(JSON.parse(readFileSync(founderPath(), 'utf8'))).toEqual({
      operatorNumber: 7, tier: 1, syncedAt: expect.any(String),
    });
    expect(JSON.parse(readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8'))).toMatchObject({
      plan, status: 'active', licenseKey: license,
    });
    expect(await readEntitlement()).toMatchObject({
      plan, actualPlan: plan,
      founder: { operatorNumber: 7, tier: 1 },
      actualFounder: { operatorNumber: 7, tier: 1 },
    });
  });

  it('clears stale founder metadata', async () => {
    seedStaleSeat();
    serveAccountLicense({ license: await signedLicense('pro'), source: 'subscription' });

    expect(await (await sync()).json()).toMatchObject({ ok: true, plan: 'pro', source: 'subscription' });
    expect(existsSync(founderPath())).toBe(false);
    expect(await readEntitlement()).toMatchObject({ plan: 'pro', founder: null, actualFounder: null });
  });

  it('does not persist a seat or entitlement for an invalid license signature', async () => {
    const otherKey = await generateKeyPair('EdDSA');
    const license = await new SignJWT({ plan: 'pro' })
      .setProtectedHeader({ alg: 'EdDSA' }).setSubject(SUBJECT).setExpirationTime('1h')
      .sign(otherKey.privateKey);
    serveAccountLicense({ license, source: 'subscription', founder: { operatorNumber: 7 } });

    expect(await (await sync()).json()).toMatchObject({ ok: false, reason: 'bad signature (wrong key or tampered)' });
    expect(existsSync(founderPath())).toBe(false);
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
  });

  it('rejects a different license subject and clears the stale seat', async () => {
    seedStaleSeat();
    serveAccountLicense({
      license: await signedLicense('pro', 'user_other_fixture'), source: 'subscription',
      founder: { operatorNumber: 7 },
    });

    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'license_subject_mismatch' });
    expect(existsSync(founderPath())).toBe(false);
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
  });
  it('preserves the ten-turn daily chat cap through the real route and persisted counter', async () => {
    serverIdentity.userId = SUBJECT;
    const { POST } = await import('@/app/api/v2/chat/route');
    const request = () => new NextRequest('http://localhost/api/v2/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello', model: 'o8-default', history: [] }),
    });
    for (let turn = 0; turn < 10; turn++) {
      const result = await POST(request());
      expect(result.status).toBe(200);
      await result.text();
    }
    const rejected = await POST(request());
    expect(rejected.status).toBe(429);
    const error = await rejected.json();
    expect(error).toMatchObject({ error: 'free_tier_rate_limit', limit: 10, remaining: 0 });
    expect(error).not.toHaveProperty('upgradeUrl');
    expect(gatewayStream).toHaveBeenCalledTimes(10);
    const persisted = new Database(path.join(dataDir, 'chat-usage.db'), { readonly: true });
    try {
      expect(persisted.prepare('SELECT count FROM chat_usage WHERE user_id = ?').get(SUBJECT)).toEqual({ count: 10 });
    } finally { persisted.close(); }
  });

  it('preserves the proxy budget gate with a real authenticated session and persisted usage', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    window.fetch = upstream;
    vi.stubEnv('CORTEX_IDE_JWT_SECRET', 'fixture-only-session-secret');
    writeFileSync(path.join(dataDir, 'entitlement.json'), JSON.stringify({ plan: 'pro', status: 'active', licenseKey: await signedLicense('pro') }));
    const database = await import('@/lib/db');
    closeMainDb = database.closeDb;
    const { createUser } = await import('@/lib/db/users');
    const { createSession } = await import('@/lib/db/sessions');
    const { signToken } = await import('@/lib/auth/jwt');
    const { logUsage, getCurrentPeriodCost } = await import('@/lib/db/usage');
    const user = createUser({ plan: 'pro' });
    const token = await signToken({ uid: user.id, plan: user.plan });
    createSession({ userId: user.id, token, expiresAt: new Date(Date.now() + 60_000) });
    logUsage({ userId: user.id, provider: 'openai', model: 'fixture-model', inputTokens: 1, outputTokens: 1, costUsd: user.tokenBudgetUsd! });
    expect(getCurrentPeriodCost(user.id)).toBe(user.tokenBudgetUsd);
    const { POST } = await import('@/app/api/v2/proxy/llm/route');
    const response = await POST(new NextRequest('http://localhost/api/v2/proxy/llm', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: 'openai', model: 'fixture-model', disableTools: true,
        messages: [{ role: 'assistant', content: 'Earlier turn' }, { role: 'user', content: 'Hello' }] }),
    }));
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Monthly token budget exceeded') });
    expect(upstream).not.toHaveBeenCalled();
    expect(getCurrentPeriodCost(user.id)).toBe(user.tokenBudgetUsd);
  });

});
