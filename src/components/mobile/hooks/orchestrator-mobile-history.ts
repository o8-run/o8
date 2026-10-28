'use client';

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { deserializeStoredTranscript, type StoredTranscriptMessage } from '@/lib/transcripts/history-serde';
import { placeSteerTranscriptEntries, validSteerTranscriptAnchor } from '@/lib/transcripts/steer-anchor';
import type { MobileOrchestratorTranscriptEntry, MobileTranscriptEntry } from '@/lib/mobile/types';

export function historyToMobileTranscript(messages: StoredTranscriptMessage[]) {
  const entries: MobileOrchestratorTranscriptEntry[] = [];
  const canonical: StoredTranscriptMessage[] = [];
  let counter = 0;
  for (const message of messages) {
    const text = message.text ?? message.content;
    if (typeof text !== 'string' || !text.trim()) continue;
    const role: MobileOrchestratorTranscriptEntry['role'] =
      message.role === 'user' ? 'user'
        : message.role === 'assistant' ? 'assistant'
          : message.role === 'tool' ? 'tool'
            : 'system';
    const entryId = typeof message.id === 'string' && message.id.trim()
      ? message.id
      : `history-${counter}`;
    counter += 1;
    const timestamp = message.timestamp ?? Date.now() - (messages.length - counter);
    canonical.push({ ...message, id: entryId, role, timestamp });
    entries.push({
      id: entryId,
      role,
      text,
      timestamp,
    });
  }
  return { entries, sources: new Map(deserializeStoredTranscript(canonical, { dropInvalid: true }).map(entry => [entry.id, entry])) };
}


interface HistoryScope {
  threadId: string | null;
  active: boolean;
  pending: boolean;
  dirty: boolean;
}

/** Reconcile acknowledged steer metadata without replacing a live output buffer. */
export function useMobileSteerHistory(
  threadId: string | null,
  setSources: Dispatch<SetStateAction<ReadonlyMap<string, MobileTranscriptEntry>>>,
  setTranscript: Dispatch<SetStateAction<MobileOrchestratorTranscriptEntry[]>>,
) {
  const scopeRef = useRef<HistoryScope | null>(null);
  useEffect(() => {
    const scope = { threadId, active: true, pending: false, dirty: false };
    scopeRef.current = scope;
    return () => { scope.active = false; };
  }, [threadId]);

  return useCallback((message: Record<string, unknown>) => {
    const scope = scopeRef.current;
    if (!scope?.active || !scope.threadId || message.channel !== 'realtime' || message.event !== 'batch') return;
    const batch = message.data as { events?: Array<{ channel: string; data?: { mutation?: {
      source?: string; action?: string; status?: string; surfaceId?: string;
    } } }> } | undefined;
    if (!Array.isArray(batch?.events) || !batch.events.some(event => {
      const mutation = event.data?.mutation;
      return event.channel === 'mutation' && mutation?.source === 'server'
        && mutation.action === 'composer-queue' && mutation.status === 'completed' && mutation.surfaceId === scope.threadId;
    })) return;
    scope.dirty = true;
    if (scope.pending) return;
    scope.pending = true;
    void (async () => {
      try {
        while (scope.active && scope.dirty) {
          scope.dirty = false;
          try {
            const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(scope.threadId!)}`, { cache: 'no-store' });
            if (!response.ok) continue;
            const data = await response.json() as { messages?: StoredTranscriptMessage[] };
            if (!scope.active) return;
            const history = historyToMobileTranscript(data.messages ?? []);
            const steers = history.entries.filter(entry => entry.role === 'user' && validSteerTranscriptAnchor(history.sources.get(entry.id)?.steerAnchor));
            if (!steers.length) continue;
            setSources(current => {
              const next = new Map(current);
              for (const steer of steers) next.set(steer.id, history.sources.get(steer.id)!);
              return next;
            });
            setTranscript(current => {
              const next = new Map(current.map(entry => [entry.id, entry]));
              for (const steer of steers) next.set(steer.id, steer);
              return [...next.values()];
            });
          } catch (error) {
            console.log('[mobile-orchestrator] steer history refresh failed', error);
          }
        }
      } finally { scope.pending = false; }
    })();
  }, [setSources, setTranscript]);
}


export interface MobileToolBoundary {
  assistantMessageId: string;
  text: string;
  toolCount: number;
}
export function rememberMobileToolBoundary(
  current: ReadonlyMap<string, MobileToolBoundary>, id: string, assistantMessageId: string, text: string,
): ReadonlyMap<string, MobileToolBoundary> {
  if (current.has(id)) return current;
  const toolCount = [...current.values()].filter(entry => entry.assistantMessageId === assistantMessageId).length + 1;
  return new Map([...current, [id, { assistantMessageId, text, toolCount }]]);
}

/** Keep the existing mobile tool rows between their surrounding text blocks. */
export function placeMobileTranscript(
  transcript: MobileOrchestratorTranscriptEntry[], sources: ReadonlyMap<string, MobileTranscriptEntry>,
  tools: ReadonlyMap<string, MobileToolBoundary>,
): MobileOrchestratorTranscriptEntry[] {
  const originals = new Map(transcript.map(entry => [entry.id, entry]));
  const entries: MobileTranscriptEntry[] = transcript.map(entry => {
    const tool = tools.get(entry.id);
    return { ...sources.get(entry.id), id: entry.id, role: tool ? 'user' : entry.role, text: entry.text, timestamp: entry.timestamp,
      ...(tool ? { steerAnchor: { ...tool, blockText: tool.text, thinking: '', blockThinking: '', sequence: 1 } } : {}) };
  });
  const boundaries = new Map<string, MobileTranscriptEntry[]>();
  for (const entry of entries) if (validSteerTranscriptAnchor(entry.steerAnchor)) {
    const id = entry.steerAnchor.assistantMessageId;
    const group = boundaries.get(id) ?? []; group.push(entry); boundaries.set(id, group);
  }
  for (const group of boundaries.values()) {
    group.sort((a, b) => a.steerAnchor!.text.length - b.steerAnchor!.text.length
      || a.steerAnchor!.toolCount - b.steerAnchor!.toolCount
      || Number(tools.has(b.id)) - Number(tools.has(a.id))
      || a.steerAnchor!.sequence - b.steerAnchor!.sequence);
    group.forEach((entry, index) => { entry.steerAnchor = { ...entry.steerAnchor!, sequence: index + 1 }; });
  }
  return placeSteerTranscriptEntries(entries)
    .filter(entry => entry.role !== 'assistant' || entry.text.trim())
    .map(entry => ({ ...originals.get(entry.id), id: entry.id,
      role: originals.get(entry.id)?.role === 'tool' ? 'tool' : entry.role, text: entry.text, timestamp: entry.timestamp ?? 0 }));
}
