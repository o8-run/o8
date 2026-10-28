import 'server-only';
import { randomUUID } from 'node:crypto';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { saveCompactionOperation } from './compaction-status-store';
import type { CompactionOperation } from './compaction-status';

/** One live operation, independent of any persisted transcript boundary. */
export async function withLiveCompaction<T>(scope: { repoPath: string; threadId: string }, run: (operation: CompactionOperation) => Promise<T>): Promise<T> {
  const operation: CompactionOperation = { ...scope, operationId: `compaction-${randomUUID()}`,
    phase: 'waiting', requestedAt: Date.now(), updatedAt: Date.now() };
  const mutation = {
    mutationId: operation.operationId, source: 'server' as const, action: 'orchestrator-compaction',
    repoPath: scope.repoPath, surfaceId: scope.threadId, createdAt: new Date().toISOString(),
  };
  const report = async (status: 'queued' | 'pending' | 'completed' | 'failed') => {
    operation.updatedAt = Date.now();
    try { await saveCompactionOperation(operation); }
    catch { console.warn('[compaction-status] Receipt could not be saved; live confirmation is required.'); }
    // Status delivery must never queue the summarizer behind an unavailable bridge.
    void publishRealtimeMutation({ mutation: { ...mutation, status, compaction: { ...operation },
      ...(operation.settledAt !== undefined ? { settledAt: new Date(operation.settledAt).toISOString() } : {}) } }).catch(() => {});
  };
  await report('queued');
  try {
    operation.phase = 'compacting'; operation.startedAt = Date.now();
    await report('pending');
    const result = await run(operation);
    operation.phase = 'complete';
    return result;
  } catch (error) {
    operation.phase = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
    throw error;
  } finally {
    operation.settledAt = Date.now();
    await report(operation.phase === 'complete' ? 'completed' : 'failed');
  }
}
