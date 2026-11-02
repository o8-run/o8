import { workerMemoryNeedsRefresh } from '@/lib/dispatch/worker-memory-context';
import { assertOwnedStopAdmission } from './action-admission';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRunController } from './run-controller';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

/** Select continuation without changing identity, cwd, configuration or spawn admission. */
export async function prepareOwnedContinuation(session: OwnedSessionRecord, prompt: string, adapter: OwnedRuntimeAdapter, controller: OwnedRunController) {
  const resumable = session.threadId && adapter.resumeArgs({ threadId: session.threadId,
    sessionDir: session.sessionDir, prompt, model: session.model, effort: session.effort, runtimeConfig: session.runtimeConfig });
  if (resumable) return { mode: 'resume' as const, prompt };
  // Let spawn rebuild stale packet context from authority before reading any history.
  if (workerMemoryNeedsRefresh(session)) return { mode: 'launch' as const, prompt };
  const transcript: string[] = [];
  for (const run of session.recentRuns.slice(0, 3).reverse()) {
    const { parsed } = await controller.readRunArtifacts(run, false);
    transcript.push(...parsed.entries.slice(-24).map(entry => `${entry.label}: ${entry.text.slice(0, 1_000)}`));
  }
  return { mode: 'launch' as const, prompt: [
    'Continue the interrupted task in this same checkout and branch. Inspect and preserve the existing edits before continuing.',
    'The runtime has no resumable thread. This fresh process carries the saved task and a summary of its prior transcript.',
    `Original task:\n${(session.initialPrompt ?? session.latestPrompt).slice(0, 8_000)}`,
    `Prior transcript summary:\n${transcript.join('\n').slice(-8_000) || session.latestSummary}`,
    `Continuation request:\n${prompt}`,
  ].join('\n\n') };
}

/** Called under the store's surface lock; retirement retains recovery artifacts in place. */
export async function retireOwnedSession(surfaceId: string, io: OwnedSessionIo, controller: OwnedRunController) {
  const session = await io.findSession(surfaceId) ?? await io.findArchivedSession(surfaceId);
  if (!session) return { retired: false, note: 'Saved worker metadata is unavailable. Inspect its preserved checkout before recovery.' };
  assertOwnedStopAdmission(session);
  await controller.refreshSession(session, true, false);
  if (session.activeRun) return { retired: false, note: 'The worker has an active or unresolved run. Stop it before retiring it.' };
  session.retiredAt ??= new Date().toISOString();
  session.detachedAt ??= session.retiredAt;
  session.detachedReason = 'Retired by the operator; branch, edits and transcript retained.';
  await io.saveSession(session);
  return { retired: true, note: 'Worker retired; saved session artifacts retained in place.' };
}
