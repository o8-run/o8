import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import { rebuildWorkerMemoryContext, workerMemoryIsCurrent } from './worker-memory-context';
import { getLane } from '@/lib/lane/registry';
import { laneGit } from '@/lib/lane/lane-git';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { OwnedRunController } from '@/lib/runtimes/shared/owned-session/run-controller';

/** Bounded source context is evidence to inspect, never a new task or authority. */
export async function buildWorkerHandoffContext(
  session: OwnedSessionRecord,
  readArtifacts: OwnedRunController['readRunArtifacts'],
): Promise<string> {
  const lane = session.laneId ? getLane(session.laneId) : null;
  if (!lane || lane.sessionKey !== session.surfaceId) throw new Error('The source worker lane changed before handoff.');
  const revision = readMemoryRevision();
  const currentMemory = workerMemoryIsCurrent(session);
  const task = currentMemory
    ? session.initialPrompt ?? session.recentRuns.at(-1)?.prompt ?? session.latestPrompt
    : await rebuildWorkerMemoryContext(session);
  const cwd = lane.worktreePath ?? lane.repoPath;
  const git = async (args: string[]) => laneGit(cwd, lane.repoPath, args, { timeout: 5_000, maxBuffer: 256 * 1024 })
    .then(output => output.stdout.slice(0, 24_000)).catch(() => '[Workspace evidence unavailable; inspect the checkout.]');
  const [diff, status, messages] = await Promise.all([
    git(['diff', session.head ?? 'HEAD', '--']),
    git(['status', '--short']),
    Promise.all((currentMemory ? session.recentRuns.filter(run => (run.memoryRevision ?? '0') === revision) : []).slice(0, 3).reverse().map(async run => {
      const artifacts = await readArtifacts(run);
      return { prompt: run.prompt.slice(0, 8_000), messages: artifacts.parsed.entries
        .filter(entry => entry.kind === 'message').slice(-6)
        .map(entry => ({ role: entry.label, text: entry.text.slice(0, 4_000) })) };
    })),
  ]);
  if (readMemoryRevision() !== revision) throw new Error('Worker memory changed during handoff; rebuild before retrying.');
  return [
    task,
    '\nContinue this task in the existing checkout after the previous runtime reached its usage limit.',
    'Inspect existing work and verify the carried observations. Handoff does not reset approvals, task scope or retry budgets.',
    '<worker-handoff-context>',
    JSON.stringify({ schema: 'o8/worker-handoff/v1', sourceSession: session.surfaceId,
      task,
      latestRequest: currentMemory ? session.latestPrompt : task, workspace: { branch: lane.branch, base: session.head ?? null, status, diff }, messages }),
    '</worker-handoff-context>',
  ].join('\n');
}
