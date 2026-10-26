// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';

const tauriInvoke = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

import { browserViewHide, getDesktopInfo, isMacHost } from './bridge';

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
