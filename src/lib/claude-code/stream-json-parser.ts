import { cacheUsageEvidence } from '@/lib/prompt-cache/usage-evidence';
export type ClaudeCodeStreamJsonChatEvent =
  | { type: 'delta'; text: string; blockIndex?: number; messageIndex?: number; messageKey?: string }
  | { type: 'thinking'; text: string; blockIndex?: number; messageIndex?: number; messageKey?: string }
  | { type: 'tool_call'; id?: string | null; name: string; status: 'calling' | 'running' | 'done'; args?: Record<string, unknown>; preview?: string }
  | { type: 'tool_result'; isError?: boolean; id?: string | null; name?: string; args?: Record<string, unknown>; output?: string; preview?: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheRetentionMs?: number;
      cacheObserved?: boolean;
      costUsd?: number;
    }
  | { type: 'plan_step'; id?: string | null; text: string; status?: 'pending' | 'active' | 'complete' }
  | { type: 'permission_request'; id?: string | null; name?: string; text: string; args?: Record<string, unknown> };

export type ClaudeCodeStreamJsonParserEvent =
  | ClaudeCodeStreamJsonChatEvent
  | {
      type: 'done';
      text: string;
      isError?: boolean;
      subtype?: string;
      sessionId?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheRetentionMs?: number;
      cacheObserved?: boolean;
      costUsd?: number;
      duration?: number;
    };

export interface ClaudeCodeStreamJsonParserState {
  fullResponse: string;
  sessionId: string | null;
  emittedDone: boolean;
}

export interface ClaudeCodeStreamJsonParserOptions {
  planMode?: boolean;
  maxToolResultPreviewChars?: number;
}

export interface ClaudeCodeStreamJsonParser {
  pushChunk: (chunk: string) => ClaudeCodeStreamJsonParserEvent[];
  flush: () => ClaudeCodeStreamJsonParserEvent[];
  getState: () => ClaudeCodeStreamJsonParserState;
}

interface TrackedToolCall {
  id?: string | null;
  name: string;
  input?: Record<string, unknown>;
}

const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 500;
const PLAN_STEP_RE = /^\s*(?:[-*\u2022]|\d+[.)]|\[[ xX-]])\s+(.+)$/;
const PERMISSION_TOOL_NAMES = new Set([
  'ExitPlanMode',
  'exit_plan_mode',
  'permission_request',
  'request_permission',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArgs(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value) ?? undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      const record = asRecord(item);
      if (typeof record?.text === 'string') return record.text;
      return record ? safeJson(record) : '';
    })
    .filter(Boolean)
    .join('\n');
}

function previewText(text: string, maxChars: number): string | undefined {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact;
}

function usageFromClaude(input: unknown, costUsd?: number): Extract<ClaudeCodeStreamJsonChatEvent, { type: 'usage' }> | null {
  const usage = asRecord(input);
  const inputTokens = asNumber(usage?.input_tokens) ?? asNumber(usage?.inputTokens) ?? 0;
  const outputTokens = asNumber(usage?.output_tokens) ?? asNumber(usage?.outputTokens) ?? 0;
  const cacheReadTokens = asNumber(usage?.cache_read_input_tokens)
    ?? asNumber(usage?.cacheReadTokens)
    ?? 0;
  const cacheWriteTokens = asNumber(usage?.cache_creation_input_tokens)
    ?? asNumber(usage?.cacheWriteTokens)
    ?? 0;
  const nextCost = costUsd ?? asNumber(usage?.cost_usd) ?? asNumber(usage?.total_cost_usd);
  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheWriteTokens <= 0 && typeof nextCost !== 'number') return null;
  return {
    type: 'usage',
    ...cacheUsageEvidence(usage ?? {}),
    inputTokens,
    outputTokens,
    ...((usage?.cache_read_input_tokens ?? usage?.cacheReadTokens) !== undefined && cacheReadTokens >= 0 ? { cacheReadTokens } : {}),
    ...((usage?.cache_creation_input_tokens ?? usage?.cacheWriteTokens) !== undefined && cacheWriteTokens >= 0 ? { cacheWriteTokens } : {}),
    ...(typeof nextCost === 'number' ? { costUsd: nextCost } : {}),
  };
}

function toolKey(tool: TrackedToolCall): string {
  if (tool.id) return `id:${tool.id}`;
  return `name:${tool.name}:${safeJson(tool.input ?? {})}`;
}

function createToolTracker() {
  const pendingById = new Map<string, TrackedToolCall>();
  const pendingQueue: TrackedToolCall[] = [];
  const emittedToolKeys = new Set<string>();

  return {
    record(tool: TrackedToolCall) {
      const key = toolKey(tool);
      if (emittedToolKeys.has(key)) return false;
      emittedToolKeys.add(key);
      pendingQueue.push(tool);
      if (tool.id) pendingById.set(tool.id, tool);
      return true;
    },
    resolve(toolUseId?: string | null) {
      if (toolUseId) {
        const matched = pendingById.get(toolUseId) ?? null;
        if (!matched) return null;
        pendingById.delete(toolUseId);
        const queueIndex = pendingQueue.findIndex((tool) => tool.id === toolUseId);
        if (queueIndex >= 0) pendingQueue.splice(queueIndex, 1);
        return matched;
      }

      const matched = pendingQueue.shift() ?? null;
      if (matched?.id) pendingById.delete(matched.id);
      return matched;
    },
  };
}

function permissionText(name: string, args?: Record<string, unknown>): string {
  for (const key of ['plan', 'reason', 'description', 'message', 'text']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (name === 'ExitPlanMode') {
    return 'Claude is requesting permission to leave plan mode and make changes.';
  }
  return 'Claude is requesting permission to continue.';
}

function planStepFromLine(line: string): string | null {
  const match = line.match(PLAN_STEP_RE);
  if (!match?.[1]) return null;
  const text = match[1].trim();
  return text ? text : null;
}

export function createClaudeCodeStreamJsonParser(
  options: ClaudeCodeStreamJsonParserOptions = {},
): ClaudeCodeStreamJsonParser {
  const maxToolResultPreviewChars = options.maxToolResultPreviewChars ?? DEFAULT_TOOL_RESULT_PREVIEW_CHARS;
  const state: ClaudeCodeStreamJsonParserState = {
    fullResponse: '',
    sessionId: null,
    emittedDone: false,
  };
  const tracker = createToolTracker();
  const streamedTextIndices = new Set<number>();
  const streamedThinkingIndices = new Set<number>();
  let streamedTextWithoutIndex = false;
  let streamedThinkingWithoutIndex = false;
  let messageIndex = 0;
  let messageKey = 'stream:0';
  let snapshotMessageOrdinal = 0;
  let lineBuffer = '';
  let planLineBuffer = '';

  const emitPlanSteps = (text: string): ClaudeCodeStreamJsonParserEvent[] => {
    if (!options.planMode || !text) return [];
    const events: ClaudeCodeStreamJsonParserEvent[] = [];
    planLineBuffer += text;
    const lines = planLineBuffer.split('\n');
    planLineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const step = planStepFromLine(line);
      if (step) events.push({ type: 'plan_step', text: step, status: 'active' });
    }
    return events;
  };

  const emitText = (
    text: string,
    events: ClaudeCodeStreamJsonParserEvent[],
    blockIndex?: number,
    markStreamedText = false,
    emittedMessageKey = messageKey,
  ) => {
    if (!text) return;
    state.fullResponse += text;
    if (markStreamedText) {
      if (typeof blockIndex === 'number' && blockIndex >= 0) {
        streamedTextIndices.add(blockIndex);
      } else {
        streamedTextWithoutIndex = true;
      }
    }
    events.push({
      type: 'delta', text, messageIndex, messageKey: emittedMessageKey,
      ...(typeof blockIndex === 'number' ? { blockIndex } : {}),
    });
    events.push(...emitPlanSteps(text));
  };

  const emitToolUse = (
    block: Record<string, unknown>,
    events: ClaudeCodeStreamJsonParserEvent[],
  ) => {
    const name = asString(block.name) ?? asString(block.tool) ?? 'tool';
    const args = asArgs(block.input) ?? asArgs(block.args);
    const tool = {
      id: asString(block.id) ?? asString(block.tool_use_id) ?? null,
      name,
      input: args,
    };
    if (!tracker.record(tool)) return;

    const preview = typeof args?.description === 'string'
      ? args.description
      : typeof args?.command === 'string'
        ? args.command
        : typeof args?.file_path === 'string'
          ? args.file_path
          : undefined;
    events.push({
      type: 'tool_call',
      id: tool.id,
      name,
      status: 'running',
      ...(args ? { args } : {}),
      ...(preview ? { preview: previewText(preview, 180) } : {}),
    });

    if (PERMISSION_TOOL_NAMES.has(name)) {
      events.push({
        type: 'permission_request',
        id: tool.id,
        name,
        text: permissionText(name, args),
        ...(args ? { args } : {}),
      });
    }
  };

  const emitToolResult = (
    block: Record<string, unknown>,
    events: ClaudeCodeStreamJsonParserEvent[],
  ) => {
    const toolUseId = asString(block.tool_use_id) ?? asString(block.id) ?? null;
    const matchedTool = tracker.resolve(toolUseId);
    const explicitOutput = asString(block.output) ?? asString(block.result);
    const rawOutput = explicitOutput ?? stringifyToolResultContent(block.content);
    // A screenshot tool's base64 is swamped in the result; surface the saved
    // file path (o8_view_screenshot persists it) so the canvas can SHOW the
    // capture via serve-image instead of dropping it.
    const shot = rawOutput ? rawOutput.match(/\/tmp\/o8-screenshots\/[^\s"']+\.(?:png|jpe?g)/i) : null;
    const output = shot ? shot[0] : rawOutput;
    events.push({
      type: 'tool_result',
      ...(block.is_error === true ? { isError: true } : {}),
      id: matchedTool?.id ?? toolUseId,
      name: matchedTool?.name ?? asString(block.name) ?? asString(block.tool),
      ...(matchedTool?.input ? { args: matchedTool.input } : {}),
      ...(output ? { output, preview: previewText(output, maxToolResultPreviewChars) } : {}),
    });
  };

  const emitDone = (
    event: Record<string, unknown>,
    events: ClaudeCodeStreamJsonParserEvent[],
  ) => {
    const costUsd = asNumber(event.total_cost_usd) ?? asNumber(event.cost_usd);
    const usage = usageFromClaude(event.usage, costUsd);
    if (usage) events.push(usage);
    const sessionId = asString(event.session_id) ?? state.sessionId ?? undefined;
    if (sessionId) state.sessionId = sessionId;
    if (state.emittedDone) return;
    const subtype = asString(event.subtype);
    const isResult = event.type === 'result';
    const isError = event.is_error === true
      || (isResult && subtype !== undefined && subtype !== 'success');
    const explicitResult = asString(event.result);
    const errorText = isError && Array.isArray(event.errors)
      ? event.errors.filter((value): value is string => typeof value === 'string').join('\n')
      : '';
    const resultText = explicitResult?.trim() ? explicitResult : errorText || state.fullResponse;
    const doneEvent: ClaudeCodeStreamJsonParserEvent = {
      type: 'done',
      text: resultText,
      ...(isError ? { isError: true } : {}),
      ...(subtype ? { subtype } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(usage?.cacheObserved === false ? { cacheObserved: false } : {}),
      ...(usage?.cacheRetentionMs ? { cacheRetentionMs: usage.cacheRetentionMs } : {}),
      ...(typeof usage?.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage?.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      ...(typeof usage?.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(typeof usage?.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(typeof costUsd === 'number' ? { costUsd } : {}),
      ...(typeof asNumber(event.duration_ms) === 'number' ? { duration: asNumber(event.duration_ms) } : {}),
    };
    events.push(doneEvent);
    state.emittedDone = true;
  };

  const processEvent = (event: Record<string, unknown>): ClaudeCodeStreamJsonParserEvent[] => {
    const events: ClaudeCodeStreamJsonParserEvent[] = [];
    const type = asString(event.type);

    if (type === 'system') {
      const id = asString(event.session_id);
      if (id) state.sessionId = id;
      return events;
    }

    // `--include-partial-messages` wraps the Anthropic SSE events in a
    // `stream_event` envelope: { type: 'stream_event', event: { type:
    // 'content_block_delta', ... } }. Unwrap and re-process — this is what
    // makes mid-turn token deltas real (verified against the live CLI
    // 2026-06-11; without the unwrap, text only landed via the complete
    // `assistant` message, one blob per turn). The streamedTextIndices
    // machinery below already dedupes the final assistant replay.
    if (type === 'stream_event') {
      const inner = asRecord(event.event);
      if (inner) return processEvent(inner);
      return events;
    }

    if (type === 'message_start') {
      messageIndex += 1;
      const message = asRecord(event.message);
      messageKey = `stream:${asString(message?.id) ?? messageIndex}`;
      streamedTextIndices.clear();
      streamedThinkingIndices.clear();
      streamedTextWithoutIndex = false;
      streamedThinkingWithoutIndex = false;
      return events;
    }

    if (type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      const blockIndex = asNumber(event.index);
      const thinking = asString(delta?.thinking);
      const text = asString(delta?.text);
      if (delta?.type === 'thinking_delta' && thinking) {
        if (typeof blockIndex === 'number' && blockIndex >= 0) streamedThinkingIndices.add(blockIndex);
        else streamedThinkingWithoutIndex = true;
        events.push({
          type: 'thinking', text: thinking, messageIndex, messageKey,
          ...(typeof blockIndex === 'number' ? { blockIndex } : {}),
        });
        return events;
      }
      if (delta?.type === 'thinking_summary') {
        const summary = asString(delta.summary) ?? thinking ?? text;
        if (summary) {
          if (typeof blockIndex === 'number' && blockIndex >= 0) streamedThinkingIndices.add(blockIndex);
          else streamedThinkingWithoutIndex = true;
          events.push({
            type: 'thinking', text: summary, messageIndex, messageKey,
            ...(typeof blockIndex === 'number' ? { blockIndex } : {}),
          });
        }
        return events;
      }
      if (text) {
        emitText(text, events, blockIndex, true);
      }
      return events;
    }

    if (type === 'content_block_start') {
      const block = asRecord(event.content_block);
      if (block?.type === 'tool_use') {
        emitToolUse(block, events);
      } else if (block?.type === 'thinking') {
        events.push({
          type: 'thinking', text: '', messageIndex, messageKey,
          ...(typeof asNumber(event.index) === 'number' ? { blockIndex: asNumber(event.index) } : {}),
        });
      }
      return events;
    }

    if (type === 'assistant') {
      const message = asRecord(event.message);
      const content = message?.content;
      const hasStreamedText = streamedTextWithoutIndex || streamedTextIndices.size > 0;
      const snapshotKey = hasStreamedText
        ? messageKey
        : `snapshot:${asString(message?.id) ?? snapshotMessageOrdinal++}`;
      if (Array.isArray(content)) {
        content.forEach((rawBlock, blockIndex) => {
          const block = asRecord(rawBlock);
          if (!block) return;
          if (block.type === 'text') {
            const text = asString(block.text);
            if (!text) return;
            // With --include-partial-messages, every text block already
            // streamed as content_block_delta frames — the assistant message
            // is a REPLAY. Index matching (`has(index)`) is positionally
            // fragile: the replayed content array compacts/shifts when
            // thinking blocks are present, so a block streamed at index 1
            // replays at position 0 and re-emits — doubling fullResponse and
            // every non-SSE answer built from it (found live 2026-06-11 via
            // doubled `o8 ask` answers). If ANY text streamed this turn, the
            // replay is redundant — skip it entirely.
            if (hasStreamedText) return;
            emitText(text, events, blockIndex, false, snapshotKey);
          } else if (block.type === 'thinking') {
            const thinking = asString(block.thinking) ?? asString(block.text);
            if (thinking && !streamedThinkingWithoutIndex && !streamedThinkingIndices.has(blockIndex)) {
              events.push({ type: 'thinking', text: thinking, blockIndex, messageIndex, messageKey: snapshotKey });
            }
          } else if (block.type === 'tool_use') {
            emitToolUse(block, events);
          }
        });
      }
      const usage = usageFromClaude(message?.usage);
      if (usage) events.push(usage);
      return events;
    }

    if (type === 'user') {
      const message = asRecord(event.message);
      const content = message?.content;
      if (!Array.isArray(content)) return events;
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (block?.type === 'tool_result') {
          emitToolResult(block, events);
        }
      }
      return events;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      emitToolUse(event, events);
      return events;
    }

    if (type === 'tool_result' || type === 'tool_output') {
      emitToolResult(event, events);
      return events;
    }

    if (type === 'thinking') {
      const text = asString(event.text) ?? asString(event.thinking);
      if (text) events.push({ type: 'thinking', text });
      return events;
    }

    if (type === 'usage') {
      const usage = usageFromClaude(event, asNumber(event.costUsd) ?? asNumber(event.cost_usd));
      if (usage) events.push(usage);
      return events;
    }

    if (type === 'plan_step') {
      const text = asString(event.text);
      if (text) {
        events.push({
          type: 'plan_step',
          id: asString(event.id) ?? null,
          text,
          status: event.status === 'pending' || event.status === 'active' || event.status === 'complete'
            ? event.status
            : undefined,
        });
      }
      return events;
    }

    if (type === 'permission_request') {
      const text = asString(event.text) ?? permissionText('permission_request', asArgs(event.args));
      events.push({
        type: 'permission_request',
        id: asString(event.id) ?? null,
        name: asString(event.name),
        text,
        ...(asArgs(event.args) ? { args: asArgs(event.args) } : {}),
      });
      return events;
    }

    // A streamed message_stop ends one model message, not the worker turn.
    // Tool calls and compaction can follow it. Only the outer result carries
    // terminal success/failure; consuming the first stop masks later errors.
    if (type === 'result') {
      emitDone(event, events);
    }

    return events;
  };

  const parseLine = (line: string): ClaudeCodeStreamJsonParserEvent[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      const event = JSON.parse(trimmed) as unknown;
      const record = asRecord(event);
      return record ? processEvent(record) : [];
    } catch {
      return [];
    }
  };

  return {
    pushChunk(chunk) {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      return lines.flatMap((line) => parseLine(line));
    },
    flush() {
      const events = lineBuffer ? parseLine(lineBuffer) : [];
      lineBuffer = '';
      if (options.planMode) {
        const step = planStepFromLine(planLineBuffer);
        if (step) events.push({ type: 'plan_step', text: step, status: 'active' });
        planLineBuffer = '';
      }
      return events;
    },
    getState() {
      return { ...state };
    },
  };
}
