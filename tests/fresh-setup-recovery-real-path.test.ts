// @vitest-environment jsdom
import { act, createElement, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSetupWizard } from '@/app/dashboard/hooks/useSetupWizard';
import { Onboarding } from '@/components/desktop/Onboarding';
import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import { resolveFreshComposerTurnOptions } from '@/components/desktop/thoughts/useBackendSwitchChoice';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK, type OrchestratorBackendSetting } from '@/components/desktop/thoughts/operator-defaults';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import { MODEL_IDS } from '@/lib/models';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => undefined }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));

let root: Root;
let host: HTMLDivElement;
let check: () => Promise<Response>;
const fetchMock = vi.fn<typeof fetch>();

function Setup() {
  const setup = useSetupWizard();
  return setup.setupWizardOpen ? createElement(Onboarding, {
    onComplete: () => setup.handleSetupComplete(),
    completionError: setup.setupCompleteError ?? setup.setupCheckError,
  }) : createElement('output', { 'data-setup-check-complete': setup.setupCheckComplete }, 'Workspace');
}
function FirstChat() {
  const [model, setModel] = useState(MODEL_IDS.orchestratorDefault as string);
  const [backend, setBackend] = useState<OrchestratorBackendSetting>('codex');
  const [, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const stream = useOrchestratorStream('~', { threadId: 'thoughts-first-setup-chat' });
  useEffect(() => {
    const send = () => stream.send('First chat', {
      backend: 'codex', model, thinkingEffort: 'max',
      resolveTurnOptions: signal => resolveFreshComposerTurnOptions({
        repoPath: '~', backend, backendSourceRef, setBackend, setModel, setOperatorDefaults,
      }, signal),
    });
    window.addEventListener('o8:test-first-chat-send', send);
    return () => window.removeEventListener('o8:test-first-chat-send', send);
  }, [backend, model, stream]);
  return createElement('button', { onClick: () => window.dispatchEvent(new Event('o8:test-first-chat-send')) }, 'Send first chat');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  localStorage.clear();
  invalidateOperatorDefaultsValuesSnapshot();
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  check = async () => Response.json({ setupComplete: false });
  fetchMock.mockReset().mockImplementation(async (url) => {
    const target = String(url);
    if (target === '/api/setup/config') return check();
    if (target.startsWith('/api/panel/operator-defaults')) return Response.json({
      values: { orchestratorBackend: 'codex', orchestratorModel: MODEL_IDS.orchestratorDefault,
        inAppOrchestratorEnabled: false, thinkingEffort: 'max', telemetryConsentAnswered: true },
      sources: {}, dispatchableRuntimes: [{ id: 'codex', label: 'Coding runtime', available: true,
        unavailableReason: null, detail: '', fix: '' }], builtInAgent: null,
    });
    if (target.startsWith('/api/panel/repos')) return Response.json({ repos: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); localStorage.clear();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  transport.socket = null;
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => { root.render(createElement(StrictMode, null, createElement(Setup))); await vi.advanceTimersByTimeAsync(1); });
}
function expectVisibleRecovery() {
  expect(document.querySelector('[data-o8-onboarding]')).not.toBeNull();
  expect(document.body.textContent).toContain('Could not check setup');
  expect(document.body.textContent).toContain('Open a project');
}

it.each(['non-OK', 'failed', 'aborted'])('keeps fresh setup visible after a %s initial check', async mode => {
  check = async () => {
    if (mode === 'non-OK') return Response.json({}, { status: 503 });
    throw mode === 'aborted' ? new DOMException('Aborted', 'AbortError') : new Error('Check failed');
  };
  await mount();
  expectVisibleRecovery();
});

it('shows recovery for a delayed check and ignores its late completion', async () => {
  const pending: Array<(response: Response) => void> = [];
  check = () => new Promise(resolve => pending.push(resolve));
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expectVisibleRecovery();
  await act(async () => { pending.forEach(resolve => resolve(Response.json({ setupComplete: true }))); await Promise.resolve(); });
  expectVisibleRecovery();
});

it('keeps a completed install in the workspace', async () => {
  check = async () => Response.json({ setupComplete: true });
  await mount();
  expect(document.querySelector('[data-o8-onboarding]')).toBeNull();
  expect(document.querySelector('[data-setup-check-complete="true"]')).not.toBeNull();
});

it('sends the first chat using the selected runtime default instead of an incompatible inherited model', async () => {
  await act(async () => { root.render(createElement(FirstChat)); await vi.advanceTimersByTimeAsync(50); });
  await act(async () => { host.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(50); });
  const payloads = vi.mocked(transport.socket!.send).mock.calls
    .map(([raw]) => JSON.parse(String(raw))).filter(row => row.type === 'orchestrator-send');
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ backend: 'codex', model: getRuntimeCapability('codex').defaultModel, thinkingEffort: 'max' });
});
