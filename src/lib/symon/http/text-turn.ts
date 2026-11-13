import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { loadSymonTextSession, bindSymonTextEffectiveModel } from '@/lib/mobile/symon-text-session-store';
import { type SymonTextPlannerSelection } from '@/lib/mobile/symon-text-eval';
import {
  pollSymonTextInterrupt,
  pollSymonTextTurn,
} from '@/lib/mobile/symon-text-bridge-client';
import { getSymonBrain } from '@/lib/symon/durable/brain';

const POLL_WINDOW_MS = 3_000;

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const planner = body?.planner && typeof body.planner === 'object' && !Array.isArray(body.planner)
    ? body.planner as Record<string, unknown>
    : null;
  // The engine is a native planner registry entry id, so the shape is checked
  // here and the id itself is verified by the native bound resolve — an unknown
  // one is refused there rather than pinned to a hardcoded pair (#2176).
  const selection: SymonTextPlannerSelection | null = planner
    && typeof planner.engine === 'string'
    && /^[a-z0-9-]{1,32}$/.test(planner.engine)
    && typeof planner.model === 'string'
    && typeof planner.effort === 'string'
    ? { engine: planner.engine, model: planner.model, effort: planner.effort }
    : null;
  if (!sessionId || !turnId || !prompt || !selection) {
    return NextResponse.json({ ok: false, state: 'error', error: 'bad_request' }, { status: 400 });
  }
  // Eligibility comes from the persisted session, never from caller input.
  const session = loadSymonTextSession(sessionId);
  if (selection.engine === 'pi' || session?.engine === 'pi') {
    return runPiBrainTurn(sessionId, turnId, body?.text, session?.engine === 'pi' && selection.engine === 'pi');
  }
  selection.allowDefaultFallback = session?.allowDefaultFallback === true
    && session.engine === selection.engine && session.model === selection.model
    && session.effort === selection.effort;
  try {
    const result = await pollSymonTextTurn({
      sessionId,
      turnId,
      prompt,
      planner: selection,
      reconcileOnly: body?.reconcileOnly === true,
    }, POLL_WINDOW_MS);
    if (result.state === 'done' || result.state === 'error') {
      bindSymonTextEffectiveModel(sessionId, result.result?.model, result.result?.effort);
    }
    // A native answer is recorded into the brain's thread for the Symon tab. Best effort.
    if (result.state === 'done' && result.result?.status === 'done' && typeof result.result.text === 'string'
      && result.result.text.trim() && typeof body?.text === 'string' && body.text.trim()) {
      const exchange = [{ role: 'user' as const, text: body.text }, { role: 'assistant' as const, text: result.result.text }];
      void getSymonBrain()
        .then((brain) => brain.record({ key: `phone:${sessionId}`, source: 'phone', title: 'Phone', requestId: `relay:phone:${turnId}`, entries: exchange }))
        .catch(() => {});
    }
    return NextResponse.json({ ok: result.state !== 'error', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    });
  }
}

/**
 * A phone turn on the built-in Pi brain (#3453). The brain keeps the thread's
 * history, so it takes the newest message only; the turn id makes a repeated
 * poll reach the same turn.
 */
async function runPiBrainTurn(sessionId: string, turnId: string, text: unknown, bound: boolean) {
  if (!bound) {
    return NextResponse.json({ ok: false, state: 'error', error: 'session_mismatch', detail: 'This text session is bound to another planner.' }, { status: 409 });
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 8_000) {
    return NextResponse.json({ ok: false, state: 'error', error: 'bad_request' }, { status: 400 });
  }
  let outcome;
  try {
    const brain = await getSymonBrain();
    outcome = await brain.send({ key: `phone:${sessionId}`, source: 'phone', title: 'Phone', requestId: `phone:${turnId}`, text }, POLL_WINDOW_MS);
  } catch {
    return NextResponse.json({ ok: false, state: 'error', error: 'brain_unavailable', detail: 'Symon could not answer right now. Please try again.' });
  }
  if (outcome.state === 'pending') return NextResponse.json({ ok: true, state: 'pending' });
  if (outcome.state === 'failed') return NextResponse.json({ ok: false, state: 'error', detail: outcome.message });
  const session = loadSymonTextSession(sessionId);
  return NextResponse.json({
    ok: true,
    state: 'done',
    result: { status: 'done', text: outcome.text, model: session?.model, effort: session?.effort },
  });
}

export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  if (!sessionId || !turnId) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  if (loadSymonTextSession(sessionId)?.engine === 'pi') {
    try {
      const stopped = await (await getSymonBrain()).stop(`phone:${sessionId}`);
      return NextResponse.json({ ok: stopped, state: 'done' });
    } catch {
      return NextResponse.json({ ok: false, state: 'error', error: 'brain_unavailable' }, { status: 503 });
    }
  }
  try {
    const result = await pollSymonTextInterrupt(sessionId, turnId, POLL_WINDOW_MS);
    return NextResponse.json({ ok: result.state === 'done', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    }, { status: 503 });
  }
}
