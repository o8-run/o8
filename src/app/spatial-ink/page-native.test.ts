// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ events: new Map<string, (event: { payload: unknown }) => void>(), invoke: vi.fn(async () => {}), emit: vi.fn(async () => {}) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'token' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: bridge.emit, listen: async (name: string, handler: (event: { payload: unknown }) => void) => { bridge.events.set(name, handler); return () => bridge.events.delete(name); } }));
const { default: SpatialInkPage } = await import('./page');

type Body = Record<string, unknown>;
let root: Root; let node: HTMLDivElement;
let answer: (body: Body) => unknown | 'hang';
const bodies: Body[] = [];
const MONITOR = { x: 0, y: 0, width: 1024, height: 768 };

async function event(name: string, payload: unknown) { await act(async () => bridge.events.get(name)?.({ payload })); }
async function pointer(type: string, x: number, y: number) {
  await act(async () => { window.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y }), { pointerId: 1 })); });
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const emitted = (name: string) => bridge.emit.mock.calls.filter(call => (call as unknown[])[0] === name).map(call => (call as unknown[])[1] as Body);
async function hold() {
  await event('o8:spatial-ink-armed', { generation: 12, monitor: MONITOR, scale: 2 });
  await event('o8:stt-event', { type: 'system-start', origin: 'system', lane: 'agent' });
  await advance(0);
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks(); bridge.events.clear(); bodies.length = 0;
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Path2D', class { constructor(readonly d: string) {} });
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body;
    bodies.push(body);
    const reply = answer(body);
    if (reply === 'hang') return new Promise(() => {});
    return Promise.resolve({ ok: true, json: async () => reply });
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, createRadialGradient: () => ({ addColorStop() {} }) } as unknown as CanvasRenderingContext2D);
  Object.assign(window, { innerWidth: 1024, innerHeight: 768 });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(React.createElement(SpatialInkPage)));
  await advance(0);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('flag on: hands the pointer to the native panel and relays its points through the same events', async () => {
  let frames = 0;
  answer = (body) => {
    if (body.action === 'arm') return { enabled: true, native: true, capturing: true, next: 0 };
    if (body.action === 'frame') return ++frames === 1
      ? { enabled: true, native: true, capturing: true, points: [[0, 0.25, 0.5, 0], [0, 0.5, 0.5, 16]], next: 2 }
      : { enabled: true, native: true, capturing: true, next: 2 };
    return { enabled: true, native: true, capturing: false, disarmed: 'handoff', points: [[0, 0.75, 0.5, 32]], next: 3 };
  };
  await hold();
  expect(bodies[0]).toMatchObject({ action: 'arm', surface: 'ink', session: 1, monitor: MONITOR, reducedMotion: false });
  expect(emitted('o8:spatial-ink-pointer')).toEqual([{ generation: 12, owner: 'native' }]);
  // The web window captures nothing for this hold.
  await pointer('pointerdown', 10, 10);
  await pointer('pointermove', 20, 20);
  await pointer('pointerup', 20, 20);
  expect(emitted('o8:spatial-ink-first-stroke')).toEqual([]);
  await advance(100);
  expect(bodies[1]).toMatchObject({ action: 'frame', session: 1, from: 0 });
  expect(emitted('o8:spatial-ink-first-stroke')).toHaveLength(1);
  await event('o8:stt-event', { type: 'final', origin: 'system', sessionId: 5, text: 'look here' });
  await advance(0);
  expect(bodies.at(-1)).toMatchObject({ action: 'release', session: 1, handoff: true, from: 2 });
  expect(emitted('o8:spatial-ink-strokes')).toEqual([{
    sessionId: 5, visualCaptureId: null, visualCaptureGeneration: null, instruction: '',
    strokes: [{ points: [{ x: 0.25, y: 0.5, t: 0 }, { x: 0.5, y: 0.5, t: 16 }, { x: 0.75, y: 0.5, t: 32 }] }],
    viewport: { w: 1024, h: 768, scale: 1 },
  }]);
  // Teardown after the handoff sends nothing more to the panel.
  const sent = bodies.length;
  await event('o8:stt-event', { type: 'system-idle', origin: 'system', lane: 'agent' });
  await event('o8:spatial-ink-clear', {});
  await advance(500);
  expect(bodies).toHaveLength(sent);
});

it('flag off: one arm request answers disabled and the web draws as before', async () => {
  answer = () => ({ native: false, enabled: false });
  await hold();
  expect(bodies).toHaveLength(1);
  expect(emitted('o8:spatial-ink-pointer')).toEqual([]);
  await pointer('pointerdown', 512, 384);
  await pointer('pointermove', 768, 384);
  await pointer('pointerup', 768, 384);
  expect(emitted('o8:spatial-ink-first-stroke')).toHaveLength(1);
  await event('o8:stt-event', { type: 'final', origin: 'system', sessionId: 2, text: 'x' });
  const [strokes] = emitted('o8:spatial-ink-strokes');
  expect((strokes.strokes as Array<{ points: Array<{ x: number; y: number }> }>)[0].points.map(p => [p.x, p.y])).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  await advance(1000);
  expect(bodies).toHaveLength(1);
});

it('no acknowledgement: the web keeps the pointer for the whole hold', async () => {
  answer = () => 'hang';
  await hold();
  await pointer('pointerdown', 100, 100);
  await advance(400);
  expect(emitted('o8:spatial-ink-pointer')).toEqual([]);
  await pointer('pointermove', 200, 100);
  await pointer('pointerup', 200, 100);
  await event('o8:stt-event', { type: 'final', origin: 'system', sessionId: 3, text: 'x' });
  expect(emitted('o8:spatial-ink-strokes')[0].strokes).toHaveLength(1);
});

it('a lost keep-alive gives the hold back to the web with the points drawn so far', async () => {
  let frames = 0;
  answer = (body) => {
    if (body.action === 'arm') return { enabled: true, native: true, capturing: true };
    if (body.action === 'frame') return ++frames === 1 ? { enabled: true, native: true, capturing: true, points: [[0, 0.1, 0.1, 0]], next: 1 } : 'hang';
    return { enabled: true, native: true };
  };
  await hold();
  await advance(100);
  await advance(100 + 350);
  expect(emitted('o8:spatial-ink-pointer')).toEqual([{ generation: 12, owner: 'native' }, { generation: 12, owner: 'web' }]);
  expect(bodies.at(-1)).toMatchObject({ action: 'release', immediate: true });
  // The web owns the rest of the hold and ships both the panel's and its own strokes.
  await pointer('pointerdown', 512, 384);
  await pointer('pointerup', 512, 384);
  await event('o8:stt-event', { type: 'final', origin: 'system', sessionId: 4, text: 'x' });
  const strokes = emitted('o8:spatial-ink-strokes')[0].strokes as Array<{ points: Array<{ x: number; y: number }> }>;
  expect(strokes.map(stroke => stroke.points.length)).toEqual([1, 1]);
  expect(strokes[0].points[0].x).toBeCloseTo(0.1); expect(strokes[0].points[0].y).toBeCloseTo(0.1);
  expect(strokes[1].points[0]).toMatchObject({ x: 0.5, y: 0.5 });
});
