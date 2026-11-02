// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativeBrowserSurface } from './NativeBrowserSurface';

const bridge = vi.hoisted(() => ({ open: vi.fn(), setRect: vi.fn(), hide: vi.fn(), show: vi.fn(), viewport: vi.fn(async () => ({ w: window.innerWidth, h: window.innerHeight })), capture: vi.fn<() => Promise<string | null>>(async () => null) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, browserViewOpen: bridge.open, browserViewSetRect: bridge.setRect, browserViewHide: bridge.hide, browserViewShow: bridge.show, browserViewCapture: bridge.capture, browserViewViewportSize: bridge.viewport, browserViewClose: vi.fn() }));

it('moves the native browser page with its floating shell without requiring a resize', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => 'null' })));
  let intersect!: (entries: IntersectionObserverEntry[]) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pip = this.closest<HTMLElement>('[data-hover-pip]');
    if (this.dataset.o8NativeBrowser && pip) return new DOMRect(Number.parseFloat(pip.style.left), Number.parseFloat(pip.style.top) + 30, 440, 264);
    return new DOMRect();
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(createElement('div', { 'data-hover-pip': '', style: { position: 'fixed', left: 100, top: 120 } }, createElement(NativeBrowserSurface, { url: 'https://example.com/' }))));
    await act(async () => intersect([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry]));
    expect(bridge.open).toHaveBeenCalledWith('https://example.com/', { x: 100, y: 150, w: 440, h: 264 }, expect.any(String));
    const pip = host.querySelector<HTMLElement>('[data-hover-pip]')!;
    await act(async () => { pip.style.left = '200px'; pip.style.top = '220px'; await Promise.resolve(); });
    expect(bridge.setRect).toHaveBeenLastCalledWith({ x: 200, y: 250, w: 440, h: 264 });
  } finally {
    act(() => root.unmount()); host.remove(); measure.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});

it.each(['blurred root', 'painted child'])('keeps the native page live beneath a transparent %s portal and still occludes visible overlays', async (variant) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => 'null' })));
  let intersect!: (entries: IntersectionObserverEntry[]) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const portal = document.createElement('div');
  portal.style.opacity = '0';
  portal.style.backdropFilter = variant === 'blurred root' ? 'blur(24px)' : 'none';
  const body = document.createElement('div'); body.style.backgroundColor = 'rgb(38, 38, 38)'; portal.append(body);
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.o8NativeBrowser) return new DOMRect(100, 100, 440, 300);
    if (this === portal || portal.contains(this)) return new DOMRect(120, 120, 200, 100);
    if (this.style.height === '100vh') return new DOMRect(0, 0, 1, window.innerHeight);
    return new DOMRect();
  });
  const originalPoints = document.elementsFromPoint;
  document.elementsFromPoint = vi.fn(() => portal.isConnected ? [body] : [host.querySelector('[data-o8-native-browser]')!]);
  bridge.capture.mockResolvedValue('fixture-snapshot');
  try {
    act(() => root.render(createElement(NativeBrowserSurface, { url: `https://example.com/occlusion-${variant.replaceAll(' ', '-')}` })));
    await act(async () => intersect([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    bridge.hide.mockClear(); bridge.show.mockClear();
    await act(async () => { document.body.append(portal); await vi.advanceTimersByTimeAsync(600); });
    expect(bridge.hide).not.toHaveBeenCalled();
    expect(host.querySelector('img')?.style.display).toBe('none');
    await act(async () => { portal.style.opacity = '1'; await vi.advanceTimersByTimeAsync(600); });
    expect(bridge.hide).toHaveBeenCalledOnce();
    expect(host.querySelector('img')?.style.display).toBe('block');
    await act(async () => { portal.remove(); await vi.advanceTimersByTimeAsync(900); });
    expect(bridge.show).toHaveBeenCalledOnce();
    expect(host.querySelector('img')?.style.display).toBe('none');
    await act(async () => window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: true } })));
    expect(bridge.hide).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: false } })));
    expect(bridge.show).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount()); host.remove(); portal.remove(); measure.mockRestore();
    document.elementsFromPoint = originalPoints;
    bridge.capture.mockResolvedValue(null);
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});

it.each([0.8, 1.25])('uses the rendered host bounds at CSS UI zoom %s, independently of display scale', async (zoom) => {
  await geometryFixture(async ({ intersect, host, resize }) => {
    document.documentElement.style.zoom = String(zoom);
    const rect = new DOMRect(400 * zoom, 100 * zoom, 300 * zoom, 400 * zoom);
    host.getBoundingClientRect = () => rect;
    await act(async () => intersect(host, true));
    expect(bridge.open).toHaveBeenLastCalledWith(expect.any(String), { x: rect.x, y: rect.y, w: rect.width, h: rect.height, pageZoom: zoom }, expect.any(String));
    // Native page zoom shrinks the CSS viewport, unlike html.style.zoom.
    bridge.viewport.mockResolvedValue({ w: window.innerWidth * 1.25, h: window.innerHeight * 1.25 });
    await act(async () => resize());
    expect(bridge.setRect).toHaveBeenLastCalledWith(zoom === 0.8
      ? { x: 400, y: 100, w: 300, h: 400 }
      : { x: 625, y: 157, w: 468, h: 624, pageZoom: 1.5625 });
  });
});

it('does not let a hidden twin or a departing PiP hide or navigate the current native owner', async () => {
  await geometryFixture(async ({ intersect, host, container, render }) => {
    host.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300);
    await act(async () => intersect(host, true));
    const pip = document.createElement('div'); container.append(pip);
    await render(pip, bridge.open.mock.lastCall![0]);
    const pipHost = pip.querySelector<HTMLElement>('[data-o8-native-browser]')!;
    pipHost.getBoundingClientRect = () => new DOMRect(200, 200, 300, 200);
    await act(async () => intersect(pipHost, true));
    bridge.hide.mockClear(); bridge.open.mockClear();
    await act(async () => intersect(host, false));
    expect(bridge.hide).not.toHaveBeenCalled();
    // Reverse callback order on expansion: new owner appears before old exits.
    await act(async () => intersect(host, true));
    expect(bridge.open).not.toHaveBeenCalled();
    bridge.hide.mockClear();
    await act(async () => intersect(pipHost, false));
    expect(bridge.hide).not.toHaveBeenCalled();
    await act(async () => intersect(host, false));
    expect(bridge.hide).toHaveBeenCalledOnce();
  });
});

it('clips to an overflow ancestor, follows position-only layout motion, and hides a collapsed host before the observer fires', async () => {
  await geometryFixture(async ({ intersect, host, container }) => {
    container.style.overflowX = 'hidden'; container.style.overflowY = 'hidden';
    container.getBoundingClientRect = () => new DOMRect(100, 100, 350, 240);
    let rect = new DOMRect(100, 100, 400, 300);
    host.getBoundingClientRect = () => rect;
    await act(async () => intersect(host, true));
    expect(bridge.open).toHaveBeenLastCalledWith(expect.any(String), { x: 100, y: 100, w: 350, h: 240 }, expect.any(String));
    rect = new DOMRect(140, 130, 300, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.setRect).toHaveBeenLastCalledWith({ x: 140, y: 130, w: 300, h: 200 });
    bridge.hide.mockClear();
    container.style.display = 'none';
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.hide).toHaveBeenCalledOnce();
  });
});

it('insets fractional zoomed bounds so native rounding cannot paint outside the card', async () => {
  await geometryFixture(async ({ intersect, host }) => {
    host.getBoundingClientRect = () => new DOMRect(200.2, 65.59, 352, 211.19);
    await act(async () => intersect(host, true));
    expect(bridge.open).toHaveBeenLastCalledWith(expect.any(String), { x: 201, y: 66, w: 351, h: 210 }, expect.any(String));
  });
});

it('fits a PiP page viewport and text scale while its native bounds resize', async () => {
  await geometryFixture(async ({ intersect, host }) => {
    let rect = new DOMRect(100, 100, 400, 300);
    host.getBoundingClientRect = () => rect;
    await act(async () => intersect(host, true));
    expect(bridge.open).toHaveBeenLastCalledWith(expect.any(String), { x: 100, y: 100, w: 400, h: 300, pageZoom: 0.4 }, expect.any(String));
    rect = new DOMRect(140, 130, 300, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.setRect).toHaveBeenLastCalledWith({ x: 140, y: 130, w: 300, h: 200, pageZoom: 0.3 });
  }, 1000);
});

it('recovers from transient invalid geometry without another intersection event', async () => {
  await geometryFixture(async ({ intersect, host, container }) => {
    host.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300);
    container.style.opacity = '0';
    await act(async () => intersect(host, true));
    expect(bridge.open).not.toHaveBeenCalled();
    container.style.opacity = '1';
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.open).toHaveBeenCalledOnce();
    bridge.hide.mockClear(); bridge.show.mockClear();
    container.style.opacity = '0';
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.hide).toHaveBeenCalledOnce();
    container.style.opacity = '1';
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.show).toHaveBeenCalledOnce();
  });
});

it('discards a superseded URL calibration even when native viewport replies resolve out of order', async () => {
  await geometryFixture(async ({ intersect, host, updateUrl }) => {
    const replies: Array<(size: { w: number; h: number }) => void> = [];
    bridge.viewport.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    host.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300);
    await act(async () => intersect(host, true));
    await updateUrl('https://example.com/latest-geometry');
    expect(replies).toHaveLength(2);
    await act(async () => replies[1]({ w: window.innerWidth, h: window.innerHeight }));
    await act(async () => replies[0]({ w: window.innerWidth * 1.25, h: window.innerHeight * 1.25 }));
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.open.mock.lastCall?.[0]).toBe('https://example.com/latest-geometry');
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(bridge.setRect).not.toHaveBeenCalledWith(expect.objectContaining({ x: 125 }));
  });
});

let fixtureId = 0;
async function geometryFixture(check: (fixture: {
  intersect: (el: Element, visible: boolean) => void; host: HTMLElement; container: HTMLElement;
  resize: () => void; updateUrl: (url: string) => Promise<void>; render: (container: HTMLElement, url: string) => Promise<void>;
}) => Promise<void>, viewportWidth?: number) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers();
  bridge.viewport.mockResolvedValue({ w: window.innerWidth, h: window.innerHeight });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => 'null' })));
  const observers = new Map<Element, (entries: IntersectionObserverEntry[]) => void>();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: IntersectionObserverEntry[]) => void) {}
    observe(el: Element) { observers.set(el, this.callback); } disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.style.height === '100vh') return new DOMRect(0, 0, 1, window.innerHeight * Number(document.documentElement.style.zoom || 1));
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  });
  const points = document.elementsFromPoint;
  document.elementsFromPoint = () => [];
  const container = document.createElement('div'); document.body.append(container);
  const roots: ReturnType<typeof createRoot>[] = [];
  const render = async (node: HTMLElement, url: string) => {
    const root = createRoot(node); roots.push(root);
    await act(async () => root.render(createElement(NativeBrowserSurface, { url, viewportWidth })));
  };
  try {
    await render(container, `https://example.com/geometry-owner-${++fixtureId}`);
    const host = container.querySelector<HTMLElement>('[data-o8-native-browser]')!;
    await check({ intersect: (el, visible) => observers.get(el)!([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry]), host, container, resize: () => window.dispatchEvent(new Event('resize')), updateUrl: async (url) => { await act(async () => roots[0].render(createElement(NativeBrowserSurface, { url, viewportWidth }))); }, render });
  } finally {
    act(() => roots.reverse().forEach(root => root.unmount())); container.remove();
    document.documentElement.style.removeProperty('zoom'); document.elementsFromPoint = points;
    measure.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  }
}
