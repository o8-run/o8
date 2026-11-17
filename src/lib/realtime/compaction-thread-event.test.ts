import { describe, expect, it } from 'vitest';
import { compactionThreadEvent } from './compaction-thread-event';

const operation = { operationId: 'compaction-1', repoPath: '/repo', threadId: 'thread-1', phase: 'compacting', requestedAt: 10, startedAt: 12, updatedAt: 12 };

describe('compaction events for a thread', () => {
  it('addresses a live compaction to its own thread', () => {
    expect(compactionThreadEvent({ action: 'orchestrator-compaction', status: 'pending', compaction: operation })).toEqual({
      repoPath: '/repo', threadId: 'thread-1',
      message: { channel: 'orchestrator', event: 'compaction', data: { repoPath: '/repo', threadId: 'thread-1', operationId: 'compaction-1', phase: 'compacting', startedAt: 12, settledAt: null } },
    });
  });

  it('reports the end so a client can clear its notice', () => {
    const done = compactionThreadEvent({ action: 'orchestrator-compaction', compaction: { ...operation, phase: 'complete', settledAt: 40 } });
    expect(done?.message.data).toMatchObject({ phase: 'complete', settledAt: 40 });
  });

  it('ignores other mutations and malformed receipts', () => {
    expect(compactionThreadEvent({ action: 'lane-update', compaction: operation })).toBeNull();
    expect(compactionThreadEvent({ action: 'orchestrator-compaction' })).toBeNull();
    expect(compactionThreadEvent({ action: 'orchestrator-compaction', compaction: { ...operation, phase: 'napping' } })).toBeNull();
    expect(compactionThreadEvent(null)).toBeNull();
  });
});
