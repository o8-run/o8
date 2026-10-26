import { cacheUsageEvidence } from '@/lib/prompt-cache/usage-evidence';
import { planFromToolInput, type OrchestratorPlanStep } from './orchestrator-plan';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export type OrchestratorEvent =
  | { type: 'turn_receipt'; leadModel: string; effort: ThinkingEffort; effortSource?: import('@/lib/orchestrator/thinking-effort').EffortReceiptSource; serviceTier?: import('@/lib/orchestrator/thinking-effort').LeadServiceTier; permissionMode?: import('@/lib/orchestrator/permission-mode').OrchestratorPermissionMode }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id?: string | null; name: string; input: unknown }
  | { type: 'tool_result'; id?: string | null; name: string; input?: unknown; output: string; isError?: boolean }
  // A COMPLETE plan snapshot (never a delta) — from Codex todo_list items or
  // Claude TodoWrite/update_plan tool calls. ws-server maps it to the mobile
  // `plan-update` orchestrator event. Step ids are stable within a turn.
  | { type: 'plan'; explanation: string | null; steps: OrchestratorPlanStep[] }
  | { type: 'done'; terminalOutcome?: 'completed' | 'failed' | 'unconfirmed'; sessionId: string | null; cost: number | null; usage?: OrchestratorTurnUsage }
  | { type: 'error'; error: string; code?: string; status?: number }
  // ── Collide (MoA) — emitted ONLY by the collide backend (moa.ts). Proposer
  //    text is buffered, not streamed, so it never pollutes the visible answer
  //    or the persisted assistant text; these two carry it to the faint pre-roll
  //    card. The aggregator's reply still flows through `text` as the sole answer.
  // ── Attempt boundary (#2142). Emitted between the attempts of a retried turn
  //    (today: a detected false dispatch). Everything the discarded attempt
  //    streamed — text, thinking, tool pills — is already in the operator's
  //    bubble and in the incrementally-persisted assistant row by the time the
  //    detector can fire, because settle only ever gated the terminal events.
  //    Consumers MUST drop that content on this event; otherwise the retry's
  //    narration is appended to the discarded one and both ship as a single
  //    glued-together reply.
  | { type: 'turn_retry'; attempt: number; reason: string; notice: string }
  | { type: 'collide_phase'; phase: 'proposing' | 'synthesizing'; proposers?: string[] }
  | { type: 'collide_proposal'; proposer: string; text: string; breach?: boolean }
  // ── Handoff (#1730) — the responding agent changed mid-thread. Emitted at the
  //    seam, before the receiving agent's first token, so the transcript can
  //    render the block inline rather than reconstructing it afterwards.
  //
  //    `lossless` is a claim about CONTEXT, not about quality: true means the
  //    receiving agent inherited the real conversation state rather than a
  //    replay or a summary. Verified true for an ACP same-session model swap
  //    (2026-08-04: deepseek stored a codeword, grok-4.5 recalled it on the
  //    same sessionId). A cross-runtime handoff is a cold start with injected
  //    context and must report false — the operator needs to know which one
  //    they got, because only one of them can be trusted to remember.
  | {
    type: 'handoff';
    from: { backend: string; model: string | null } | null;
    to: { backend: string; model: string | null };
    lossless: boolean;
    handoffId?: string;
    carries?: Record<'narrative' | 'intent' | 'workspace' | 'governance' | 'provenance', 'full' | 'summary' | 'omitted'>;
    packet?: Record<string, unknown>;
  };

export interface OrchestratorTurnUsage {
  cacheObserved?: boolean;
  cacheRetentionMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
}

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  summary?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string } | Record<string, unknown>>;
};

interface ToolCallTracker {
  recordToolUse: (tool: { id?: string | null; name: string; input: unknown }) => void;
  resolveToolResult: (toolUseId?: string | null) => { id?: string | null; name: string; input: unknown } | null;
  /**
   * Mark that text streamed via a `content_block_delta` this turn. Used to dedupe
   * the trailing `assistant` summary event, which re-emits the full assembled text
   * for every block — without this guard, every delta-streamed turn renders the
   * response twice in the chat bubble.
   */
  recordTextDelta: (index: number) => void;
  /** True if `recordTextDelta` was called for this content block index this turn. */
  hasStreamedText: (index: number) => boolean;
  /**
   * True if ANY text streamed this turn (any index). Content-based, not
   * position-based: the assistant replay's content array compacts/shifts when
   * thinking blocks are present, so index-matching mis-fires and re-emits —
   * doubling the answer (the Collide aggregator hit this live). If any text
   * streamed, the replay is redundant → skip it wholesale. Mirrors the fix
   * already in claude-code/stream-json-parser.ts (a9d94b51).
   */
  hasAnyStreamedText: () => boolean;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function parseOrchestratorTurnUsage(event: Record<string, unknown>): OrchestratorTurnUsage | null {
  const usage = event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage)
    ? event.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const parsed = {
    ...cacheUsageEvidence(usage),
    inputTokens: tokenCount(usage.input_tokens ?? usage.inputTokens),
    outputTokens: tokenCount(usage.output_tokens ?? usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens ?? usage.cacheReadTokens),
    ...((usage.cache_creation_input_tokens ?? usage.cacheWriteTokens) !== undefined
      ? { cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens) } : {}),
  };
  return [parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheWriteTokens].some(value => (value ?? 0) > 0) ? parsed : null;
}

export function createToolCallTracker(): ToolCallTracker {
  const pendingById = new Map<string, { id?: string | null; name: string; input: unknown }>();
  const pendingQueue: Array<{ id?: string | null; name: string; input: unknown }> = [];
  const streamedTextIndices = new Set<number>();
  let anyStreamedText = false;

  return {
    recordToolUse(tool) {
      if (tool.id && pendingById.has(tool.id)) {
        return;
      }
      pendingQueue.push(tool);
      if (tool.id) {
        pendingById.set(tool.id, tool);
      }
    },
    resolveToolResult(toolUseId) {
      if (toolUseId) {
        const matched = pendingById.get(toolUseId) ?? null;
        if (!matched) return null;
        pendingById.delete(toolUseId);
        const queueIndex = pendingQueue.findIndex((tool) => tool.id === toolUseId);
        if (queueIndex >= 0) pendingQueue.splice(queueIndex, 1);
        return matched;
      }

      const matched = pendingQueue.shift() ?? null;
      if (!matched) return null;
      if (matched.id) pendingById.delete(matched.id);
      return matched;
    },
    recordTextDelta(index) {
      streamedTextIndices.add(index);
      anyStreamedText = true;
    },
    hasStreamedText(index) {
      return streamedTextIndices.has(index);
    },
    hasAnyStreamedText() {
      return anyStreamedText;
    },
  };
}

function stringifyToolResultContent(content: ContentBlock['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        return item.text;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function processStreamEvent(
  event: Record<string, unknown>,
  onEvent: (e: OrchestratorEvent) => void,
  onSessionId: (id: string) => void,
  onCost: (cost: number) => void,
  tracker: ToolCallTracker,
): void {
  const type = event.type as string | undefined;

  switch (type) {
    case 'system': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) break;
      const blockIndex = typeof event.index === 'number' ? event.index : -1;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (blockIndex >= 0) tracker.recordTextDelta(blockIndex);
        onEvent({ type: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent({ type: 'thinking', text: delta.thinking });
      } else if (delta.type === 'thinking_summary') {
        const summary = typeof delta.summary === 'string'
          ? delta.summary
          : typeof delta.thinking === 'string'
            ? delta.thinking
            : typeof delta.text === 'string'
              ? delta.text
              : '';
        if (summary) {
          onEvent({ type: 'thinking', text: summary });
        }
      }
      break;
    }

    case 'content_block_start': {
      const block = event.content_block as ContentBlock | undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const nextTool = {
          id: typeof block.id === 'string' ? block.id : null,
          name: block.name,
          input: block.input ?? null,
        };
        tracker.recordToolUse(nextTool);
        onEvent({ type: 'tool_use', ...nextTool });
        // content_block_start rarely carries the full input (it streams via
        // input_json_delta, which this parser doesn't accumulate) — the plan
        // usually materializes from the assistant replay below instead.
        const plan = planFromToolInput(nextTool.name, nextTool.input);
        if (plan) onEvent({ type: 'plan', ...plan });
      }
      break;
    }

    case 'assistant': {
      // Claude Code's stream-json mode emits `content_block_delta` events for
      // text as it streams, AND a final `assistant` event containing the full
      // assembled message. Re-emitting text from the assistant event after
      // deltas already flowed produces "OK, still here.OK, still here." in
      // the chat bubble. We dedupe per-block-index: if any text_delta already
      // emitted for this content block, skip the assistant copy.
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      content.forEach((rawBlock, index) => {
        const block = rawBlock as ContentBlock;
        if (block.type === 'text' && typeof block.text === 'string') {
          // Content-based dedup (not index-based): if ANY text streamed via
          // deltas this turn, the assistant event is a redundant full replay —
          // skip it. Index-matching mis-fired when the replay's content array
          // shifted (thinking blocks), doubling the Collide aggregator's answer.
          if (tracker.hasAnyStreamedText()) {
            console.log(`[stream-dedupe] skipping assistant text block ${index} (text already streamed via deltas this turn, ${block.text.length} chars)`);
            return;
          }
          onEvent({ type: 'text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          onEvent({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const nextTool = {
            id: typeof block.id === 'string' ? block.id : null,
            name: block.name,
            input: block.input ?? null,
          };
          tracker.recordToolUse(nextTool);
          onEvent({ type: 'tool_use', ...nextTool });
          const plan = planFromToolInput(nextTool.name, nextTool.input);
          if (plan) onEvent({ type: 'plan', ...plan });
        }
      });
      break;
    }

    case 'user': {
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content as ContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        const matchedTool = tracker.resolveToolResult(typeof block.tool_use_id === 'string' ? block.tool_use_id : null);
        onEvent({
          type: 'tool_result',
          id: matchedTool?.id ?? (typeof block.tool_use_id === 'string' ? block.tool_use_id : null),
          name: matchedTool?.name ?? '',
          input: matchedTool?.input,
          output: stringifyToolResultContent(block.content),
          // Anthropic tags a failed tool_result with `is_error`. Thread it through
          // so the transcript can flip the chip to an error badge (deliverable 3,
          // turn grammar). The Codex path carries no equivalent flag — its shell
          // results stay statusless (running→done), an accepted gap.
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      break;
    }

    case 'result': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      const totalCost = event.total_cost_usd as number | undefined;
      if (typeof totalCost === 'number') onCost(totalCost);
      const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
      const isError = event.is_error === true || subtype?.startsWith('error_') === true;
      if (isError) {
        const nestedError = event.error && typeof event.error === 'object'
          ? event.error as Record<string, unknown>
          : null;
        const error = typeof event.result === 'string'
          ? event.result
          : typeof event.message === 'string'
            ? event.message
            : typeof event.error === 'string'
              ? event.error
              : typeof nestedError?.message === 'string'
                ? nestedError.message
                : 'Claude Code turn failed.';
        const code = typeof event.error_code === 'string'
          ? event.error_code
          : typeof nestedError?.code === 'string'
            ? nestedError.code
            : subtype;
        onEvent({ type: 'error', error, ...(code ? { code } : {}) });
      }
      break;
    }
  }
}
