import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';

import {
  compactText,
  deriveRunOutcome,
  formatClock,
  shortHome,
} from './helpers';
import {
  buildRuntimeSurface,
  latestRun,
  reviewDisposition,
  type OwnedLifecycleContext,
} from './lifecycle';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type {
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
  OwnedTailEntry,
  OwnedTailGroup,
} from './types';

export function createReviewTailController({
  adapter,
  lifecycleContext,
  io,
  runController,
  stderrNoise,
  launchGroupLabel,
  resumeGroupLabel,
}: {
  adapter: OwnedRuntimeAdapter;
  lifecycleContext: OwnedLifecycleContext;
  io: OwnedSessionIo;
  runController: OwnedRunController;
  stderrNoise: RegExp[];
  launchGroupLabel: string;
  resumeGroupLabel: string;
}) {
  async function getTelemetrySources(surfaceId: string) {
    const activeSession = await io.findSession(surfaceId);
    const session = activeSession ?? await io.findArchivedSession(surfaceId);
    if (!session) {
      return null;
    }

    return {
      threadId: session.threadId,
      model: session.model,
      stdoutPaths: [...session.recentRuns]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((run) => run.stdoutPath),
    };
  }

  async function collectTailEntries(session: OwnedSessionRecord, limit?: number) {
    const retainedEntryLimit = Math.min(Math.max(Math.floor(limit ?? 24), 1), 200);
    const retainedGroupLimit = limit === undefined
      ? 8
      : Math.min(Math.max(Math.floor(limit), 8), 200);
    const runs = [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const entries: OwnedTailEntry[] = [];
    const groups: OwnedTailGroup[] = [];
    let discoveredThreadId = session.threadId;

    for (const run of runs) {
      const { parsed, stderrRaw } = await runController.readRunArtifacts(run, false);
      const parsedEntries = run.modelFallback ? [...parsed.entries, {
        id: `${run.id}:model-fallback`, kind: 'event', label: 'Codex CLI update',
        text: run.modelFallback.notice, timestamp: run.finishedAt,
      } satisfies OwnedTailEntry] : parsed.entries;
      // Discover the thread id before the empty-transcript skip below: a run
      // can legitimately produce no visible entries (a quiet/tool-only turn)
      // while its adapter still reports the runtime's session/thread id in
      // the parsed log. Skipping straight past it here silently loses the
      // only thread id the session will ever get, which then makes #1524
      // cold-resume permanently unavailable for that session — resume()
      // fails "session was not found" even though the run finished cleanly.
      discoveredThreadId = discoveredThreadId ?? parsed.threadId;
      if (!parsedEntries.length) continue;

      const outcome = deriveRunOutcome(run, parsed, stderrRaw, stderrNoise);
      entries.push(...parsedEntries);
      groups.push({
        id: run.id,
        title: `${run.mode === 'launch' ? launchGroupLabel : resumeGroupLabel} • ${outcome}`,
        mode: run.mode,
        outcome,
        prompt: compactText(run.prompt, 8000),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        startedAtLabel: formatClock(run.startedAt),
        finishedAtLabel: formatClock(run.finishedAt),
        summary: outcome === 'interrupted'
          ? `Interrupted before ${adapter.squadShortName} completed the turn.`
          : outcome === 'failed'
            ? 'Run ended without a clean turn completion.'
            : outcome === 'running'
              ? 'Run is still in flight.'
              : 'Run completed and the session can continue from here.',
        entries: parsedEntries,
      });
    }

    return {
      entries: entries.slice(-retainedEntryLimit),
      groups: groups.slice(-retainedGroupLimit),
      threadId: discoveredThreadId,
    };
  }

  async function getRuntimeTail(surfaceId: string, limit?: number) {
    const activeSession = await io.findSession(surfaceId);
    const session = activeSession ?? await io.findArchivedSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} runtime surface was not found.`);
    }

    if (activeSession) {
      // Transcript polling runs every second while a pane is visible. Keep it
      // independent of lifecycle reconciliation: process/tmux probes can be
      // slow under fleet load, while the durable JSONL is already authoritative
      // for transcript activity and safe to read directly.
      const tail = await collectTailEntries(session, limit);
      if (!session.threadId && tail.threadId) {
        session.threadId = tail.threadId;
        await io.saveSession(session);
      }
      return {
        surface: buildRuntimeSurface(lifecycleContext, session, Boolean(session.activeRun)),
        entries: tail.entries,
        groups: tail.groups,
      };
    }

    const tail = await collectTailEntries(session, limit);
    return {
      surface: buildRuntimeSurface(lifecycleContext, session, false),
      entries: tail.entries,
      groups: tail.groups,
    };
  }

  function buildReviewActions(packet: Pick<RuntimeReviewPacket, 'dirty' | 'changedFiles' | 'lastRun' | 'reviewDisposition'>) {
    const actions = [] as string[];

    if (packet.lastRun?.outcome === 'running') {
      actions.push('Watch the active run', 'Interrupt if it drifts');
      return actions;
    }

    if (packet.reviewDisposition === 'resolved') {
      actions.push('Keep watching for new evidence');
    }

    if (packet.dirty) {
      actions.push('Review current repo delta', 'Open desktop diff context');
    }

    if (packet.lastRun?.outcome === 'failed') {
      actions.push('Resume with correction context', 'Inspect failing command evidence');
    } else if (packet.lastRun?.outcome === 'interrupted') {
      actions.push('Resume from the interrupted state');
    } else if (packet.lastRun?.outcome === 'finished') {
      actions.push('Decide whether the result is good enough', 'Resume with a bounded follow-up if needed');
    }

    if (!actions.length) {
      actions.push('Review the latest run evidence');
    }

    return actions.slice(0, 4);
  }

  function buildReviewNotes(session: OwnedSessionRecord, dirty: boolean) {
    const latest = latestRun(session);
    const notes = [
      'Current repo delta is shown live from git and is not yet isolated per run when multiple sessions touch the same repo.',
    ];

    if (!dirty) {
      notes.push('The repo is currently clean, so this run may have been exploratory, purely read-only, or already reconciled.');
    }

    if (!session.threadId) {
      notes.push(`This owned surface is still waiting for its first persistent ${adapter.squadShortName} thread id before resume becomes available.`);
    }
    if (latest?.childExit && latest.childExit.classification !== 'clean-exit') {
      notes.push(`Worker child exit: ${latest.childExit.classification}; code=${latest.childExit.code ?? 'null'}; signal=${latest.childExit.signal ?? 'null'}${latest.childExit.stderrTail ? `; stderrTail=${compactText(latest.childExit.stderrTail, 500)}` : ''}.`);
    }

    return notes;
  }

  async function getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
    const session = await io.findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} review packet was not found.`);
    }

    await runController.refreshSession(session, true);
    const repoReview = await getRuntimeRepoReview(session.repoPath);
    const lastRun = latestRun(session);
    const lastRunArtifacts = lastRun ? await runController.readRunArtifacts(lastRun) : null;
    const lastRunOutcome = lastRun && lastRunArtifacts
      ? deriveRunOutcome(lastRun, lastRunArtifacts.parsed, lastRunArtifacts.stderrRaw, stderrNoise)
      : undefined;
    const lastRunEvidence = lastRunArtifacts && lastRun && adapter.parseRunEvidence
      ? adapter.parseRunEvidence(lastRunArtifacts.stdoutRaw, lastRun, lastRunOutcome ?? lastRun.outcome)
      : null;
    const runtimeSurface = buildRuntimeSurface(lifecycleContext, session, Boolean(session.activeRun));
    const linkedWorktree = await getWorktreeManager(session.repoPath).list()
      .then((worktrees) => worktrees.find((worktree) => worktree.sessionKey === session.surfaceId) ?? null)
      .catch(() => null);

    const packet: RuntimeReviewPacket = {
      surfaceId: session.surfaceId,
      runtime: lifecycleContext.runtimeId,
      title: session.title,
      summary: runtimeSurface.lifecycle?.summary ?? session.latestSummary,
      repoPath: shortHome(session.repoPath),
      repoSlug: session.repoSlug,
      branch: repoReview.branch ?? session.branch,
      head: repoReview.head ?? session.head,
      dirty: repoReview.dirty,
      diffStat: repoReview.diffStat,
      changedFiles: repoReview.changedFiles,
      recentCommits: repoReview.recentCommits,
      reviewDisposition: reviewDisposition(session),
      reviewDispositionUpdatedAt: session.reviewDispositionUpdatedAt,
      reviewDispositionUpdatedAtLabel: formatClock(session.reviewDispositionUpdatedAt),
      worktree: linkedWorktree ? {
        id: linkedWorktree.id,
        path: linkedWorktree.path,
        branch: linkedWorktree.branch,
        baseBranch: linkedWorktree.baseBranch,
        status: linkedWorktree.status,
        dirtyFiles: linkedWorktree.dirtyFiles,
      } : null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            mode: lastRun.mode,
            outcome: lastRunOutcome ?? lastRun.outcome,
            prompt: compactText(lastRun.prompt, 260),
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            startedAtLabel: formatClock(lastRun.startedAt),
            finishedAtLabel: formatClock(lastRun.finishedAt),
            assistantSummary: lastRunEvidence?.assistantSummary,
            commands: lastRunEvidence?.commands ?? [],
          }
        : undefined,
      nextActions: [],
      notes: buildReviewNotes(session, repoReview.dirty),
    };

    packet.nextActions = buildReviewActions(packet);
    return packet;
  }

  return {
    getTelemetrySources,
    getRuntimeTail,
    getReviewPacket,
  };
}
