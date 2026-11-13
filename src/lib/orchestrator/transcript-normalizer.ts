/**
 * Codex Transcript Normalizer
 *
 * Pure transform from raw Codex JSONL (as written by `codex exec` into
 * owned-run stdout files or rollout files) into a compact, agent-friendly
 * event stream.
 *
 * Consolidates `tool_call` / `tool_result` pairs, emits assistant text as a
 * single event, and surfaces terminal events (`done`, `error`). Each event
 * carries a monotonic `seq` so callers can paginate with cursor semantics.
 *
 * The function is a pure string-in → array-out transform and never throws
 * on malformed input. Callers can treat the empty array as a benign signal
 * that the session has no durable transcript yet.
 */

export type TranscriptEvent =
  | { seq: number; ts: string; type: 'tool_call'; callId?: string; tool: string; args: string; summary: string }
  | { seq: number; ts: string; type: 'tool_result'; callId?: string; tool: string; ok: boolean; summary: string }
  | { seq: number; ts: string; type: 'assistant'; text: string }
  | { seq: number; ts: string; type: 'steer'; source: string; text: string; failed?: boolean; note?: string }
  | { seq: number; ts: string; type: 'error'; message: string }
  | { seq: number; ts: string; type: 'done'; exitCode: number };

const MAX_SUMMARY = 240;
const MAX_ASSISTANT_TEXT = 4_000;
const MAX_ARGS = 600;

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStr(source: Record<string, unknown> | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNum(source: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function clip(input: string | undefined, max: number, preserveLines = false): string {
  if (!input) return '';
  const collapsed = preserveLines ? input.trim() : input.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function extractText(source: unknown): string {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return '';
  if (Array.isArray(source)) return source.map(extractText).filter(Boolean).join(' ');
  const obj = source as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return '';
}

function normalizedArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input.trim();
  try { return JSON.stringify(input); } catch { return ''; }
}

function argsPreview(input: unknown): string {
  return clip(normalizedArgs(input), MAX_ARGS);
}

interface NormalizedTimestamp {
  value: string;
  reliable: boolean;
}

function normalizeTs(raw: unknown, fallback: string): NormalizedTimestamp {
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return { value: parsed.toISOString(), reliable: true };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return { value: parsed.toISOString(), reliable: true };
  }
  return { value: fallback, reliable: false };
}

interface PendingCall { seq: number; tool: string; }
interface EmittedTool { callIndex: number; resultIndex?: number; tool: string; }
type ToolCallShape = 'response-function' | 'response-custom' | 'event-exec' | 'item-exec' | 'item-tool';
interface IdentityAlias { callId: string; shapes: Set<ToolCallShape>; }

/**
 * Normalize raw Codex JSONL into a TranscriptEvent stream. Never throws —
 * malformed lines are skipped. Returns `[]` when input is empty or entirely
 * unparseable so callers can treat absence as a benign condition.
 */
export function normalizeCodexEvents(rawJsonl: string, fallbackTimestamp = new Date().toISOString(), nativeIdentities = false): TranscriptEvent[] {
  if (!rawJsonl || typeof rawJsonl !== 'string') return [];
  const normalizer = createCodexEventNormalizer(fallbackTimestamp, nativeIdentities);
  normalizer.append(rawJsonl);
  return normalizer.events;
}

/** Incremental JSONL ingestion retains call identities across file chunks and runs. */
export function createCodexEventNormalizer(fallbackTimestamp = new Date().toISOString(), nativeIdentities = false) {

  const out: TranscriptEvent[] = [];
  const pending = new Map<string, PendingCall>();
  const emitted = new Map<string, EmittedTool>();
  /** Full tool+args+timestamp → cross-shape occurrences in arrival order. */
  const identityAliases = new Map<string, IdentityAlias[]>();
  const fallbackTs = fallbackTimestamp;
  let seq = 0;
  let syntheticCallSeq = 0;
  let currentSourceId = '';
  const nativeId = (kind: string, callId?: string) => nativeIdentities && currentSourceId
    ? { eventId: `${currentSourceId}:${kind}:${callId ?? '0'}` } : {};
  const nextSeq = () => (seq += 1);
  const nextSyntheticCallId = (prefix: string) => `${prefix}-synthetic-${syntheticCallSeq += 1}`;

  const pushToolCall = (input: {
    ts: string;
    timestampReliable: boolean;
    callId: string;
    shape: ToolCallShape;
    tool: string;
    args: string;
    identityArgs: string;
  }) => {
    const { ts, timestampReliable, callId, shape, tool, args, identityArgs } = input;
    // Codex carries ONE command in several stream shapes -- `exec_command_begin`,
    // `item.started`, `response_item` -- and each derives its call id
    // differently (`call_id` vs `id` vs `id\0command`). Keyed on id alone, the
    // same command emitted four identical `tool_call` rows sharing a timestamp
    // to the millisecond, and at a 50-event cap those copies displaced real
    // history (#1845). A genuine re-run carries a distinct timestamp, so
    // tool+args+ts identifies the emission itself rather than the shape that
    // announced it.
    // Alias only when both the timestamp and full arguments are trustworthy.
    // The displayed arguments are clipped, and missing/invalid timestamps use
    // fallbackTs; neither is safe as an identity. Track shape occurrences so
    // two legitimate same-millisecond calls with the same arguments pair by
    // ordinal instead of collapsing into one row.
    const identity = timestampReliable && identityArgs
      ? `${tool}\u0000${identityArgs}\u0000${ts}`
      : null;
    const aliases = identity ? (identityAliases.get(identity) ?? []) : [];
    const alias = aliases.find((candidate) => !candidate.shapes.has(shape));
    const previous = emitted.get(callId)
      ?? (alias ? emitted.get(alias.callId) : undefined);
    if (previous) {
      const previousCall = out[previous.callIndex];
      out[previous.callIndex] = {
        seq: previousCall!.seq,
        ts: previousCall!.ts,
        type: 'tool_call',
        ...('eventId' in previousCall ? { eventId: previousCall.eventId } : {}),
        callId: previousCall.type === 'tool_call' ? previousCall.callId : callId,
        tool,
        args,
        summary: clip(args || `call ${tool}`, MAX_SUMMARY),
      };
      previous.tool = tool;
      // Every id shape naming this call must reach the same record, so the
      // result pairs with the row already on screen instead of orphaning.
      emitted.set(callId, previous);
      pending.set(callId, { seq: previousCall!.seq, tool });
      if (identity) {
        const existingAlias = alias
          ?? aliases.find((candidate) => emitted.get(candidate.callId) === previous);
        if (existingAlias) {
          existingAlias.shapes.add(shape);
        } else {
          aliases.push({ callId, shapes: new Set([shape]) });
          identityAliases.set(identity, aliases);
        }
      }
      return;
    }
    const thisSeq = nextSeq();
    pending.set(callId, { seq: thisSeq, tool });
    const summary = clip(args || `call ${tool}`, MAX_SUMMARY);
    out.push({ seq: thisSeq, ts, type: 'tool_call', callId, tool, args, summary, ...nativeId('tool_call', callId) });
    emitted.set(callId, { callIndex: out.length - 1, tool });
    if (identity) {
      aliases.push({ callId, shapes: new Set([shape]) });
      identityAliases.set(identity, aliases);
    }
  };

  const pushToolResult = (ts: string, callId: string | undefined, fallbackTool: string, rawOutput: string, exitCode: number | undefined) => {
    const pendingCall = callId ? pending.get(callId) : undefined;
    if (callId) pending.delete(callId);
    const previous = callId ? emitted.get(callId) : undefined;
    const tool = pendingCall?.tool ?? previous?.tool ?? fallbackTool;
    const output = clip(rawOutput, MAX_SUMMARY);
    const ok = exitCode === undefined ? true : exitCode === 0;
    const previousResult = previous?.resultIndex === undefined ? undefined : out[previous.resultIndex];
    const result: TranscriptEvent = {
      seq: previousResult?.seq ?? nextSeq(), ts: previousResult?.ts ?? ts, type: 'tool_result', callId: previous && out[previous.callIndex].type === 'tool_call' ? (out[previous.callIndex] as Extract<TranscriptEvent, { type: 'tool_call' }>).callId : callId, tool, ok,
      summary: output || (ok ? 'ok' : `exit ${exitCode}`),
      ...(previousResult && 'eventId' in previousResult ? { eventId: previousResult.eventId } : nativeId('tool_result', callId)),
    };
    if (previous && previous.resultIndex !== undefined) {
      out[previous.resultIndex] = result;
      return;
    }
    out.push(result);
    if (previous) previous.resultIndex = out.length - 1;
  };

  const append = (rawJsonl: string) => {
    for (const rawLine of rawJsonl.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      let parsed: Record<string, unknown> | null = null;
      try { parsed = safeObject(JSON.parse(line)); } catch { parsed = null; }
      if (!parsed) continue;

      const type = readStr(parsed, 'type');
      const sourceId = readStr(parsed, 'uuid', 'id') || readStr(safeObject(parsed.item), 'id') || readStr(safeObject(parsed.payload), 'id');
      currentSourceId = sourceId;
      const normalizedTimestamp = normalizeTs(parsed.timestamp, fallbackTs);
      const ts = normalizedTimestamp.value;
      const payload = safeObject(parsed.payload);
      const payloadType = payload ? readStr(payload, 'type') : '';

      // Assistant text
      if (type === 'event_msg' && payloadType === 'agent_message') {
        const text = clip(
          typeof payload!.message === 'string' ? payload!.message : extractText(payload!.content),
          MAX_ASSISTANT_TEXT, true,
        );
        if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text, ...(nativeIdentities && sourceId ? { eventId: `${sourceId}:assistant` } : {}) });
        continue;
      }

      if (type === 'item.completed') {
        const item = safeObject(parsed.item);
        const itemType = item ? readStr(item, 'type') : '';

        if (itemType === 'agent_message') {
          const text = clip(
            readStr(item, 'text') || extractText(item!.content) || extractText(item!.message),
            MAX_ASSISTANT_TEXT, true,
          );
          if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text, ...(nativeIdentities && sourceId ? { eventId: `${sourceId}:assistant` } : {}) });
          continue;
        }

        if (itemType === 'command_execution') {
          const command = readStr(item, 'command');
          const itemId = readStr(item, 'id');
          const callId = itemId && command ? `${itemId}\u0000${command}` : itemId;
          pushToolResult(ts, callId, 'exec_command', extractText(item!.aggregated_output), readNum(item, 'exit_code'));
          continue;
        }

        if (itemType === 'tool_use') {
          const callId = readStr(item, 'id');
          const fallback = readStr(item, 'name', 'tool_name') || 'tool';
          pushToolResult(ts, callId, fallback, extractText(item!.output ?? item!.result), undefined);
          continue;
        }
      }

      // Tool calls
      if (type === 'response_item' && (payloadType === 'function_call' || payloadType === 'custom_tool_call')) {
        const callId = readStr(payload, 'call_id', 'id') || nextSyntheticCallId('tool');
        const tool = readStr(payload, 'name', 'namespace', 'execution') || 'tool';
        const rawArgs = payloadType === 'custom_tool_call' ? payload!.input : payload!.arguments;
        pushToolCall({
          ts,
          timestampReliable: normalizedTimestamp.reliable,
          callId,
          shape: payloadType === 'custom_tool_call' ? 'response-custom' : 'response-function',
          tool,
          args: argsPreview(rawArgs),
          identityArgs: normalizedArgs(rawArgs),
        });
        continue;
      }

      if (type === 'event_msg' && payloadType === 'exec_command_begin') {
        const callId = readStr(payload, 'call_id', 'id') || nextSyntheticCallId('exec');
        const command = readStr(payload, 'parsed_cmd', 'cmd', 'command');
        pushToolCall({
          ts,
          timestampReliable: normalizedTimestamp.reliable,
          callId,
          shape: 'event-exec',
          tool: 'exec_command',
          args: clip(command, MAX_ARGS),
          identityArgs: normalizedArgs(command),
        });
        continue;
      }

      if (type === 'item.started') {
        const item = safeObject(parsed.item);
        if (item && readStr(item, 'type') === 'command_execution') {
          const command = readStr(item, 'command');
          const itemId = readStr(item, 'id');
          const callId = itemId && command ? `${itemId}\u0000${command}` : itemId || nextSyntheticCallId('exec');
          pushToolCall({
            ts,
            timestampReliable: normalizedTimestamp.reliable,
            callId,
            shape: 'item-exec',
            tool: 'exec_command',
            args: clip(command, MAX_ARGS),
            identityArgs: normalizedArgs(command),
          });
          continue;
        }
        if (item && readStr(item, 'type') === 'tool_use') {
          const callId = readStr(item, 'id') || nextSyntheticCallId('tool');
          const tool = readStr(item, 'name', 'tool_name') || 'tool';
          const rawInput = item.input ?? item.arguments ?? item.invocation;
          pushToolCall({
            ts,
            timestampReliable: normalizedTimestamp.reliable,
            callId,
            shape: 'item-tool',
            tool,
            args: argsPreview(rawInput),
            identityArgs: normalizedArgs(rawInput),
          });
          continue;
        }
      }

      // Tool results
      if (type === 'response_item' && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
        const callId = readStr(payload, 'call_id', 'id');
        pushToolResult(ts, callId, 'tool', extractText(payload!.output), readNum(payload, 'exit_code'));
        continue;
      }

      if (type === 'event_msg' && payloadType === 'exec_command_end') {
        const callId = readStr(payload, 'call_id', 'id');
        const rawOutput = extractText(payload!.aggregated_output ?? payload!.output);
        pushToolResult(ts, callId, 'exec_command', rawOutput, readNum(payload, 'exit_code'));
        continue;
      }

      // Errors
      if (type === 'error' || type === 'turn.failed' || type === 'run.failed'
        || (type === 'event_msg' && payloadType === 'error')) {
        const message = clip(
          readStr(parsed, 'message', 'error')
            || readStr(payload, 'message', 'error')
            || extractText(parsed.error)
            || extractText(payload?.content),
          MAX_SUMMARY,
        );
        out.push({ seq: nextSeq(), ts, type: 'error', message: message || 'Codex run error' });
        continue;
      }

      // Terminal
      if (type === 'turn.completed' || (type === 'event_msg' && payloadType === 'task_complete')) {
        const exitCode = readNum(parsed, 'exit_code') ?? readNum(payload, 'exit_code') ?? 0;
        out.push({ seq: nextSeq(), ts, type: 'done', exitCode });
        continue;
      }
    }
  };

  return { append, events: out };
}
