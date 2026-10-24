import { codexUsageCostUsd, resolveRate } from '@/lib/cost/rate-table';
import type { OrchestratorEvent, OrchestratorTurnUsage } from './orchestrator-stream-events';
import { planFromCodexTodoList, planFromToolInput, type OrchestratorPlanSnapshot } from './orchestrator-plan';

export interface ParsedCodexLine {
  type?: string;
  thread_id?: string;
  message?: string;
  code?: string;
  error?: unknown;
  payload?: Record<string, unknown>;
  item?: Record<string, unknown>;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

export interface CodexLineHandlerState {
  terminalOutcome?: 'completed' | 'failed';
  threadId: string | null;
  cost: number | null;
  usage?: OrchestratorTurnUsage;
  /** Last emitted plan snapshot (serialized) — codex re-sends the identical
   * todo_list on started AND completed; suppress the duplicate. Per-turn:
   * every sendTurn/rebound creates a fresh state literal. */
  lastPlanJson?: string;
}

function safeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function emitPlanOnce(
  plan: OrchestratorPlanSnapshot | null,
  state: CodexLineHandlerState,
  onEvent: (event: OrchestratorEvent) => void,
): void {
  if (!plan) return;
  const serialized = JSON.stringify(plan);
  if (state.lastPlanJson === serialized) return;
  state.lastPlanJson = serialized;
  onEvent({ type: 'plan', explanation: plan.explanation, steps: plan.steps });
}

function computeUsdCost(usage: ParsedCodexLine['usage'], model?: string): number | null {
  if (!usage) return null;
  const rate = resolveRate('codex', model) ?? resolveRate('codex', 'gpt-5.5')!;
  const total = codexUsageCostUsd(rate, {
    inputTokens: Math.max(0, usage.input_tokens ?? 0),
    cachedInputTokens: Math.max(0, usage.cached_input_tokens ?? 0),
    outputTokens: Math.max(0, usage.output_tokens ?? 0),
  });
  return Number.isFinite(total) && total > 0 ? total : null;
}

function normalizeUsage(usage: NonNullable<ParsedCodexLine['usage']>): OrchestratorTurnUsage {
  const cacheReadTokens = Math.max(0, usage.cached_input_tokens ?? 0);
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cacheReadTokens),
    outputTokens: Math.max(0, usage.output_tokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens: 0,
    ...(!(typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0
      && typeof usage.cached_input_tokens === 'number' && Number.isFinite(usage.cached_input_tokens) && usage.cached_input_tokens >= 0
      && usage.cached_input_tokens <= usage.input_tokens) ? { cacheObserved: false } : {}),
  };
}

export function handleCodexJsonLine(
  line: string,
  state: CodexLineHandlerState,
  onEvent: (event: OrchestratorEvent) => void,
  options: { isLocalModel: boolean; model?: string; onActivity?: () => void },
): boolean {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line) as ParsedCodexLine;
    const type = String(parsed.type ?? '');
    const payload = safeObject(parsed.payload);

    if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
      state.threadId = parsed.thread_id;
      return true;
    }

    if (type === 'error' || type === 'turn.failed' || type === 'run.failed') {
      state.terminalOutcome = 'failed';
      const nestedError = safeObject(parsed.error);
      const message = typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : typeof nestedError?.message === 'string'
            ? nestedError.message
            : JSON.stringify(parsed.error ?? parsed);
      const code = typeof nestedError?.code === 'string'
        ? nestedError.code
        : typeof parsed.code === 'string'
          ? parsed.code
          : undefined;
      onEvent({ type: 'error', error: message, ...(code ? { code } : {}) });
      return true;
    }

    if (type === 'event_msg' && payload?.type === 'error') {
      const nestedError = safeObject(payload.error);
      const message = typeof payload.message === 'string'
        ? payload.message
        : typeof payload.error === 'string'
          ? payload.error
          : typeof nestedError?.message === 'string'
            ? nestedError.message
            : JSON.stringify(payload);
      const code = typeof nestedError?.code === 'string'
        ? nestedError.code
        : typeof payload.code === 'string'
          ? payload.code
          : undefined;
      onEvent({ type: 'error', error: message, ...(code ? { code } : {}) });
      return true;
    }

    if (type === 'event_msg' && payload?.type === 'agent_message') {
      const text = typeof payload.message === 'string' ? payload.message : '';
      if (text) onEvent({ type: 'text', text });
      return true;
    }

    const item = safeObject(parsed.item);
    if (item && (type === 'item.started' || type === 'item.updated' || type === 'item.completed')) {
      options.onActivity?.();
    }

    // todo_list rides item.started / item.updated / item.completed and is a
    // FULL list every time — normalize each into a complete plan snapshot.
    if (
      (type === 'item.started' || type === 'item.updated' || type === 'item.completed')
      && item?.type === 'todo_list'
    ) {
      emitPlanOnce(planFromCodexTodoList(item), state, onEvent);
      return true;
    }

    // Older proto dialect: update_plan surfaces as an event_msg with
    // { explanation?, plan: [{ step, status }] }.
    if (type === 'event_msg' && payload?.type === 'plan_update') {
      emitPlanOnce(planFromToolInput('update_plan', payload), state, onEvent);
      return true;
    }

    if (type === 'item.completed' && item?.type === 'agent_message') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) onEvent({ type: 'text', text });
      return true;
    }

    if (type === 'item.completed' && item?.type === 'tool_use') {
      const name = typeof item.name === 'string' ? item.name : 'tool';
      let input: unknown = {};
      if (typeof item.arguments === 'string') {
        try { input = JSON.parse(item.arguments); } catch { input = item.arguments; }
      } else if (item.arguments && typeof item.arguments === 'object') {
        input = item.arguments;
      }
      onEvent({ type: 'tool_use', id: typeof item.id === 'string' ? item.id : null, name, input });
      return true;
    }

    if (type === 'item.completed' && item?.type === 'command_execution') {
      const cmd = typeof item.command === 'string'
        ? item.command
        : Array.isArray(item.command)
          ? (item.command as string[]).join(' ')
          : '';
      const output = typeof item.output === 'string' ? item.output : '';
      const callId = typeof item.id === 'string' ? item.id : null;
      onEvent({ type: 'tool_use', id: callId, name: 'shell', input: { command: cmd } });
      if (output) onEvent({ type: 'tool_result', id: callId, name: 'shell', output: output.slice(0, 4_000) });
      return true;
    }

    if (type === 'event_msg' && payload?.type === 'exec_command_begin') {
      const command = typeof payload.command === 'string'
        ? payload.command
        : Array.isArray(payload.command)
          ? (payload.command as string[]).join(' ')
          : '';
      onEvent({ type: 'tool_use', id: typeof payload.call_id === 'string' ? payload.call_id : null, name: 'shell', input: { command } });
      return true;
    }

    if (type === 'event_msg' && payload?.type === 'exec_command_end') {
      const output = typeof payload.stdout === 'string'
        ? payload.stdout
        : typeof payload.output === 'string'
          ? payload.output
          : '';
      onEvent({ type: 'tool_result', id: typeof payload.call_id === 'string' ? payload.call_id : null, name: 'shell', output: output.slice(0, 4_000) });
      return true;
    }

    if (type === 'response_item' && payload?.type === 'reasoning') {
      const summary = typeof payload.summary === 'string'
        ? payload.summary
        : Array.isArray(payload.summary)
          ? (payload.summary as string[]).join('\n')
          : '';
      if (summary) onEvent({ type: 'thinking', text: summary });
      return true;
    }

    if (type === 'response_item' && payload?.type === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'function';
      let input: unknown = {};
      if (typeof payload.arguments === 'string') {
        try { input = JSON.parse(payload.arguments); } catch { input = payload.arguments; }
      }
      onEvent({ type: 'tool_use', id: typeof payload.call_id === 'string' ? payload.call_id : null, name, input });
      return true;
    }

    if (type === 'response_item' && payload?.type === 'function_call_output') {
      const output = typeof payload.output === 'string' ? payload.output : '';
      const shot = output.match(/\/tmp\/o8-screenshots\/[^\s"']+\.(?:png|jpe?g)/i);
      onEvent({
        type: 'tool_result',
        id: typeof payload.call_id === 'string' ? payload.call_id : null,
        name: typeof payload.name === 'string' ? payload.name : 'function',
        output: shot ? shot[0] : output.slice(0, 4_000),
      });
      return true;
    }

    if (type === 'turn.completed' && state.terminalOutcome !== 'failed') state.terminalOutcome = 'completed';
    if (type === 'turn.completed' && parsed.usage) {
      state.cost = options.isLocalModel ? null : computeUsdCost(parsed.usage, options.model);
      state.usage = normalizeUsage(parsed.usage);
    }
    return true;
  } catch {
    // Codex can emit banner/info lines before JSON starts.
    return false;
  }
}
