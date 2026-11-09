import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { buildMachineSessionEndEval } from '@/lib/mobile/symon-tool-eval';

const POLL_MS = 50;
const TIMEOUT_MS = 5_000;

export type MachineSessionEndResult =
  | { status: 200; body: { ok: true; removed: boolean } }
  | { status: 400 | 502 | 503 | 504; body: { ok: false; error: string; detail: string } };

function client(): O8WebviewClient {
  const global = globalThis as { __o8SymonMachineSessionClient?: O8WebviewClient };
  global.__o8SymonMachineSessionClient ??= new O8WebviewClient();
  return global.__o8SymonMachineSessionClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ends a Symon machine session in the desktop webview's machine bridge. The webview socket is
 * reachable from any o8 server process, so the WS server calls this directly rather than through
 * Next; /api/symon/machine/session serves the same function over HTTP.
 */
export async function endSymonMachineSession(sessionId: string): Promise<MachineSessionEndResult> {
  if (!sessionId || sessionId.length > 160) {
    return { status: 400, body: { ok: false, error: 'bad_request', detail: 'A bounded sessionId is required.' } };
  }
  const code = buildMachineSessionEndEval(sessionId);
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const { result } = await client().evalJs(code);
      const parsed = JSON.parse(result) as { state?: string; removed?: boolean; detail?: string };
      if (parsed.state === 'no_bridge') {
        return { status: 503, body: { ok: false, error: 'desktop_unavailable', detail: 'The Symon machine bridge is not mounted.' } };
      }
      if (parsed.state === 'error') {
        return { status: 502, body: { ok: false, error: 'cleanup_failed', detail: parsed.detail || 'Machine-session cleanup failed.' } };
      }
      if (parsed.state === 'done') return { status: 200, body: { ok: true, removed: parsed.removed === true } };
      await sleep(POLL_MS);
    }
    return { status: 504, body: { ok: false, error: 'cleanup_timeout', detail: 'Machine-session cleanup timed out.' } };
  } catch (error) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'desktop_unavailable',
        detail: error instanceof Error ? error.message : 'Machine-session cleanup bridge failed.',
      },
    };
  }
}
