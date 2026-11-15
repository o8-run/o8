import { NextResponse } from 'next/server';

const REASON = 'The canvas runs in the desktop app window that Next serves, so canvas intents need Next running.';

/**
 * The canvas intent bus as the WS process answers it. Intents drive the canvas page that Next
 * renders in the desktop app's webview, so without Next there is no canvas to drive, and o8 next
 * has none of its own. A 4xx carries the reason to MCP callers, which report 4xx error text and
 * do not retry it; a 5xx would reach them as a bare status after retries.
 */
export function POST(): Response {
  return NextResponse.json(
    { ok: false, error: REASON, code: 'canvas_unavailable' },
    { status: 409, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
