import 'server-only';
import { randomUUID } from 'node:crypto';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

/** One live operation, independent of any persisted transcript boundary. */
export async function withLiveCompaction<T>(scope: { repoPath: string; threadId: string }, run: () => Promise<T>): Promise<T> {
  const mutation = {
    mutationId: `compaction-${randomUUID()}`, source: 'server' as const, action: 'orchestrator-compaction',
    repoPath: scope.repoPath, surfaceId: scope.threadId, createdAt: new Date().toISOString(),
  };
  await publishRealtimeMutation({ mutation: { ...mutation, status: 'pending' } });
  let status: 'completed' | 'failed' = 'failed';
  try {
    const result = await run();
    status = 'completed';
    return result;
  } finally {
    await publishRealtimeMutation({ mutation: { ...mutation, status, settledAt: new Date().toISOString() } });
  }
}
