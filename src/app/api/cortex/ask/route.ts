/**
 * POST /api/cortex/ask  (epic #915 sub-2 — real composer)
 *
 * Accepts: { question: string, repoPath?: string, mode?: 'brain' | 'memory' }
 *
 * Runs the full Q&A pipeline:
 *   1. Flash classifier (50ms) → question class + BM25 variants
 *   2. retrieveAll (sql + fts5 + graph) → union-merged TypedRows
 *   3. Compose:
 *        Class A → Gemini Flash JSON (200–500ms, one-sentence)
 *        Class B → Claude Sonnet streaming (1–3s TTFT)
 *   4. Stream SSE frames:
 *        event: open       { ok: true }
 *        event: token      { text: string }
 *        event: citation   { kind, rowId, table, excerpt?, url? }
 *        event: alert      { kind, message, fromHouse, toHouse, fromModel, toModel }
 *        event: done       {}
 *        event: error      { message: string }
 *
 * Cache: 30min in-process TTL (normalized key, eagerly invalidated on
 * spec-ingest + ledger writes — see ask.ts).
 * Bypass: ?force=1 query param OR body { bypassCache: true } — aligned with
 * the JSON sibling /api/cortex/ask/answer so callers don't have to know
 * which route takes which shape (cost a live debugging session 2026-06-11).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { resolveComposerBrainRoute, withComposerBrainRoute } from '@/lib/operator/composer-brain-route';
import { NextRequest } from 'next/server';

import { runAskPipeline } from '@/lib/cortex/qa/ask';
import { ManagedBrainUnavailableError } from '@/lib/cortex/qa/compose-class-a';
import { withBrainRetrievalUsage } from '@/lib/cortex/qa/llm/brain-spend';

interface AskBody {
  conversation?: unknown;
  preferredRuntime?: unknown;
  question?: unknown;
  repoPath?: unknown;
  projectId?: unknown;
  mode?: unknown;
  terse?: unknown;
  bypassCache?: unknown;
}

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AskBody | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return new Response(JSON.stringify({ ok: false, error: 'question is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const repoPath =
    typeof body?.repoPath === 'string' && body.repoPath.trim() ? body.repoPath.trim() : undefined;
  const projectId =
    typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;

  const force = request.nextUrl.searchParams.get('force') === '1' || body?.bypassCache === true;
  const terse = body?.terse === true;

  const conversationRoute = body?.conversation === true ? await resolveComposerBrainRoute(typeof body.preferredRuntime === 'string' ? body.preferredRuntime : undefined) : undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Stream may already be closed if the client disconnected.
        }
      };

      const emit = (name: string, payload: unknown) => {
        enqueue(sseEvent(name, payload));
      };

      try {
        emit('open', { ok: true });
        let meteredAnswer = '';
        const meteredEmit = (name: string, payload: unknown) => {
          if (name === 'token') meteredAnswer += (payload as { text?: string }).text ?? '';
          emit(name, payload);
        };
        if (conversationRoute) emit('route', { runtime: conversationRoute.runtime, model: conversationRoute.model });
        const answer = () => withBrainRetrievalUsage(
          question,
          { repoPath },
          () => runAskPipeline(question, repoPath, meteredEmit, force, projectId, { terse }),
          () => meteredAnswer,
        );
        if (conversationRoute) await withComposerBrainRoute(conversationRoute, answer); else await answer();
      } catch (err) {
        console.error('[qa][ask-route] pipeline error:', err);
        emit('error', { message: err instanceof ManagedBrainUnavailableError ? err.message : conversationRoute?.runtime ? `The connected ${conversationRoute.runtime === 'codex' ? 'Codex' : 'Claude'} runtime could not answer. Check its connection and try again.` : 'Unable to answer cortex question.', ...(err instanceof ManagedBrainUnavailableError ? { code: err.code } : {}) });
        emit('done', {});
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
