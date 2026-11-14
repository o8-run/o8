// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => undefined; },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({ active: false }) }));

let root: Root;
let dom: JSDOM;
const bodies: { action: string; snapshot?: { hud?: { placement?: unknown; surface?: string } } }[] = [];
beforeEach(() => {
  vi.useFakeTimers(); handlers.clear(); bodies.length = 0;
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ native: true, enabled: true }));
  }));
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const emit = async (name: string, payload: unknown) => { await act(async () => { handlers.get(name)?.({ payload }); }); };

it('carries the anchor the shell sends just before the start event into the native frame', async () => {
  const { default: AgentPartialsPage } = await import('./page');
  await act(async () => { root.render(createElement(AgentPartialsPage)); });
  await tick(50);
  expect(handlers.has('o8:agent-partials-placement')).toBe(true);
  // The real order: show() anchors the window, then the start event follows.
  await emit('o8:agent-partials-placement', { surface: 'caret', x: 300, y: 200, width: 460, height: 138 });
  await emit('o8:stt-event', { type: 'system-start', origin: 'system', hud: true, surface: 'caret', mode: 'dictation' });
  await emit('o8:stt-event', { type: 'status', origin: 'system', text: 'listening' });
  await tick(300);
  const frames = bodies.filter(body => body.action === 'frame');
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.at(-1)?.snapshot?.hud).toMatchObject({ surface: 'caret', placement: { x: 300, y: 200, width: 460, height: 138 } });
});
