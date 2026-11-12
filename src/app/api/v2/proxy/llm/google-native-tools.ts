import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@/lib/auth/middleware';
import { logUsage } from '@/lib/db/usage';
import { parseInlineMarkdownDataImages } from '@/lib/llm/inline-images';
import { computeCost, type Message } from './provider-config';
import { executeNativeTool, extractFilePath } from './google-native-execution';

const GOOGLE_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_FALLBACKS: Record<string, string> = {};
const GOOGLE_TIMEOUT_MS = 30_000;
const MAX_GEMINI_TOOL_STEPS = 8;

type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
};

type GoogleContent = {
  role: 'user' | 'model';
  parts: GooglePart[];
};

type NativeToolCall = {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  filePath?: string;
};

type GoogleStepResult = {
  toolCalls: NativeToolCall[];
  modelContent: GoogleContent | null;
  inputTokens: number;
  outputTokens: number;
};

type GoogleFetchResult =
  | {
      ok: true;
      response: globalThis.Response;
      activeModel: string;
      fallbackUsed: { originalModel: string; fallbackModel: string; reason: string } | null;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

const GEMINI_TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the current project directory.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Project-relative file path to read.' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'create_file',
      description: 'Create a new file in the current project directory. Fails if the file already exists.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Project-relative file path to create.' },
          content: { type: 'string', description: 'Full file contents to write.' },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Propose an exact text replacement in a project file. This creates an approval entry and does not modify the file directly.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Project-relative file path to edit.' },
          old_text: { type: 'string', description: 'Exact existing text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['file_path', 'old_text', 'new_text'],
      },
    },
    {
      name: 'shell',
      description: 'Run a safe read-only shell command in the current project directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'A safe shell command using the strict allowlist.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'github',
      description: 'Run a scoped GitHub CLI command in the current project directory without the leading `gh` prefix.',
      parameters: {
        type: 'object',
        properties: {
          subcommand: { type: 'string', description: 'GitHub CLI subcommand to append to `gh`, such as `pr list` or `issue view 123`.' },
        },
        required: ['subcommand'],
      },
    },
  ],
}];

interface GoogleStreamOptions {
  apiKey: string;
  auth: AuthContext | null;
  disableTools?: boolean;
  lastUserContent?: string;
  messages: Message[];
  model: string;
  scopedRepoRoot: string | null;
  tabId: string;
  /** Restrict attached tools to this allowlist of names. Absent = all tools. */
  toolNames?: string[];
}

function buildGoogleUrl(model: string) {
  return `${GOOGLE_API_URL}/${model}:streamGenerateContent?alt=sse`;
}

function jsonError(message: string, status: number) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

const PLAN_MODE_NOTE = '\n\nIMPORTANT: You are in PLAN mode. You have NO tools available. Do not write `<execute_tool>` markers, function calls, or pretend to invoke tools. Reason and answer using only the conversation context. If the user asks for something that needs a tool, explain what you would do and ask them to switch to Code mode.';

/** Filter the tool declarations to an allowlist of tool names (e.g. the operator
 *  rail restricts the o8 model to file-editing tools — no shell/github). Absent =
 *  all tools (the generic google-provider path is unchanged). */
function selectToolDeclarations(toolNames?: string[]) {
  if (!toolNames) return GEMINI_TOOL_DECLARATIONS;
  const allow = new Set(toolNames);
  return [{
    functionDeclarations: GEMINI_TOOL_DECLARATIONS[0].functionDeclarations.filter((d) => allow.has(d.name)),
  }];
}

function buildGoogleRequest(messages: Message[], disableTools: boolean, toolNames?: string[]) {
  const baseSystem = messages.find((message) => message.role === 'system')?.content;
  const systemMessage = disableTools && baseSystem ? `${baseSystem}${PLAN_MODE_NOTE}` : baseSystem;
  const contents: GoogleContent[] = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const parsedContent = parseInlineMarkdownDataImages(message.content);
      const parts: GooglePart[] = parsedContent.hasImages
        ? parsedContent.parts.map((part) => (
            part.type === 'text'
              ? { text: part.text }
              : { inlineData: { mimeType: part.image.mimeType, data: part.image.base64Data } }
          ))
        : [{ text: message.content }];
      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });

  return {
    contents,
    body: {
      contents,
      ...(systemMessage ? { systemInstruction: { parts: [{ text: systemMessage }] } } : {}),
      generationConfig: {
        thinkingConfig: { includeThoughts: true },
      },
      ...(!disableTools ? { tools: selectToolDeclarations(toolNames) } : {}),
    } satisfies Record<string, unknown>,
  };
}

async function fetchGoogleStream(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<GoogleFetchResult> {
  const attempt = async (activeModel: string): Promise<globalThis.Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
    try {
      return await fetch(buildGoogleUrl(activeModel), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const response = await attempt(model);
    if (response.ok || (response.status !== 429 && response.status !== 503)) {
      if (response.ok) {
        return { ok: true, response, activeModel: model, fallbackUsed: null };
      }
      await response.body?.cancel();
      return { ok: false, status: response.status, message: `google API error (${response.status}): Request failed` };
    }

    const fallbackModel = GOOGLE_FALLBACKS[model];
    if (!fallbackModel) {
      await response.body?.cancel();
      return { ok: false, status: response.status, message: `google API error (${response.status}): Request failed` };
    }

    const fallbackResponse = await attempt(fallbackModel);
    if (!fallbackResponse.ok) {
      await fallbackResponse.body?.cancel();
      return { ok: false, status: fallbackResponse.status, message: `google API error (${fallbackResponse.status}): Request failed` };
    }

    return {
      ok: true,
      response: fallbackResponse,
      activeModel: fallbackModel,
      fallbackUsed: { originalModel: model, fallbackModel, reason: `Model overloaded (${response.status})` },
    };
  } catch {
    const fallbackModel = GOOGLE_FALLBACKS[model];
    if (!fallbackModel) {
      return {
        ok: false,
        status: 502,
        message: 'Google request failed',
      };
    }

    try {
      const fallbackResponse = await attempt(fallbackModel);
      if (!fallbackResponse.ok) {
        await fallbackResponse.body?.cancel();
        return { ok: false, status: fallbackResponse.status, message: `google API error (${fallbackResponse.status}): Request failed` };
      }
      return {
        ok: true,
        response: fallbackResponse,
        activeModel: fallbackModel,
        fallbackUsed: { originalModel: model, fallbackModel, reason: 'Initial request failed' },
      };
    } catch {
      return {
        ok: false,
        status: 502,
        message: 'Google request failed',
      };
    }
  }
}

async function consumeGoogleStream(
  response: globalThis.Response,
  onEvent: (event: { type: 'content' | 'thinking'; text: string }) => void,
): Promise<GoogleStepResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { toolCalls: [], modelContent: null, inputTokens: 0, outputTokens: 0 };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: NativeToolCall[] = [];
  const modelParts: GooglePart[] = [];

  const parseLine = (line: string) => {
    let payload = line.trim();
    if (!payload) return;
    if (payload.startsWith('data: ')) payload = payload.slice(6).trim();
    if (!payload || payload === '[' || payload === ']' || payload === ',') return;

    try {
      const parsed = JSON.parse(payload.replace(/^,/, ''));
      const parts = parsed.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const rawPart of parts as GooglePart[]) {
          modelParts.push(rawPart);
          if (rawPart.thought === true && rawPart.text) {
            onEvent({ type: 'thinking', text: rawPart.text });
            continue;
          }
          if (rawPart.functionCall?.name) {
            const args = rawPart.functionCall.args ?? {};
            toolCalls.push({
              toolName: rawPart.functionCall.name,
              toolCallId: rawPart.functionCall.id || randomUUID(),
              arguments: args,
              ...(extractFilePath(args) ? { filePath: extractFilePath(args) } : {}),
            });
            continue;
          }
          if (rawPart.text) {
            onEvent({ type: 'content', text: rawPart.text });
            continue;
          }
          if (rawPart.inlineData?.data) {
            const mimeType = rawPart.inlineData.mimeType || 'image/png';
            onEvent({
              type: 'content',
              text: `\n![Generated Image](data:${mimeType};base64,${rawPart.inlineData.data})\n`,
            });
          }
        }
      }
      if (parsed.usageMetadata) {
        inputTokens = parsed.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = parsed.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
    } catch {
      return;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      parseLine(line);
    }
  }

  if (buffer.trim()) {
    parseLine(buffer);
  }

  return {
    toolCalls,
    modelContent: modelParts.length > 0 ? { role: 'model', parts: modelParts } : null,
    inputTokens,
    outputTokens,
  };
}

export async function createGoogleToolResponseStream(options: GoogleStreamOptions): Promise<Response> {
  const { body, contents } = buildGoogleRequest(options.messages, Boolean(options.disableTools), options.toolNames);
  const initialFetch = await fetchGoogleStream(options.apiKey, options.model, body);
  if (!initialFetch.ok) {
    return jsonError(initialFetch.message, initialFetch.status);
  }

  let activeModel = initialFetch.activeModel;
  const encoder = new TextEncoder();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (payload: Record<string, unknown> | '[DONE]') => {
        const data = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        if (initialFetch.fallbackUsed) {
          enqueue({
            type: 'fallback',
            originalModel: initialFetch.fallbackUsed.originalModel,
            fallbackModel: initialFetch.fallbackUsed.fallbackModel,
            reason: initialFetch.fallbackUsed.reason,
          });
        }
        let currentResponse = initialFetch.response;
        let step = 0;

        while (step < MAX_GEMINI_TOOL_STEPS) {
          const stepResult = await consumeGoogleStream(currentResponse, (event) => {
            if (!event.text) return;
            if (event.type === 'thinking') {
              enqueue({ type: 'thinking', text: event.text });
              return;
            }
            enqueue({ type: 'content', text: event.text });
          });

          totalInputTokens += stepResult.inputTokens;
          totalOutputTokens += stepResult.outputTokens;

          if (stepResult.toolCalls.length === 0) {
            break;
          }

          if (stepResult.modelContent) {
            contents.push(stepResult.modelContent);
          }

          const functionResponseParts: GooglePart[] = [];
          for (const toolCall of stepResult.toolCalls) {
            enqueue({
              type: 'tool_use',
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              arguments: toolCall.arguments,
              ...(toolCall.filePath ? { filePath: toolCall.filePath } : {}),
              status: 'calling',
            });

            const result = await executeNativeTool(toolCall.toolName, toolCall.arguments, {
              model: activeModel,
              repoRoot: options.scopedRepoRoot,
              tabId: options.tabId,
              // Enforce the allowlist at execution, not just advertisement.
              allowedTools: options.toolNames,
            });

            enqueue({
              type: 'tool_result',
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              output: result.output,
              ...(result.diff ? { diff: result.diff } : {}),
              status: result.status,
            });

            functionResponseParts.push({
              functionResponse: {
                name: toolCall.toolName,
                response: result.response,
              },
            });
          }

          contents.push({ role: 'user', parts: functionResponseParts });
          step += 1;

          const followFetch = await fetchGoogleStream(options.apiKey, activeModel, {
            ...body,
            contents,
          });
          if (!followFetch.ok) {
            enqueue({ type: 'error', message: followFetch.message });
            break;
          }

          activeModel = followFetch.activeModel;
          currentResponse = followFetch.response;
        }

        const costUsd = computeCost(activeModel, totalInputTokens, totalOutputTokens);
        enqueue({
          type: 'usage',
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd,
        });
        enqueue('[DONE]');

        if (options.auth?.user && totalOutputTokens > 0) {
          try {
            logUsage({
              userId: options.auth.user.id,
              model: activeModel,
              provider: 'google',
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              costUsd,
              agentName: 'llm-chat',
              requestType: 'chat',
            });
          } catch {
            console.error('[proxy/llm/google] Failed to log usage');
          }
        }

      } catch {
        enqueue({
          type: 'error',
          message: 'Google stream error',
        });
      } finally {
        try {
          controller.close();
        } catch {
          return;
        }
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
