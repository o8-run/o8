export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { getApiBase } from '@/lib/panel/api-port';

/**
 * Canvas intent bus (#1232 phase 2) — gated in middleware (loopback + token).
 * Symon (and any local agent surface) drives the canvas through one POST:
 * the verb rides into the webview as an `o8:canvas-intent` CustomEvent, whose
 * listener executes the SAME handlers the canvas rail buttons call. Read verbs
 * retain the synchronous page ack; non-idempotent `spawn-agents` is queued in a
 * separate eval and acknowledged immediately so a busy webview cannot turn a
 * landed spawn into an HTTP timeout.
 *
 * `ensure` (default true) navigates the webview to the canvas route first when
 * it's somewhere else, then waits for the intent listener to mount.
 */

const VERBS = new Set(['enter', 'open-browser', 'ask-brain', 'open-spec', 'spawn-terminal', 'search', 'zoom', 'dock', 'send-prompt', 'spawn-agents', 'render', 'grid', 'list', 'center-on-card', 'pan', 'read-card', 'move-card', 'resize-card', 'focus-card', 'close-card', 'add-image', 'stack', 'flip', 'separate', 'add-file', 'add-tree', 'open-diff', 'open-chat', 'add-video']);
const CANVAS_ROUTE = '/preview/canvas-glass';
const READY_POLL_MS = 300;
const READY_TIMEOUT_MS = 10_000;
const NAV_CONFIRM_MS = 400;

interface IntentBody {
  verb?: unknown;
  args?: unknown;
  ensure?: unknown;
  origin?: unknown;
  clientMutationId?: unknown;
}

interface DispatchProbe {
  ready: boolean;
  route?: string;
  ack?: { verb: string | null; ok: boolean; note: string | null; error?: string | null; data?: unknown } | null;
}

function webviewClient(): O8WebviewClient {
  // Same global key as /api/browser/agent — one socket connection per server.
  const store = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!store.__o8BrowserAgentClient) store.__o8BrowserAgentClient = new O8WebviewClient();
  return store.__o8BrowserAgentClient;
}

function readinessEval(): string {
  return `(() => JSON.stringify({ ready: window.__o8CanvasIntentReady === true, route: location.pathname }))()`;
}

function dispatchEval(verb: string, args: Record<string, unknown>, origin: string | null, readAck: boolean): string {
  return `(() => {
    const w = window;
    if (w.__o8CanvasIntentReady !== true) {
      return JSON.stringify({ ready: false, route: location.pathname });
    }
    w.dispatchEvent(new CustomEvent('o8:canvas-intent', { detail: { verb: ${JSON.stringify(verb)}, args: ${JSON.stringify(args)}, origin: ${JSON.stringify(origin)} } }));
    return JSON.stringify({ ready: true, route: location.pathname${readAck ? ', ack: w.__o8CanvasIntentLast || null' : ''} });
  })()`;
}

async function probeCanvas(client: O8WebviewClient): Promise<DispatchProbe> {
  try {
    const result = await client.evalJs(readinessEval());
    return JSON.parse(result.result) as DispatchProbe;
  } catch {
    // evalJs can throw transiently while the webview is mid-navigation (the
    // full reload below tears down the JS context for a beat) or busy. Unknown
    // route is deliberately "retry probe", never evidence to navigate.
    return { ready: false };
  }
}

async function dispatchWithAck(client: O8WebviewClient, verb: string, args: Record<string, unknown>, origin: string | null): Promise<DispatchProbe> {
  const result = await client.evalJs(dispatchEval(verb, args, origin, true));
  return JSON.parse(result.result) as DispatchProbe;
}

async function queueSpawnDispatch(client: O8WebviewClient, args: Record<string, unknown>, origin: string | null): Promise<void> {
  await client.queueEvalJs(dispatchEval('spawn-agents', args, origin, false));
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as IntentBody | null;
  const verb = typeof body?.verb === 'string' ? body.verb : '';
  if (!VERBS.has(verb)) {
    return NextResponse.json({ ok: false, error: `verb must be one of ${[...VERBS].join(', ')}` }, { status: 400 });
  }
  const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const ensure = body?.ensure !== false;
  const origin = body?.origin === 'symon' ? 'symon' : null;
  if (verb === 'spawn-agents' && (typeof args.task !== 'string' || !args.task.trim())) {
    return NextResponse.json({ ok: false, error: 'spawn-agents needs args.task' }, { status: 400 });
  }

  try {
    const client = webviewClient();
    let probe = await probeCanvas(client);
    let navigated = false;

    if (!probe.ready && ensure) {
      // Spawn without hijack (Q ruling 2026-07-17): when the operator is NOT
      // on the canvas, 'spawn-agents' must not yank the webview there. The
      // workers spawn through the same governed seam the canvas rail uses
      // (/api/orchestrator/spawn-prompt) and surface quietly in the IDE agent
      // rail (supervisor launch → background tab); the canvas blooms the
      // cards whenever the operator opens it. Needs an explicit repo in args
      // — without one only the canvas page knows its active repo, so the
      // legacy ensure-navigation below still applies.
      if (verb === 'spawn-agents' && probe.route && probe.route !== CANVAS_ROUTE) {
        const repoPath = typeof args.repo === 'string' ? args.repo.trim() : '';
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        if (repoPath && task) {
          const clientMutationId = typeof body?.clientMutationId === 'string' && body.clientMutationId.trim()
            ? body.clientMutationId.trim()
            : crypto.randomUUID();
          const { POST: spawnPrompt } = await import('@/app/api/orchestrator/spawn-prompt/route');
          const forwarded = new NextRequest(new Request(new URL('/api/orchestrator/spawn-prompt', getApiBase()), {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify({
              repoPath,
              task,
              count: args.count,
              clientMutationId,
              ...(origin === 'symon' ? { origin } : {}),
            }),
          }));
          const res = await spawnPrompt(forwarded);
          const data = await res.json().catch(() => null) as { ok?: boolean } | null;
          return NextResponse.json({
            ok: res.ok && data?.ok !== false,
            verb,
            note: 'spawned in the IDE — operator was not on the canvas, so no navigation; workers appear in the agent rail (and on the canvas when opened)',
            ...(data && typeof data === 'object' ? { data } : {}),
          });
        }
      }
      if (probe.route && probe.route !== CANVAS_ROUTE) {
        await new Promise((resolve) => setTimeout(resolve, NAV_CONFIRM_MS));
        const confirm = await probeCanvas(client);
        // FULL navigation, not client.navigate() — that drives the SPA router
        // (__o8Navigate__), which does not reliably cross from /dashboard to
        // the /preview/canvas-glass route segment, so the canvas never loads
        // and the intent listener never mounts (o8_canvas then fails every
        // time). window.location.assign is exactly what o8's own "enter canvas"
        // button uses for this hop.
        if (!confirm.ready && confirm.route && confirm.route !== CANVAS_ROUTE) {
          await client.evalJs(`(() => {
            const flush = window.__o8CanvasFlushSnapshot;
            if (typeof flush === 'function') {
              try { flush(); } catch {}
            }
            window.location.assign(${JSON.stringify(CANVAS_ROUTE)});
          })()`);
          navigated = true;
        } else {
          probe = confirm;
        }
      }
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!probe.ready && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
        probe = await probeCanvas(client);
      }
    }

    if (!probe.ready) {
      return NextResponse.json({
        ok: false,
        error: probe.route === CANVAS_ROUTE
          ? 'canvas intent listener never came up — is "Experimental: Canvas mode" enabled in Settings?'
          : `canvas not open (current route: ${probe.route ?? 'unknown'})`,
        route: probe.route ?? null,
        navigated,
      });
    }

    if (verb === 'spawn-agents') {
      await queueSpawnDispatch(client, args, origin);
      return NextResponse.json({
        ok: true,
        accepted: true,
        verb,
        note: 'spawn-agents dispatch queued',
        ...(navigated ? { navigated: true } : {}),
      }, { status: 202 });
    }

    const dispatched = await dispatchWithAck(client, verb, args, origin);
    if (!dispatched.ready) {
      return NextResponse.json({
        ok: false,
        error: 'canvas intent listener disappeared before dispatch',
        route: dispatched.route ?? null,
      });
    }
    const ack = dispatched.ack && dispatched.ack.verb === verb ? dispatched.ack : null;
    return NextResponse.json({
      ok: ack ? ack.ok : true,
      verb,
      ...(ack?.note ? { note: ack.note } : {}),
      ...(ack?.error ? { error: ack.error } : {}),
      ...(ack?.data !== undefined ? { data: ack.data } : {}),
      ...(navigated ? { navigated: true } : {}),
    });
  } catch (error) {
    console.error('[canvas-intent] bridge failed:', error);
    return NextResponse.json({
      ok: false,
      error: 'canvas intent bridge failed',
      hint: 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
    });
  }
}
