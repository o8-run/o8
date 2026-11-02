// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadHistoryBackfill } from './useThreadHistoryBackfill';

describe('useThreadHistoryBackfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('stops requesting pages when the bounded history window fills', async () => {
    const fetchPage = vi.fn(async () => ({
      messages: ['older'],
      page: { hasMore: true, beforeCursor: 'next-page' },
    }));

    const onComplete = vi.fn();
    function Harness() {
      const { startBackfill } = useThreadHistoryBackfill({
        fetchPage,
        getScrollContainer: () => null,
        onPrepend: () => false,
        onComplete,
      });
      useEffect(() => startBackfill('thread-1', { hasMore: true, beforeCursor: 'first-page' }), [startBackfill]);
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('thread-1');
    await act(async () => root.unmount());
  });
});

it('reports completion for a tail-only history and for an empty final page, never a superseded request', async () => {
  const onComplete = vi.fn();
  let resolvePage: (result: { messages: string[] }) => void;
  const fetchPage = vi.fn(() => new Promise<{ messages: string[] }>(resolve => { resolvePage = resolve; }));
  let backfill: ReturnType<typeof useThreadHistoryBackfill<string>>;
  function Harness() {
    const current = useThreadHistoryBackfill({ fetchPage, getScrollContainer: () => null, onPrepend: () => {}, onComplete });
    useEffect(() => { backfill = current; });
    return null;
  }
  vi.useFakeTimers();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness)));
    backfill!.startBackfill('tail-only', { hasMore: false });
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('tail-only'); onComplete.mockClear();
    backfill!.startBackfill('old', { hasMore: true, beforeCursor: 'page' });
    await act(async () => vi.advanceTimersByTimeAsync(120));
    backfill!.cancelBackfill();
    await act(async () => resolvePage!({ messages: [] }));
    expect(onComplete).not.toHaveBeenCalled();
    backfill!.startBackfill('current', { hasMore: true, beforeCursor: 'page' });
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => resolvePage!({ messages: [] }));
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('current');
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});
