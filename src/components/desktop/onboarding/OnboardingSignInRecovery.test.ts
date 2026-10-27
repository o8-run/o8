// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { createOnboardingPreviewRequest, PREVIEW_PROJECT } from '@/app/preview/first-run/FirstRunPreview';
import { recommendRuntimeSetup, type SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { PROGRESS_KEY } from './onboarding-progress';
import type { OnboardingRequest } from './request';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const originalClipboard = navigator.clipboard;
afterEach(() => {
  act(() => root?.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
async function click(label: string) { expect(button(label), label).toBeDefined(); await act(async () => button(label)!.click()); }

function fixture() {
  const base = createOnboardingPreviewRequest(localStorage);
  let signedIn = false;
  let failRefresh = false;
  const inventory = (): SetupRuntime[] => [
    { id: 'codex', label: 'Codex', installed: true, available: signedIn, unavailableReason: signedIn ? null : 'needs_auth', detail: signedIn ? 'Ready' : 'Installed, sign-in needed', fix: 'Run `codex login`.' },
    { id: 'claude-code', label: 'Claude Code', available: false, unavailableReason: 'not_installed', detail: 'Missing', fix: 'Install Claude Code.' },
  ];
  const request = vi.fn<OnboardingRequest>(async (input, init) => {
    const url = String(input);
    if (!url.includes('operator-defaults') || init?.method === 'POST' || !url.includes('include=setup')) return base(input, init);
    if (url.includes('include=setup-built-in')) return Response.json({ builtInAgent: null });
    if (url.includes('refresh=runtime') && failRefresh) return Response.json({ error: 'Could not check sign-in. Try again.' }, { status: 503 });
    const current = inventory();
    const values = JSON.parse(localStorage.getItem('settings') ?? '{}');
    const sources = Object.fromEntries(Object.keys(values).map((key) => [key, 'file']));
    return Response.json({ values, sources, dispatchableRuntimes: current, setupRecommendation: recommendRuntimeSetup({ inventory: current, values, sources, activity: { codex: 0, claude: 0, complete: true } }) });
  });
  return { request, signIn: () => { signedIn = true; }, fail: (value: boolean) => { failRefresh = value; } };
}
async function render(request: OnboardingRequest, complete = vi.fn().mockResolvedValue(true)) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Onboarding, { request, onComplete: complete, storage: localStorage })));
  return { complete };
}

it('opens an installed tool sign-in action from project setup without running a command or changing saved choices', async () => {
  const state = fixture();
  const { complete } = await render(state.request);
  await click('Open Sample project');
  await click('Sign in to Codex');
  expect(document.querySelector('h1')?.textContent).toBe('Sign in to Codex');
  expect(document.activeElement).toBe(document.querySelector('h1'));
  expect(document.querySelector('code')?.textContent).toBe('codex login');
  expect(button('Copy Codex sign-in command')).toBeDefined();
  expect(button('Check sign-in')).toBeDefined();
  expect(state.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(complete).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!)).toMatchObject({ project: PREVIEW_PROJECT, step: 'dispatch' });
  await click('Back to tools');
  expect(document.activeElement).toBe(button('Sign in to Codex'));
});

it('preserves the command and project through clipboard and scan failures, and enables continuation only after a ready scan', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Blocked')).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const state = fixture();
  await render(state.request);
  await click('Open Sample project'); await click('Sign in to Codex');
  await click('Copy Codex sign-in command');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Clipboard');
  expect(document.querySelector('code')?.textContent).toBe('codex login');
  await click('Copy Codex sign-in command');
  expect(writeText).toHaveBeenLastCalledWith('codex login');
  state.fail(true);
  await click('Check sign-in');
  expect(document.body.textContent).toContain('Could not check');
  expect(document.querySelector('code')?.textContent).toBe('codex login');
  expect(button('Continue to Sample project')?.disabled).toBe(true);
  state.fail(false);
  await click('Check sign-in');
  expect(button('Continue to Sample project')?.disabled).toBe(true);
  state.signIn(); await click('Check sign-in');
  expect(document.body.textContent).toContain('Codex is ready');
  expect(button('Continue to Sample project')?.disabled).toBe(false);
  await click('Back to tools');
  expect(document.activeElement).toBe(button('Back to agent choices'));
  await click('Continue to Sample project');
  expect(button('Save privacy choices')).toBeDefined();
  expect(JSON.parse(localStorage.getItem('settings')!)).toMatchObject({ orchestratorBackend: 'codex', workerRuntimes: ['codex'] });
});

it('keeps the pending workspace after a failed handoff so retry opens the same project', async () => {
  const state = fixture();
  const complete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await render(state.request, complete);
  await click('Open Sample project'); state.signIn();
  await click('Refresh tools'); await click('Continue to Sample project');
  await click('Keep crash reports off'); await click('Turn off'); await click('Save privacy choices');
  expect(complete).toHaveBeenCalledExactlyOnceWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
  await click('Continue');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenLastCalledWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('resumes the selected project after restarting during tool recovery', async () => {
  const state = fixture();
  const { complete } = await render(state.request);
  await click('Open Sample project');
  act(() => root.unmount());
  state.signIn(); await render(state.request, complete);
  await click('Continue to Sample project');
  expect(button('Save privacy choices')).toBeDefined();
  await click('Keep crash reports off'); await click('Turn off'); await click('Save privacy choices');
  expect(complete).toHaveBeenCalledExactlyOnceWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('keeps an explicit unavailable agent selected when another tool becomes ready', async () => {
  localStorage.setItem('settings', JSON.stringify({ orchestratorBackend: 'claude', defaultDispatchRuntime: 'claude-code', workerRuntimes: ['claude-code'] }));
  const state = fixture();
  await render(state.request);
  await click('Open Sample project');
  await click('Add coding tools'); await click('Sign in to Codex');
  state.signIn(); await click('Check sign-in');
  expect(button('Continue to Sample project')?.disabled).toBe(true);
  expect(JSON.parse(localStorage.getItem('settings')!)).toMatchObject({ orchestratorBackend: 'claude', workerRuntimes: ['claude-code'] });
});


it('keeps project opening separate from an explicit tool-settings visit after restart', async () => {
  const state = fixture(); state.signIn();
  const { complete } = await render(state.request);
  await click('Open Sample project');
  await click('← Projects');
  await click('Change');
  act(() => root.unmount());
  await render(state.request, complete);
  expect(button('Continue to Sample project')).toBeUndefined();
  await click('Use this setup');
  expect(document.body.textContent).toContain('Setup saved');
  expect(complete).not.toHaveBeenCalled();
});
