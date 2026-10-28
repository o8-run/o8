// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';

const tauriInvoke = vi.fn(async () => undefined);
const nativeViewport = vi.hoisted(() => ({ scale: 1, width: 1300, height: 850 }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  innerSize: async () => ({ width: nativeViewport.width, height: nativeViewport.height }),
  scaleFactor: async () => nativeViewport.scale,
}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

import { browserViewHide, getDesktopInfo, isMacHost, browserViewViewportSize, browserViewOpen, browserViewSetRect } from './bridge';

// browser_view_* Tauri commands are macOS-only; on Linux the dashboard mount
// spammed "Command browser_view_hide not found" (Debian 13, v0.1.810).

function stubUserAgent(ua: string): void {
  vi.stubGlobal('navigator', { ...navigator, userAgent: ua });
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  tauriInvoke.mockClear();
});

describe('browser_view_* commands are gated on a macOS host', () => {
  it('skips browser_view_hide off macOS but still invokes other commands', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15');
    expect(isMacHost()).toBe(false);
    await browserViewHide();
    expect(tauriInvoke).not.toHaveBeenCalled();
    await getDesktopInfo();
    expect(tauriInvoke).toHaveBeenCalledWith('get_desktop_info', undefined);
  });

  it('invokes browser_view_hide on macOS', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
    expect(isMacHost()).toBe(true);
    await browserViewHide();
    expect(tauriInvoke).toHaveBeenCalledWith('browser_view_hide', undefined);
  });
});

it.each([1, 2])('measures native logical viewport points on a %sx display without applying UI zoom', async (scale) => {
  nativeViewport.scale = scale; nativeViewport.width = 1300 * scale; nativeViewport.height = 850 * scale;
  document.documentElement.style.zoom = '0.8';
  try { expect(await browserViewViewportSize()).toEqual({ w: 1300, h: 850 }); }
  finally { document.documentElement.style.removeProperty('zoom'); }
});

it('carries page viewport zoom through the real open and geometry IPC wrappers', async () => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
  const rect = { x: 100, y: 100, w: 400, h: 300, pageZoom: 0.4 };
  await browserViewOpen('https://example.com/', rect);
  expect(tauriInvoke).toHaveBeenLastCalledWith('browser_view_open', { url: 'https://example.com/', ...rect });
  await browserViewSetRect({ ...rect, w: 300, pageZoom: 0.3 });
  expect(tauriInvoke).toHaveBeenLastCalledWith('browser_view_set_rect', { ...rect, w: 300, pageZoom: 0.3 });
});
