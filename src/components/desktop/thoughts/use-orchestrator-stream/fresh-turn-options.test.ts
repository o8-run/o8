// @vitest-environment jsdom

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => undefined }));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const { getRuntimeCapability, listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
  const runtimes = listDispatchableRuntimes();
  return { ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
    getRuntimeAuthSnapshot: async () => ({ statuses: Object.fromEntries(runtimes.map((runtime) => {
      const house = getRuntimeCapability(runtime).authHouse;
      return [house, { house, runtime, installed: true, ready: true, authenticated: true, unavailableReason: null, detail: 'Fixture', fix: '', checkedAt: 0 }];
    }).filter(([house]) => house)), suggestedSubscriptionProfile: { profile: null, detail: null } }),
    getDispatchableRuntimeAvailability: async () => runtimes.map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: 'Fixture', fix: '' })),
    invalidateRuntimeAuthCache: () => {},
  };
});

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', async () => {
  const { listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
  return { useRuntimeInventory: () => ({
    inventory: listDispatchableRuntimes().map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: '', fix: '' })),
    loading: false, error: null, refresh: () => {},
  }) };
});

import { act, createElement, createRef, useEffect, useRef, useState, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/panel/operator-defaults/route';
import { DELETE as DELETE_CHAT, GET as GET_CHAT, PATCH as PATCH_CHAT, POST as POST_CHAT } from '@/app/api/v2/chat-history/route';
import { NextRequest } from 'next/server';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import { REPLY_MODEL_DEFAULTS } from '../chat-panel/contextual-turn';
import { ThoughtsChatPanel, type ThoughtsChatPanelHandle } from '../ThoughtsChatPanel';
import { composerModeStorageKey, legacySwarmStorageKey } from '../composer-mode-storage';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK, type OrchestratorBackendSetting } from '../operator-defaults';
import { resolveFreshComposerTurnOptions } from '../useBackendSwitchChoice';
import { useOrchestratorStream } from '../useOrchestratorStream';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { findIdleOrchestratorSession } from '../chat-panel/idle-orchestrator-session';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));
vi.mock('../chat-panel/ProfiledChatMessageList', async () => {
  const { createElement: element, forwardRef: withRef } = await import('react');
  return { ProfiledChatMessageList: withRef<HTMLDivElement>(() => element('div')) };
});

const repoPath = '/repo/live-defaults';
let root: Root;
let host: HTMLDivElement;
let freshFetchFails = false;
let freshFetchGate: Promise<void> | null = null;
let releaseFreshFetch: (() => void) | null = null;
let historyResponse: Record<string, unknown> | null = null;
let useRealHistoryRoute = false;
let historyPatchGate: Promise<void> | null = null;
let historyPostGate: Promise<void> | null = null;
let runtimeInventoryAgents: Array<{ sessionKey: string; runtime: string; status: string; workspace: string }> = [];

interface ComposerTestWindow extends Window {
  interruptComposerTurn?: () => void;
  setComposerBackendOwnership?: (source: 'thread' | 'user') => void;
  submitComposerTurn?: () => void;
  switchComposerRepo?: () => void;
}

function composerWindow(): ComposerTestWindow {
  return window as unknown as ComposerTestWindow;
}

function invokeComposerAction(action: keyof ComposerTestWindow, ...args: unknown[]) {
  const callback = composerWindow()[action];
  if (typeof callback !== 'function') throw new Error(`Missing composer test action: ${action}`);
  Reflect.apply(callback, composerWindow(), args);
}

function blockFreshFetch() {
  freshFetchGate = new Promise<void>((resolve) => { releaseFreshFetch = resolve; });
}

async function releaseAndSettleFreshFetch() {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  const refreshIndex = fetchMock.mock.calls
    .findLastIndex(([input]) => String(input).startsWith('/api/panel/operator-defaults'));
  const pending = fetchMock.mock.results[refreshIndex]?.value as Promise<unknown> | undefined;
  await act(async () => {
    releaseFreshFetch?.();
    await pending;
    await vi.advanceTimersByTimeAsync(20);
  });
}

async function persistDefaults(orchestratorModel: string, orchestratorBackend: 'claude' | 'codex' | 'o8') {
  const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestratorModel, orchestratorBackend }),
  }));
  expect(response.ok).toBe(true);
}

function ComposerSubmissionHarness() {
  const [activeRepoPath, setActiveRepoPath] = useState(repoPath);
  const [displayedModel, setDisplayedModel] = useState('gpt-5.6-sol');
  const [displayedBackend, setDisplayedBackend] = useState<OrchestratorBackendSetting>('codex');
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const [, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const result = useOrchestratorStream(activeRepoPath, { threadId: 'fresh-turn-options' });

  useEffect(() => {
    composerWindow().submitComposerTurn = () => {
      result.send('operator message', {
        model: displayedModel,
        backend: displayedBackend === 'auto' ? undefined : displayedBackend,
        resolveTurnOptions: (signal) => resolveFreshComposerTurnOptions({
          repoPath: activeRepoPath,
          backend: displayedBackend,
          backendSourceRef,
          setBackend: setDisplayedBackend,
          setModel: setDisplayedModel,
          setOperatorDefaults,
        }, signal),
      });
    };
    composerWindow().interruptComposerTurn = result.interrupt;
    composerWindow().switchComposerRepo = () => setActiveRepoPath('/repo/switched');
    composerWindow().setComposerBackendOwnership = (source) => {
      backendSourceRef.current = source;
      setDisplayedBackend('codex');
    };
  }, [activeRepoPath, displayedBackend, displayedModel, result]);

  return createElement('output', { 'data-testid': 'displayed-model' }, displayedModel);
}

function RoutingThoughtsHarness({ panelRef, initialComposerMode, observeIdle = false, visible = false }: { panelRef: RefObject<ThoughtsChatPanelHandle | null>; initialComposerMode?: 'moa' | 'fusion'; observeIdle?: boolean; visible?: boolean }) {
  const [collideEnabled, setCollideEnabled] = useState(initialComposerMode === 'moa');
  const missionState: OrchestratorMissionState = {
    version: 2,
    prompt: '',
    summary: '',
    packets: [],
    updatedAt: new Date(0).toISOString(),
  };
  return createElement(ThoughtsChatPanel, {
    ref: panelRef,
    composerModeStorageId: initialComposerMode === 'fusion' ? 'routing-fusion-tab' : undefined,
    open: visible,
    agents: [],
    missionState,
    preferredRuntime: 'codex',
    sessionTargets: [],
    workspaceTargets: [],
    repoPath,
    initialMode: 'fleet',
    onModePersist: () => {},
    collideEnabled,
    onSetCollide: setCollideEnabled,
    suppressAutoRestore: true,
    suppressRuntimePrewarm: !observeIdle,
    thoughtsBodyBackground: 'var(--t-bg)',
    thoughtsElevatedSurface: 'var(--t-panel)',
    thoughtsElevatedBorder: 'var(--t-border)',
    thoughtsElevatedShadow: 'var(--t-panel-shadow)',
    thoughtsMutedGlass: 'var(--t-muted)',
    onMissionStateChange: () => {},
    onChromeChange: () => {},
  });
}

async function waitForPayload(count: number) {
  return vi.waitFor(() => {
    const payloads = sentTurnPayloads();
    if (payloads.length < count) throw new Error(`Timed out waiting for outbound payload ${count}`);
    return payloads[count - 1]!;
  }, { timeout: 200, interval: 5 });
}

function sentTurnPayloads() {
  const sent = transport.socket!.send as ReturnType<typeof vi.fn>;
  return sent.mock.calls
    .map(([payload]) => JSON.parse(payload as string) as Record<string, unknown>)
    .filter((payload) => payload.type === 'orchestrator-send');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/orchestrator/composer-queue')) return Response.json({ items: [] });
    if (url.startsWith('/api/runtime/inventory')) {
      return new Response(JSON.stringify({ agents: runtimeInventoryAgents }));
    }
    if (url.startsWith('/api/runtime/launch')) return new Promise<Response>(() => {});
    if (url.startsWith('/api/panel/operator-defaults')) {
      if (freshFetchFails) return new Response('unavailable', { status: 503 });
      if (freshFetchGate) await freshFetchGate;
      if (init?.method === 'POST') {
        return POST(new Request(`http://127.0.0.1${url}`, init));
      }
      return GET(new Request(`http://127.0.0.1${url}`));
    }
    if (url.startsWith('/api/v2/chat-history?tabId=') && historyResponse) {
      return new Response(JSON.stringify(historyResponse), { headers: { 'Content-Type': 'application/json' } });
    }
    if (useRealHistoryRoute && url.startsWith('/api/v2/chat-history')) {
      const request = new NextRequest(`http://127.0.0.1${url}`, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body ? String(init.body) : undefined,
      });
      if (init?.method === 'PATCH') {
        if (historyPatchGate) await historyPatchGate;
        return PATCH_CHAT(request);
      }
      if (init?.method === 'POST') {
        if (historyPostGate) await historyPostGate;
        return POST_CHAT(request);
      }
      return GET_CHAT(request);
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  freshFetchFails = false;
  freshFetchGate = null;
  releaseFreshFetch = null;
  historyResponse = null;
  useRealHistoryRoute = false;
  historyPatchGate = null;
  historyPostGate = null;
  runtimeInventoryAgents = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ComposerSubmissionHarness)));
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
  }
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  host.remove();
  localStorage.clear();
  transport.socket = null;
  vi.unstubAllGlobals();
});

describe('composer fresh operator defaults at the send seam', () => {
  it('reuses only an idle orchestrator at the exact normalized repository, excluding siblings and descendants', async () => {
    runtimeInventoryAgents = [
      { sessionKey: 'sibling', runtime: 'claude-code', status: 'idle', workspace: `${repoPath}-other` },
      { sessionKey: 'descendant', runtime: 'claude-code', status: 'idle', workspace: `${repoPath}/child` },
      { sessionKey: 'same', runtime: 'claude-code', status: 'reviewing', workspace: `${repoPath}/` },
    ];
    expect(findIdleOrchestratorSession(runtimeInventoryAgents, repoPath)?.sessionKey).toBe('same');
    expect(findIdleOrchestratorSession(runtimeInventoryAgents.slice(0, 2), repoPath)).toBeNull();
    await act(async () => root.unmount()); root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    await act(async () => {
      root.render(createElement(RoutingThoughtsHarness, { panelRef, observeIdle: true, visible: true }));
      await vi.advanceTimersByTimeAsync(50);
    });
    const requests = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
    expect(requests.some((url) => url.startsWith('/api/runtime/inventory'))).toBe(true);
    expect(requests.filter((url) => url.startsWith('/api/runtime/launch'))).toEqual([]);
    expect(sentTurnPayloads()).toEqual([]);
  });

  it.each([false, true])('does not launch a ready turn while an empty panel is visible: %s, and sends only the operator request', async (visible) => {
    await act(async () => root.unmount()); root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    // Two mounts cover the reload lifecycle without an actual runtime.
    for (let mount = 0; mount < 2; mount += 1) {
      await act(async () => {
        root.render(createElement(RoutingThoughtsHarness, { key: mount, panelRef, observeIdle: true, visible }));
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(sentTurnPayloads()).toEqual([]);
      const requests = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
      expect(requests.filter((url) => url.startsWith('/api/runtime/launch'))).toEqual([]);
      if (!visible) expect(requests.filter((url) => url.startsWith('/api/runtime/inventory'))).toEqual([]);
    }
    await act(async () => {
      expect(panelRef.current?.sendNow('operator requested work')).toBe(true);
      await waitForPayload(1);
    });
    expect(sentTurnPayloads()).toHaveLength(1);
    expect(sentTurnPayloads()[0]).toMatchObject({ type: 'orchestrator-send', displayMessage: 'operator requested work', backend: 'codex', orchestrationMode: 'fleet', pickedMode: 'fast' });
    expect(sentTurnPayloads()[0].message).toContain('Delegate only when the user asks');
    // Let this mount's 800ms history debounce land against its own synthetic
    // transport before the next test installs a real history-route fixture.
    await act(async () => { await vi.advanceTimersByTimeAsync(950); });
  });

  it.each([true, false])('keeps a chat on its selected repository through first send and reload (saved=%s)', async (alreadySaved) => {
    const oldRepo = '/repo/old-thread-home';
    const newRepo = '/repo/new-turn-home';
    const tabId = `thoughts-target-${alreadySaved}-${Date.now()}`;
    if (alreadySaved) {
      const saved = await POST_CHAT(new NextRequest('http://127.0.0.1/api/v2/chat-history', {
        method: 'POST',
        body: JSON.stringify({
          tabId,
          repoPath: oldRepo,
          repoName: 'old-thread-home',
          messages: [],
        }),
      }));
      expect(saved.ok).toBe(true);
    }
    useRealHistoryRoute = true;
    let releasePatch: () => void = () => {};
    historyPatchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    // Keep the debounced transcript POST distinct from the repository PATCH
    // notification, even when the machine takes longer than the debounce.
    let releasePost: () => void = () => {};
    historyPostGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const historyUpdates: string[] = [];
    const onHistoryUpdate = (event: Event) => {
      historyUpdates.push((event as CustomEvent<{ threadId: string }>).detail.threadId);
    };
    window.addEventListener('o8:chat-history-updated', onHistoryUpdate);
    await act(async () => root.unmount());
    root = createRoot(host);
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    try {
      await act(async () => root.render(createElement(ThoughtsChatPanel, {
        ref: panelRef,
        open: true,
        agents: [],
        missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
        preferredRuntime: 'codex',
        sessionTargets: [],
        workspaceTargets: [
          { id: oldRepo, label: 'Old thread home', repoName: 'old-thread-home', localPath: oldRepo, branch: 'main', isWorktree: false },
          { id: newRepo, label: 'New turn home', repoName: 'new-turn-home', localPath: newRepo, branch: 'main', isWorktree: false },
        ],
        repoPath: oldRepo,
        scopeTabId: 'owning-tab',
        ownerTabId: 'owning-tab',
        initialMode: 'fleet',
        onModePersist: () => {},
        suppressAutoRestore: true,
        suppressRuntimePrewarm: true,
        thoughtsBodyBackground: 'var(--t-bg)',
        thoughtsElevatedSurface: 'var(--t-panel)',
        thoughtsElevatedBorder: 'var(--t-border)',
        thoughtsElevatedShadow: 'var(--t-panel-shadow)',
        thoughtsMutedGlass: 'var(--t-muted)',
        onMissionStateChange: () => {},
        onChromeChange: () => {},
      })));
      await act(async () => {
        panelRef.current!.loadThread(tabId);
        await vi.advanceTimersByTimeAsync(50);
      });
      const pickProject = async (current: string, next: string) => {
        const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="Project target: ${current}"]`);
        expect(trigger).toBeTruthy();
        await act(async () => trigger!.click());
        const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((button) => button.textContent?.includes(next));
        expect(choice).toBeTruthy();
        await act(async () => choice!.click());
      };
      await pickProject('old-thread-home', newRepo);
      await pickProject('new-turn-home', oldRepo);
      await pickProject('old-thread-home', newRepo);
      expect(host.querySelector('button[aria-label="Project target: new-turn-home"]')).toBeTruthy();
      await act(async () => {
        expect(panelRef.current?.sendNow('Continue in the new repository')).toBe(true);
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(sentTurnPayloads()).toHaveLength(0);
      await act(async () => {
        releasePatch();
        await waitForPayload(1);
      });
      expect(historyUpdates).toEqual([tabId]);
      releasePost();
      expect(sentTurnPayloads()[0]?.threadId).toBe(tabId);
      expect(sentTurnPayloads()[0]?.repoPath).toBe(newRepo);
      await act(async () => { await vi.advanceTimersByTimeAsync(950); });
      const record = await GET_CHAT(new NextRequest(`http://127.0.0.1/api/v2/chat-history?tabId=${tabId}`));
      const persisted = await record.json();
      expect(persisted.repoPath).toBe(newRepo);
      expect(persisted.messages.find((message: { role: string }) => message.role === 'user')).toMatchObject({ content: 'Continue in the new repository' });
      await act(async () => {
        panelRef.current!.loadThread(tabId);
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(host.querySelector('button[aria-label^="Project target"]')).toBeNull();
    } finally {
      releasePatch();
      releasePost();
      historyPatchGate = null;
      historyPostGate = null;
      window.removeEventListener('o8:chat-history-updated', onHistoryUpdate);
      await DELETE_CHAT(new NextRequest(`http://127.0.0.1/api/v2/chat-history?tabId=${tabId}`));
    }
  });

  it('sends a Project picker selection to the owning workspace tab', async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    const scopeEvents: Array<{ tabId: string; repoPath: string; repoName: string }> = [];
    const onScope = (event: Event) => {
      scopeEvents.push((event as CustomEvent<{ tabId: string; repoPath: string; repoName: string }>).detail);
    };
    window.addEventListener('o8:select-workspace-scope', onScope);
    try {
      await act(async () => root.render(createElement(ThoughtsChatPanel, {
        open: true,
        agents: [],
        missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
        preferredRuntime: 'codex',
        sessionTargets: [],
        workspaceTargets: [
          { id: repoPath, label: 'Original', repoName: 'original', localPath: repoPath, branch: 'main', isWorktree: false },
          { id: '/repo/selected', label: 'Selected', repoName: 'selected', localPath: '/repo/selected', branch: 'main', isWorktree: false },
        ],
        repoPath,
        scopeTabId: 'owning-tab',
        ownerTabId: 'owning-tab',
        initialMode: 'fleet',
        onModePersist: () => {},
        suppressAutoRestore: true,
        suppressRuntimePrewarm: true,
        thoughtsBodyBackground: 'var(--t-bg)',
        thoughtsElevatedSurface: 'var(--t-panel)',
        thoughtsElevatedBorder: 'var(--t-border)',
        thoughtsElevatedShadow: 'var(--t-panel-shadow)',
        thoughtsMutedGlass: 'var(--t-muted)',
        onMissionStateChange: () => {},
        onChromeChange: () => {},
      })));
      const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Project target: original"]');
      expect(trigger).toBeTruthy();
      await act(async () => trigger?.click());
      const selected = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((button) => button.textContent?.includes('/repo/selected'));
      expect(selected).toBeTruthy();
      await act(async () => selected?.click());
      expect(scopeEvents).toEqual([{ tabId: 'owning-tab', repoPath: '/repo/selected', repoName: 'selected' }]);
      expect(host.querySelector('button[aria-label="Project target: selected"]')).toBeTruthy();
      await act(async () => window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
        detail: { tabId: 'another-tab', repoPath, repoName: 'original' },
      })));
      expect(host.querySelector('button[aria-label="Project target: selected"]')).toBeTruthy();
    } finally {
      window.removeEventListener('o8:select-workspace-scope', onScope);
    }
  });

  it('reaches the live resolver through the real ThoughtsChatPanel send callback', async () => {
    const composerModeStorageId = 'live-mode-tab';
    localStorage.setItem('o8:composer-selector-v1', '0');
    localStorage.setItem(legacySwarmStorageKey(composerModeStorageId), '1');
    await act(async () => root.unmount());
    root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    const missionState: OrchestratorMissionState = {
      version: 2,
      prompt: '',
      summary: '',
      packets: [],
      updatedAt: new Date(0).toISOString(),
    };
    await act(async () => {
      root.render(createElement(ThoughtsChatPanel, {
        ref: panelRef,
        open: false,
        agents: [],
        missionState,
        preferredRuntime: 'codex',
        sessionTargets: [],
        workspaceTargets: [],
        repoPath,
        composerModeStorageId,
        initialMode: 'fleet',
        onModePersist: () => {},
        suppressAutoRestore: true,
        suppressRuntimePrewarm: true,
        thoughtsBodyBackground: 'var(--t-bg)',
        thoughtsElevatedSurface: 'var(--t-panel)',
        thoughtsElevatedBorder: 'var(--t-border)',
        thoughtsElevatedShadow: 'var(--t-panel-shadow)',
        thoughtsMutedGlass: 'var(--t-muted)',
        onMissionStateChange: () => {},
        onChromeChange: () => {},
      }));
      await vi.advanceTimersByTimeAsync(50);
    });
    await persistDefaults('gpt-5.6-terra', 'codex');
    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('operator message')).toBe(true);
      payload = await waitForPayload(1);
      await vi.advanceTimersByTimeAsync(20);
    });
    const modelButton = [...host.querySelectorAll('button')]
      .find((button) => button.title.startsWith('Terra'));
    expect(modelButton).toBeTruthy();
    expect(payload).toMatchObject({
      model: 'gpt-5.6-terra',
      backend: 'codex',
      orchestrationMode: 'fusion',
      displayMessage: 'operator message',
    });
    expect(payload.message).toContain('[Mode: Fusion]');
    expect(localStorage.getItem(composerModeStorageKey(composerModeStorageId))).toBe('fusion');
    expect(localStorage.getItem(legacySwarmStorageKey(composerModeStorageId))).toBe('0');
  });

  it('sends a new o8 workspace turn with its own model despite a stale provider model pin', async () => {
    await act(async () => root.unmount()); root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('claude-opus-5', 'o8');
    writeStoredOrchestratorModel(repoPath, 'claude-opus-5');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    await act(async () => {
      root.render(createElement(ThoughtsChatPanel, {
        ref: panelRef, open: true, agents: [],
        missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
        preferredRuntime: 'codex', sessionTargets: [], workspaceTargets: [], repoPath,
        initialMode: 'fleet', lockedMode: 'fleet', suppressAutoRestore: true, suppressRuntimePrewarm: true,
        thoughtsBodyBackground: 'transparent', thoughtsElevatedSurface: 'transparent', thoughtsElevatedBorder: 'none',
        thoughtsElevatedShadow: 'none', thoughtsMutedGlass: 'transparent', onMissionStateChange: () => {}, onChromeChange: () => {},
      }));
      await vi.advanceTimersByTimeAsync(50);
    });
    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('Help me draft a reply.')).toBe(true);
      payload = await waitForPayload(1);
    });
    expect(payload).toMatchObject({ backend: 'o8', model: 'o8-free', displayMessage: 'Help me draft a reply.' });
    expect(readStoredOrchestratorModel(repoPath)).toBe('claude-opus-5');
    const defaults = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await defaults.json()).values).toMatchObject({ orchestratorBackend: 'o8', orchestratorModel: 'claude-opus-5' });
  });

  it('sends a new reply through managed inference without inheriting or overwriting the workspace model', async () => {
    await act(async () => root.unmount()); root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-6-astra', 'codex');
    writeStoredOrchestratorModel(repoPath, 'gpt-6-astra');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    await act(async () => {
      root.render(createElement(ThoughtsChatPanel, {
        ref: panelRef, open: true, agents: [],
        missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
        preferredRuntime: 'codex', sessionTargets: [], workspaceTargets: [], repoPath,
        initialMode: 'fleet', lockedMode: 'fleet', suppressAutoRestore: true, suppressRuntimePrewarm: true,
        contextualConversation: { requestContext: 'Issue context for a private draft', modelDefaults: REPLY_MODEL_DEFAULTS },
        thoughtsBodyBackground: 'transparent', thoughtsElevatedSurface: 'transparent', thoughtsElevatedBorder: 'none',
        thoughtsElevatedShadow: 'none', thoughtsMutedGlass: 'transparent', onMissionStateChange: () => {}, onChromeChange: () => {},
      }));
      await vi.advanceTimersByTimeAsync(50);
    });
    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('Help me draft a reply.')).toBe(true);
      payload = await waitForPayload(1);
    });
    expect(payload).toMatchObject({ backend: 'o8', model: 'o8-free', displayMessage: 'Help me draft a reply.' });
    expect(payload.message).toContain('Issue context for a private draft');
    expect(readStoredOrchestratorModel(repoPath)).toBe('gpt-6-astra');
    const defaults = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await defaults.json()).values).toMatchObject({ orchestratorBackend: 'codex', orchestratorModel: 'gpt-6-astra' });
  });

  for (const selectorEnabled of [true, false]) {
    it(`resets comparison mode before a ${selectorEnabled ? 'selector' : 'classic'} lead pick reaches routing`, async () => {
      localStorage.setItem('o8:composer-selector-v1', selectorEnabled ? '1' : '0');
      await act(async () => root.unmount());
      root = createRoot(host);
      invalidateOperatorDefaultsValuesSnapshot();
      await persistDefaults('gpt-5.6-sol', 'codex');
      const panelRef = createRef<ThoughtsChatPanelHandle>();
      await act(async () => {
        root.render(createElement(RoutingThoughtsHarness, { panelRef, initialComposerMode: 'moa' }));
        await vi.advanceTimersByTimeAsync(50);
      });

      const modelTrigger = selectorEnabled
        ? host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')
        : [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.title.endsWith(' · Compare plans'));
      await act(async () => {
        modelTrigger!.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      if (selectorEnabled) {
        act(() => document.querySelector<HTMLButtonElement>('[data-testid="lead-house-codex"]')!.click());
      } else {
        const codexHouse = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.trim() === 'Codex')!;
        await act(async () => {
          codexHouse.click();
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      const pickedModel = selectorEnabled
        ? document.querySelector<HTMLButtonElement>('[data-testid="lead-row-gpt-5.6-terra"]')
        : [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.includes('GPT-5.6 Terra'));
      act(() => pickedModel!.click());
      expect(readStoredOrchestratorModel(repoPath)).toBe('gpt-5.6-terra');

      const resetModeTrigger = selectorEnabled
        ? host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')
        : host.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]');
      expect(resetModeTrigger?.getAttribute('aria-label')).toContain(selectorEnabled ? 'Delegation off' : 'Solo');

      let payload: Record<string, unknown> = {};
      await act(async () => {
        expect(panelRef.current?.sendNow('route this lead')).toBe(true);
        payload = await waitForPayload(1);
      });
      expect(payload).toMatchObject({
        backend: 'codex',
        model: 'gpt-5.6-terra',
        orchestrationMode: 'single',
      });
      expect(payload.backend).not.toBe('collide');
      expect(payload.message).toContain('[Mode: Solo]');
    });
  }

  it('resets Fusion when a deferred backend handoff applies through the real panel', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    localStorage.setItem(composerModeStorageKey('routing-fusion-tab'), 'fusion');
    writeStoredOrchestratorModel(repoPath, 'gpt-5.6-sol');
    historyResponse = {
      backend: 'codex',
      messages: [
        { id: 'history-user', role: 'user', content: 'previous turn', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'previous reply', timestamp: 2, backend: 'codex', model: 'gpt-5.6-sol' },
      ],
    };
    await act(async () => root.unmount());
    root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    await act(async () => {
      root.render(createElement(RoutingThoughtsHarness, { panelRef, initialComposerMode: 'fusion' }));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(panelRef.current).not.toBeNull();
    await act(async () => {
      panelRef.current!.loadThread('backend-handoff-thread');
      await vi.advanceTimersByTimeAsync(100);
    });

    const modeTrigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    expect(modeTrigger.getAttribute('aria-label')).toContain('Fusion');
    const leadTrigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    act(() => leadTrigger.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="lead-house-claude"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="lead-row-claude-sonnet-5"]')!.click());

    expect(modeTrigger.getAttribute('aria-label')).toContain('Fusion');
    const handoff = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Hand off')!;
    await act(async () => {
      handoff.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(modeTrigger.getAttribute('aria-label')).toContain('Delegation off');
    expect(readStoredOrchestratorModel(repoPath)).toBe('claude-sonnet-5');

    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('continue on picked backend')).toBe(true);
      payload = await waitForPayload(1);
    });
    expect(payload).toMatchObject({
      backend: 'claude',
      model: 'claude-sonnet-5',
      orchestrationMode: 'single',
    });
    expect(payload.backend).not.toBe('collide');
    expect(payload.message).toContain('[Mode: Solo]');
  });

  it('carries and displays each persisted default without remounting, while retaining a repo model pin', async () => {
    await persistDefaults('gpt-5.6-sol', 'codex');
    let first: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      first = await waitForPayload(1);
    });
    expect(first).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('gpt-5.6-sol');

    await persistDefaults('claude-sonnet-5', 'claude');
    let second: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      second = await waitForPayload(2);
    });
    expect(second).toMatchObject({ model: 'claude-sonnet-5', backend: 'claude' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('claude-sonnet-5');

    writeStoredOrchestratorModel(repoPath, 'gpt-5.6-sol');
    await persistDefaults('claude-sonnet-5', 'claude');
    await act(async () => {
      invokeComposerAction('setComposerBackendOwnership', 'thread');
    });
    let pinned: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      pinned = await waitForPayload(3);
    });
    expect(pinned).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('gpt-5.6-sol');

    await act(async () => {
      invokeComposerAction('setComposerBackendOwnership', 'user');
    });
    let userOwned: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      userOwned = await waitForPayload(4);
    });
    expect(userOwned).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });

    freshFetchFails = true;
    let fallback: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      fallback = await waitForPayload(5);
    });
    expect(fallback).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
  });

  it('cancels a pending default refresh when the operator stops or changes repo context', async () => {
    await persistDefaults('claude-sonnet-5', 'claude');
    blockFreshFetch();
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      invokeComposerAction('interruptComposerTurn');
    });
    await releaseAndSettleFreshFetch();
    expect(sentTurnPayloads()).toHaveLength(0);

    // The repo switch only cancels once React commits it, and act defers that
    // commit to the end of its scope. Close the scope before releasing the
    // refresh so the cancellation cannot race the resolved defaults.
    blockFreshFetch();
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      invokeComposerAction('switchComposerRepo');
    });
    await releaseAndSettleFreshFetch();
    expect(sentTurnPayloads()).toHaveLength(0);
  });
});
