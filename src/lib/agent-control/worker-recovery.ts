import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import type { WorkerRecovery } from './types';

const execFileAsync = promisify(execFile);

export async function readWorkerRecovery(surfaceId: string): Promise<(WorkerRecovery & { worktreeExists: boolean }) | null> {
  const session = await readOwnedSessionRecord(surfaceId);
  if (!session || typeof session.cwd !== 'string' || !session.cwd.trim()) return null;
  const worktreePath = session.cwd;
  const exists = await stat(worktreePath).then(info => info.isDirectory(), () => false);
  const latest = session.recentRuns[0];
  const recoverable = exists && !session.activeRun && !session.detachedAt && !session.retiredAt
    && (latest?.outcome === 'interrupted' || latest?.outcome === 'failed');
  return { worktreePath, worktreeExists: exists, branch: session.branch ?? null, runId: latest?.id ?? null,
    actions: recoverable ? ['resume', 'retire'] : [], retired: Boolean(session.retiredAt) };
}

async function missingCheckoutLocation(surfaceId: string, recovery: WorkerRecovery): Promise<string> {
  let branchStatus = `Branch ${recovery.branch ?? '(unrecorded)'} existence could not be verified in the repository.`;
  if (recovery.branch) {
    try {
      const { resolveAgentControlTarget } = await import('./service');
      const target = await resolveAgentControlTarget({ kind: 'session', id: surfaceId });
      await execFileAsync(resolveGitBinary(), ['-C', target.repoPath ?? recovery.worktreePath,
        'show-ref', '--verify', '--quiet', `refs/heads/${recovery.branch}`], { windowsHide: true, timeout: 2_000 });
      branchStatus = `Branch ${recovery.branch} still exists in the repository.`;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 1) {
        branchStatus = `Branch ${recovery.branch} does not exist in the repository.`;
      }
    }
  }
  return `Checkout folder is missing at ${recovery.worktreePath}. ${branchStatus} Uncommitted edits could not be verified.`;
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
  const location = recovery ? recovery.worktreeExists
    ? `Branch ${recovery.branch ?? '(unrecorded)'} and edits remain at ${recovery.worktreePath}.`
    : await missingCheckoutLocation(surfaceId, recovery) : '';
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
  if (!recovery.worktreeExists) return { ok: false, status: 'unavailable' as const,
    note: `${location} Retire this saved worker, or restore its checkout folder before trying Resume again.` };
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
