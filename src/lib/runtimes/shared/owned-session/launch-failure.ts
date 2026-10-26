import { writeFile } from 'node:fs/promises';
import { prependOwnedRun } from './run-ledger';
import type { OwnedRunMode, OwnedRunRecord, OwnedSessionRecord } from './types';

export async function stageOwnedLaunchFailure(input: {
  session: OwnedSessionRecord; runId: string; mode: OwnedRunMode; prompt: string;
  stdoutPath: string; stderrPath: string; message: string;
}): Promise<OwnedRunRecord> {
  const { session, runId, mode, prompt, stdoutPath, stderrPath, message } = input;
  await writeFile(stderrPath, `${message}\n`, 'utf8').catch(() => {});
  const finishedAt = new Date().toISOString();
  const run: OwnedRunRecord = { id: runId, mode, prompt, startedAt: finishedAt, finishedAt,
    pid: 0, stdoutPath, stderrPath, outcome: 'failed' };
  session.latestPrompt = prompt;
  session.latestSummary = message;
  session.reviewDisposition = 'watching';
  session.reviewDispositionUpdatedAt = finishedAt;
  session.activeRun = undefined;
  if (session.recentRuns.some(candidate => candidate.id === runId)) {
    session.recentRuns = session.recentRuns.map(candidate => candidate.id === runId ? run : candidate);
  } else prependOwnedRun(session, run);
  return run;
}
