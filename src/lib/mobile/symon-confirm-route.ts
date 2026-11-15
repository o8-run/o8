export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { requirePanelAuth } from '@/lib/panel/auth';
import type { SymonConfirmationResolution } from '@/lib/mobile/symon-tool-relay';

const POLL_INTERVAL_MS = 100;
const CONFIRM_TIMEOUT_MS = 10_000;

function webviewClient(): O8WebviewClient {
  const g = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!g.__o8BrowserAgentClient) g.__o8BrowserAgentClient = new O8WebviewClient();
  return g.__o8BrowserAgentClient;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function buildConfirmEval(input: {
  sessionId: string;
  callId: string;
  confirmationId: string;
  allow: boolean;
  terminal?: 'expired' | 'preempted';
}): string {
  const sessionId = JSON.stringify(input.sessionId);
  const callId = JSON.stringify(input.callId);
  const confirmationId = JSON.stringify(input.confirmationId);
  const allow = JSON.stringify(input.allow);
  const terminal = JSON.stringify(input.terminal ?? null);
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    if (!A || typeof A.resolveConfirm !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const sessionId = ${sessionId};
    const callId = ${callId};
    const confirmationId = ${confirmationId};
    const allow = ${allow};
    const terminal = ${terminal};
    const calls = (w.__o8SymonToolCalls = w.__o8SymonToolCalls || {});
    const pairKey = JSON.stringify([sessionId, callId]);
    const slot = calls[pairKey];
    if (!slot || slot.confirmationId !== confirmationId) return JSON.stringify({ state: 'mismatch' });
    const decisions = (w.__o8SymonConfirmDecisions = w.__o8SymonConfirmDecisions || {});
    const decisionKey = JSON.stringify([sessionId, callId, confirmationId]);
    const NOW = Date.now();
    for (const key in decisions) {
      if (decisions[key] && NOW - (decisions[key].startedAt || 0) > 300000) delete decisions[key];
    }
    let decision = decisions[decisionKey];
    if (!decision) {
      decision = decisions[decisionKey] = { startedAt: NOW, allow, terminal, done: false };
      Promise.resolve().then(() => A.resolveConfirm(
        confirmationId,
        allow,
        { sessionId, callId },
        terminal || undefined,
      )).then((resolution) => {
        decision = decisions[decisionKey] = Object.assign(decisions[decisionKey] || {}, { done: true, resolution });
        if (resolution && resolution.status !== 'not_found') {
          slot.decisionSubmitted = true;
          slot.confirmResolution = resolution;
        }
      }).catch((error) => {
        decisions[decisionKey] = Object.assign(decisions[decisionKey] || {}, {
          done: true,
          error: String((error && error.message) || error),
        });
      });
    }
    if (decision.done && decision.error) {
      delete decisions[decisionKey];
      return JSON.stringify({ state: 'error', detail: decision.error });
    }
    if (decision.done) return JSON.stringify({ state: 'done', resolution: decision.resolution });
    return JSON.stringify({ state: 'pending' });
  })()`;
}

function isResolution(value: unknown): value is SymonConfirmationResolution {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.status === 'resolved' || record.status === 'already_resolved') {
    return typeof record.allow === 'boolean';
  }
  return record.status === 'expired' || record.status === 'preempted' || record.status === 'not_found';
}

async function resolveViaBridge(input: {
  sessionId: string;
  callId: string;
  confirmationId: string;
  allow: boolean;
  terminal?: 'expired' | 'preempted';
}): Promise<{ ok: true; resolution: SymonConfirmationResolution } | { ok: false; error: string; detail?: string }> {
  const client = webviewClient();
  const code = buildConfirmEval(input);
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let sawBridge = false;

  while (Date.now() < deadline) {
    let parsed: { state?: string; resolution?: unknown; detail?: string };
    try {
      const { result } = await client.evalJs(code);
      parsed = JSON.parse(result);
    } catch (error) {
      if (!sawBridge) {
        return { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : undefined };
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    sawBridge = true;
    if (parsed.state === 'no_bridge') return { ok: false, error: 'desktop_unavailable' };
    if (parsed.state === 'mismatch') return { ok: false, error: 'confirmation_mismatch' };
    if (parsed.state === 'error') return { ok: false, error: 'confirmation_failed', detail: parsed.detail };
    if (parsed.state === 'done') {
      return isResolution(parsed.resolution)
        ? { ok: true, resolution: parsed.resolution }
        : { ok: false, error: 'confirmation_failed', detail: 'Invalid desktop resolution.' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: 'confirmation_timeout' };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const confirmationId = typeof body?.confirmationId === 'string' ? body.confirmationId : '';
  const allow = typeof body?.allow === 'boolean' ? body.allow : null;
  const terminal = body?.terminal === 'expired' || body?.terminal === 'preempted'
    ? body.terminal
    : undefined;
  const invalidTerminal = body?.terminal !== undefined && terminal === undefined;
  if (!sessionId || !callId || !confirmationId || allow === null || invalidTerminal || (allow && terminal)) {
    return NextResponse.json({ ok: false, error: 'bad_request' });
  }

  return NextResponse.json(await resolveViaBridge({
    sessionId,
    callId,
    confirmationId,
    allow,
    ...(terminal ? { terminal } : {}),
  }));
}
