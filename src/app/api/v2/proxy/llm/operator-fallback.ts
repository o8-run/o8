import { managedTextModelOptions } from '@/lib/cortex/qa/llm/inference-route';
import type { AuthContext } from '@/lib/auth/middleware';
import type { Message } from './provider-config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 30_000;

/**
 * Where to POST + which headers to send. When `endpoint` is set (the founder
 * managed-proxy route), it wins — the request never touches OpenRouter directly
 * and `apiKey` is unused. Otherwise it's the direct OpenRouter call with the
 * BYO/env key. Both speak the same OpenAI-compatible streaming shape, so only
 * the destination + auth differ.
 */
function resolveUpstream(options: StreamOptions): { url: string; headers: Record<string, string> } {
  if (options.endpoint) {
    return {
      url: options.endpoint.url,
      headers: { 'Content-Type': 'application/json', ...options.endpoint.headers },
    };
  }
  return {
    url: OPENROUTER_URL,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://o8.app',
      'X-Title': 'o8 Operator',
    },
  };
}

interface StreamOptions {
  apiKey: string;
  messages: Message[];
  model: string;
  auth: AuthContext | null;
  /** When set, the stream opens with a 'fallback' banner event (paid plan whose
   *  Gemini quota died). Omit/null when this model IS the plan's primary — the
   *  free plan rides this path by design and must not see a degradation banner. */
  notice?: { originalModel: string; originalModelLabel: string; reason: string } | null;
  /**
   * Managed-inference route override (the founder perk). When set, the request
   * POSTs to this URL with these headers instead of OpenRouter + the raw key —
   * so a signed-in founder gets the o8 model with ZERO local keys, drawing on
   * o8's managed proxy (same `/v1/inference` endpoint the Brain uses, verified
   * to stream OpenRouter-format SSE). `apiKey` is ignored on this path.
   */
  endpoint?: { url: string; headers: Record<string, string> } | null;
}

/**
 * o8 Operator OpenAI-compatible path — streams a response from the managed
 * endpoint or a direct OpenRouter key. It is the primary rail on the managed
 * endpoint (the managed text model, then the $0 model) and the paid plan's
 * fallback when a local Gemini key hits quota.
 *
 * Text-only chat: this stream never carries a tools array (#3408 retired the
 * operator's own tool loop; o8's tools run in the built-in Pi agent).
 */
export async function streamOpenRouterFallback(options: StreamOptions): Promise<Response> {
  const { messages, model, notice } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  const target = resolveUpstream(options);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify({
        model,
        stream: true,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...managedTextModelOptions(model),
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return new Response(
      JSON.stringify({
        error: 'OpenRouter fallback request failed',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    await upstream.body?.cancel();
    return new Response(
      JSON.stringify({
        error: `OpenRouter fallback error (${upstream.status}): Request failed`,
      }),
      { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(streamController) {
      const enqueue = (payload: Record<string, unknown> | '[DONE]') => {
        const data = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload);
        streamController.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Degradation banner ONLY when this genuinely is a fallback (paid plan,
      // Gemini quota dead). The free plan's primary ride stays banner-free.
      if (notice) {
        enqueue({
          type: 'fallback',
          originalModel: notice.originalModel,
          originalModelLabel: notice.originalModelLabel,
          fallbackModel: model,
          fallbackModelLabel: 'OpenRouter free tier',
          reason: notice.reason,
        });
      }

      const reader = upstream.body?.getReader();
      if (!reader) {
        enqueue('[DONE]');
        streamController.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                enqueue({ type: 'content', text: delta });
              }
              if (parsed.usage) {
                enqueue({
                  type: 'usage',
                  inputTokens: parsed.usage.prompt_tokens ?? 0,
                  outputTokens: parsed.usage.completion_tokens ?? 0,
                });
              }
            } catch {
              // ignore malformed chunk
            }
          }
        }
      } finally {
        enqueue('[DONE]');
        streamController.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
