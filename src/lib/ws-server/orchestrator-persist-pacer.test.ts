import { describe, expect, it } from 'vitest';

import { createPersistPacer, INCREMENTAL_PERSIST_MS } from '@/lib/ws-server/orchestrator-assistant-text';

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
