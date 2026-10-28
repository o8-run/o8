'use client';

import { useCallback, useEffect, useRef } from 'react';
import { captureTranscriptReadingAnchor, restoreTranscriptReadingAnchor } from './transcript-reading-anchor';

const TOP_LOAD_THRESHOLD_PX = 240;

export interface ThreadHistoryPage<T> {
  messages: T[];
  page?: {
    hasMore?: boolean;
    beforeCursor?: string | null;
  };
}

interface ThreadHistoryBackfillOptions<T> {
  fetchPage: (tabId: string, before: string) => Promise<ThreadHistoryPage<T> | null>;
  getScrollContainer: () => HTMLElement | null;
  onPrepend: (messages: T[]) => boolean | void;
  onComplete?: (tabId: string) => void;
}

/**
 * Pages older thread history without blocking the tail's first paint. The
 * scroll-height compensation keeps the row under the reader's eye fixed while
 * React prepends a page above it.
 */
export function useThreadHistoryBackfill<T>({
  fetchPage,
  getScrollContainer,
  onPrepend,
  onComplete,
}: ThreadHistoryBackfillOptions<T>) {
  const stateRef = useRef<{ tabId: string; before: string | null; hasMore: boolean; generation: number } | null>(null);
  const loadingRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  const cancelIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const loadOlderPage = useCallback(async () => {
    const state = stateRef.current;
    if (!state?.hasMore || !state.before || loadingRef.current) return;
    loadingRef.current = true;
    const { tabId, before, generation } = state;
    const container = getScrollContainer();
    try {
      const result = await fetchPage(tabId, before);
      const current = stateRef.current;
      if (!result || !current || current.generation !== generation || current.tabId !== tabId) return;

      current.hasMore = result.page?.hasMore === true;
      current.before = result.page?.beforeCursor ?? null;
      if (result.messages.length > 0) {
        // The reader and live tail may both move during the request. Measure
        // immediately before the prepend, never at the request's start.
        const anchor = container ? captureTranscriptReadingAnchor(container) : null;
        const priorHeight = container?.scrollHeight ?? 0;
        const priorTop = container?.scrollTop ?? 0;
        if (onPrepend(result.messages) === false) {
          current.hasMore = false;
          current.before = null;
        }
        requestAnimationFrame(() => {
          if (!container?.isConnected || stateRef.current?.generation !== generation || stateRef.current.tabId !== tabId) return;
          if (!restoreTranscriptReadingAnchor(container, anchor) && !anchor) {
            container.scrollTop = priorTop + container.scrollHeight - priorHeight;
          }
        });
      }
      if (!current.hasMore || !current.before) onComplete?.(tabId);
    } finally {
      loadingRef.current = false;
    }
  }, [fetchPage, getScrollContainer, onPrepend, onComplete]);

  const scheduleIdlePage = useCallback(() => {
    const state = stateRef.current;
    if (!state?.hasMore || idleTimerRef.current !== null) return;
    // Small timeout is webview-safe where requestIdleCallback is absent, and
    // gives the tail page a frame to render before history work begins.
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      void loadOlderPage().then(scheduleIdlePage);
    }, 120);
  }, [loadOlderPage]);

  const startBackfill = useCallback((tabId: string, page: ThreadHistoryPage<T>['page']) => {
    cancelIdle();
    stateRef.current = {
      tabId,
      before: page?.beforeCursor ?? null,
      hasMore: page?.hasMore === true,
      generation: (stateRef.current?.generation ?? 0) + 1,
    };
    if (!stateRef.current.hasMore || !stateRef.current.before) onComplete?.(tabId);
    else scheduleIdlePage();
  }, [cancelIdle, scheduleIdlePage, onComplete]);

  const cancelBackfill = useCallback(() => {
    cancelIdle();
    if (stateRef.current) {
      stateRef.current = { ...stateRef.current, hasMore: false, generation: stateRef.current.generation + 1 };
    }
  }, [cancelIdle]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollTop <= TOP_LOAD_THRESHOLD_PX) {
      cancelIdle();
      void loadOlderPage().then(scheduleIdlePage);
    }
  }, [cancelIdle, loadOlderPage, scheduleIdlePage]);

  useEffect(() => cancelBackfill, [cancelBackfill]);

  return { startBackfill, cancelBackfill, onScroll };
}
