import { isCodexModelId } from '@/lib/models';
import { NextRequest, NextResponse } from 'next/server';
import {
  writePersistedLlmChat,
  type PersistedLlmChatMessage,
} from '@/lib/llm/chat-history-store';
import {
  buildLlmRequestMessages,
  cleanProxyContent,
  cliRuntimeForModel,
  defaultMobileLlmModel,
  ensurePersistedMobileLlmChatSession,
  isCliModel,
  providerForLlmModel,
} from '@/lib/llm/mobile-chat-session';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { EFFORT_CHOICE_LIST } from '@/lib/orchestrator/effort-pin';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MobileChatSendBody {
  sessionKey?: string;
  message?: string;
  model?: string;
  effort?: unknown;
  repoPath?: string;
}

function persistStreamResult(
  tabId: string,
  model: string,
  result: {
    responseText?: string;
    errorText?: string | null;
    approvalRequired?: { summary?: string | null } | null;
    tokens?: { input: number; output: number };
    costUsd?: number;
    thinkingText?: string;
    toolCalls?: MobileTranscriptToolCall[];
    sources?: MobileTranscriptSource[];
  },
) {
  const existing = ensurePersistedMobileLlmChatSession(tabId, { model });
  const persistedMessages = existing.messages ?? [];

  if (result.approvalRequired) {
    const note = result.approvalRequired.summary || 'Approval required for this workspace chat tool call.';
    writePersistedLlmChat(tabId, {
      ...existing,
      model,
      messages: [
        ...persistedMessages,
        {
          id: `approval-pending-${Date.now()}`,
          role: 'assistant',
          content: `Approval pending: ${note}`,
          timestamp: Date.now(),
          model,
        },
      ],
    });
    invalidateInboxCache();
    return;
  }

  if (result.errorText) {
    writePersistedLlmChat(tabId, {
      ...existing,
      model,
      messages: [
        ...persistedMessages,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${result.errorText}`,
          timestamp: Date.now(),
          isError: true,
          model,
        },
      ],
    });
    invalidateInboxCache();
    return;
  }

  const assistantMessage: PersistedLlmChatMessage = {
    id: `asst-${Date.now()}`,
    role: 'assistant',
    content: cleanProxyContent(result.responseText ?? ''),
    model,
    tokens: result.tokens,
    costUsd: result.costUsd,
    timestamp: Date.now(),
    toolCalls: result.toolCalls?.length ? result.toolCalls : undefined,
    sources: result.sources?.length ? result.sources : undefined,
    thinking: result.thinkingText || undefined,
  };

  writePersistedLlmChat(tabId, {
    ...existing,
    model,
    messages: [...persistedMessages, assistantMessage],
  });
  invalidateInboxCache();
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as MobileChatSendBody | null;
  const sessionKey = body?.sessionKey?.trim();
  const message = body?.message?.trim();
  const requestedModel = body?.model?.trim();

  if (!sessionKey || !sessionKey.startsWith('llm-chat:')) {
    return NextResponse.json({ error: 'sessionKey must be an llm-chat session' }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  if (requestedModel?.startsWith('cli:codex:') && !isCodexModelId(requestedModel.slice('cli:codex:'.length))) {
    return NextResponse.json({ error: 'Unknown Codex model', code: 'invalid_model' }, { status: 400 });
  }

  const effort = body?.effort;
  if (effort !== undefined && !isThinkingEffort(effort)) {
    return NextResponse.json({
      error: `effort must be one of: ${EFFORT_CHOICE_LIST}.`, code: 'invalid_effort',
    }, { status: 400 });
  }

  const tabId = sessionKey.replace(/^llm-chat:/, '');
  const existing = ensurePersistedMobileLlmChatSession(tabId, { model: requestedModel });
  const model = requestedModel || existing.model || defaultMobileLlmModel();
  const provider = providerForLlmModel(model);

  const userMessage: PersistedLlmChatMessage = {
    id: `user-${Date.now()}`,
    role: 'user',
    content: message,
    timestamp: Date.now(),
  };

  writePersistedLlmChat(tabId, {
    ...existing,
    model,
    messages: [...(existing.messages ?? []), userMessage],
  });
  invalidateInboxCache();

  const useCli = isCliModel(model);
  const proxyEndpoint = useCli ? '/api/v2/proxy/cli' : '/api/v2/proxy/llm';
  const repoPath = body?.repoPath?.trim() || existing.repoPath;
  const proxyBody = useCli
    ? {
        runtime: cliRuntimeForModel(model),
        model,
        messages: buildLlmRequestMessages(existing, message),
        ...(effort ? { effort } : {}),
        ...(repoPath ? { repoPath } : {}),
      }
    : {
        model,
        provider,
        messages: buildLlmRequestMessages(existing, message),
        approvedTools: [],
      };

  const proxyRes = await fetch(new URL(proxyEndpoint, request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tab-id': tabId,
    },
    body: JSON.stringify(proxyBody),
    cache: 'no-store',
  });

  if (!proxyRes.ok || !proxyRes.body) {
    const payload = await proxyRes.json().catch(() => ({ error: `HTTP ${proxyRes.status}` }));
    const errorText = typeof payload?.error === 'string' ? payload.error : `HTTP ${proxyRes.status}`;
    persistStreamResult(tabId, model, { errorText });
    return NextResponse.json(
      { error: errorText },
      { status: proxyRes.status || 500 },
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let responseText = '';
  let tokens: { input: number; output: number } | undefined;
  let costUsd: number | undefined;
  let thinkingText = '';
  let toolCalls: MobileTranscriptToolCall[] = [];
  let sources: MobileTranscriptSource[] = [];
  let errorText: string | null = null;
  let approvalRequired: { summary?: string | null } | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const reader = proxyRes.body!.getReader();
      let buffer = '';

      const processLine = (line: string) => {
        controller.enqueue(encoder.encode(`${line}\n`));
        if (!line.startsWith('data: ')) return;

        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (parsed.type === 'content' && typeof parsed.text === 'string') {
          responseText += parsed.text;
          return;
        }
        if (parsed.type === 'usage') {
          tokens = {
            input: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0,
            output: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0,
          };
          costUsd = typeof parsed.costUsd === 'number' ? parsed.costUsd : undefined;
          return;
        }
        if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
          thinkingText += parsed.text;
          return;
        }
        if (parsed.type === 'tool_call' && typeof parsed.name === 'string') {
          toolCalls = [
            ...toolCalls,
            {
              name: parsed.name,
              args: parsed.args && typeof parsed.args === 'object' ? parsed.args as Record<string, unknown> : undefined,
              status: parsed.status === 'calling' || parsed.status === 'running' || parsed.status === 'done'
                ? parsed.status
                : undefined,
            },
          ];
          return;
        }
        if (parsed.type === 'sources' && Array.isArray(parsed.sources)) {
          sources = parsed.sources as MobileTranscriptSource[];
          return;
        }
        if (parsed.type === 'approval_required') {
          approvalRequired = {
            summary: typeof parsed.summary === 'string' ? parsed.summary : null,
          };
          return;
        }
        if (parsed.type === 'error' && typeof parsed.message === 'string') {
          errorText = parsed.message;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            processLine(line);
          }
        }

        const tail = decoder.decode();
        if (tail) {
          buffer += tail;
        }
        if (buffer) {
          processLine(buffer);
        }
      } catch (error) {
        const fallbackMessage = error instanceof Error ? error.message : 'Stream error';
        errorText = errorText ?? fallbackMessage;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: fallbackMessage })}\n\n`));
      } finally {
        persistStreamResult(tabId, model, {
          responseText,
          errorText,
          approvalRequired,
          tokens,
          costUsd,
          thinkingText,
          toolCalls,
          sources,
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: proxyRes.status,
    headers: {
      'Content-Type': proxyRes.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
