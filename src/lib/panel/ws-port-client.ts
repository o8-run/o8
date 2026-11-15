/**
 * Browser-side WS port resolver.
 *
 * The native sidecar records the selected ws-server port. The shell layout
 * (`src/components/shell-layout.tsx`) resolves it server-side and injects
 * the value as `window.__O8_WS_PORT__`
 * before any client code runs.
 *
 * Browser hooks call `getBrowserWsPort()` instead of hardcoding a port. Legacy
 * dev workflows (`npm run dev` without Tauri) fall back to DEFAULT_WS_PORT,
 * which matches the port ws-server binds to when no override is set.
 */

import { DEFAULT_WS_PORT } from '@/lib/panel/port-constants';

declare global {
  interface Window {
    __O8_WS_PORT__?: number;
  }
}

export function getBrowserWsPort(): number {
  if (typeof window === 'undefined') return DEFAULT_WS_PORT;
  const injected = window.__O8_WS_PORT__;
  if (typeof injected === 'number' && Number.isInteger(injected) && injected > 0 && injected < 65536) {
    return injected;
  }
  return DEFAULT_WS_PORT;
}
