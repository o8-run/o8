// @vitest-environment jsdom
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelemetryConsentCard } from '@/components/desktop/TelemetryConsentCard';
import { GeneralTab } from '@/components/desktop/settings/GeneralTab';
import { fetchOperatorDefaults, invalidateOperatorDefaultsSnapshot } from '@/components/desktop/settings/operator-defaults-client';
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
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ plan: 'free' }) }));

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
const button = (label: string) => Array.from(document.querySelectorAll('button'))
  .find((item) => item.textContent?.trim() === label)!;
async function click(label: string) {
  expect(button(label), label).toBeDefined();
  await act(async () => { button(label).click(); await Promise.all(requests); });
}
const usageSwitch = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
  .find((item) => item.parentElement?.textContent?.includes('Share usage data'));
function Startup() { useAppOpenedTelemetry(); return null; }
async function render(settings = false) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement('div', null,
    createElement(Startup),
    settings ? createElement(GeneralTab) : createElement(TelemetryConsentCard),
  )));
  await act(async () => { await Promise.all(requests); });
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(settings ? usageSwitch() : document.querySelector('[role="dialog"]')).toBeTruthy();
  });
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

describe('default-on usage analytics through persisted routes and first-run UI', () => {
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

  it('discloses every event and example visibly, and persists one-click off before acknowledgment', async () => {
    await render();
    expect(document.body.textContent).toContain('on by default');
    expect(document.querySelectorAll('button')).not.toHaveLength(0);
    expect(Array.from(document.querySelectorAll('button')).filter((item) => item.textContent?.trim() === 'Turn off')).toHaveLength(1);
    const example = Array.from(document.querySelectorAll('pre')).find((item) => item.textContent?.includes('repo.added'))!;
    expect(example.closest('details:not([open])')).toBeNull();
    expect(JSON.parse(example.textContent!)).toEqual({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } });
    for (const event of ['app.opened', 'brain.asked', 'orchestrator.message', 'dispatch.started', 'merge.approved', 'repo.added']) {
      expect(document.body.textContent).toContain(event);
    }
    for (const never of ['Code', 'prompts', 'repo names', 'file paths', 'file contents']) expect(document.body.textContent).toContain(never);
    await click('Turn off');
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: false, crashReportsEnabled: false });
    expect(egress).not.toHaveBeenCalled();
    await click('Keep crash reports off');
    await click('Save privacy choices');
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: true, crashReportsEnabled: false });
    expect(egress).not.toHaveBeenCalled();
  });

  it('refreshes cached defaults before showing an earlier opt-out on the first-run screen', async () => {
    await fetchOperatorDefaults({}, { includeRuntime: false });
    await request({ method: 'POST', body: JSON.stringify({ productTelemetryEnabled: false }) });
    await render();
    expect(button('Turn off')).toBeUndefined();
    expect(document.body.textContent).toContain('Usage analytics are off.');
    await click('Keep crash reports off');
    await click('Save privacy choices');
    expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBe(false);
    expect(egress).not.toHaveBeenCalled();
  });

  it('emits app.opened once after a fresh install finishes the privacy screen', async () => {
    await render();
    expect(egress).not.toHaveBeenCalled();
    expect(await emitProductEvent('repo.added', { hasRemote: true, isGitRepo: true })).toBe(false);
    await click('Keep crash reports off');
    await click('Save privacy choices');
    await vi.waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(egress.mock.calls[0]?.[1]?.body))).toEqual({ event: 'app.opened' });
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: null, telemetryConsentAnswered: true, crashReportsEnabled: false });
    window.dispatchEvent(new Event(PRODUCT_TELEMETRY_READY_EVENT));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(egress).toHaveBeenCalledTimes(1);
  });

  it('keeps a requested opt-out when its successful disk write loses the response', async () => {
    await render();
    loseOptOutResponse = true;
    await click('Turn off');
    expect(document.body.textContent).toContain('Save response unavailable.');
    expect(getOperatorDefaultsSync().values.productTelemetryEnabled).toBe(false);
    await click('Keep crash reports off');
    await click('Save privacy choices');
    expect(getOperatorDefaultsSync().values).toMatchObject({ productTelemetryEnabled: false, telemetryConsentAnswered: true });
    expect(egress).not.toHaveBeenCalled();
  });

  it('shows the effective default in Settings and flips persisted egress immediately', async () => {
    await request({ method: 'POST', body: JSON.stringify({ productTelemetryEnabled: null, crashReportsEnabled: false, telemetryConsentAnswered: true }) });
    await render(true);
    const toggle = () => usageSwitch()!;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await vi.waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    egress.mockClear();
    await act(async () => { toggle().click(); await Promise.all(requests); });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(toggle().getAttribute('aria-checked')).toBe('false');
    });
    expect(await emitProductEvent('app.opened')).toBe(false);
    expect(egress).not.toHaveBeenCalled();
    await act(async () => { toggle().click(); await Promise.all(requests); });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(toggle().getAttribute('aria-checked')).toBe('true');
    });
    expect(await emitProductEvent('app.opened')).toBe(true);
    expect(egress).toHaveBeenCalledTimes(1);
    expect(getOperatorDefaultsSync().values.crashReportsEnabled).toBe(false);
  });
});
