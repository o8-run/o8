'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Onboarding, type OnboardingStep } from '@/components/desktop/Onboarding';
import { TelemetryConsentCard } from '@/components/desktop/TelemetryConsentCard';
import type { OnboardingRequest } from '@/components/desktop/onboarding/request';
import { getPalette, resolveTheme } from '@/lib/theme/registry';
import { useTheme } from '@/lib/theme/context';
import { isTauri } from '@/lib/tauri/bridge';
import { PROGRESS_KEY, browserProgressStorage, type OnboardingTask, type ProgressStorage } from '@/components/desktop/onboarding/onboarding-progress';
import { recommendRuntimeSetup, type SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { previewBuiltInAgent } from './built-in-agent-fixture';
import type { OnboardingPermissionClient } from '@/components/desktop/onboarding/OnboardingPermissionsStep';
import type { PermissionSnapshot } from '@/components/desktop/onboarding/permissions-check';

export type ConsentPreviewState = 'unanswered' | 'one-choice' | 'saving' | 'error';
type PreviewSurface = 'consent' | 'onboarding';
type PreviewTools = 'both' | 'codex' | 'claude-code' | 'none' | 'sign-in' | 'built-in-free' | 'built-in-paid' | 'built-in-with-tools' | 'built-in-windows';

const ONBOARDING_STEPS: Array<{ value: OnboardingStep; label: string }> = [
  { value: 'open', label: 'Projects' },
  { value: 'repos', label: 'GitHub' },
  { value: 'dispatch', label: 'Tools' },
  { value: 'privacy', label: 'Privacy' },
  { value: 'permissions', label: 'Voice & permissions' },
  { value: 'mobile', label: 'iPhone app' },
];

const CONSENT_STATES: Array<{ value: ConsentPreviewState; label: string }> = [
  { value: 'unanswered', label: 'Unanswered' },
  { value: 'one-choice', label: 'One choice made' },
  { value: 'saving', label: 'Saving' },
  { value: 'error', label: 'Save error' },
];

const ignorePreviewAction = () => {};
const pickPreviewFolder = async () => '/preview/sample-project';
type PreviewPermissions = 'browser' | 'new' | 'ready' | 'mixed';
function previewPermissionClient(scenario: PreviewPermissions): OnboardingPermissionClient | undefined {
  if (scenario === 'browser') return undefined;
  const statuses: PermissionSnapshot = scenario === 'ready'
    ? { microphone: 'granted', accessibility: 'granted', 'input-monitoring': 'granted', 'screen-recording': 'granted' }
    : scenario === 'mixed' ? { microphone: 'granted', accessibility: 'denied', 'input-monitoring': 'unknown', 'screen-recording': 'granted' }
      : { microphone: 'not-asked', accessibility: 'denied', 'input-monitoring': 'denied', 'screen-recording': 'denied' };
  return { supported: () => true, read: async () => ({ ...statuses }), request: async (id) => { statuses[id] = 'granted'; } };
}
const restartPreviewPermissions = async () => { throw new Error('Preview: native restart is unavailable. Your preview stays here.'); };
export const PREVIEW_PROJECT = { id: 'preview-project', name: 'Sample project', localPath: '/preview/sample-project', defaultBranch: 'main' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createOnboardingPreviewRequest(storage: ProgressStorage | null = null, tools: PreviewTools = 'both'): OnboardingRequest {
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(storage?.getItem('settings') ?? '{}'); } catch { /* Fresh fixture. */ }
  return async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/panel/github-status')) {
    return jsonResponse({ authenticated: false, deviceFlowEnabled: false });
  }
  if (url.startsWith('/api/panel/repos')) return jsonResponse(init?.method === 'POST' ? { repo: PREVIEW_PROJECT } : { repos: [PREVIEW_PROJECT] });
  if (url.startsWith('/api/setup/agent')) return jsonResponse({ request: null });
  if (url.startsWith('/api/setup/detect')) {
    return jsonResponse({
      tools: [{ id: 'local-preview', name: 'Local preview runtime', detected: true, ready: true, version: 'preview' }],
    });
  }
  if (url.startsWith('/api/panel/operator-defaults')) {
    const builtInAgent = tools.startsWith('built-in-') ? previewBuiltInAgent(tools === 'built-in-paid' ? 'pro' : 'free', tools === 'built-in-windows' ? 'win32' : 'darwin') : null;
    if (url.includes('include=setup-built-in')) return jsonResponse({ builtInAgent });
    if (init?.method === 'POST') {
      values = { ...values, ...JSON.parse(String(init.body ?? '{}')) };
      storage?.setItem('settings', JSON.stringify(values));
    }
    const inventory: SetupRuntime[] = [
      { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: 'Ready', fix: '' },
      { id: 'claude-code', label: 'Claude Code', available: true, unavailableReason: null, detail: 'Ready', fix: '' },
      { id: 'opencode', label: 'OpenCode', available: false, unavailableReason: 'not_installed', detail: 'Not installed', fix: 'Install OpenCode, then refresh tools.' },
    ];
    for (const item of inventory) {
      if (item.available && tools !== 'both' && tools !== 'built-in-with-tools' && tools !== item.id) { item.available = false; item.unavailableReason = 'not_installed'; item.detail = 'Not installed'; item.fix = `Install ${item.label}, then refresh tools.`; }
    }
    if (tools === 'sign-in') {
      const codex = inventory[0]!;
      Object.assign(codex, storage?.getItem('signed-in-runtime') === 'codex'
        ? { available: true, installed: true, unavailableReason: null, detail: 'Ready', fix: '' }
        : { available: false, installed: true, unavailableReason: 'needs_auth', detail: 'Installed, sign-in needed', fix: 'Run `codex login`.' });
    }
    if (builtInAgent) inventory.unshift(builtInAgent);
    return jsonResponse({ values, sources: Object.fromEntries(Object.keys(values).map((key) => [key, 'file'])), dispatchableRuntimes: inventory, setupRecommendation: recommendRuntimeSetup({ inventory, values, sources: Object.fromEntries(Object.keys(values).map((key) => [key, 'file'])), activity: { codex: 12, claude: 4, complete: true } }) });
  }
  if (url.startsWith('/api/connectors/')) return jsonResponse({ profile: null });
  return jsonResponse({ error: 'Preview request is not stubbed.' }, 404);
  };
}
export const previewOnboardingRequest = createOnboardingPreviewRequest();

export function createConsentPreviewRequest(state: ConsentPreviewState) {
  return async (init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return jsonResponse({ values: { telemetryConsentAnswered: false } });
    }
    if (state === 'saving') return new Promise<Response>(() => {});
    if (state === 'error') {
      return jsonResponse({ error: 'Preview: choices could not be saved.' }, 500);
    }
    return jsonResponse({ values: { ...JSON.parse(String(init.body ?? '{}')) } });
  };
}

export function ConsentScenario({ state, request: injectedRequest }: {
  state: ConsentPreviewState;
  request?: ReturnType<typeof createConsentPreviewRequest>;
}) {
  const defaultRequest = useMemo(() => createConsentPreviewRequest(state), [state]);
  const request = injectedRequest ?? defaultRequest;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || state === 'unanswered') return;
    let cancelled = false;
    let submitted = false;
    const findButton = (label: string) => Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === label);
    const driveState = () => {
      if (cancelled || submitted) return;
      const firstChoice = findButton('Share crash reports');
      if (!firstChoice || firstChoice.disabled) return;
      if (firstChoice.getAttribute('aria-pressed') !== 'true') {
        firstChoice.click();
        return;
      }
      if (state === 'one-choice') {
        observer.disconnect();
        return;
      }
      const save = findButton('Save privacy choices');
      if (!save || save.disabled) return;
      submitted = true;
      observer.disconnect();
      save.click();
    };
    const observer = new MutationObserver(driveState);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'disabled'],
    });
    driveState();
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [state]);

  return <div ref={containerRef}><TelemetryConsentCard request={request} /></div>;
}

const controlStyle: React.CSSProperties = {
  minHeight: 32,
  paddingTop: 5,
  paddingBottom: 5,
  paddingLeft: 10,
  paddingRight: 28,
  borderRadius: 8,
  border: '1px solid var(--t-divider-strong)',
  background: 'var(--t-chat-surface-bg)',
  color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
};

export function FirstRunPreview() {
  const appearance = useTheme();
  const nativeGlass = isTauri() && appearance.surface === 'glass';
  const [controlsOpen, setControlsOpen] = useState(true);
  const [surface, setSurface] = useState<PreviewSurface>('onboarding');
  const [consentState, setConsentState] = useState<ConsentPreviewState>('unanswered');
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | undefined>(undefined);
  const [permissions, setPermissions] = useState<PreviewPermissions>('browser');
  const permissionClient = useMemo(() => previewPermissionClient(permissions), [permissions]);

  const [palette, setPalette] = useState<'light' | 'dark'>('light');
  const [tools, setTools] = useState<PreviewTools>('both');
  const [run, setRun] = useState(0);
  const [finishedTask, setFinishedTask] = useState<OnboardingTask | null>(null);
  const [finished, setFinished] = useState(false);
  const storage = useMemo<ProgressStorage>(() => ({
    getItem: (key) => browserProgressStorage()?.getItem(`o8:preview:${key}`) ?? null,
    setItem: (key, value) => browserProgressStorage()?.setItem(`o8:preview:${key}`, value),
    removeItem: (key) => browserProgressStorage()?.removeItem(`o8:preview:${key}`),
  }), []);
  const [onboardingRequest, setOnboardingRequest] = useState(() => createOnboardingPreviewRequest(storage));

  const restart = (nextTools = tools) => {
    storage.removeItem('settings'); storage.removeItem(PROGRESS_KEY); storage.removeItem('signed-in-runtime');
    setOnboardingRequest(() => createOnboardingPreviewRequest(storage, nextTools));
    setFinished(false); setOnboardingStep('open'); setRun((value) => value + 1);
  };

  return (
    <main style={{ ...(!nativeGlass ? resolveTheme(getPalette(palette), 'solid').cssVars : {}), position: 'fixed', inset: 0, overflow: 'hidden', background: nativeGlass ? 'var(--t-bg-gradient)' : 'var(--t-bg)', color: 'var(--t-text)' } as React.CSSProperties}>
      {finished ? <section style={{ maxWidth: 520, marginTop: 160, marginLeft: 'auto', marginRight: 'auto', paddingTop: 24, paddingBottom: 24, paddingLeft: 32, paddingRight: 32, fontFamily: 'var(--font-sans-system)' }}><h1 style={{ fontSize: 30, fontWeight: 300 }}>Workspace opened.</h1><p style={{ lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{finishedTask?.project.name ?? 'An empty workspace'} is ready. In the app, you land directly in the workspace with your composer ready.</p><p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>This preview ends at the handoff. No task was submitted.</p><button type="button" onClick={() => restart()} style={controlStyle}>Restart preview</button></section> : surface === 'consent' ? (
        <ConsentScenario key={consentState} state={consentState} />
      ) : (
        <Onboarding
          key={`${run}:${onboardingStep}:${permissions}`}
          initialStep={onboardingStep}
          request={onboardingRequest}
          storage={storage}
          pickFolder={pickPreviewFolder}
          openExternal={ignorePreviewAction}
          permissionClient={permissionClient}
          allowSetupTerminal={false}
          restartPermissions={restartPreviewPermissions}
          onComplete={(task) => { setFinishedTask(task ?? null); setFinished(true); return true; }}
        />
      )}

      <aside data-onboarding-preview-controls="" style={{
        position: 'fixed',
        top: 10,
        left: controlsOpen ? '50%' : undefined,
        right: controlsOpen ? undefined : 12,
        zIndex: 100001,
        transform: controlsOpen ? 'translateX(-50%)' : undefined,
        width: 'max-content',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
        maxWidth: 'calc(100vw - 24px)',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 10,
        border: '1px solid var(--t-divider-strong)',
        background: 'var(--t-chat-surface-card-bg)',
        boxShadow: 'var(--t-glass-shadow)',
        fontFamily: 'var(--font-sans-system)',
      }}>
        <button type="button" onClick={() => setControlsOpen((value) => !value)} style={{ ...controlStyle, paddingRight: 10 }}>{controlsOpen ? 'Hide controls' : 'Preview controls'}</button>
        {controlsOpen ? <>
        <span style={{ paddingLeft: 3, fontSize: 9, fontWeight: 500, letterSpacing: '0.12em', color: 'var(--t-text-muted)', whiteSpace: 'nowrap' }}>
          DEV PREVIEW
        </span>
        <select
          aria-label="First-run surface"
          value={surface}
          onChange={(event) => setSurface(event.target.value as PreviewSurface)}
          style={controlStyle}
        >
          <option value="consent">Privacy consent</option>
          <option value="onboarding">Onboarding</option>
        </select>
        {surface === 'consent' ? (
          <select
            aria-label="Consent state"
            value={consentState}
            onChange={(event) => setConsentState(event.target.value as ConsentPreviewState)}
            style={controlStyle}
          >
            {CONSENT_STATES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <select
            aria-label="Onboarding step"
            value={onboardingStep ?? ''}
            onChange={(event) => { setFinished(false); setOnboardingStep(event.target.value as OnboardingStep); }}
            style={controlStyle}
          >
            <option value="" disabled>Jump to step</option>
            {ONBOARDING_STEPS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
        <select aria-label="Available tools" value={tools} onChange={(event) => { const next = event.target.value as PreviewTools; setTools(next); restart(next); }} style={controlStyle}>
          <option value="both">Codex + Claude</option><option value="codex">Codex only</option><option value="claude-code">Claude only</option><option value="none">No tools</option><option value="sign-in">Installed · sign-in needed</option>
          <option value="built-in-free">Built-in · free</option><option value="built-in-paid">Built-in · paid</option><option value="built-in-with-tools">Built-in + tools</option><option value="built-in-windows">Built-in · Windows</option>
        </select>
        <select aria-label="Voice permissions" value={permissions} onChange={(event) => setPermissions(event.target.value as PreviewPermissions)} style={controlStyle}>
          <option value="browser">Browser · unavailable</option><option value="new">macOS · new</option><option value="ready">macOS · ready</option><option value="mixed">macOS · mixed</option>
        </select>
        {tools === 'sign-in' ? <button type="button" onClick={() => storage.setItem('signed-in-runtime', 'codex')} style={{ ...controlStyle, paddingRight: 10 }}>Mark preview sign-in ready</button> : null}
        <select aria-label="Preview theme" disabled={nativeGlass} title={nativeGlass ? 'Native glass uses the app appearance.' : undefined} value={palette} onChange={(event) => setPalette(event.target.value as 'light' | 'dark')} style={controlStyle}><option value="light">Light</option><option value="dark">Dark</option></select>
        <button type="button" aria-label="Reset onboarding preview" onClick={() => restart()} style={{ ...controlStyle, paddingRight: 10 }}>Reset</button>
        <span style={{ fontSize: 10, color: 'var(--t-text-faint)', whiteSpace: 'nowrap' }}>isolated state</span>
        </> : null}
      </aside>
    </main>
  );
}
