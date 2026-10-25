import { AsyncLocalStorage } from 'node:async_hooks';
import { assertPreRunAdmission, withoutPreRunAdmission } from '@/lib/lane/pre-run-cancellation';
import { advanceCorrectionStop } from '@/lib/db/worker-correction-fences';
import { getSqlite } from '@/lib/db';
import type { OwnedSessionRecord } from './types';

interface Admission { correctionId: string; surfaceId: string; runId: string; allowInterrupted: boolean; check: () => void }
const admission = new AsyncLocalStorage<Admission & { active: boolean }>();
type ActionGuard = (session: OwnedSessionRecord | null, preparedRunId?: string) => void;
const actionGuard = new AsyncLocalStorage<ActionGuard>();

/** Keep a queued operator intent fenced through asynchronous spawn preparation. */
export function withOwnedActionGuard<T>(check: ActionGuard, action: () => Promise<T>): Promise<T> {
  const parent = actionGuard.getStore();
  let active = true;
  return actionGuard.run((session, preparedRunId) => {
    parent?.(session, preparedRunId);
    if (!active) return;
    check(session, preparedRunId);
  }, async () => {
    try { return await action(); } finally { active = false; }
  });
}

/** Gateway requests are new operations, never continuations of their launch. */
export function withoutOwnedStartAdmission<T>(operation: () => Promise<T>): Promise<T> {
  return withoutPreRunAdmission(() => admission.exit(() => actionGuard.exit(operation)));
}

/** Assert only the surrounding action guard, including before lane attachment. */
export function assertOwnedActionGuard(): void {
  assertPreRunAdmission();
  actionGuard.getStore()?.(null);
}

/** An explicit correction may continue only the exact run the operator selected. */
export function withOwnedActionAdmission<T>(input: Admission, action: () => Promise<T>): Promise<T> {
  const current = { ...input, active: true };
  return admission.run(current, async () => {
    try { return await action(); } finally { current.active = false; }
  });
}

export function assertOwnedActionAdmission(session: OwnedSessionRecord | null, preparedRunId?: string): void {
  assertPreRunAdmission();
  actionGuard.getStore()?.(session, preparedRunId);
  const expected = admission.getStore();
  if (!expected?.active) return;
  expected.check();
  const run = session?.activeRun ?? session?.recentRuns[0];
  if (!session || session.surfaceId !== expected.surfaceId || session.detachedAt || session.orphanedAt
    || run?.id !== (preparedRunId ?? expected.runId)
    || (!preparedRunId && !expected.allowInterrupted && (run.outcome === 'interrupted' || run.interruptRequestedAt))) {
    throw new Error('Worker run changed or was stopped. The correction was not admitted.');
  }
}

/** An explicit Stop cancels pending corrections before waiting on the owned lock. */
export function holdPendingOwnedCorrections(surfaceId: string): void {
  getSqlite().transaction(() => {
    advanceCorrectionStop(`worker:${surfaceId}`);
    getSqlite().prepare(`UPDATE worker_correction_deliveries SET status = 'held',
    note = 'Worker stopped. Inspect it before resuming.', updated_at = ?
    WHERE surface_id = ? AND status IN ('pending','sending') AND correction_id != ?`)
    .run(Date.now(), surfaceId, admission.getStore()?.active ? admission.getStore()!.correctionId : '');
  })();
}
