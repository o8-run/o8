import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import {
  FREE_CHAT_MODEL_ID,
  PAID_CHAT_MODEL_ID,
  missingChatGatewayEnv,
  resolveDeepSeekByokKey,
  streamGatewayChat,
} from '@/lib/chat/gateway-client';
import type {
  ChatErrorResponse,
  ChatHistoryMessage,
  ChatRequestBody,
  ChatRequestModel,
  ChatStreamEvent,
} from '@/lib/chat/types';
import {
  FREE_TIER_DAILY_LIMIT,
  getTodayCount,
  recordChatTurn,
} from '@/lib/chat/usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_HISTORY_MESSAGES = 50;

function jsonError(error: string, message: string, status: number, extra?: Omit<ChatErrorResponse, 'error' | 'message'>) {
  return NextResponse.json(
    {
      error,
      message,
      ...extra,
    } satisfies ChatErrorResponse,
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHistory(value: unknown): ChatHistoryMessage[] | null {
  if (!Array.isArray(value)) return null;

  const history: ChatHistoryMessage[] = [];
  for (const item of value.slice(-MAX_HISTORY_MESSAGES)) {
    if (!isRecord(item)) return null;
    const role = item.role;
    const content = item.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null;
    }
    const trimmed = content.trim();
    if (trimmed) {
      history.push({ role, content: trimmed });
    }
  }

  return history;
}

function parseBody(value: unknown): ChatRequestBody | { paidModel: string } | null {
  if (!isRecord(value)) return null;

  const message = typeof value.message === 'string' ? value.message.trim() : '';
  const model = typeof value.model === 'string' ? value.model : '';
  const history = normalizeHistory(value.history);
  if (!message || !history) return null;

  if (model === 'o8-default' || model === 'byo-key') {
    return {
      message,
      model: model as ChatRequestModel,
      history,
    };
  }

  if (
    model === 'claude-max' ||
    model === 'sonnet-4.6' ||
    model === 'sonnet-5' ||
    model === PAID_CHAT_MODEL_ID ||
    model.startsWith('paid:')
  ) {
    return { paidModel: model };
  }

  return null;
}

async function requireClerkUser(): Promise<{ userId: string } | { response: NextResponse }> {
  try {
    const session = await auth();
    if (!session.userId) {
      return {
        response: jsonError(
          'unauthenticated',
          'Sign in to use chat.',
          401,
        ),
      };
    }
    return { userId: session.userId };
  } catch (error) {
    return {
      response: jsonError(
        'clerk_auth_unavailable',
        error instanceof Error ? error.message : 'Clerk authentication is unavailable.',
        503,
      ),
    };
  }
}

function encodeSse(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const missingEnv = missingChatGatewayEnv();
    if (missingEnv.length > 0) {
      return jsonError(
        'chat_gateway_env_missing',
        `Missing required chat environment variables: ${missingEnv.join(', ')}`,
        503,
      );
    }

    const clerkUser = await requireClerkUser();
    if ('response' in clerkUser) return clerkUser.response;

    const rawBody = await request.json().catch(() => null);
    const body = parseBody(rawBody);
    if (!body) {
      return jsonError(
        'invalid_request',
        'Expected { message, model, history } with model set to o8-default or byo-key.',
        400,
      );
    }
    if ('paidModel' in body) {
      return jsonError(
        'paid_tier_not_yet_active',
        'Paid chat models are not active yet.',
        402,
      );
    }

    const userId = clerkUser.userId;
    const isByok = body.model === 'byo-key';
    const currentCount = isByok ? 0 : getTodayCount(userId);
    if (!isByok && currentCount >= FREE_TIER_DAILY_LIMIT) {
      return jsonError(
        'free_tier_rate_limit',
        'You have used your 10 free chat turns for today. Switch to Bring your own key in desktop Settings to continue.',
        429,
        {
          limit: FREE_TIER_DAILY_LIMIT,
          remaining: 0,
        },
      );
    }

    const byokApiKey = isByok ? await resolveDeepSeekByokKey() : undefined;
    if (isByok && !byokApiKey) {
      return jsonError(
        'byok_key_missing',
        'Add a DeepSeek API key in Settings before using Bring your own key.',
        400,
      );
    }

    const upstream = streamGatewayChat({
      userId,
      history: body.history,
      message: body.message,
      byokApiKey: byokApiKey ?? undefined,
      abortSignal: request.signal,
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const text of upstream) {
            if (text) {
              controller.enqueue(encodeSse({ type: 'content', text }));
            }
          }

          if (!isByok) {
            const count = recordChatTurn(userId);
            controller.enqueue(encodeSse({
              type: 'usage',
              count,
              limit: FREE_TIER_DAILY_LIMIT,
              remaining: Math.max(0, FREE_TIER_DAILY_LIMIT - count),
            }));
          }

          controller.enqueue(encodeSse({ type: 'done' }));
          controller.close();
        } catch (error) {
          controller.enqueue(encodeSse({
            type: 'error',
            error: 'gateway_stream_failed',
            message: error instanceof Error ? error.message : `Gateway stream failed for ${FREE_CHAT_MODEL_ID}.`,
          }));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return jsonError(
      'chat_route_failed',
      error instanceof Error ? error.message : 'Chat request failed.',
      500,
    );
  }
}
