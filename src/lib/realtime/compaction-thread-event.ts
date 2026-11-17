import { isCompactionOperation, type CompactionPhase } from '@/lib/orchestrator/compaction-status';

/** What a thread's own subscribers hear while its context is being compacted. */
export interface CompactionThreadEvent {
  repoPath: string;
  threadId: string;
  message: {
    channel: 'orchestrator';
    event: 'compaction';
    data: { repoPath: string; threadId: string; operationId: string; phase: CompactionPhase; startedAt: number | null; settledAt: number | null };
  };
}

/**
 * Turns a compaction receipt into an event for the thread it belongs to.
 * Clients that follow a thread do not read the global mutation stream, so
 * without this they learn of a compaction only after it has finished.
 */
export function compactionThreadEvent(mutation: unknown): CompactionThreadEvent | null {
  if (!mutation || typeof mutation !== 'object') return null;
  const record = mutation as { action?: unknown; compaction?: unknown };
  if (record.action !== 'orchestrator-compaction' || !isCompactionOperation(record.compaction)) return null;
  const { repoPath, threadId, operationId, phase, startedAt, settledAt } = record.compaction;
  return {
    repoPath, threadId,
    message: { channel: 'orchestrator', event: 'compaction', data: { repoPath, threadId, operationId, phase, startedAt: startedAt ?? null, settledAt: settledAt ?? null } },
  };
}
