// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DashboardPage from './page';
import { getQueryClient } from '@/lib/query/client';

const chunks = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve, started: false };
  };
  return { o8: deferred(), review: deferred() };
});
vi.mock('@/components/desktop/O8Panel', async () => {
  chunks.o8.started = true;
  await chunks.o8.promise;
  return { O8Panel: () => createElement('div', null, 'Panel loaded') };
});
vi.mock('@/components/desktop/review/ReviewPanel', async () => {
  chunks.review.started = true;
  await chunks.review.promise;
  return { ReviewPanel: () => createElement('div', null, 'Panel loaded') };
});
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, user: null, isLoaded: true, clerkEnabled: false }) }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({
  DesktopWebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
  useSharedDesktopWs: () => ({ connectionState: 'disconnected', sendTerminalCreate() {}, sendTerminalAttach() {}, sendTerminalInput() {}, sendTerminalResize() {}, sendTerminalVisibility() {}, sendTerminalDetach() {} }),
  useWsConnectionEpoch: () => 0, useWsConnectionState: () => 'disconnected',
}));
vi.mock('@/components/desktop/TileContainer', () => ({ TileContainer: () => null }));
vi.mock('@/components/desktop/AgentPanel', () => ({ AgentPanel: () => null }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));

it.each(['o8', 'review'] as const)('shows an in-panel loading state while the %s chunk is pending', async kind => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  getQueryClient().clear();
  localStorage.clear();
  localStorage.setItem('o8:right-panel:visible', '1');
  localStorage.setItem('o8:right-panel:kind', kind);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/setup/config') return Response.json({ setupComplete: true });
    return Response.json({ agents: [], conversations: [], packets: [], projects: [], approvals: [], tasks: [], worktrees: [], settings: {}, tools: [], repos: [], archivedIds: [], lanes: [], validatedRestorePaths: [] });
  }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DashboardPage)));
    await vi.waitFor(() => expect(chunks[kind].started).toBe(true));
    const panel = host.querySelector('[data-mcp-scope="chat-panel"]')!;
    const loading = panel.querySelector<HTMLElement>('[aria-label="Loading workspace"]');
    expect(loading).not.toBeNull();
    expect(loading?.style.position).not.toBe('fixed');
    await act(async () => { chunks[kind].resolve(); await chunks[kind].promise; });
    await vi.waitFor(() => expect(panel.textContent).toContain('Panel loaded'));
    expect(panel.querySelector('[aria-label="Loading workspace"]')).toBeNull();
  } finally {
    await act(async () => { chunks[kind].resolve(); await chunks[kind].promise; root.unmount(); });
    host.remove(); localStorage.clear(); getQueryClient().clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
