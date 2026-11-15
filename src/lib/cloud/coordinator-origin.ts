import type { NextRequest } from 'next/server';
import { isLoopbackHostname } from '@/lib/auth/loopback-request';
import { isTrustedPanelRequest } from '@/lib/panel/auth';
import { O8_PAGE_ORIGIN_HEADER } from '@/lib/ws-server/native-owner';

/** The coordinator's loopback page that may frame a task preview, or null. */
export function coordinatorOrigin(request: NextRequest): string | null {
  // The packaged Next server may bind 0.0.0.0 (O8_LAN_ACCESS), so nextUrl is not the client's
  // origin. Socket-peer truth must still win over a spoofed loopback Host.
  if (!isTrustedPanelRequest(request)) return null;
  // Next checked the browser's page before forwarding to the WS listener, whose Host is its own.
  const forwarded = request.headers.get(O8_PAGE_ORIGIN_HEADER);
  if (forwarded !== null) {
    try {
      const page = new URL(forwarded);
      return page.origin === forwarded && ['http:', 'https:'].includes(page.protocol) && isLoopbackHostname(page.hostname) ? forwarded : null;
    } catch { return null; }
  }
  const host = request.headers.get('host');
  if (!host) return null;
  try {
    const url = new URL(`${request.nextUrl.protocol}//${host}`);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackHostname(url.hostname)
      && url.host === host && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin : null;
  } catch { return null; }
}
