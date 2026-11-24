import { O8_CLIENT_ADDR_HEADER } from '@/lib/auth/loopback-request';

export const O8_RELAY_FORWARD_HEADER = 'x-o8-relay-forward';
export const O8_RELAY_FORWARD_MARKER = 'o8-relay-forward';
export const O8_RELAY_SURFACE_HEADER = 'x-o8-relay-surface';
export const O8_WEB_MACHINE_SURFACE = 'web-machine';
export const O8_AUTH_MODE_META = 'o8-auth-mode';

/**
 * A web-machine request must carry all three server-derived relay facts. The
 * packaged HTTP wrapper canonicalizes these headers from the loopback relay
 * connector, so a remote client cannot turn itself into a trusted local page.
 */
export function headersIndicateWebMachineRelay(
  get: (name: string) => string | null,
): boolean {
  return get(O8_CLIENT_ADDR_HEADER) === O8_RELAY_FORWARD_MARKER
    && get(O8_RELAY_FORWARD_HEADER) === '1'
    && get(O8_RELAY_SURFACE_HEADER) === O8_WEB_MACHINE_SURFACE;
}

/**
 * The only requests a relayed web-machine stream may replay: reads of the
 * desktop-app notice pages and the static files they load. The browser console
 * is gone, so no API route, write or realtime traffic is reachable this way.
 */
const WEB_MACHINE_PAGES = new Set(['/', '/mobile', '/dashboard', '/icon.png', '/favicon.ico']);

export function webMachineRouteAllowed(method: unknown, path: unknown): boolean {
  // Same default as the replay itself: a frame without a method is a GET.
  const verb = typeof method === 'string' ? method.toUpperCase() : method === undefined ? 'GET' : '';
  if (verb !== 'GET' && verb !== 'HEAD') return false;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\') || path.includes('..') || /%2e|%2f|%5c/i.test(path)) return false;
  const pathname = path.split(/[?#]/, 1)[0]!;
  const page = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return WEB_MACHINE_PAGES.has(page) || pathname.startsWith('/_next/static/');
}

export interface WebMachineBrowserTransport {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  openWebSocket: (path: '/ws') => WebSocket;
}

declare global {
  interface Window {
    __O8_WEB_MACHINE_TRANSPORT__?: WebMachineBrowserTransport;
  }
}

export function isWebMachineBrowserSurface(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(`meta[name="${O8_AUTH_MODE_META}"]`)
    ?.getAttribute('content') === O8_WEB_MACHINE_SURFACE;
}
