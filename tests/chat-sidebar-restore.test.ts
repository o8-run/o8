// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/dashboard/page';
import { getQueryClient } from '@/lib/query/client';
import { resetComposerDraftMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, user: null, isLoaded: true, clerkEnabled: false }) }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ DesktopWebSocketProvider: ({children}: {children: React.ReactNode}) => children, useSharedDesktopWs: () => ({ connectionState: 'disconnected', sendTerminalCreate() {}, sendTerminalAttach() {}, sendTerminalInput() {}, sendTerminalResize() {}, sendTerminalVisibility() {}, sendTerminalDetach() {} }), useWsConnectionEpoch: () => 0, useWsConnectionState: () => 'disconnected' }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({ useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh() {} }) }));
vi.mock('@/components/desktop/workspace-terminal/XtermPanel', () => ({ XtermPanel: () => null }));
const transport = vi.hoisted(() => ({ sockets: [] as WebSocket[], sends: [] as Record<string, unknown>[] }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => {
    const socket = { readyState: WebSocket.OPEN, close: vi.fn(), send: vi.fn((raw: string) => {
      const payload = JSON.parse(raw);
      if (payload.type === 'orchestrator-subscribe') {
        (socket as unknown as { thread?: string }).thread = payload.threadId;
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true, threadId: payload.threadId } }) } as MessageEvent));
      }
      if (payload.type === 'orchestrator-send') transport.sends.push(payload);
    }) } as unknown as WebSocket;
    transport.sockets.push(socket);
    setTimeout(() => socket.onopen?.({} as Event), 0);
    return socket;
  },
}));
const repo = { name: 'Fixture', localPath: '/fixture', branch: 'main' };
const noop = () => {};
let host: HTMLDivElement;
let root: Root;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
async function type(input: HTMLTextAreaElement, value: string) {
  expect(input.isConnected).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); }); }
beforeEach(() => {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args); pendingTimers.add(timer); return timer;
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: noop });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel: noop }) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (text: string) => ({ width: text.length * 8 }), fillRect() {}, clearRect() {}, fillText() {}, setTransform() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({data: new Uint8ClampedArray(w*h*4)}) } as unknown as CanvasRenderingContext2D);
  getQueryClient().clear();
  localStorage.clear(); resetComposerDraftMemoryForTests(); transport.sockets = []; transport.sends = [];
  const saved = { version: 1, activeTabId: 'orchestrator-existing', savedAt: new Date().toISOString(), tabs: [{
    id: 'orchestrator-existing', kind: 'orchestrator', label: 'Existing conversation', repoPath: repo.localPath,
    repoName: repo.name, cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: 'thoughts-existing',
  }] };
  localStorage.setItem('fixture:terminal:tile-root', JSON.stringify(saved));
  localStorage.setItem('fixture:history:thoughts-existing', JSON.stringify({ repoPath: repo.localPath, title: 'Existing conversation', messages: [{ id: 'old-result', role: 'assistant', text: 'Retained existing result', timestamp: 1 }] }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://fixture');
    if (url.pathname === '/api/panel/terminal-state') {
      const key = 'fixture:terminal:' + url.searchParams.get('scope');
      if (init?.method === 'POST') { localStorage.setItem(key, String(init.body)); return Response.json({ ok: true }); }
      const value = localStorage.getItem(key); return value ? Response.json(JSON.parse(value)) : new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/v2/chat-history') {
      if (init?.method === 'POST') {
        const history = JSON.parse(String(init.body));
        localStorage.setItem('fixture:history:' + history.tabId, JSON.stringify(history));
        return Response.json({ ok: true });
      }
      return Response.json(JSON.parse(localStorage.getItem('fixture:history:' + url.searchParams.get('tabId')) ?? '{"messages":[]}'));
    }
    if (url.pathname.includes('composer-queue')) return Response.json({ items: [] });
    return Response.json({ agents: [], conversations: [], packets: [], projects: [], approvals: [], tasks: [], worktrees: [], settings: {}, tools: [], repos: [], archivedIds: [], lanes: [], validatedRestorePaths: [] });
  }));
  localStorage.setItem('o8:sidebar:visible', 'false');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); for (const timer of pendingTimers) clearTimeout(timer); pendingTimers.clear(); host.remove(); localStorage.clear(); resetComposerDraftMemoryForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


it.each([
  { width: 1440, initiallyOpen: false }, { width: 1440, initiallyOpen: true },
  { width: 1024, initiallyOpen: false }, { width: 1024, initiallyOpen: true },
])('restores a settled sidebar at $width with saved visibility $initiallyOpen', async ({ width, initiallyOpen }) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  localStorage.setItem('o8:sidebar:visible', String(initiallyOpen));
  localStorage.setItem('cortex-theme-palette', 'dark');
  localStorage.setItem('cortex-reduce-transparency', 'on');
  await import('@/components/desktop/workspace-terminal/OrchestratorTab');
  await act(async () => root.render(createElement(DashboardPage)));
  await vi.dynamicImportSettled();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }, { timeout: 10000 }).toBeGreaterThan(0);
  const aside = host.querySelector<HTMLElement>('#o8-chat-list')!;
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const workspace = input.closest('[data-o8-workspace-root]')!;
  await expect.poll(async () => { await settle(); return workspace.textContent; }).toContain('Retained existing result');
  await type(input, 'Keep the selected conversation draft.');
  const tabId = workspace.getAttribute('data-o8-active-tab-id');
  const footer = workspace.querySelector('[data-testid="composer-selector-footer"]');
  expect(footer).not.toBeNull();
  const modelAndEffort = footer!.textContent;
  const toggle = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Toggle sidebar"]')]
    .find(button => !button.closest('[aria-hidden="true"]'))!;
  const command = async (control = false) => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'b', metaKey: !control, ctrlKey: control, bubbles: true, cancelable: true,
  })));
  expect(aside.style.display).toBe(initiallyOpen && width >= 1280 ? 'flex' : 'none');
  if (aside.style.display === 'flex') await act(async () => toggle().click());
  expect(aside.style.display).toBe('none');
  // Hover and pointer departure do not turn a collapsed list into a pinned list.
  await act(async () => {
    toggle().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    toggle().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  await settle(); expect(aside.style.display).toBe('none');
  for (let repeat = 0; repeat < 2; repeat++) {
    await act(async () => toggle().click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: width - 20, clientY: 500 })));
    await settle();
    expect(aside.style.display).toBe('flex');
    expect(aside.getAttribute('aria-hidden')).toBe('false'); expect(aside.hasAttribute('inert')).toBe(false);
    await command(repeat === 1); expect(aside.style.display).toBe('none');
    await command(repeat === 1); await settle(); expect(aside.style.display).toBe('flex');
    expect(localStorage.getItem('o8:sidebar:visible')).toBe('true');
    expect(workspace.getAttribute('data-o8-active-tab-id')).toBe(tabId);
    expect(workspace.querySelector('textarea')).toBe(input); expect(input.value).toBe('Keep the selected conversation draft.');
    expect(footer!.textContent).toBe(modelAndEffort);
    expect(localStorage.getItem('cortex-theme-palette')).toBe('dark');
    expect(localStorage.getItem('cortex-reduce-transparency')).toBe('on');
    await command(); expect(aside.style.display).toBe('none');
  }
  expect(transport.sends).toEqual([]);
});
