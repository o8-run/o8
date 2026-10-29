// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ events: new Map<string, (event: { payload: unknown }) => void>(), invoke: vi.fn(async () => {}), emit: vi.fn(async () => {}) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: bridge.emit, listen: async (name: string, handler: (event: { payload: unknown }) => void) => { bridge.events.set(name, handler); return () => bridge.events.delete(name); } }));
const { default: SpatialInkPage } = await import('./page');
let root: Root; let node: HTMLDivElement;
async function event(name: string, payload: unknown) { await act(async () => bridge.events.get(name)?.({ payload })); }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); bridge.events.clear();
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {} } as unknown as CanvasRenderingContext2D);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(React.createElement(SpatialInkPage)));
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows a passive input below live ink and fences old native events without opening an editor', async () => {
  await event('o8:visual-capture-begin', { id: 'capture-owned', generation: 42 });
  expect(bridge.invoke).toHaveBeenCalledWith('o8_visual_capture_ready', { id: 'capture-owned', generation: 42 });
  const point = (x: number, y: number, t: number) => ({ x, y, t });
  await event('o8:visual-capture-ink', { id: 'capture-owned', generation: 41, phase: 'start', point: point(0.2, 0.2, 0) });
  expect(node.querySelector('textarea')).toBeNull();
  for (const [phase, p] of [['start', point(0.2, 0.2, 200)], ['move', point(0.3, 0.3, 400)], ['end', point(0.3, 0.3, 400)]] as const) {
    await event('o8:visual-capture-ink', { id: 'capture-owned', generation: 42, phase, point: p });
  }
  const input = node.querySelector('textarea')!;
  expect(input).not.toBeNull(); expect(document.activeElement).not.toBe(input);
  expect(node.querySelector('[aria-label="Instruction for marked area"]')).not.toBeNull();
  expect(node.textContent).toContain('Finish'); expect(node.querySelector('[role="dialog"]')).toBeNull();
  await event('o8:visual-capture-finish', { id: 'capture-owned', generation: 41 });
  expect(bridge.emit).not.toHaveBeenCalledWith('o8:spatial-ink-strokes', expect.anything());
  await event('o8:visual-capture-finish', { id: 'capture-owned', generation: 42 });
  expect(bridge.emit).toHaveBeenCalledWith('o8:spatial-ink-strokes', expect.objectContaining({ visualCaptureId: 'capture-owned', visualCaptureGeneration: 42 }));
});
it('keeps a reduced-motion mark visible when a move repeats the first point', async () => {
  await act(async () => root.unmount());
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('Path2D', class { constructor(readonly d: string) {} });
  const fill = vi.fn(); const arc = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {}, beginPath() {}, arc, fill, createRadialGradient: () => ({ addColorStop() {} }) } as unknown as CanvasRenderingContext2D);
  root = createRoot(node);
  await act(async () => root.render(React.createElement(SpatialInkPage)));
  await event('o8:visual-capture-begin', { id: 'capture-still', generation: 7 });
  for (const phase of ['start', 'move'] as const) {
    await event('o8:visual-capture-ink', { id: 'capture-still', generation: 7, phase, point: { x: 0.5, y: 0.5, t: phase === 'start' ? 0 : 16 } });
  }
  await act(async () => frame?.(0));
  expect(fill).toHaveBeenCalled();
  expect(arc).toHaveBeenCalledWith(512, 384, 2.6, 0, Math.PI * 2);
});
