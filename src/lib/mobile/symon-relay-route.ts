export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { loadPersistedAgentSession } from '@/lib/mobile/symon-agent-registry';

/**
 * Mobile Symon remote — gated in middleware (loopback + ws-token, the whole
 * /api/mobile/ family).
 *
 * The phone (o8-mobile) drives the desktop's voice-to-voice Symon the same way
 * double-tap Right ⌘ does: this POST rides an `o8:symon-remote-toggle`
 * CustomEvent into the running webview, where RealtimeVoiceHost's listener calls
 * the EXACT toggle() the hotkey calls. The mic + WebRTC session stay on the Mac
 * — the phone is only the trigger. GET reads back the live RealtimeStatus so the
 * phone can reflect idle/connecting/live without owning the session.
 */

interface SymonProbe {
  ready: boolean;
  status: string;
}

function webviewClient(): O8WebviewClient {
  // Reuse the single per-server socket connection (shared with
  // /api/browser/agent and /api/canvas/intent).
  const store = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!store.__o8BrowserAgentClient) store.__o8BrowserAgentClient = new O8WebviewClient();
  return store.__o8BrowserAgentClient;
}

const STATUS_EVAL = `(() => {
  const w = window;
  return JSON.stringify({
    ready: w.__o8SymonRemoteReady === true,
    status: typeof w.__o8RealtimeStatus === 'string' ? w.__o8RealtimeStatus : 'idle',
  });
})()`;

const TOGGLE_EVAL = `(() => {
  const w = window;
  if (w.__o8SymonRemoteReady !== true) {
    return JSON.stringify({ ready: false, status: 'idle' });
  }
  w.dispatchEvent(new CustomEvent('o8:symon-remote-toggle'));
  return JSON.stringify({
    ready: true,
    status: typeof w.__o8RealtimeStatus === 'string' ? w.__o8RealtimeStatus : 'idle',
  });
})()`;

async function probe(code: string): Promise<SymonProbe> {
  const { result } = await webviewClient().evalJs(code);
  return JSON.parse(result) as SymonProbe;
}

function bridgeError(error: unknown, verb: string) {
  return NextResponse.json({
    ok: false,
    error: error instanceof Error ? error.message : `symon ${verb} bridge failed`,
    hint: 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
  });
}

/**
 * Additive Agent-mode field (docs/internals/symon-agent-mode.md §GET). Reads the disk
 * mirror of the process-local activeAgentSession registry that the ws-server
 * owns — null unless a phone-hosted Agent session is live. Never affects the
 * existing Remote-mode `ready`/`status` shape.
 */
function agentSessionField(): { sessionId: string; startedAt: number; status: string } | null {
  const record = loadPersistedAgentSession();
  if (!record) return null;
  return { sessionId: record.sessionId, startedAt: record.startedAt, status: record.lastStatus };
}

export async function GET() {
  const agentSession = agentSessionField();
  try {
    const probed = await probe(STATUS_EVAL);
    return NextResponse.json({ ok: true, ready: probed.ready, status: probed.status, agentSession });
  } catch (error) {
    // Remote-mode bridge probe failed, but the Agent-session field is derived
    // from the registry mirror (independent of the webview), so still surface it.
    const res = bridgeError(error, 'status');
    const payload = await res.json();
    return NextResponse.json({ ...payload, agentSession });
  }
}

export async function POST() {
  try {
    const probed = await probe(TOGGLE_EVAL);
    if (!probed.ready) {
      return NextResponse.json({
        ok: false,
        error: 'Symon voice host is not mounted in the webview — is the o8 dashboard open?',
      });
    }
    // status here is PRE-toggle (start/stop is async); the phone polls GET to
    // converge on the real idle/connecting/live state.
    return NextResponse.json({ ok: true, status: probed.status });
  } catch (error) {
    return bridgeError(error, 'toggle');
  }
}
