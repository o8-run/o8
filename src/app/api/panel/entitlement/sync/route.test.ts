import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.fn();
const clearCachedAccountEntitlementMock = vi.fn();
const clearCachedEntitlementMock = vi.fn();
const clearFounderRecordMock = vi.fn();
const getEntitlementMock = vi.fn(async () => ({ plan: 'free', flags: {}, source: 'default' }));
const verifyLicenseMock = vi.fn();
const writeCachedEntitlementMock = vi.fn<(input: { licenseKey?: string; plan?: string }) => boolean>(() => true);
const writeFounderRecordMock = vi.fn();
let tempDataDir: string | null = null;

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
}));

vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({
  proxyBaseUrl: () => 'https://license.test',
  planToken: () => JSON.parse(readFileSync(path.join(tempDataDir!, 'entitlement.json'), 'utf8')).licenseKey,
}));

vi.mock('@/lib/entitlement/bootstrap', () => ({
  getOrCreateInstallId: () => 'install_123',
}));

vi.mock('@/lib/entitlement/founder', () => ({
  clearFounderRecord: clearFounderRecordMock,
  writeFounderRecord: writeFounderRecordMock,
}));

vi.mock('@/lib/entitlement/license', () => ({
  clearCachedAccountEntitlement: clearCachedAccountEntitlementMock,
  clearCachedEntitlement: clearCachedEntitlementMock,
  verifyLicense: verifyLicenseMock,
  writeCachedEntitlement: writeCachedEntitlementMock,
}));

vi.mock('@/lib/entitlement/store', () => ({
  getEntitlement: getEntitlementMock,
}));

function sessionToken(iat: number): string {
  const payload = Buffer.from(JSON.stringify({ iat })).toString('base64url');
  return `header.${payload}.signature`;
}

function markerPath(): string {
  if (!tempDataDir) throw new Error('temp data dir not initialized');
  return path.join(tempDataDir, 'auth-signed-out-at');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function post(body: unknown, token = sessionToken(20)) {
  const { POST } = await import('./route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-session-token': token,
    },
    body: JSON.stringify(body),
  }));
}

describe('entitlement sync route', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 5, 1));
    vi.resetModules();
    vi.clearAllMocks();
    tempDataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-sync-'));
    process.env.CORTEX_IDE_DATA_DIR = tempDataDir;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test';
    authMock.mockResolvedValue({ userId: null, getToken: vi.fn() });
    getEntitlementMock.mockResolvedValue({ plan: 'free', flags: {}, source: 'default' });
    verifyLicenseMock.mockResolvedValue({
      valid: true,
      plan: 'founder',
      expiresAt: 4_102_444_800,
      subject: 'user_founder',
    });
    writeCachedEntitlementMock.mockImplementation((input: { licenseKey?: string; plan?: string }) => {
      writeFileSync(path.join(tempDataDir!, 'entitlement.json'), JSON.stringify(input));
      return true;
    });
    writeFounderRecordMock.mockReturnValue(true);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
      return Response.json({
        license: 'license.jwt',
        source: 'founding',
        founder: { operatorNumber: 2, tier: 1 },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
    tempDataDir = null;
    delete process.env.CORTEX_IDE_DATA_DIR;
    vi.unstubAllEnvs();
  });

  it('keeps persisted voice controls through same-account license and managed credential refresh, but not fresh sign-in', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    vi.stubEnv('O8_DATA_DIR', tempDataDir!);
    vi.stubEnv('WS_TOKEN', 'voice-sync-operator-fixture');
    let license = 'license.one';
    const id = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return Response.json({});
      if (url.endsWith('/account/license')) return Response.json({ license });
      if (url.endsWith('/github/app/token')) return Response.json({ installed: true,
        token: `fixture-${license}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        installationId: 88, ownerClerkUserId: 'user_founder' });
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return Response.json(url.endsWith('/v1/live/sessions') ? { id, sdp: 'answer' } : { events: [] });
    });
    const { readAccountState } = await import('@/lib/auth/account-state');
    const { readManagedGithubState } = await import('@/lib/github-broker/managed');
    const sync = async () => {
      expect((await post({ clerkUserId: 'user_founder' })).status).toBe(200);
      await vi.waitFor(() => expect(readManagedGithubState()?.token).toBe(`fixture-${license}`));
      await vi.waitFor(() => expect(readAccountState()?.status).toBe('ready'));
    };
    await sync();
    const before = readAccountState()!;
    const voiceRequest = (action: string) => new Request('http://localhost/api/voice/live', {
      method: 'POST', headers: { authorization: 'Bearer voice-sync-operator-fixture' },
      body: JSON.stringify({ action, id, binding: 'same-chat', after: 0, context: '', sdp: 'offer' }),
    });
    const voice = await import('@/app/api/voice/live/route');
    expect((await voice.POST(voiceRequest('start'))).status).toBe(200);
    const receipt = path.join(tempDataDir!, 'managed-voice-relay', `${id}.json`);
    const stored = readFileSync(receipt, 'utf8');
    expect(JSON.parse(stored).version).toBe(2);
    license = 'license.two';
    await sync();
    expect(readAccountState()).toMatchObject({ accountId: before.accountId, epoch: before.epoch });
    expect(readAccountState()?.generation).not.toBe(before.generation);
    vi.resetModules();
    const reloaded = await import('@/app/api/voice/live/route');
    expect((await reloaded.POST(voiceRequest('poll'))).status).toBe(200);
    expect((await reloaded.POST(voiceRequest('close'))).status).toBe(200);
    expect(calls.map(call => call.authorization)).toEqual(['Bearer license.one', 'Bearer license.two', 'Bearer license.two']);
    expect(readFileSync(receipt, 'utf8')).toBe(stored);
    expect((await post({ clearSignInMarker: true })).status).toBe(200);
    await sync();
    expect((await reloaded.POST(voiceRequest('poll'))).status).toBe(404);
    expect(calls).toHaveLength(3);
    expect(readFileSync(receipt, 'utf8')).toBe(stored);
  });

  it('clears entitlement and founder state on signed-out sync', async () => {
    const response = await post({ signedOut: true });
    const data = await response.json();

    expect(data.reason).toBe('signed_out');
    expect(clearCachedAccountEntitlementMock).toHaveBeenCalledOnce();
    expect(clearCachedEntitlementMock).not.toHaveBeenCalled();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
  });

  it('preserves the cached entitlement when the session credential is transiently absent', async () => {
    const response = await post({ clerkUserId: 'user_founder' }, '');
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.reason).toBe('no_session');
    expect(clearCachedEntitlementMock).not.toHaveBeenCalled();
    expect(clearFounderRecordMock).not.toHaveBeenCalled();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
  });

  it('clears stale paid cache when the active signed-in account has no license', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const response = await post({ clerkUserId: 'user_free' });
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.plan).toBe('free');
    expect(data.source).toBe('default');
    expect(clearCachedAccountEntitlementMock).toHaveBeenCalledOnce();
    expect(clearCachedEntitlementMock).not.toHaveBeenCalled();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
  });

  it('refuses to persist a license minted for a previous Clerk identity', async () => {
    const response = await post({ clerkUserId: 'user_free' });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.reason).toBe('license_subject_mismatch');
    expect(clearCachedAccountEntitlementMock).toHaveBeenCalledOnce();
    expect(clearCachedEntitlementMock).not.toHaveBeenCalled();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
    expect(writeFounderRecordMock).not.toHaveBeenCalled();
  });

  // ── Sign-out marker hygiene (#1483 — auto-signout loop) ──────────────────
  describe('sign-out marker hygiene', () => {
    it('retires the marker on the desktop sign-in callback action', async () => {
      writeFileSync(markerPath(), `${nowSeconds()}\n`);
      const response = await post({ clearSignInMarker: true });
      const data = await response.json();

      expect(data.ok).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
    });

    it('still rejects a genuinely stale pre-sign-out token against a recent marker', async () => {
      const now = nowSeconds();
      writeFileSync(markerPath(), `${now}\n`);
      // Token issued BEFORE the sign-out — the guard must still block it.
      const response = await post({ clerkUserId: 'user_founder' }, sessionToken(now - 60));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.reason).toBe('stale_session');
    });

    it('ignores a marker older than the max age so a fresh session is never purged forever', async () => {
      const eightDaysAgo = nowSeconds() - 8 * 24 * 60 * 60;
      writeFileSync(markerPath(), `${eightDaysAgo}\n`);
      // Even a token whose iat predates the (expired) marker must sync — the
      // stale marker self-expires instead of trapping the account in a loop.
      const response = await post({ clerkUserId: 'user_founder' }, sessionToken(eightDaysAgo - 100));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
    });

    it('clears the marker after a successful subject-matched sync', async () => {
      const now = nowSeconds();
      writeFileSync(markerPath(), `${now - 3600}\n`); // 1h ago — within max age
      const response = await post({ clerkUserId: 'user_founder' }, sessionToken(now)); // fresh token
      const data = await response.json();

      expect(data.ok).toBe(true);
      expect(writeCachedEntitlementMock).toHaveBeenCalledOnce();
      expect(existsSync(markerPath())).toBe(false);
    });
  });

  // ── Managed GitHub App token — cross-account race (audit #2) ────────────────
  describe('managed GitHub App token binding', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('clears a cached managed token when the hosted service rejects Free access', async () => {
      const {
        readManagedGithubState,
        writeActiveIdentity,
        writeManagedGithubState,
      } = await import('@/lib/github-broker/managed');
      writeManagedGithubState({
        installed: true,
        token: 'ghs_previous_paid_token',
        expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        installationId: 88,
        accountLogin: 'paid-before',
        ownerClerkUserId: 'user_free',
      });
      writeActiveIdentity('user_free');

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/github/app/token')) {
          return Response.json({ error: 'paid_entitlement_required' }, { status: 403 });
        }
        if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      await post({ clerkUserId: 'user_free' });
      await flush();
      await flush();

      await vi.waitFor(() => expect(readManagedGithubState()).toBeNull());
    });

    it('drops user B\'s delayed refresh that completes AFTER user A signs in', async () => {
      const { readManagedGithubState } = await import('@/lib/github-broker/managed');

      // Hold B's /github/app/token response open so it lands after A signs in.
      let releaseB: (r: Response) => void = () => {};
      const bTokenResponse = new Promise<Response>((res) => { releaseB = res; });

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/github/app/token')) return bTokenResponse; // B's delayed refresh
        if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
        return new Response('{}', { status: 404 }); // free — license path writes no managed state
      }) as unknown as typeof fetch;

      // 1) B syncs → kicks off the fire-and-forget managed refresh (awaits B's token).
      await post({ clerkUserId: 'user_B' }, sessionToken(30));
      await flush();

      // 2) A signs in → bumps the sign-in epoch and clears state.
      await post({ clearSignInMarker: true }, sessionToken(40));

      // 3) B's delayed token finally arrives with a valid, correctly-owned token.
      releaseB(Response.json({
        installed: true,
        token: 'ghs_B_token',
        expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        installationId: 99,
        accountLogin: 'user-b',
        ownerClerkUserId: 'user_B',
      }));
      await flush();
      await flush();

      // The stale refresh must NOT have persisted B's token — A is now signed in.
      const state = readManagedGithubState();
      expect(state?.token).toBeUndefined();
    });
  });
});
