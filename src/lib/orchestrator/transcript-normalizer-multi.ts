/**
 * Multi-runtime transcript normalizers.
 *
 * Phase-2 audit fix — `o8_packet_transcript` previously only handled codex
 * sessions, so dispatch transcript readback returned `events: []` for
 * opencode and claude-code packets. This module ports the same
 * `TranscriptEvent` shape from `./transcript-normalizer.ts` (Codex) to the
 * other runtimes' on-disk JSONL formats.
 *
 * Schemas:
 *   - opencode 1.4.3 → events use a `type`/`part.type` discriminator pair
 *     (`text/text`, `tool_use/tool`, `step_finish/step-finish`, etc.).
 *     Tool calls and tool results live inside the same `part` (the
 *     `state.status` flips from `pending` → `completed`), so we emit a
 *     synthesized `tool_call` immediately followed by `tool_result` when
 *     we see a completed tool part.
 *   - claude-code → events use a `type` field (`user`/`assistant`/`system`)
 *     with `message.content` carrying anthropic-style content blocks
 *     (`text`, `tool_use`, `tool_result`). One JSONL line per event.
 *
 * Returns `[]` on empty input or malformed JSONL — never throws so callers
 * can treat absence as a benign condition (same contract as
 * `normalizeCodexEvents`).
 */

import { createBackgroundAgents } from '@/lib/claude-code/background-agents';
import type { TranscriptEvent } from './transcript-normalizer';

const MAX_SUMMARY = 240;
const MAX_ASSISTANT_TEXT = 4_000;
const MAX_ARGS = 600;

function clip(input: string | undefined, max: number, preserveLines = false): string {
  if (!input) return '';
  const collapsed = preserveLines ? input.trim() : input.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
  }
  return undefined;
}

function argsPreview(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return clip(input, MAX_ARGS);
  try {
    return clip(JSON.stringify(input), MAX_ARGS);
  } catch {
    return '';
  }
}

function normalizeTs(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

// ── opencode ─────────────────────────────────────────────────────────────────

/**
 * Normalize opencode JSONL into the shared `TranscriptEvent` shape.
 *
 * opencode 1.4.3 schema (newline-delimited JSON):
 *   {"type":"step_start","part":{"type":"step-start"}}
 *   {"type":"text","part":{"type":"text","text":"..."}}
 *   {"type":"tool_use","part":{"type":"tool","tool":"glob","callID":"call_x",
 *     "state":{"status":"completed","input":{...},"output":"..."}}}
 *   {"type":"step_finish","part":{"type":"step-finish","tokens":{...}}}
 *
 * Tool calls and results are folded into the same `part` (state.status
 * flips when the tool completes), so we synthesize matching `tool_call`
 * + `tool_result` events from one log line.
 */
export function normalizeOpencodeEvents(rawJsonl: string): TranscriptEvent[] {
  if (!rawJsonl || typeof rawJsonl !== 'string') return [];

  const out: TranscriptEvent[] = [];
  const emittedTools = new Map<string, { callIndex: number; resultIndex?: number }>();
  const fallbackTs = new Date().toISOString();
  let seq = 0;
  const nextSeq = () => (seq += 1);

  for (const rawLine of rawJsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = safeObject(JSON.parse(line));
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const type = readStr(parsed, 'type');
    const ts = normalizeTs(parsed.timestamp, fallbackTs);
    const part = safeObject(parsed.part);
    const partType = readStr(part, 'type');

    // ── assistant text ────────────────────────────────────────────────────────
    if (type === 'text' && partType === 'text') {
      const text = clip(readStr(part, 'text'), MAX_ASSISTANT_TEXT, true);
      if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text });
      continue;
    }

    // ── tool call + result (folded into one part on completion) ───────────────
    if (type === 'tool_use' && partType === 'tool') {
      const tool = readStr(part, 'tool', 'name') || 'tool';
      const callId = readStr(part, 'callID', 'call_id', 'id') || `tool-${seq + 1}`;
      const state = safeObject(part?.state);
      const status = readStr(state, 'status');
      const input = state?.input ?? part?.input ?? {};
      const args = argsPreview(input);

      const emitted = emittedTools.get(callId);
      const previousCall = emitted ? out[emitted.callIndex] : undefined;
      const toolCall: TranscriptEvent = {
        seq: previousCall?.seq ?? nextSeq(),
        ts: previousCall?.ts ?? ts,
        type: 'tool_call',
        callId,
        tool,
        args,
        summary: clip(args || `call ${tool}`, MAX_SUMMARY),
      };
      if (emitted) out[emitted.callIndex] = toolCall;
      else {
        out.push(toolCall);
        emittedTools.set(callId, { callIndex: out.length - 1 });
      }

      if (status === 'completed' || status === 'error') {
        const output = state?.output ?? state?.result ?? '';
        const ok = status !== 'error';
        const summaryRaw = typeof output === 'string' ? output : argsPreview(output);
        const current = emittedTools.get(callId)!;
        const previousResult = current.resultIndex === undefined ? undefined : out[current.resultIndex];
        const toolResult: TranscriptEvent = {
          seq: previousResult?.seq ?? nextSeq(),
          ts: previousResult?.ts ?? ts,
          type: 'tool_result',
          callId,
          tool,
          ok,
          summary: clip(summaryRaw || (ok ? 'ok' : 'error'), MAX_SUMMARY),
        };
        if (current.resultIndex === undefined) {
          out.push(toolResult);
          current.resultIndex = out.length - 1;
        } else {
          out[current.resultIndex] = toolResult;
        }
      }
      continue;
    }

    // ── error event ───────────────────────────────────────────────────────────
    if (type === 'error') {
      const message = clip(
        readStr(parsed, 'message', 'error') || readStr(part, 'message', 'error'),
        MAX_SUMMARY,
      );
      out.push({ seq: nextSeq(), ts, type: 'error', message: message || 'opencode run error' });
      continue;
    }

    // ── completion (step_finish with reason==='stop' marks the end) ───────────
    if (type === 'step_finish' && partType === 'step-finish') {
      const reason = readStr(part, 'reason');
      // Only the *last* step_finish is meaningfully terminal — but the opencode
      // log writes one per turn, so we let consumers pick the latest `done`.
      // Carry the exit code 0 unless `reason === 'error'`.
      if (reason === 'stop' || reason === 'tool-calls' || reason === '') {
        // Don't emit a `done` for tool-calls — that's mid-turn.
        if (reason === 'stop' || reason === '') {
          out.push({ seq: nextSeq(), ts, type: 'done', exitCode: 0 });
        }
      } else if (reason === 'error') {
        out.push({ seq: nextSeq(), ts, type: 'error', message: 'opencode step ended with error' });
      }
      continue;
    }
  }

  return out;
}

// ── claude-code ──────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | unknown[];
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as AnthropicContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n').trim();
}

function extractClaudeToolBlocks(content: unknown): AnthropicContentBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as AnthropicContentBlock[]).filter((b) => b?.type === 'tool_use' && b.name);
}

function extractClaudeToolResults(content: unknown): AnthropicContentBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as AnthropicContentBlock[]).filter((b) => b?.type === 'tool_result');
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as AnthropicContentBlock[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * Normalize claude-code JSONL into the shared `TranscriptEvent` shape.
 *
 * claude-code schema (one JSONL line per event):
 *   {"type":"user","message":{"role":"user","content":"hi"|[blocks]}}
 *   {"type":"assistant","message":{"role":"assistant","content":[blocks]}}
 *     blocks include {type:"text",text:"..."} and
 *     {type:"tool_use",name:"Bash",input:{...},id:"call_x"}.
 *   {"type":"user","message":{"role":"user","content":[{type:"tool_result",
 *     tool_use_id:"call_x",content:"..."}]}}
 *
 * Tool calls and results live in separate JSONL lines, so we maintain a
 * pending-call map keyed by `tool_use_id` to keep the call/result pairing.
 */
export function normalizeClaudeCodeEvents(rawJsonl: string): TranscriptEvent[] {
  if (!rawJsonl || typeof rawJsonl !== 'string') return [];

  const out: TranscriptEvent[] = [];
  const pending = new Map<string, { tool: string }>();
  const backgroundAgents = createBackgroundAgents();
  const fallbackTs = new Date().toISOString();
  let seq = 0;
  const nextSeq = () => (seq += 1);

  for (const rawLine of rawJsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = safeObject(JSON.parse(line));
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const type = readStr(parsed, 'type');
    const ts = normalizeTs(parsed.timestamp, fallbackTs);
    const message = safeObject(parsed.message);
    const content = message?.content;

    // ── assistant text + tool_use blocks ──────────────────────────────────────
    if (type === 'assistant' && message) {
      const text = clip(extractClaudeText(content), MAX_ASSISTANT_TEXT, true);
      if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text });

      for (const block of extractClaudeToolBlocks(content)) {
        const tool = block.name ?? 'tool';
        const callId = block.id ?? `tool-${seq + 1}`;
        const args = argsPreview(block.input);
        pending.set(callId, { tool });
        out.push({
          seq: nextSeq(),
          ts,
          type: 'tool_call',
          callId,
          tool,
          args,
          summary: clip(args || `call ${tool}`, MAX_SUMMARY),
        });
      }
      continue;
    }

    // ── user-side tool_result blocks (paired by tool_use_id) ──────────────────
    if (type === 'user' && message) {
      for (const block of extractClaudeToolResults(content)) {
        const callId = block.tool_use_id ?? '';
        // As on the live lead, a background launch is still a pending call.
        if (backgroundAgents.isRunning(callId)) continue;
        const pendingCall = callId ? pending.get(callId) : undefined;
        if (callId) pending.delete(callId);
        const tool = pendingCall?.tool ?? 'tool';
        const summary = clip(extractToolResultText(block.content), MAX_SUMMARY);
        out.push({
          seq: nextSeq(),
          ts,
          type: 'tool_result',
          callId,
          tool,
          ok: block.is_error !== true,
          summary: summary || 'ok',
        });
      }
      continue;
    }

    // ── system task lifecycle and errors ──────────────────────────────────────
    if (type === 'system') {
      const answer = backgroundAgents.observe(parsed);
      if (answer) {
        const pendingCall = pending.get(answer.id);
        pending.delete(answer.id);
        out.push({
          seq: nextSeq(),
          ts,
          type: 'tool_result',
          callId: answer.id,
          tool: pendingCall?.tool ?? 'tool',
          ok: !answer.isError,
          summary: clip(answer.output, MAX_SUMMARY) || 'ok',
        });
      }
      const text = typeof message?.content === 'string' ? message.content : '';
      const lower = text.toLowerCase();
      if (text && (lower.includes('error') || lower.includes('crash') || lower.includes('fatal'))) {
        out.push({ seq: nextSeq(), ts, type: 'error', message: clip(text, MAX_SUMMARY) });
      }
      continue;
    }

    // claude-code doesn't emit a structured "done" event in the JSONL — the
    // run ends when the file stops growing. Callers can use `findLastIndex
    // type==='assistant'` as the end-of-turn signal. We deliberately don't
    // synthesize a fake `done` here.
    void readNum; // silence unused-import warning when no error path runs
  }

  return out;
}
