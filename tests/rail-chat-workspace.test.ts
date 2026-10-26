// @vitest-environment jsdom
import { act, createElement, useRef, useState, type HTMLAttributes } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from '@/components/desktop/shell/CompactNavigationRail';
import { TileContainer, type TileContentRegistry } from '@/components/desktop/TileContainer';
import { WorkspaceTerminal } from '@/components/desktop/WorkspaceTerminal';
import { OrchestratorDataProvider } from '@/components/desktop/orchestrator-data-context';
import { TILE_LAYOUT_STORAGE_KEY, useTileLayout } from '@/app/dashboard/hooks/useTileLayout';
import { createDefaultTileLayout, deserializeTileLayout, getFirstLeaf } from '@/lib/tiles/operations';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { resetComposerDraftMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, user: null }) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark', workspaceGlass: true, surface: 'glass' }) }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => undefined, useWsConnectionEpoch: () => 0, useWsConnectionState: () => 'disconnected' }));
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
const missionState = { version: 2 as const, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() };
let host: HTMLDivElement;
let root: Root;
let busyOwners = new Set<string>();
const trackBusy = (event: Event) => {
  const detail = (event as CustomEvent<{ tabId: string; busy: boolean }>).detail;
  if (detail.busy) busyOwners.add(detail.tabId);
};
function Workspace() {
  const [layout, setLayout] = useState(() => deserializeTileLayout(localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) ?? '') ?? createDefaultTileLayout());
  const [activeTileId, setActiveTileId] = useState<string | null>('tile-root');
  const controller = useTileLayout({ tileLayout: layout, setTileLayout: setLayout, activeTileId, setActiveTileId,
    activeWorkspaceChatSessionKey: undefined, contextualPanelHandlesRef: useRef(new Map<string, ContextualPanelHandle>()),
    workspaceTerminalHandlesRef: useRef(new Map<string, TerminalTabHandle>()),
    findInsertionTarget: () => getFirstLeaf(layout.root), findWorkspaceTarget: () => null,
    globalRepoEntries: [], globalRepoEntry: null, refreshRestoredRepoState: async () => true,
    workspaceChatTargetKeyByRepoPath: {}, workspaceChatTargets: [], workspaceSidePanelRepoPath: null,
    workspaceTerminalPreferredRepo: repo, waitForWorkspaceTerminalTarget: async () => { throw new Error('Unused'); },
  });
  const surface = { label: 'Workspace', description: 'Conversation', hideHeader: true,
    render: ({ active, content, tileId }: Parameters<TileContentRegistry['terminal']['render']>[0]) => createElement(WorkspaceTerminal, {
      stateScope: tileId, defaultTab: content.kind === 'terminal' && content.initialTab === 'terminal' ? 'terminal' : 'orchestrator',
      splitCreated: content.kind === 'terminal' && content.createdFromSplit, activeWorkspaceSurface: active,
      preferredRepo: repo, selectedRepo: repo, termWsConnected: false,
      sendTerminalCreate: noop, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop,
      sendTerminalVisibility: noop, sendTerminalDetach: noop,
    }) };
  const registry: TileContentRegistry = { terminal: surface, workspace: surface, preview: surface, canvas: surface, 'contextual-panel': surface };
  // eslint-disable-next-line react/no-children-prop -- required provider prop is replaced by the child arguments
  return createElement(OrchestratorDataProvider, { agents: [], missionState, workspaceTargets: [], onMissionStateChange: noop, children: null },
    createElement(CompactNavigationRail, { activeDestination: 'agents', glassSurface: true, onHome: noop, onNewSession: noop,
      onCreateTerminal: noop, onOpenProjects: noop, onOpenSettings: noop, onOpenShortcuts: noop, onOpenPRs: noop, onOpenUsage: noop }),
    createElement(TileContainer, { keepPrimarySessionAlive: true, activeTileId, layout, registry, onActivateTile: setActiveTileId,
      onCloseTile: controller.handleCloseTile, onResizeSplit: controller.handleResizeSplit, onSplitTile: controller.handleSplitTile }));
}
function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); target.dispatchEvent(event);
}
async function type(input: HTMLTextAreaElement, value: string) {
  expect(input.isConnected).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); }); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: noop });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel: noop }) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (text: string) => ({ width: text.length * 8 }) } as unknown as CanvasRenderingContext2D);
  localStorage.clear(); resetComposerDraftMemoryForTests(); transport.sockets = []; transport.sends = [];
  const saved = { version: 1, activeTabId: 'orchestrator-existing', savedAt: new Date().toISOString(), tabs: [{
    id: 'orchestrator-existing', kind: 'orchestrator', label: 'Existing conversation', repoPath: repo.localPath,
    repoName: repo.name, cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: 'thoughts-existing',
  }] };
  localStorage.setItem('fixture:terminal:tile-root', JSON.stringify(saved));
  localStorage.setItem('fixture:history:thoughts-existing', JSON.stringify({ repoPath: repo.localPath, title: 'Existing conversation', messages: [{ id: 'old-result', role: 'assistant', text: 'Retained existing result', timestamp: 1 }] }));
  busyOwners = new Set(); window.addEventListener('o8:orchestrator', trackBusy);
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
    return Response.json({ agents: [], conversations: [], packets: [], tools: [], repos: [], archivedIds: [], lanes: [], validatedRestorePaths: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { window.removeEventListener('o8:orchestrator', trackBusy); await act(async () => root.unmount()); host.remove(); localStorage.clear(); resetComposerDraftMemoryForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function emitTurn(turn: Record<string, unknown>, answer: string) {
  const data = { threadId: turn.threadId, userMessageId: 'user-' + turn.clientMessageId,
    assistantMessageId: 'answer-' + turn.clientMessageId, message: turn.displayMessage ?? turn.message, timestamp: Date.now() };
  for (const [event, extra] of [['turn-start', {}], ['status', { status: 'busy' }], ['output', { text: answer }], ['status', { status: 'ready' }]] as const) {
    await act(async () => {
      for (const socket of transport.sockets) socket.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event, data: { ...data, ...extra } }) } as MessageEvent);
    });
  }
  await settle();
}

it.each([false, true])('isolates a rail-created conversation when the fresh pane sends first: %s', async freshFirst => {
  await import('@/components/desktop/workspace-terminal/OrchestratorTab');
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Workspace))));
  await vi.dynamicImportSettled(); await settle();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }, { timeout: 10000 }).toBe(1);
  const older = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const oldPane = older.closest('[data-o8-workspace-root]')!;
  await expect.poll(async () => { await settle(); return oldPane.textContent; }).toContain('Retained existing result');
  await type(older, 'Unsent existing draft');
  const tile = host.querySelector<HTMLElement>('[data-tile-id="tile-root"]')!;
  vi.spyOn(tile, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 600));
  await act(async () => {
    pointer(host.querySelector('[aria-label="Run orchestrator"]')!, 'pointerdown', -20, 150);
    pointer(document, 'pointermove', 592, 150); pointer(document, 'pointerup', 592, 150);
  }); await settle(); await vi.dynamicImportSettled();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }).toBe(2);
  const fresh = [...host.querySelectorAll<HTMLTextAreaElement>('textarea')].find(input => input !== older)!;
  const newPane = fresh.closest('[data-o8-workspace-root]')!;
  expect(oldPane.getAttribute('data-o8-active-tab-id')).not.toBe(newPane.getAttribute('data-o8-active-tab-id'));
  expect(fresh.value).toBe(''); await type(fresh, 'New pane only');
  expect(older.value).toBe('Unsent existing draft');
  await act(async () => window.dispatchEvent(new CustomEvent('o8:thread-title-maybe-updated', { detail: { threadId: 'thoughts-existing' } })));
  await settle();
  const first = freshFirst ? fresh : older;
  const second = freshFirst ? older : fresh;
  const firstPane = freshFirst ? newPane : oldPane;
  const secondPane = freshFirst ? oldPane : newPane;
  await act(async () => { pointer(first, 'pointerdown', 100, 200); first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  await settle(); expect(transport.sends).toHaveLength(1);
  await emitTurn(transport.sends[0], 'First pane answer');
  expect(firstPane.textContent).toContain('First pane answer');
  expect(secondPane.textContent).not.toContain(freshFirst ? 'New pane only' : 'Unsent existing draft');
  expect(secondPane.textContent).not.toContain('First pane answer');
  expect(second.value).toBe(freshFirst ? 'Unsent existing draft' : 'New pane only');
  expect(busyOwners.has(secondPane.getAttribute('data-o8-active-tab-id')!)).toBe(false);
  await act(async () => { pointer(second, 'pointerdown', 700, 200); second.focus(); second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  await settle(); expect(transport.sends).toHaveLength(2);
  expect(transport.sends[0].threadId).not.toBe(transport.sends[1].threadId);
  await emitTurn(transport.sends[1], 'Second pane answer');
  expect(firstPane.textContent).not.toContain('Second pane answer');
  expect(secondPane.textContent).toContain('Second pane answer');
  expect(oldPane.textContent).toContain('Retained existing result');
  expect(newPane.textContent).not.toContain('Retained existing result');
  expect(host.textContent).not.toContain('This chat is preparing another message');
  await type(oldPane.querySelector('textarea')!, 'Existing next draft'); await type(newPane.querySelector('textarea')!, 'Fresh next draft');
  const oldId = oldPane.getAttribute('data-o8-active-tab-id')!;
  const newId = newPane.getAttribute('data-o8-active-tab-id')!;
  const scope = newPane.closest('[data-tile-id]')!.getAttribute('data-tile-id')!;
  await expect.poll(async () => {
    await settle();
    return JSON.parse(localStorage.getItem('fixture:terminal:' + scope) ?? '{}').tabs?.[0]?.orchestratorThreadId;
  }, { timeout: 3000 }).toBe(transport.sends[freshFirst ? 0 : 1].threadId);
  await expect.poll(async () => { await settle(); return localStorage.getItem('fixture:history:' + transport.sends[1].threadId); }, { timeout: 3000 }).toContain('Second pane answer');
  await act(async () => root.unmount()); resetComposerDraftMemoryForTests(); root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Workspace))));
  await vi.dynamicImportSettled();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }).toBe(2);
  const restoredOld = host.querySelector(`[data-o8-active-tab-id="${oldId}"]`)!;
  const restoredNew = host.querySelector(`[data-o8-active-tab-id="${newId}"]`)!;
  await expect.poll(async () => { await settle(); return restoredOld.querySelector('textarea')?.value; }).toBe('Existing next draft');
  await expect.poll(async () => { await settle(); return restoredNew.querySelector('textarea')?.value; }, { timeout: 3000 }).toBe('Fresh next draft');
  expect(restoredOld.textContent).toContain('Retained existing result');
  expect(restoredNew.textContent).not.toContain('Retained existing result');
  expect(transport.sends).toHaveLength(2);
});
