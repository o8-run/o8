import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));

let dataDir: string;
let privateKey: CryptoKey;
let publicKeyPem: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function signedLicense(plan: 'free' | 'pro' | 'founder') {
  return new SignJWT({ plan })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(plan === 'free' ? 'install_fixture' : 'user_paid_fixture')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function holdFreeResponse(license: string) {
  const requested = deferred<void>();
  const response = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://license.invalid/issue-free');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      installId: readFileSync(path.join(dataDir, 'install-id'), 'utf8').trim(),
    });
    requested.resolve();
    return response.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    requested: requested.promise,
    respond: () => response.resolve(Response.json({ license })),
    fetchMock,
  };
}

async function applyLicense(licenseKey: string) {
  const { POST } = await import('@/app/api/panel/entitlement/route');
  return POST(new Request('http://localhost/api/panel/entitlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licenseKey }),
  }));
}

async function bootstrapEntitlement() {
  const { ensureFreeEntitlement } = await import('@/lib/entitlement/bootstrap');
  const { getEntitlement } = await import('@/lib/entitlement/store');
  await ensureFreeEntitlement();
  return getEntitlement();
}

describe('free entitlement issuance through routes and persisted licenses', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA');
    privateKey = pair.privateKey;
    publicKeyPem = await exportSPKI(pair.publicKey);
  });

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-race-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('O8_PLAN', undefined);
    vi.stubEnv('O8_PROXY_URL', 'https://license.invalid');
    vi.stubEnv('O8_LICENSE_PUBKEY', publicKeyPem);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['free', 'pro', 'founder'] as const)(
    'preserves a %s license applied while coalesced bootstrap requests wait for free issuance',
    async (plan) => {
      const licenseKey = await signedLicense(plan);
      const held = holdFreeResponse(await signedLicense('free'));
      const first = bootstrapEntitlement();
      await held.requested;
      const second = bootstrapEntitlement();

      const applied = await applyLicense(licenseKey);
      expect(await applied.json()).toMatchObject({ plan, actualPlan: plan, source: 'file' });
      const entitlementPath = path.join(dataDir, 'entitlement.json');
      const persisted = readFileSync(entitlementPath, 'utf8');
      held.respond();

      for (const response of await Promise.all([first, second])) {
        expect(response).toMatchObject({ plan, actualPlan: plan, source: 'file' });
      }
      expect(readFileSync(entitlementPath, 'utf8')).toBe(persisted);
      expect(JSON.parse(persisted)).toMatchObject({ plan, licenseKey });
      expect(held.fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('preserves a paid license applied while the free signature is being verified', async () => {
    const freeLicense = await signedLicense('free');
    const paidLicense = await signedLicense('pro');
    const verifying = deferred<void>();
    const finishVerification = deferred<void>();
    const licenses = await import('@/lib/entitlement/license');
    const verify = licenses.verifyLicense;
    vi.spyOn(licenses, 'verifyLicense').mockImplementation(async (token, options) => {
      const result = await verify(token, options);
      if (token === freeLicense) {
        verifying.resolve();
        await finishVerification.promise;
      }
      return result;
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ license: freeLicense })));
    const pending = bootstrapEntitlement();
    await verifying.promise;
    expect(await (await applyLicense(paidLicense)).json()).toMatchObject({ plan: 'pro' });
    const entitlementPath = path.join(dataDir, 'entitlement.json');
    const persisted = readFileSync(entitlementPath, 'utf8');
    finishVerification.resolve();

    expect(await pending).toMatchObject({ plan: 'pro', source: 'file' });
    expect(readFileSync(entitlementPath, 'utf8')).toBe(persisted);
  });

  it('does not cache the free response after a plan is pinned during issuance', async () => {
    const held = holdFreeResponse(await signedLicense('free'));
    const pending = bootstrapEntitlement();
    await held.requested;
    vi.stubEnv('O8_PLAN', 'pro');
    held.respond();

    expect(await pending).toMatchObject({ plan: 'pro', source: 'env' });
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
  });

  it.each(['off', 'none', 'disabled', '0', 'false'])(
    'does not cache the free response after the hosted service is set to %s',
    async (optOut) => {
      const held = holdFreeResponse(await signedLicense('free'));
      const pending = bootstrapEntitlement();
      await held.requested;
      vi.stubEnv('O8_PROXY_URL', optOut);
      held.respond();

      expect(await pending).toMatchObject({ plan: 'free', source: 'default' });
      expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
    },
  );

  it.each(['founder', 'pro', undefined])(
    'allows explicit hosted authentication only while its initial pin remains unchanged (%s)',
    async (nextPlan) => {
      vi.stubEnv('O8_PLAN', 'founder');
      const licenseKey = await signedLicense('free');
      const held = holdFreeResponse(licenseKey);
      const { ensureFreeEntitlement } = await import('@/lib/entitlement/bootstrap');
      const pending = ensureFreeEntitlement({ allowPinnedPlan: true });
      await held.requested;
      vi.stubEnv('O8_PLAN', nextPlan);
      held.respond();
      await pending;

      const entitlementPath = path.join(dataDir, 'entitlement.json');
      expect(existsSync(entitlementPath)).toBe(nextPlan === 'founder');
      if (nextPlan === 'founder') {
        expect(JSON.parse(readFileSync(entitlementPath, 'utf8'))).toMatchObject({
          plan: 'free', licenseKey,
        });
      }
    },
  );

  it('persists a verified free license when entitlement and configuration remain unchanged', async () => {
    const licenseKey = await signedLicense('free');
    const held = holdFreeResponse(licenseKey);
    const pending = bootstrapEntitlement();
    await held.requested;
    held.respond();

    expect(await pending).toMatchObject({ plan: 'free', source: 'file' });
    expect(JSON.parse(readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8'))).toMatchObject({
      plan: 'free', licenseKey,
    });
  });
});
