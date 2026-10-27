// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, expect, it, vi } from 'vitest';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import type { OnboardingRequest } from '@/components/desktop/onboarding/request';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-onboarding-sign-in-'));
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
let ready = false;
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  invalidateRuntimeAuthCache: vi.fn(),
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } })),
  getDispatchableRuntimeAvailability: vi.fn(async (): Promise<SetupRuntime[]> => [{
    id: 'codex', label: 'Codex', installed: true, available: ready,
    unavailableReason: ready ? null : 'needs_auth', detail: ready ? 'Ready' : 'Sign-in needed', fix: 'Run `codex login`.',
  }]),
}));
vi.mock('@/lib/setup/runtime-activity', () => ({
  readRuntimeActivity: vi.fn(async () => ({ codex: 0, claude: 0, complete: true })),
  readLocalLeadModels: vi.fn(async () => ({})),
}));

const route = await import('@/app/api/panel/operator-defaults/route');
const { Onboarding } = await import('@/components/desktop/Onboarding');
const { createOnboardingPreviewRequest, PREVIEW_PROJECT } = await import('@/app/preview/first-run/FirstRunPreview');
const { PROGRESS_KEY } = await import('@/components/desktop/onboarding/onboarding-progress');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterAll(() => {
  act(() => root?.unmount()); document.body.replaceChildren(); localStorage.clear();
  vi.unstubAllEnvs(); rmSync(dataDir, { recursive: true, force: true });
});
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name || item.getAttribute('aria-label') === name)!;
async function click(name: string) {
  await expect.poll(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return Boolean(button(name) && !button(name).disabled);
  }, { timeout: 5000 }).toBe(true);
  await act(async () => button(name).click());
}

it('checks readiness through the setup route, saves real settings, and resumes the project after remount', async () => {
  const projectFixtures = createOnboardingPreviewRequest(localStorage);
  const request: OnboardingRequest = async (input, init) => {
    const url = String(input);
    if (!url.includes('operator-defaults')) return projectFixtures(input, init);
    const req = new Request(`http://127.0.0.1${url}`, init);
    return init?.method === 'POST' ? route.POST(req) : route.GET(req);
  };
  const complete = vi.fn().mockResolvedValue(true);
  const mount = async () => {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(Onboarding, { request, onComplete: complete, storage: localStorage, allowSetupTerminal: false })));
  };
  await mount(); await click('Open Sample project'); await click('Sign in to Codex');
  expect(document.querySelector('code')?.textContent).toBe('codex login');
  expect(button('Continue to Sample project').disabled).toBe(true);
  await click('Check sign-in');
  expect(button('Continue to Sample project').disabled).toBe(true);
  ready = true; await click('Check sign-in');
  await expect.poll(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return button('Continue to Sample project')?.disabled;
  }).toBe(false);
  act(() => root!.unmount()); await mount();
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)).toMatchObject({ project: PREVIEW_PROJECT, continueProjectAfterTools: true });
  await click('Continue to Sample project');
  await expect.poll(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return Boolean(button('Save privacy choices'));
  }).toBe(true);
  const saved = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults?include=values'))).json();
  expect(saved.values).toMatchObject({ orchestratorBackend: 'codex', workerRuntimes: ['codex'] });
  expect(saved.sources.workerRuntimes).toBe('file');
  expect(readFileSync(join(dataDir, 'settings.toml'), 'utf8')).toContain('codex');
  expect(complete).not.toHaveBeenCalled();
  await click('Keep crash reports off'); await click('Turn off'); await click('Save privacy choices');
  await expect.poll(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return complete.mock.calls.length;
  }).toBe(1);
  expect(complete).toHaveBeenCalledExactlyOnceWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  const consent = await (await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults?include=values'))).json();
  expect(consent.values).toMatchObject({ telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false });
});
