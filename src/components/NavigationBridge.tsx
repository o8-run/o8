'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Renderer-side navigation bridge for the o8 webview MCP tools.
 *
 * Exposes `window.__o8Navigate__(path)` so the operator MCP server's
 * `o8_view_navigate` tool can drive Next.js App Router transitions via
 * `router.push()` instead of `webview.navigate()` (full reload) or
 * raw `pushState + popstate` (which doesn't always trigger soft
 * navigation across page route segments — eg. /context-graph ↔
 * /dashboard — and leaves Next.js mid-route, freezing the JS thread
 * for 10–30s of hydration).
 *
 * Mounted once in the root layout. See issue #863. The previous boot
 * site for tauri-plugin-mcp listener registration was retired in #932
 * phase 2 — the eval_and_await protocol invokes JS from Rust each call
 * instead of holding persistent listeners, so no JS-side init is needed.
 */
export default function NavigationBridge() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined' || (window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__) return;

    const navigate = (path: string) => {
      // router.push handles same-origin paths; absolute URLs fall back
      // to a full navigation as a safety net.
      try {
        router.push(path);
      } catch {
        window.location.assign(path);
      }
    };

    (window as unknown as { __o8Navigate__?: (path: string) => void }).__o8Navigate__ = navigate;

    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      if (detail && typeof detail.path === 'string') {
        navigate(detail.path);
      }
    };
    window.addEventListener('o8:navigate', onCustomEvent as EventListener);

    return () => {
      window.removeEventListener('o8:navigate', onCustomEvent as EventListener);
      const w = window as unknown as { __o8Navigate__?: (path: string) => void };
      if (w.__o8Navigate__ === navigate) {
        delete w.__o8Navigate__;
      }
    };
  }, [router]);

  return null;
}
