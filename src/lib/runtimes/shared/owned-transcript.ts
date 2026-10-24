import type { OwnedTailEntry, OwnedTailGroup } from './owned-session';
import type { RuntimeTranscriptEntry } from '../types';

interface OwnedTranscriptTail {
  entries: OwnedTailEntry[];
  groups: OwnedTailGroup[];
}

function transcriptTimestamp(value?: string, fallback?: string): Date {
  const direct = value ? new Date(value) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const fallbackTimestamp = fallback ? new Date(fallback) : null;
  return fallbackTimestamp && !Number.isNaN(fallbackTimestamp.getTime())
    ? fallbackTimestamp
    : new Date();
}

function runtimeEntry(
  entry: OwnedTailEntry,
  fallbackTimestamp?: string,
): RuntimeTranscriptEntry {
  return {
    id: entry.id,
    role: entry.kind === 'message' ? 'assistant'
      : entry.kind === 'tool' ? 'tool'
      : 'system',
    text: entry.text,
    ...(entry.tokens ? { tokens: entry.tokens, model: entry.model } : {}),
    timestamp: transcriptTimestamp(entry.timestamp, fallbackTimestamp),
    toolName: entry.kind === 'tool' ? entry.label : undefined,
    thinking: entry.thinking,
    thinkingActive: entry.thinkingActive,
  };
}

function applyTranscriptWindow(
  entries: RuntimeTranscriptEntry[],
  sinceId?: string,
  limit?: number,
  includeSinceEntry = false,
): RuntimeTranscriptEntry[] {
  let next = entries;
  if (sinceId) {
    const sinceIndex = next.findIndex((entry) => entry.id === sinceId);
    if (sinceIndex >= 0) next = next.slice(sinceIndex + (includeSinceEntry ? 0 : 1));
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && next.length > limit) {
    next = next.slice(-limit);
  }
  return next;
}

/**
 * Normalize the shared owned-session tail without losing the user turn stored
 * on each group. Some parsers also emit a prompt event inside `group.entries`;
 * the stable prompt id keeps that duplicate out while preserving the user role.
 */
export function ownedTailToRuntimeTranscript(
  tail: OwnedTranscriptTail,
  sinceId?: string,
  limit?: number,
  options?: { includeSinceEntry?: boolean },
): RuntimeTranscriptEntry[] {
  const entries: RuntimeTranscriptEntry[] = [];
  const seenIds = new Set<string>();
  const toolEntries = new Map<string, RuntimeTranscriptEntry>();

  const append = (entry: RuntimeTranscriptEntry) => {
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    entries.push(entry);
  };

  const appendOwnedEntry = (entry: OwnedTailEntry, fallbackTimestamp?: string) => {
    if (entry.toolCall) {
      const toolKey = entry.toolCall.id ?? entry.id;
      const existing = entries.find((candidate) => candidate.id === entry.id);
      if (entry.kind === 'tool' && existing) {
        toolEntries.set(toolKey, existing);
        return;
      }
      if (entry.kind === 'tool-output') {
        const call = toolEntries.get(toolKey);
        if (call?.toolCalls?.[0]) {
          call.toolCalls[0] = {
            ...call.toolCalls[0],
            status: entry.toolCall.status,
            result: entry.toolCall.result ?? entry.text,
            preview: entry.toolCall.preview ?? call.toolCalls[0].preview,
          };
          return;
        }
      }
      const toolEntry: RuntimeTranscriptEntry = {
        id: entry.kind === 'tool-output' ? `${entry.id}:paired` : entry.id,
        role: 'assistant',
        text: '',
        timestamp: transcriptTimestamp(entry.timestamp, fallbackTimestamp),
        toolCalls: [{ ...entry.toolCall }],
      };
      append(toolEntry);
      toolEntries.set(toolKey, toolEntry);
      return;
    }
    append(runtimeEntry(entry, fallbackTimestamp));
  };

  for (const group of tail.groups) {
    const promptId = `${group.id}:prompt`;
    const prompt = group.prompt.trim();
    if (prompt) {
      append({
        id: promptId,
        role: 'user',
        text: prompt,
        timestamp: transcriptTimestamp(group.startedAt),
      });
    }
    for (const entry of group.entries) {
      const isDuplicatePrompt = entry.id === promptId
        || (prompt
          && entry.text.trim() === prompt
          && entry.label.toLowerCase().includes('prompt'));
      if (isDuplicatePrompt) continue;
      appendOwnedEntry(entry, group.finishedAt ?? group.startedAt);
    }
  }

  // Older or partially written tails may not have group metadata yet. Keep
  // their raw entries readable, while the id set prevents normal tails from
  // being duplicated.
  for (const entry of tail.entries) {
    appendOwnedEntry(entry);
  }

  const includeSinceEntry = options?.includeSinceEntry ?? tail.groups.some((group) => (
    group.entries.some((entry) => entry.label === 'claude-assistant')
  ));
  // Claude tool results can settle an earlier row after a later tool became
  // the cursor. Return its bounded mutable window so ID-based clients replace
  // every changed row instead of missing the earlier completion.
  return applyTranscriptWindow(entries, includeSinceEntry ? undefined : sinceId, limit, includeSinceEntry);
}
