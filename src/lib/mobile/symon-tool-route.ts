export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { toolErrorResult } from '@/lib/mobile/symon-tool-relay';
import { phoneToolServer } from '@/lib/symon/execution/server';
import {
  loadSymonScopeGrant,
  scopeSymonToolArgs,
} from '@/lib/mobile/symon-agent-registry';
/** Server tool owner; see docs/internals/symon-agent-mode.md. */
const LOG = '[symon-agent]';

export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  if (!sessionId || !callId) {
    return NextResponse.json({ ok: false, error: 'bad_request' });
  }
  const interrupted = await phoneToolServer.calls.interrupt(sessionId, callId);
  return interrupted.ok
    ? NextResponse.json({ ok: true, ...(interrupted.result as object) })
    : NextResponse.json({ ok: false, delivered: false, error: 'interrupt_delivery_failed' }, { status: 503 });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as
    | {
      sessionId?: unknown;
      callId?: unknown;
      tool?: unknown;
      args?: unknown;
      utterance?: unknown;
      dryRun?: unknown;
    }
    | null;

  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const args = body?.args !== undefined && body?.args !== null && typeof body.args === 'object' ? body.args : {};

  if (!sessionId || !tool || !callId) {
    return NextResponse.json(toolErrorResult('bad_request', 'sessionId, callId, and tool are required'));
  }

  const grant = loadSymonScopeGrant();
  if (!grant || grant.sessionId !== sessionId) {
    return NextResponse.json(toolErrorResult(
      'session_scope_invalid',
      'This tool call is not bound to the active Symon session scope.',
    ));
  }
  const scoped = scopeSymonToolArgs(grant, tool, args as Record<string, unknown>);
  if (!scoped.ok) return NextResponse.json(toolErrorResult(scoped.error, scoped.detail));
  if (body?.dryRun === true) {
    return NextResponse.json({
      ok: true,
      result: {
        state: 'scoped',
        scopedArgs: scoped.args,
        scopeVersion: grant.scopeVersion,
      },
    });
  }

  try {
    const outcome = await phoneToolServer.start({
      sessionId, callId, tool,
      args: { ...scoped.args, __symonSessionId: sessionId, __symonCallId: callId },
    });
    return NextResponse.json(outcome);
  } catch (error) {
    // Defensive: the server owner returns structured results, but a
    // route MUST NOT throw. Hand the model a structured failure.
    const detail = error instanceof Error ? error.message : 'tool relay failed';
    console.warn(`${LOG} tool relay exception callId=${callId}: ${detail}`);
    return NextResponse.json(toolErrorResult('tool_failed', detail));
  }
}
