'use client';

import { useCallback, useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  mapHistoryMessagesToTranscript,
  type ThoughtsHistoryMessage,
} from '../history-transcript';
import type { ThreadHistoryPage } from './useThreadHistoryBackfill';

export const MAX_THREAD_HISTORY_WINDOW_ENTRIES = 200;

export function prependBoundedThreadHistoryEntries(
  previous: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
): { entries: MobileTranscriptEntry[]; hasCapacity: boolean } {
  const seenIds = new Set(previous.map((entry) => entry.id));
  const candidates = incoming.filter((entry) => {
    if (seenIds.has(entry.id)) return false;
    seenIds.add(entry.id);
    return true;
  });
  const available = Math.max(0, MAX_THREAD_HISTORY_WINDOW_ENTRIES - previous.length);
  const accepted = available > 0 ? candidates.slice(-available) : [];
  const entries = accepted.length > 0 ? [...accepted, ...previous] : previous;
  return { entries, hasCapacity: entries.length < MAX_THREAD_HISTORY_WINDOW_ENTRIES };
}

export async function fetchThreadHistoryPage(
  tabId: string,
  before?: string,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  try {
    const params = new URLSearchParams({ tabId, limit: '60', ...(before ? { before } : {}) });
    return await fetch(`/api/v2/chat-history?${params.toString()}`, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchOlderThreadPage(tabId: string, before: string): Promise<ThreadHistoryPage<ThoughtsHistoryMessage> | null> {
  const response = await fetchThreadHistoryPage(tabId, before);
  if (!response?.ok) return null;
  return await response.json().catch(() => null) as ThreadHistoryPage<ThoughtsHistoryMessage> | null;
}

export function useBoundedThreadHistoryWindow() {
  const entriesRef = useRef<MobileTranscriptEntry[]>([]);
  const [entries, setEntries] = useState<MobileTranscriptEntry[]>([]);

  const prependHistoryMessages = useCallback((messages: ThoughtsHistoryMessage[]): boolean => {
    const result = prependBoundedThreadHistoryEntries(
      entriesRef.current,
      mapHistoryMessagesToTranscript(messages),
    );
    entriesRef.current = result.entries;
    setEntries(result.entries);
    return result.hasCapacity;
  }, []);

  const reset = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  return { entries, prependHistoryMessages, reset };
}
