import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { redactThreadText, redactToolCallForRest } from '@/lib/threads/redaction';

type Json = Record<string, unknown>;

const SESSION_PREFIX = 'subagent:';
const MAX_RESULT_CHARS = 20_000;

export function subagentSessionId(sessionKey: string | null): string | null {
  return sessionKey?.startsWith(SESSION_PREFIX) ? sessionKey.slice(SESSION_PREFIX.length) : null;
}

function logPath(id: string): string | null {
  return /^[\w-]{1,128}$/.test(id) ? join(getDataDir(), 'subagent-transcripts', `${id}.jsonl`) : null;
}

/** A subagent speaks inside its parent's stream; this is the only record of what it said. */
export function recordSubagentEvent(event: Json): void {
  if (event.type !== 'assistant' && event.type !== 'user') return;
  const file = logPath(String(event.parent_tool_use_id ?? ''));
  if (!file) return;
  try {
    mkdirSync(join(getDataDir(), 'subagent-transcripts'), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event, boundToolResults)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[subagent-transcript] failed to record an event', error);
  }
}

/** A chat is read whole on every poll, so a huge tool result stays out of it. */
function boundToolResults(key: string, value: unknown): unknown {
  if (key !== 'content' || !Array.isArray(value)) return value;
  return value.map((block: Json) => (
    block?.type === 'tool_result'
      ? { ...block, content: resultText(block.content).slice(0, MAX_RESULT_CHARS) }
      : block
  ));
}

function contentOf(event: Json): Json[] {
  const message = event.message as { content?: unknown } | undefined;
  if (typeof message?.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message?.content) ? message.content as Json[] : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Json[]).map(item => (typeof item.text === 'string' ? item.text : '')).filter(Boolean).join('\n');
}

function timeOf(event: Json): number | undefined {
  const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** One subagent's chat in saved transcript form. A replayed turn records events twice. */
export async function readSubagentTranscript(id: string): Promise<MobileTranscriptEntry[]> {
  const file = logPath(id);
  if (!file) return [];
  const log = await readFile(file, 'utf8').catch(() => '');
  const entries: MobileTranscriptEntry[] = [];
  const tools = new Map<string, MobileTranscriptToolCall>();
  const seen = new Set<unknown>();
  let reply: MobileTranscriptEntry | null = null;
  for (const line of log.split('\n')) {
    if (!line) continue;
    let event: Json;
    try { event = JSON.parse(line) as Json; } catch { continue; }
    if (event.uuid !== undefined) {
      if (seen.has(event.uuid)) continue;
      seen.add(event.uuid);
    }
    const timestamp = timeOf(event);
    for (const block of contentOf(event)) {
      if (event.type === 'user' && block.type === 'text' && typeof block.text === 'string') {
        entries.push({ id: `${id}:${entries.length}`, role: 'user', text: redactThreadText(block.text), type: 'message', timestamp });
        reply = null;
      } else if (block.type === 'tool_result') {
        const tool = tools.get(String(block.tool_use_id));
        if (tool) Object.assign(tool, redactToolCallForRest({
          ...tool, result: resultText(block.content), status: block.is_error === true ? 'error' : 'done', finishedAt: timestamp,
        }));
      } else if (event.type === 'assistant' && (block.type === 'text' || block.type === 'tool_use')) {
        const model = (event.message as { model?: unknown } | undefined)?.model;
        reply ??= entries[entries.push({
          id: `${id}:${entries.length}`, role: 'assistant', text: '', type: 'message', timestamp, backend: 'claude',
          ...(typeof model === 'string' ? { model } : {}), toolCalls: [],
        }) - 1];
        if (block.type === 'text' && typeof block.text === 'string') {
          reply.text += `${reply.text ? '\n\n' : ''}${redactThreadText(block.text)}`;
        } else if (block.type === 'tool_use') {
          const tool = redactToolCallForRest({
            id: String(block.id), name: String(block.name), args: (block.input ?? {}) as Json,
            status: 'running', startedAt: timestamp, textAt: Buffer.byteLength(reply.text),
          } as MobileTranscriptToolCall);
          tools.set(tool.id as string, tool);
          reply.toolCalls?.push(tool);
        }
      }
    }
  }
  return entries;
}
