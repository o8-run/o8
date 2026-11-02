import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersistPacer, createTrailingPersist, INCREMENTAL_PERSIST_MS } from '@/lib/ws-server/orchestrator-assistant-text';

describe('createPersistPacer', () => {
  it('saves the first delta, then at most once per interval', () => {
    let clock = 10_000;
    const due = createPersistPacer(() => clock);
    expect(due()).toBe(true);
    clock += 10;
    expect(due()).toBe(false);
    clock += INCREMENTAL_PERSIST_MS;
    expect(due()).toBe(true);
  });
});

describe('createTrailingPersist', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('saves the end of a burst once the stream goes quiet', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const trailing = createTrailingPersist();
    trailing.schedule(save);
    trailing.schedule(save);
    vi.advanceTimersByTime(INCREMENTAL_PERSIST_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves nothing after the turn has finished', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const trailing = createTrailingPersist();
    trailing.schedule(save);
    trailing.cancel();
    vi.advanceTimersByTime(INCREMENTAL_PERSIST_MS);
    expect(save).not.toHaveBeenCalled();
  });
});
