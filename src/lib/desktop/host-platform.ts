/**
 * Host platform of the native shell, stamped by Rust before first paint (#1743).
 *
 * `src-tauri/src/lib.rs` sets `window.__O8_HOST_PLATFORM__` from
 * `std::env::consts::OS` in the main window's `initialization_script`, which
 * WKWebView / WebView2 / WebKitGTK run at document-start — so the value is
 * readable SYNCHRONOUSLY from the pre-paint theme stamp in `<head>`, before any
 * Tauri IPC exists. That is why this is a window global and not
 * `getDesktopInfo()` (async invoke, far too late for the boot cover).
 *
 * The desktop chrome is built around macOS vibrancy: translucent panels paint
 * over an NSVisualEffectMaterial backdrop and the window controls are DOM-drawn
 * traffic lights over an overlay titlebar. Windows and Linux have neither, so
 * both consumers ask the same question — "is this a non-macOS shell?":
 *
 *   - theme (`src/lib/theme/context.tsx` + `pre-paint-stamp.ts`) forces
 *     `surface = 'solid'`, because translucent chrome would composite against
 *     nothing.
 *   - the header strips (`components/desktop/shell/TrafficLights.tsx`) render
 *     no window controls, because the OS draws real ones on a decorated window.
 *
 * ABSENT is macOS-equivalent on purpose: a plain browser, and any installed
 * shell older than this change, keep the existing behavior untouched.
 */

const NON_MAC_SHELLS = new Set(['windows', 'linux']);

function stampedPlatform(): unknown {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __O8_HOST_PLATFORM__?: unknown }).__O8_HOST_PLATFORM__;
}

/**
 * True only when the page is hosted by a Windows or Linux native shell.
 * False in a browser, on macOS, and on shells that predate the stamp.
 */
export function isNonMacShell(): boolean {
  const stamped = stampedPlatform();
  return typeof stamped === 'string' && NON_MAC_SHELLS.has(stamped);
}

/**
 * True only when the page is hosted by the Linux native shell, which exposes
 * Linux-only commands such as `system_tts_speak`.
 */
export function isLinuxShell(): boolean {
  return stampedPlatform() === 'linux';
}

/**
 * Local Linux patch: true when the Linux shell was launched with
 * O8_LINUX_GLASS=1 (stamped as window.__O8_LINUX_GLASS__ by lib.rs). There is
 * still no native vibrancy material, so the glass styling composites over a
 * painted backdrop (globals.css `html[data-linux-glass='true']`).
 */
export function isLinuxGlassShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __O8_HOST_PLATFORM__?: unknown; __O8_LINUX_GLASS__?: unknown };
  return w.__O8_HOST_PLATFORM__ === 'linux' && w.__O8_LINUX_GLASS__ === true;
}

/** True when the shell is non-macOS AND has no glass styling enabled. */
export function shellLacksGlass(): boolean {
  return isNonMacShell() && !isLinuxGlassShell();
}
