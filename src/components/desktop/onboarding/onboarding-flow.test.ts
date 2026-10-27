// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { createOnboardingPreviewRequest, PREVIEW_PROJECT } from '@/app/preview/first-run/FirstRunPreview';
import { PROGRESS_KEY, emptyProgress } from './onboarding-progress';
import { recommendRuntimeSetup } from '@/lib/setup/runtime-recommendation';
import type { OnboardingRequest } from './request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear(); });
const button = (label: string) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent === label || item.getAttribute('aria-label') === label)!;
const click = async (label: string) => { expect(button(label), label).toBeDefined(); await act(async () => button(label).click()); };
async function render(request: OnboardingRequest = createOnboardingPreviewRequest(), complete = vi.fn().mockResolvedValue(true), pickFolder?: () => Promise<string | null>) {
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(createElement(Onboarding, { request, onComplete: complete, storage: localStorage, pickFolder })));
  return { container, complete };
}

it('shows project, agent, and workspace progress without changing settings', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const { container } = await render(request);
  expect(container.textContent).toContain('Open a project');
  expect(container.textContent).toContain('Codex is ready');
  expect(button('Open Sample project')).toBeDefined();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('nav[aria-label="Setup progress"] [aria-current="step"]')?.textContent).toContain('Project');
  expect(container.querySelector('nav[aria-label="Setup progress"]')?.textContent).toContain('Workspace');
  expect(container.textContent).not.toContain('Workers:');
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('shows projects while agent discovery is still pending and never reports them ready early', async () => {
  const fixture = createOnboardingPreviewRequest();
  let finishScan!: (response: Response) => void;
  const scan = new Promise<Response>((resolve) => { finishScan = resolve; });
  const request: OnboardingRequest = (url, init) => new URL(String(url), 'http://127.0.0.1').searchParams.get('include') === 'setup' ? scan : fixture(url, init);
  const { container } = await render(request);
  expect(button('Open Sample project')).toBeDefined();
  expect(container.textContent).toContain('Checking your coding tools');
  expect(container.textContent).not.toContain('Codex is ready');
  await act(async () => finishScan(await fixture('/api/panel/operator-defaults?include=setup')));
  expect(container.textContent).toContain('Codex is ready');
});

it('shows the built-in agent on the project screen before external tool discovery finishes', async () => {
  const fixture = createOnboardingPreviewRequest(null, 'built-in-free');
  let finishScan!: (response: Response) => void;
  const scan = new Promise<Response>((resolve) => { finishScan = resolve; });
  const request: OnboardingRequest = (url, init) => new URL(String(url), 'http://127.0.0.1').searchParams.get('include') === 'setup' ? scan : fixture(url, init);
  const { container } = await render(request);
  expect(button('Open Sample project')).toBeDefined();
  expect(container.querySelector('[aria-label="Agent readiness"]')?.textContent).toContain('Built-in agent (Pi)');
  expect(container.querySelector('[aria-label="Agent readiness"]')?.textContent).toContain('Ready');
  await act(async () => finishScan(await fixture('/api/panel/operator-defaults?include=setup')));
  expect(container.textContent).toContain('Built-in agent (Pi) is ready');
});

it('wraps keyboard focus inside setup instead of entering the obscured workspace', async () => {
  await render();
  const overlay = document.querySelector<HTMLElement>('[data-o8-onboarding]')!;
  const first = overlay.querySelector<HTMLElement>('[tabindex="0"]')!;
  const last = button('Privacy');
  const tab = (shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  first.focus();
  expect(tab(true)).toBe(true);
  expect(document.activeElement).toBe(last);
  expect(tab()).toBe(true);
  expect(document.activeElement).toBe(first);
  button('Open a folder').focus();
  expect(tab()).toBe(false);
  expect(overlay.getAttribute('aria-modal')).toBe('true');
});

it('recovers focus taken by the workspace after startup while allowing another dialog', async () => {
  const workspace = document.createElement('button');
  document.body.appendChild(workspace);
  await render();
  workspace.focus();
  expect(document.activeElement?.closest('[data-o8-onboarding]')).not.toBeNull();
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const dialogButton = document.createElement('button');
  dialog.appendChild(dialogButton);
  document.body.appendChild(dialog);
  dialogButton.focus();
  expect(document.activeElement).toBe(dialogButton);
});

it('uses an opaque overlay and visible button ink even when workspace glass is transparent', async () => {
  const { container } = await render();
  expect(container.querySelector<HTMLElement>('[data-o8-onboarding]')?.style.background).toBe('var(--t-onboarding-surface-bg, var(--t-onboarding-bg))');
  expect(button('Open a folder').style.color).toBe('var(--t-onboarding-bg)');
  const { PALETTES } = await import('@/lib/theme/registry');
  for (const palette of PALETTES) {
    expect(palette.baseTokens['--t-onboarding-bg']).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

it('opens the chosen project after explicit privacy choices, without a tour or task draft', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(button('Save privacy choices').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
  await click('Keep crash reports off');
  expect(button('Save privacy choices').disabled).toBe(false);
  await click('Turn off');
  await click('Save privacy choices');
  expect(complete).toHaveBeenCalledWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toContainEqual({ crashReportsEnabled: false, productTelemetryEnabled: false, telemetryConsentAnswered: true });
});

it('saves a ready projectless recommendation before privacy and completes after consent', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const { complete } = await render(request);

  await click('Start without a project');
  expect(complete).not.toHaveBeenCalled();
  expect(button('Save privacy choices')).toBeDefined();

  const routingWritesBeforePrivacy = request.mock.calls.filter(([, init]) => {
    if (init?.method !== 'POST') return false;
    return JSON.parse(String(init.body)).orchestratorBackend !== undefined;
  });
  expect(routingWritesBeforePrivacy).toHaveLength(1);
  expect(JSON.parse(String(routingWritesBeforePrivacy[0]?.[1]?.body))).toMatchObject({
    orchestratorBackend: 'codex',
    defaultDispatchRuntime: 'codex',
    workerRuntimes: ['codex'],
  });

  await click('Keep crash reports off');
  await click('Turn off');
  await click('Save privacy choices');

  expect(complete).toHaveBeenCalledWith(undefined);
  expect(request.mock.calls.filter(([, init]) => {
    if (init?.method !== 'POST') return false;
    return JSON.parse(String(init.body)).orchestratorBackend !== undefined;
  })).toHaveLength(1);
});

it('preserves explicit projectless routing without writing it again', async () => {
  const fixture = createOnboardingPreviewRequest(localStorage);
  await fixture('/api/panel/operator-defaults', { method: 'POST', body: JSON.stringify({
    orchestratorBackend: 'claude', workerRuntimes: ['claude-code'], defaultDispatchRuntime: 'claude-code',
    telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false,
  }) });
  const request = vi.fn(fixture);
  const { complete } = await render(request);

  await click('Start without a project');

  expect(complete).toHaveBeenCalledWith(undefined);
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('allows projectless exploration without a ready tool', async () => {
  const request = vi.fn(createOnboardingPreviewRequest(null, 'none'));
  const { complete } = await render(request);

  await click('Start without a project');
  expect(button('Save privacy choices')).toBeDefined();
  await click('Keep crash reports off');
  await click('Turn off');
  await click('Save privacy choices');

  expect(complete).toHaveBeenCalledWith(undefined);
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { productTelemetryEnabled: false },
    { crashReportsEnabled: false, productTelemetryEnabled: false, telemetryConsentAnswered: true },
  ]);
});

it('does not continue projectless setup when saving the recommendation fails', async () => {
  const fixture = createOnboardingPreviewRequest();
  let fail = true;
  const request = vi.fn<OnboardingRequest>(async (url, init) => {
    if (String(url).includes('operator-defaults') && init?.method === 'POST'
      && JSON.parse(String(init.body)).orchestratorBackend !== undefined && fail) {
      return Response.json({ error: 'Could not save setup' }, { status: 503 });
    }
    return fixture(url, init);
  });
  const { complete } = await render(request);

  await click('Start without a project');
  expect(document.body.textContent).toContain('Could not save setup');
  expect(document.body.textContent).not.toContain('Choose what to share');
  expect(complete).not.toHaveBeenCalled();

  fail = false;
  await click('Start without a project');
  expect(button('Save privacy choices')).toBeDefined();
  expect(complete).not.toHaveBeenCalled();
});

it('resumes privacy with the selected project and retries a failed workspace handoff', async () => {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress('privacy'), project: PREVIEW_PROJECT }));
  const complete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const request = vi.fn(createOnboardingPreviewRequest());
  await render(request, complete);
  await click('Keep crash reports off');
  await click('Save privacy choices');
  expect(document.body.textContent).toContain('Could not open the workspace');
  expect(document.body.textContent).toContain('Privacy choices saved');
  expect(document.body.textContent).toContain('Setting up Sample project');
  expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
  await click('Continue');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).telemetryConsentAnswered === true)).toHaveLength(1);
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('confirms tool choices only after a successful save and keeps failures retryable', async () => {
  const fixture = createOnboardingPreviewRequest(localStorage);
  let fail = true;
  const request: OnboardingRequest = async (url, init) => {
    if (String(url).includes('operator-defaults') && init?.method === 'POST' && fail) return Response.json({ error: 'Could not save setup' }, { status: 503 });
    return fixture(url, init);
  };
  await render(request);
  await click('Change');
  await click('Use this setup');
  expect(document.body.textContent).toContain('Could not save setup');
  expect(document.body.textContent).not.toContain('Setup saved');
  fail = false;
  await click('Use this setup');
  expect(document.body.textContent).toContain('Setup saved');
  expect(document.body.textContent).toContain('Open a project.');
  expect(JSON.parse(localStorage.getItem('settings')!)).toHaveProperty('orchestratorBackend', 'codex');
});

it('routes a project to tool setup when no runtime is usable', async () => {
  const fixture = createOnboardingPreviewRequest();
  const request: OnboardingRequest = async (url, init) => String(url).includes('operator-defaults')
    ? Response.json({ values: {}, sources: {}, dispatchableRuntimes: [], setupRecommendation: recommendRuntimeSetup({ inventory: [], activity: { codex: 0, claude: 0, complete: true } }) })
    : fixture(url, init);
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(document.body.textContent).toContain('Connect a coding tool');
  expect(button('Continue to Sample project').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
});

it('revalidates a project before handing it to the workspace', async () => {
  const fixture = createOnboardingPreviewRequest();
  let repoReads = 0;
  const request: OnboardingRequest = async (url, init) => String(url) === '/api/panel/repos' && ++repoReads > 1
    ? Response.json({ repos: [] }) : fixture(url, init);
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(document.body.textContent).toContain('no longer available');
  expect(complete).not.toHaveBeenCalled();
});

it('hydrates legacy progress into the project entry without a markup mismatch', async () => {
  const { renderToString } = await import('react-dom/server');
  const { hydrateRoot } = await import('react-dom/client');
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress(), step: 'ready', project: PREVIEW_PROJECT }));
  const props = { request: createOnboardingPreviewRequest(), onComplete: vi.fn(), storage: localStorage };
  const container = document.createElement('div'); document.body.appendChild(container);
  container.innerHTML = renderToString(createElement(Onboarding, props));
  const onRecoverableError = vi.fn();
  await act(async () => { root = hydrateRoot(container, createElement(Onboarding, props), { onRecoverableError }); });
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Open a project');
  expect(container.textContent).not.toContain('Your first task');
});

it('keeps saved routing and consent, and prevents duplicate workspace openings', async () => {
  const fixture = createOnboardingPreviewRequest(localStorage);
  await fixture('/api/panel/operator-defaults', { method: 'POST', body: JSON.stringify({
    orchestratorBackend: 'claude', workerRuntimes: ['claude-code'], defaultDispatchRuntime: 'claude-code',
    telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false,
  }) });
  const request = vi.fn(fixture);
  let finish!: (value: boolean) => void;
  const complete = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await render(request, complete);
  expect(document.body.textContent).toContain('Claude Code is ready · Saved setup');
  await click('Open Sample project');
  expect(button('Open Sample project').disabled).toBe(true);
  await click('Open Sample project');
  expect(complete).toHaveBeenCalledOnce();
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await act(async () => finish(true));
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('returns from optional tool settings without starting work', async () => {
  const { complete } = await render();
  const content = document.querySelector<HTMLElement>('[aria-label="Setup content"]');
  expect(content).not.toBeNull();
  content!.scrollTop = 240;
  await click('Change');
  expect(document.body.textContent).toContain('Choose your agent');
  expect(content!.scrollTop).toBe(0);
  expect(document.activeElement?.tagName).toBe('H1');
  await click('Use this setup');
  expect(document.body.textContent).toContain('Open a project');
  expect(document.body.textContent).toContain('Codex is ready · Saved setup');
  expect(complete).not.toHaveBeenCalled();
});


it('lets folder selection cancel, then registers and opens the chosen project', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const pickFolder = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(PREVIEW_PROJECT.localPath);
  const complete = vi.fn().mockResolvedValue(true);
  await render(request, complete, pickFolder);
  await click('Open a folder');
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(document.body.textContent).toContain('Open a project');
  await click('Open a folder');
  const registration = request.mock.calls.find(([url, init]) => String(url) === '/api/panel/repos' && init?.method === 'POST');
  expect(JSON.parse(String(registration?.[1]?.body))).toEqual({ action: 'add', localPath: PREVIEW_PROJECT.localPath });
  expect(button('Save privacy choices').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
});

function agentFixture() {
  const base = createOnboardingPreviewRequest(localStorage);
  const state = { id: 'setup-request', project: PREVIEW_PROJECT, status: 'pending', claimId: 'test-claim' };
  const writes: string[] = [];
  let beforeClaim: (() => Promise<void>) | undefined;
  const request: OnboardingRequest = async (url, init) => {
    if (!String(url).startsWith('/api/setup/agent')) return base(url, init);
    if (init?.method !== 'POST') return Response.json({ request: state });
    const body = JSON.parse(String(init.body));
    if (body.action === 'claim') {
      await beforeClaim?.();
      if (state.status === 'cancelled' || state.status === 'applying') return Response.json({}, { status: 400 });
      state.status = 'applying';
    } else if (body.action === 'ack') state.status = body.status;
    if (body.action !== 'renew') writes.push(state.status);
    return Response.json({ request: state });
  };
  return { request, state, writes, holdClaim: (fn: () => Promise<void>) => { beforeClaim = fn; } };
}

it('accepts an agent-selected folder without a picker, hands privacy to the user, then confirms the workspace', async () => {
  const fixture = agentFixture();
  const picker = vi.fn();
  const { complete } = await render(fixture.request, vi.fn().mockResolvedValue(true), picker);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(fixture.state.status).toBe('needs_privacy');
  expect(picker).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  await click('Keep crash reports off'); await click('Turn off'); await click('Save privacy choices');
  expect(complete).toHaveBeenCalledWith({ project: PREVIEW_PROJECT, text: '' });
  expect(fixture.state.status).toBe('opened');
});

it('holds the UI lock during an agent claim so a manual click cannot strand it', async () => {
  const fixture = agentFixture();
  let release!: () => void;
  fixture.holdClaim(() => new Promise<void>((resolve) => { release = resolve; }));
  const { complete } = await render(fixture.request);
  expect(button('Open Sample project').disabled).toBe(true);
  await click('Open Sample project');
  await act(async () => release());
  expect(fixture.state.status).toBe('needs_privacy');
  expect(fixture.writes).toEqual(['applying', 'needs_privacy']);
  expect(complete).not.toHaveBeenCalled();
});

it('recovers a persisted handoff after remount and clears a cancelled agent receipt before a human open', async () => {
  const fixture = agentFixture();
  await render(fixture.request);
  expect(fixture.state.status).toBe('needs_privacy');
  act(() => root.unmount());
  const { complete } = await render(fixture.request);
  await click('Keep crash reports off'); await click('Turn off'); await click('Save privacy choices');
  expect(fixture.state.status).toBe('opened');
  expect(complete).toHaveBeenCalledOnce();
  act(() => root.unmount());
  fixture.state.status = 'cancelled';
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress('privacy'), project: PREVIEW_PROJECT }));
  const next = await render(fixture.request);
  await click('Save privacy choices');
  expect(next.complete).toHaveBeenCalledOnce();
  expect(fixture.state.status).toBe('cancelled');
  expect(document.body.textContent).not.toContain('could not be confirmed');
});


it('returns keyboard focus to the setup action that opened a page', async () => {
  await render();
  await click('Change');
  await click('← Projects');
  expect(document.activeElement).toBe(button('Change'));
  await click('Clone from GitHub');
  await click('Choose later');
  expect(document.activeElement).toBe(button('Clone from GitHub'));
});
