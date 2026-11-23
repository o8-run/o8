import { getSqlite } from '@/lib/db';
import type { ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';

export function correctionStopVersion(scope: string): number {
  return (getSqlite().prepare('SELECT generation FROM worker_correction_fences WHERE scope = ?').get(scope) as { generation: number } | undefined)?.generation ?? 0;
}
export function advanceCorrectionStop(scope: string): void {
  getSqlite().prepare(`INSERT INTO worker_correction_fences VALUES (?, 1)
    ON CONFLICT(scope) DO UPDATE SET generation = generation + 1`).run(scope);
}

export function holdWorkerCorrections(target: ComposerQueueTarget): void {
  getSqlite().transaction(() => {
    advanceCorrectionStop(`parent:${target.repoPath}\n${target.threadId}`);
    getSqlite().prepare(`UPDATE worker_correction_deliveries SET status = 'held', note = 'Parent stopped. Inspect the worker before resuming.', updated_at = ?
    WHERE status IN ('pending','sending') AND correction_id IN
    (SELECT id FROM worker_corrections WHERE repo_path = ? AND thread_id = ?)`).run(Date.now(), target.repoPath, target.threadId);
  })();
}
