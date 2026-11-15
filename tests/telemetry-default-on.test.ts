// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateOperatorDefaultsSnapshot } from '@/components/desktop/settings/operator-defaults-client';
import { PRODUCT_TELEMETRY_READY_EVENT, useAppOpenedTelemetry } from '@/lib/analytics/startup';
import { emitProductEvent } from '@/lib/analytics/server';
import { GET as getDefaults, POST as postDefaults } from '@/app/api/panel/operator-defaults/route';
import { GET as getTelemetry, POST as postTelemetry } from '@/app/api/panel/telemetry/route';
import { getOperatorDefaultsSync, resolveProductTelemetryEnabledSync } from '@/lib/operator/defaults';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, detectedAt: 0 })),
  getDispatchableRuntimeAvailability: vi.fn(async () => []),
  invalidateRuntimeAuthCache: vi.fn(),
}));
vi.mock('@/lib/entitlement/license', () => ({
  readCachedEntitlement: () => ({ licenseKey: 'fixture-license' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
let root: ReturnType<typeof createRoot> | undefined;
const egress = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
const requests: Promise<Response>[] = [];
let loseOptOutResponse = false;

function defaultsRequest(body: unknown) {
  return new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
const request = (init: RequestInit = {}) => {
  const response = init.method === 'POST'
    ? postDefaults(defaultsRequest(JSON.parse(String(init.body))))
    : getDefaults(new Request('http://localhost/api/panel/operator-defaults?include=values'));
  requests.push(response);
  return response;
};
// The first-run privacy card and the Settings switch were browser console UI.
// These helpers send the same requests they sent, through the real routes, and
// mount the kept startup hook that emits app.opened.
function Startup() { useAppOpenedTelemetry(); return null; }
async function mountStartup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Startup)));
  await act(async () => { await Promise.all(requests); });
}
async function saveDefaults(body: Record<string, unknown>) {
  return fetch('/api/panel/operator-defaults', { method: 'POST', body: JSON.stringify(body) });
}
async function setUsage(next: boolean) {
  return saveDefaults({ productTelemetryEnabled: next });
}
async function savePrivacyChoices() {
  const productUsage = getOperatorDefaultsSync().values.productTelemetryEnabled;
  const response = await saveDefaults({ crashReportsEnabled: false, productTelemetryEnabled: productUsage, telemetryConsentAnswered: true });
  expect(response.status).toBe(200);
  await act(async () => {
    window.dispatchEvent(new Event(PRODUCT_TELEMETRY_READY_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function coldEgressCapture() {
  writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'fixture-license' }));
  const output = execFileSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval',
    [
      'const payloads = [];',
      'globalThis.fetch = async (_url, init) => { payloads.push(JSON.parse(init.body)); return Response.json({ ok: true }); };',
      "const imported = await import('./src/lib/analytics/server.ts');",
      'const telemetry = imported.default ?? imported;',
      'const enabled = telemetry.isProductTelemetryEnabled();',
      "const emitted = await telemetry.emitProductEvent('app.opened');",
      'process.stdout.write(JSON.stringify({ enabled, emitted, payloads }));',
    ].join(' '),
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir },
  });
  return JSON.parse(output);
}

beforeEach(() => {
  for (const file of ['settings.toml', 'operator-defaults.json']) rmSync(join(dataDir, file), { force: true });
  egress.mockClear();
  requests.length = 0;
  loseOptOutResponse = false;
  invalidateOperatorDefaultsSnapshot();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/panel/operator-defaults')) {
      const response = await request(init);
      if (loseOptOutResponse && init?.body === JSON.stringify({ productTelemetryEnabled: false })) {
        return Response.json({ error: 'Save response unavailable.' }, { status: 503 });
      }
      return response;
    }
    if (url === '/api/panel/telemetry') return init?.method === 'POST'
      ? postTelemetry(new Request('http://localhost/api/panel/telemetry', init)) : getTelemetry();
    return egress(input, init);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('default-on usage analytics through persisted routes and the startup hook', () => {
  it('keeps never-chosen state through unrelated saves and all three API values', async () => {
    expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBeNull();
    expect(resolveProductTelemetryEnabledSync()).toBe(true);
    expect(await (await getTelemetry()).json()).toEqual({ enabled: false });
    expect((await request({ method: 'POST', body: JSON.stringify({ parallelCap: 3 }) })).status).toBe(200);
    expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBeNull();
    expect(readFileSync(join(dataDir, 'settings.toml'), 'utf8')).toContain('product_enabled = ""');
    for (const choice of [false, true, null]) {
      const response = await request({ method: 'POST', body: JSON.stringify({ productTelemetryEnabled: choice }) });
      expect(response.status).toBe(200);
      expect((await response.json()).values.productTelemetryEnabled).toBe(choice);
      expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBe(choice);
      expect(JSON.parse(readFileSync(join(dataDir, 'operator-defaults.json'), 'utf8')).productTelemetryEnabled).toBe(choice);
    }
  });

  it.each([false, true])('preserves a legacy explicit off after upgrade (answered: %s)', async (answered) => {
    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({
      productTelemetryEnabled: false, telemetryConsentAnswered: answered,
    }));
    await request({ method: 'POST', body: JSON.stringify({ parallelCap: 3 }) });
    expect(resolveProductTelemetryEnabledSync()).toBe(false);
    const result = await postTelemetry(new Request('http://localhost/api/panel/telemetry', {
      method: 'POST', body: JSON.stringify({ event: 'app.opened' }),
    }));
    expect(await result.json()).toEqual({ ok: true, emitted: false });
    expect(egress).not.toHaveBeenCalled();
  });

  it('persists a first-run opt-out before acknowledgment', async () => {
    await mountStartup();
    expect((await setUsage(false)).status).toBe(200);
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: false, crashReportsEnabled: false });
    expect(egress).not.toHaveBeenCalled();
    await savePrivacyChoices();
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: true, crashReportsEnabled: false });
    expect(egress).not.toHaveBeenCalled();
  });

  it('emits app.opened once after a fresh install saves its privacy choices', async () => {
    await mountStartup();
    expect(egress).not.toHaveBeenCalled();
    expect(await emitProductEvent('repo.added', { hasRemote: true, isGitRepo: true })).toBe(false);
    await savePrivacyChoices();
    await vi.waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(egress.mock.calls[0]?.[1]?.body))).toEqual({ event: 'app.opened' });
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: null, telemetryConsentAnswered: true, crashReportsEnabled: false });
    window.dispatchEvent(new Event(PRODUCT_TELEMETRY_READY_EVENT));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(egress).toHaveBeenCalledTimes(1);
  });

  it('stages off-then-on until the unanswered privacy choices are saved, including a reopened startup hook', async () => {
    await mountStartup();
    await setUsage(false);
    await setUsage(true);
    expect(getOperatorDefaultsSync().values).toMatchObject({
      productTelemetryEnabled: true, telemetryConsentAnswered: false, crashReportsEnabled: false,
    });
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    invalidateOperatorDefaultsSnapshot();
    egress.mockClear();
    await mountStartup();
    expect(egress.mock.calls.length).toBe(0);
    expect(await (await getTelemetry()).json()).toEqual({ enabled: false });
    expect(await emitProductEvent('app.opened')).toBe(false);
    expect(egress.mock.calls.length).toBe(0);
    await savePrivacyChoices();
    await vi.waitFor(() => expect(egress.mock.calls.length).toBe(1));
    expect(JSON.parse(String(egress.mock.calls[0]?.[1]?.body))).toEqual({ event: 'app.opened' });
    expect(getOperatorDefaultsSync().values).toMatchObject({
      productTelemetryEnabled: true, telemetryConsentAnswered: true, crashReportsEnabled: false,
    });
  });

  it('keeps off-then-on staged across a cold process until the privacy choices are saved', async () => {
    await setUsage(false);
    await setUsage(true);
    expect(coldEgressCapture()).toEqual({ enabled: false, emitted: false, payloads: [] });
    await savePrivacyChoices();
    expect(coldEgressCapture()).toEqual({ enabled: true, emitted: true, payloads: [{ event: 'app.opened' }] });
    expect(getOperatorDefaultsSync().values.crashReportsEnabled).toBe(false);
  });

  it('keeps a requested opt-out when its successful disk write loses the response', async () => {
    loseOptOutResponse = true;
    expect((await setUsage(false)).status).toBe(503);
    expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBe(false);
    await savePrivacyChoices();
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: true });
    expect(egress).not.toHaveBeenCalled();
  });

  it('applies the effective default at startup and flips persisted egress immediately', async () => {
    await request({ method: 'POST', body: JSON.stringify({ productTelemetryEnabled: null, crashReportsEnabled: false, telemetryConsentAnswered: true }) });
    await mountStartup();
    await vi.waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    egress.mockClear();
    expect((await setUsage(false)).status).toBe(200);
    expect(await emitProductEvent('app.opened')).toBe(false);
    expect(egress).not.toHaveBeenCalled();
    expect((await setUsage(true)).status).toBe(200);
    expect(await emitProductEvent('app.opened')).toBe(true);
    expect(egress).toHaveBeenCalledTimes(1);
    expect(getOperatorDefaultsSync().values.crashReportsEnabled).toBe(false);
  });
});
