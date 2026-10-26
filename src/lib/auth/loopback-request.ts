/**
 * Loopback-request detection shared by the middleware gate and any server
 * component that must decide whether a request came from this machine.
 *
 * A loopback Host is required before either tier of peer evidence:
 *
 * 1. `x-o8-client-addr` — stamped by the bundled production server
 *    (out/server/server.js wrapper, see scripts/tauri-export.mjs) with the
 *    REAL TCP peer address on every request, overwriting any client-supplied
 *    value. A local peer alone never authorizes a foreign Host.
 *
 * 2. Host-header heuristic — dev fallback only (`next dev` / dev-bridge run
 *    Next's stock server which doesn't stamp the header). A direct client can
 *    spoof Host, so this tier is best-effort.
 */

import { isLoopbackHost } from '../../../scripts/lib/http-request-boundary.cjs';

export const O8_CLIENT_ADDR_HEADER = 'x-o8-client-addr';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Origins the Tauri shell itself serves the boot/loader page from. WebKit
 * (macOS/Linux) uses the custom scheme `tauri://localhost`; WebView2 (Windows)
 * maps the same app content to `http(s)://tauri.localhost` instead. Exact
 * strings only — deliberately NOT a `*.localhost` suffix match: browsers
 * resolve every `*.localhost` name to loopback, so a suffix rule would let any
 * web page served from e.g. `evil.localhost` through the gate.
 */
const TAURI_SHELL_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

/** True when an Origin header value is the Tauri shell's own boot-page origin. */
export function isTauriShellOrigin(origin?: string | null): boolean {
  return origin != null && TAURI_SHELL_ORIGINS.has(origin);
}

/** True when a raw socket address (req.socket.remoteAddress) is loopback. */
export function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false;
  // Node reports IPv4-mapped IPv6 as ::ffff:127.0.0.1.
  const stripped = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return stripped === '::1' || stripped === '127.0.0.1' || stripped.startsWith('127.');
}

/** True when a Host-style hostname (no port) is loopback. */
export function isLoopbackHostname(hostname?: string | null): boolean {
  if (!hostname) return false;
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return LOOPBACK_HOSTNAMES.has(stripped);
}

/**
 * Extract the hostname from a Host-header value, handling bracketed IPv6
 * (`[::1]:3001` → `[::1]`) — a naive split(':') returns `[` for those.
 */
export function hostHeaderToHostname(host?: string | null): string | null {
  if (!host) return null;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  return host.split(':')[0] ?? null;
}

/**
 * Decide loopback-ness from request headers. `get` abstracts over
 * NextRequest.headers / next/headers so both middleware and server
 * components can share the logic.
 */
export function headersIndicateLoopback(get: (name: string) => string | null): boolean {
  if (!isLoopbackHost(get('host'))) return false;
  const clientAddr = get(O8_CLIENT_ADDR_HEADER);
  if (clientAddr) return isLoopbackAddress(clientAddr);
  return isLoopbackHostname(hostHeaderToHostname(get('host')));
}
