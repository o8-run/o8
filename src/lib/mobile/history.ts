import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { readSessionHuddleTranscriptEvents, readSessionSteerTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import '@/lib/runtimes';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

function parseToolArgs(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

function toolCallFromEntry(name: string, text: string): MobileTranscriptToolCall {
  return {
    name: name || 'tool',
    args: parseToolArgs(text),
    status: 'done',
  };
}

export function parseMobileTranscriptTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function mergeDurableMobileTranscriptEntries(
  sessionKey: string,
  transcript: MobileTranscriptEntry[],
): MobileTranscriptEntry[] {
  const huddleEntries = readSessionHuddleTranscriptEvents(sessionKey).map((event) => {
    const timestampMs = parseMobileTranscriptTimestamp(event.ts) ?? 0;
    const timestampLabel = new Date(timestampMs).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    return {
      id: `huddle-${event.seq}`,
      role: 'assistant' as const,
      text: `Huddling — plan posted\n\n${event.text}`,
      timestamp: timestampMs,
      timestampLabel,
    };
  });
  const steerEntries = readSessionSteerTranscriptEvents(sessionKey).map((event) => {
    const timestampMs = parseMobileTranscriptTimestamp(event.ts) ?? 0;
    const timestampLabel = new Date(timestampMs).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    return {
      id: `steer-${event.seq}`,
      role: 'user' as const,
      text: `${event.failed ? 'Steer failed to start' : event.source} · ${timestampLabel}\n\n${event.text}${event.note && event.note !== event.text ? `\n\n${event.note}` : ''}`,
      timestamp: timestampMs,
      timestampLabel,
    };
  });
  if (huddleEntries.length === 0 && steerEntries.length === 0) return transcript;

  const uniqueById = new Map<string, MobileTranscriptEntry>();
  for (const entry of [...transcript, ...huddleEntries, ...steerEntries]) {
    uniqueById.set(entry.id, entry);
  }
  return [...uniqueById.values()]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftTimestamp = typeof left.entry.timestamp === 'number' && Number.isFinite(left.entry.timestamp)
        ? left.entry.timestamp
        : Number.NEGATIVE_INFINITY;
      const rightTimestamp = typeof right.entry.timestamp === 'number' && Number.isFinite(right.entry.timestamp)
        ? right.entry.timestamp
        : Number.NEGATIVE_INFINITY;
      return leftTimestamp - rightTimestamp || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function mobileEntriesFromRuntimeTranscript(
  entries: RuntimeTranscriptEntry[],
): MobileTranscriptEntry[] {
  return entries.map((entry) => {
    const timestamp = entry.timestamp.getTime();
    const toolCalls = entry.toolCalls?.map((tool) => ({
      id: tool.id,
      name: tool.name,
      args: tool.args,
      preview: tool.preview,
      status: tool.status,
      result: tool.result,
    })) ?? (entry.role === 'tool' && entry.toolName
      ? [{ name: entry.toolName, status: 'done' as const }]
      : undefined);
    return {
      id: entry.id,
      role: entry.role,
      text: entry.text,
      type: entry.type ?? 'message',
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      timestampLabel: Number.isFinite(timestamp)
        ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '',
      toolCalls,
      thinking: entry.thinking,
      thinkingActive: entry.thinkingActive,
      compaction: entry.compaction ? {
        timestamp: entry.compaction.timestamp.getTime(),
        tokensBefore: entry.compaction.tokensBefore,
        tokensAfter: entry.compaction.tokensAfter,
        trigger: entry.compaction.trigger,
        source: entry.compaction.source,
        summary: entry.compaction.summary,
      } : undefined,
    };
  });
}

/**
 * Read any registered transcript-capable runtime through the normalized
 * runtime contract. `null` means the session prefix has no authoritative
 * transcript adapter; an empty array means the adapter answered successfully
 * and the session currently has no entries.
 */
export async function readRegisteredMobileRuntimeTranscript(
  sessionKey: string,
  limit: number,
): Promise<MobileTranscriptEntry[] | null> {
  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;
  if (!runtime?.capabilities.readTranscript) return null;
  // A runtime that declares the capability can still disown an individual
  // session (an unknown cloud job, say). That is the same "cannot read this"
  // answer as the check above, not a request failure -- and this helper's
  // callers render `null` rather than propagating.
  const entries = await runtime
    .readTranscript(sessionKey, undefined, limit)
    .catch(() => null);
  if (!entries) return null;
  return mobileEntriesFromRuntimeTranscript(entries);
}

function finalizeMobileTranscript(
  sessionKey: string,
  transcript: MobileTranscriptEntry[],
  limit: number,
): MobileTranscriptEntry[] {
  return mergeDurableMobileTranscriptEntries(sessionKey, transcript).slice(-limit);
}

export async function getMobileSessionTranscript(
  sessionKey: string,
  limit = 50,
  _fresh = false,
): Promise<MobileTranscriptEntry[]> {
  void _fresh;

  if (sessionKey.startsWith('llm-chat:')) {
    return finalizeMobileTranscript(
      sessionKey,
      loadMobileLlmChatHistory(sessionKey, limit).transcript,
      limit,
    );
  }

  if (sessionKey.startsWith('codex-owned:')) {
    const tail = await getOwnedCodexRuntimeTail(sessionKey, limit);
    const chatTranscript: MobileTranscriptEntry[] = [];
    const groups = tail.groups ?? [];

    for (const group of groups) {
      const pendingToolCalls: MobileTranscriptToolCall[] = [];
      const promptText = group.prompt?.trim();
      if (promptText) {
        chatTranscript.push({
          id: `${group.id}-prompt`,
          role: 'user',
          text: promptText,
          timestamp: parseMobileTranscriptTimestamp(group.startedAt),
          timestampLabel: group.startedAtLabel,
        });
      }

      for (const entry of group.entries) {
        const text = entry.text.trim();
        if (!text) continue;
        if (promptText && text === promptText) continue;
        if (text.startsWith('Usage •') || text.includes('Owned Codex session') || text.includes('Codex run launched')) continue;

        const role = runtimeTailRole(entry.label);
        if (role === 'assistant') {
          chatTranscript.push({
            id: entry.id,
            role: 'assistant',
            text,
            toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
            timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
            timestampLabel: entry.timestampLabel,
          });
          pendingToolCalls.length = 0;
        } else if (entry.kind === 'tool') {
          pendingToolCalls.push(toolCallFromEntry(entry.label || 'exec_command', entry.text));
        }
      }

      if (pendingToolCalls.length > 0) {
        chatTranscript.push({
          id: `${group.id}-tool-batch`,
          role: 'assistant',
          text: '',
          toolCalls: [...pendingToolCalls],
          timestamp: parseMobileTranscriptTimestamp(group.finishedAt ?? group.startedAt),
          timestampLabel: group.finishedAtLabel ?? group.startedAtLabel,
        });
      }
    }

    return finalizeMobileTranscript(sessionKey, chatTranscript, limit);
  }

  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    const tail = await getCodexRuntimeTail(sessionKey, limit);
    const transcript: MobileTranscriptEntry[] = [];
    for (const entry of tail.entries ?? []) {
      if (entry.kind === 'event' && entry.label === 'Agent update') {
        transcript.push({
          id: entry.id,
          role: 'assistant',
          text: entry.text,
          timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
          timestampLabel: entry.timestampLabel,
        });
        continue;
      }
      if (entry.kind === 'tool') {
        transcript.push({
          id: entry.id,
          role: 'assistant',
          text: '',
          toolCalls: [toolCallFromEntry(entry.label || 'tool', entry.text)],
          timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
          timestampLabel: entry.timestampLabel,
        });
        continue;
      }
      if (entry.kind === 'message') {
        const role = runtimeTailRole(entry.label);
        if (role === 'system' || role === 'user') {
          const lowerText = entry.text.toLowerCase();
          if (lowerText.includes('<permissions') || lowerText.includes('collaboration_mode') || lowerText.includes('# agents.md') || lowerText.includes('sandbox_mode')) continue;
        }
        transcript.push({
          id: entry.id,
          role,
          text: entry.text,
          timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
          timestampLabel: entry.timestampLabel,
        });
      }
    }

    const seen = new Set<string>();
    const deduped: MobileTranscriptEntry[] = [];
    for (const entry of transcript) {
      const toolKey = (entry.toolCalls ?? [])
        .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
        .join('|');
      const key = `${entry.role}:${entry.text.trim().slice(0, 200)}:${toolKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    return finalizeMobileTranscript(sessionKey, deduped, limit);
  }

  const runtimeTranscript = await readRegisteredMobileRuntimeTranscript(sessionKey, limit);
  return finalizeMobileTranscript(sessionKey, runtimeTranscript ?? [], limit);
}
