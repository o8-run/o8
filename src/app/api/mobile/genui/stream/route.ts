export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/genui/stream — OpenAI-compatible chat-completions facade
 * for the mobile generative-UI spike (AppLess/OpenUI pattern, 2026-07-16).
 *
 * The mobile app's `@openuidev/react-lang` stream layer speaks the vanilla
 * OpenAI `/chat/completions` SSE dialect; none of our internal LLM surfaces
 * do. This route is the adapter: it accepts `{ model?, effort?, messages, stream? }`
 * and emits `chat.completion.chunk` SSE frames (or a full `chat.completion`
 * JSON body when `stream: false`).
 *
 * The server owns model routing — no keys or authoritative model selector live
 * on the device. The phone only presents the ws-token (this route is gated by
 * the default-deny middleware like the rest of /api/mobile):
 *
 *   - Text requests can use the warm Claude REPL pool or Codex CLI, based on
 *     the allow-listed mobile model id and authenticated desktop readiness.
 *   - Image requests return an explicit pre-stream fallback signal so the
 *     phone can preserve the image and use managed Ask.
 */

import { NextRequest, NextResponse } from 'next/server';

import { askClaudeWarm } from '@/lib/claude-code/warm-repl-pool';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import {
  buildMobileAskModelCatalog,
  isMobileAskEffort,
  resolveMobileAskRoute,
  type MobileAskReadiness,
} from '@/lib/mobile/ask-model-routing';
import { MODEL_IDS } from '@/lib/models';
import { getRuntimeAuthSnapshotForClaudeCarrier } from '@/lib/runtimes/shared/auth-detect';

const CLI_TIMEOUT_MS = 120_000;
// Spend guardrail for the hosted tier: a generated screen is a few hundred
// tokens of openui-lang; 8K is generous headroom, not an open tap.
const HOSTED_MAX_TOKENS = 8_192;

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface GenUiRequestBody {
  model?: unknown;
  effort?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
}

function jsonError(message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status, headers },
  );
}

function managedFallback(message: string) {
  return jsonError(message, 409, { 'X-O8-Ask-Fallback': 'managed' });
}

/** OpenAI content can be a string or an array of typed parts — flatten to text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

function messagesContainImages(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
    && message.content.some((part) =>
      Boolean(part)
      && typeof part === 'object'
      && (part as { type?: unknown }).type === 'image_url'),
  );
}

/**
 * The warm REPL takes one user frame, so the OpenAI message array is
 * flattened: system blocks first, then the conversation transcript. Good
 * enough for the spike — screen continuity in the OpenUI pattern is carried
 * in the messages themselves, not in server-side session state.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const system: string[] = [];
  const turns: string[] = [];
  for (const msg of messages) {
    const text = contentToText(msg.content).trim();
    if (!text) continue;
    if (msg.role === 'system') system.push(text);
    else if (msg.role === 'assistant') turns.push(`Assistant: ${text}`);
    else turns.push(`User: ${text}`);
  }
  return [...system, turns.join('\n\n')].filter(Boolean).join('\n\n');
}

// ── Model routing ─────────────────────────────────────────────────────────────

interface AskRuntimeState {
  readiness: MobileAskReadiness;
  claudeBinary?: string;
  codexBinary?: string;
}

async function getAskRuntimeState(): Promise<AskRuntimeState> {
  try {
    // This surface launches the local CLI directly; a gateway-backed worker profile
    // cannot make that native process usable when the CLI itself is logged out.
    const snapshot = await getRuntimeAuthSnapshotForClaudeCarrier('native');
    const claude = snapshot.statuses.claude;
    const codex = snapshot.statuses.codex;
    return {
      readiness: {
        // `ready` is the usability verdict; `authenticated` is credential evidence only.
        // An inconclusive native probe leaves authenticated false while the house stays
        // dispatchable. This route explicitly derives the native-carrier view above.
        claude: claude.installed && claude.ready,
        codex: codex.installed && codex.ready,
      },
      claudeBinary: claude.binaryPath,
      codexBinary: codex.binaryPath,
    };
  } catch (error) {
    console.error('[genui] failed to detect local Ask runtimes:', error instanceof Error ? error.message : 'unknown');
    return { readiness: { claude: false, codex: false } };
  }
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

function chunkFrame(id: string, created: number, model: string, delta: Record<string, string>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function completionBody(id: string, created: number, model: string, text: string) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET() {
  const state = await getAskRuntimeState();
  return NextResponse.json(buildMobileAskModelCatalog(state.readiness), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(req: NextRequest) {
  let body: GenUiRequestBody;
  try {
    body = await req.json() as GenUiRequestBody;
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid request body.', 400);
  if (body.effort !== undefined && !isMobileAskEffort(body.effort)) return jsonError('Invalid explicit Ask effort.', 400);

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError('messages array is required.', 400);
  }
  const messages = body.messages as ChatMessage[];
  if (messagesContainImages(messages)) {
    return managedFallback('Image requests use managed Ask.');
  }
  const wantStream = body.stream !== false;
  const id = `genui-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const prompt = flattenMessages(messages);
  if (!prompt) return jsonError('messages contained no text content.', 400);

  const state = await getAskRuntimeState();
  const routeSelection = resolveMobileAskRoute(body.model, state.readiness, body.effort);
  if (routeSelection.kind === 'managed') {
    return managedFallback(
      routeSelection.fallback
        ? 'The selected local Ask model is unavailable; use managed Ask.'
        : 'Managed Ask was selected.',
    );
  }
  const receiptHeaders = { 'X-O8-Ask-Effort': routeSelection.effort };

  if (routeSelection.kind === 'claude') {
    const binary = state.claudeBinary;
    if (!binary) return managedFallback('Claude Code is unavailable; use managed Ask.');

    if (!wantStream) {
      try {
        const text = await askClaudeWarm(prompt, {
          binary,
          model: routeSelection.cliModel,
          effort: routeSelection.effort,
          timeoutMs: CLI_TIMEOUT_MS,
        });
        return NextResponse.json(completionBody(id, created, routeSelection.cliModel, text), { headers: receiptHeaders });
      } catch (error) {
        console.error('[genui] Claude completion failed:', error instanceof Error ? error.message : 'unknown');
        return jsonError('Generation failed on the Claude CLI tier.', 502);
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunkFrame(id, created, routeSelection.cliModel, { role: 'assistant', content: '' }, null)));
        askClaudeWarm(prompt, {
          binary,
          model: routeSelection.cliModel,
          effort: routeSelection.effort,
          timeoutMs: CLI_TIMEOUT_MS,
          onDelta: (text) => {
            try {
              controller.enqueue(encoder.encode(chunkFrame(id, created, routeSelection.cliModel, { content: text }, null)));
            } catch { /* client went away mid-stream */ }
          },
        })
          .then(() => {
            controller.enqueue(encoder.encode(chunkFrame(id, created, routeSelection.cliModel, {}, 'stop')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          })
          .catch((error) => {
            console.error('[genui] Claude stream failed:', error instanceof Error ? error.message : 'unknown');
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: 'Generation failed on the Claude CLI tier.' } })}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch { /* already closed */ }
          });
      },
    });
    return new Response(stream, { headers: { ...sseHeaders(), ...receiptHeaders } });
  }

  if (routeSelection.kind === 'codex') {
    const binary = state.codexBinary;
    if (!binary) return managedFallback('Codex is unavailable; use managed Ask.');
    let text: string;
    try {
      text = await callCodex(prompt, {
        binary,
        model: routeSelection.cliModel,
        reasoningEffort: routeSelection.effort,
        timeoutMs: CLI_TIMEOUT_MS,
      });
    } catch (error) {
      console.error('[genui] Codex completion failed:', error instanceof Error ? error.message : 'unknown');
      return jsonError('Generation failed on the Codex CLI tier.', 502);
    }
    if (!wantStream) {
      return NextResponse.json(completionBody(id, created, routeSelection.cliModel, text), { headers: receiptHeaders });
    }
    const encoder = new TextEncoder();
    const synthesized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunkFrame(id, created, routeSelection.cliModel, { role: 'assistant', content: text }, null)));
        controller.enqueue(encoder.encode(chunkFrame(id, created, routeSelection.cliModel, {}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(synthesized, { headers: { ...sseHeaders(), ...receiptHeaders } });
  }

  // Hosted tier — managed plan proxy (founder fast path) → local → BYO OpenRouter.
  const hostedRoute = await resolveOpenRouterRoute();
  if (!hostedRoute) {
    return jsonError('No hosted inference available — add an OpenRouter key or an active plan, or use the default CLI tier.', 503);
  }
  const requestedMax = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? body.max_tokens : HOSTED_MAX_TOKENS;
  const upstreamBody = {
    model: hostedRoute.model ?? MODEL_IDS.mobileOpenAiDefault,
    messages: messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
    stream: wantStream,
    max_tokens: Math.min(Math.max(1, requestedMax), HOSTED_MAX_TOKENS),
  };

  let upstream: Response;
  try {
    upstream = await fetch(hostedRoute.url, {
      method: 'POST',
      headers: hostedRoute.headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    console.error('[genui] hosted fetch failed:', error instanceof Error ? error.message : 'unknown');
    return jsonError('Hosted inference request failed.', 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[genui] hosted upstream ${upstream.status} via ${hostedRoute.via}: ${detail.slice(0, 300)}`);
    return jsonError(`Hosted inference failed upstream (${upstream.status}).`, 502);
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  // Streaming upstream (OpenRouter/local SSE is already OpenAI-shaped) — pipe through.
  if (wantStream && upstreamType.includes('text/event-stream') && upstream.body) {
    return new Response(upstream.body, { headers: sseHeaders() });
  }

  // Non-SSE upstream (e.g. the managed proxy answering JSON): normalize. When
  // the caller asked to stream, synthesize a minimal chunk sequence so the
  // OpenUI client's SSE parser still works.
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return jsonError('Hosted inference returned an unreadable response.', 502);
  }
  const text = extractCompletionText(payload);
  if (text === null) {
    return jsonError('Hosted inference response had no completion content.', 502);
  }
  const model = upstreamBody.model || 'hosted';
  if (!wantStream) {
    return NextResponse.json(completionBody(id, created, model, text));
  }
  const encoder = new TextEncoder();
  const synthesized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunkFrame(id, created, model, { role: 'assistant', content: text }, null)));
      controller.enqueue(encoder.encode(chunkFrame(id, created, model, {}, 'stop')));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(synthesized, { headers: sseHeaders() });
}

/** Pull assistant text out of an OpenAI-shaped (or proxy-shaped) completion body. */
function extractCompletionText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as { choices?: unknown; text?: unknown; content?: unknown };
  if (Array.isArray(obj.choices) && obj.choices[0] && typeof obj.choices[0] === 'object') {
    const choice = obj.choices[0] as { message?: { content?: unknown }; text?: unknown };
    const fromMessage = contentToText(choice.message?.content);
    if (fromMessage) return fromMessage;
    if (typeof choice.text === 'string' && choice.text) return choice.text;
  }
  if (typeof obj.text === 'string' && obj.text) return obj.text;
  const fromContent = contentToText(obj.content);
  return fromContent || null;
}
