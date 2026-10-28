import { stat } from 'node:fs/promises';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import type { WorkerRecovery } from './types';

export async function readWorkerRecovery(surfaceId: string): Promise<WorkerRecovery | null> {
  const session = await readOwnedSessionRecord(surfaceId);
  if (!session || typeof session.cwd !== 'string' || !session.cwd.trim()) return null;
  const worktreePath = session.cwd;
  const exists = await stat(worktreePath).then(info => info.isDirectory(), () => false);
  const latest = session.recentRuns[0];
  const recoverable = exists && !session.activeRun && !session.detachedAt && !session.retiredAt
    && (latest?.outcome === 'interrupted' || latest?.outcome === 'failed');
  return { worktreePath, branch: session.branch ?? null, runId: latest?.id ?? null,
    actions: recoverable ? ['resume', 'retire'] : [], retired: Boolean(session.retiredAt) };
}

/** Recovery addresses durable session identity, even after fleet discovery drops it. */
export async function controlSavedWorker(surfaceId: string, action: 'resume' | 'retry' | 'retire') {
  const { getRuntime } = await import('@/lib/runtimes');
  const { runtimeIdFromSessionKey } = await import('@/lib/runtime/transcript');
  const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
  const recovery = await readWorkerRecovery(surfaceId);
  const runtimeId = runtimeIdFromSessionKey(surfaceId);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;
  const lifecycle = getOwnedSessionLifecycle(surfaceId);
  const location = recovery ? `Branch ${recovery.branch ?? '(unrecorded)'} and edits remain at ${recovery.worktreePath}.` : '';
  if (!recovery || !runtime || !lifecycle) return { ok: false, status: 'unavailable' as const,
    note: `Saved worker recovery metadata is unavailable. ${location}`.trim() };
  if (action === 'retire') {
    const { holdPendingOwnedCorrections } = await import('@/lib/runtimes/shared/owned-session/action-admission');
    const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
    holdPendingOwnedCorrections(surfaceId);
    if (await lifecycle.sessionState(surfaceId) === 'active') {
      const stopped = await escalateInterruptOwnedSurface(surfaceId);
      if (!stopped?.confirmedDead) return { ok: false, status: 'unavailable' as const,
        note: `Retirement held: ${stopped?.note ?? 'Worker process exit could not be confirmed.'} ${location}` };
    }
    const result = await lifecycle.retireSession?.(surfaceId);
    return { ok: result?.retired ?? false, status: result?.retired ? 'completed' as const : 'unavailable' as const,
      note: `${result?.retired ? 'Worker retired.' : result?.note ?? 'This runtime cannot retire the saved worker.'} ${location}` };
  }
  if (!recovery.actions.includes('resume')) return { ok: false, status: 'unavailable' as const,
    note: `Worker recovery is held: inspect its current run or retirement state. ${location}` };
  try {
    const prompt = 'Continue the interrupted task from the saved transcript. Inspect and preserve all existing edits in this same checkout and branch.';
    const result = await (lifecycle.resumeSession ? lifecycle.resumeSession(surfaceId, prompt) : runtime.resume(surfaceId, prompt));
    return { ok: result.ok, status: result.ok ? 'queued' as const : 'unavailable' as const, note: `${result.note} ${location}` };
  } catch (error) {
    return { ok: false, status: 'unavailable' as const, note: `${error instanceof Error ? error.message : 'Worker resume could not be confirmed.'} ${location}` };
  }
}
