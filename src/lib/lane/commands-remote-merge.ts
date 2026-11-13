import { checkReviewRunPolicy } from './review-run-policy';
import { resolveGitBinary } from '@/lib/git/binary';
import { pushLfsObjects } from '@/lib/git/lfs-push';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { NO_REPOSITORY_HOOKS } from '@/lib/git/no-repository-hooks';
import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { cleanupRemoteMergeWorktree, fetchWorkerBranch } from '@/lib/lane/remote-fetch';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import { runLaneRebaseTypecheck } from '@/lib/lane/rebase-typecheck';
import { resolveAttributedCommitMessage } from '@/lib/lane/commit-attribution';
import { resolveGovernedMergeHistoryPlan } from '@/lib/lane/governed-merge-history';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneCommand, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import { fetchWorkerRun } from '@/lib/worker/runs';
import { SessionMergeRestrictionError, withSessionMergePublication } from '@/lib/orchestrator/session-merge-restriction';

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;

function formatLaneCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';

  return stderr || stdout || error.message;
}

export async function performRemoteCustomerMerge(
  lane: Lane,
  command: MergeCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
  const workerRun = fetchWorkerRun(lane.id);
  if (!workerRun?.remoteBranch) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'remote_branch_missing');
    return { ok: false, laneId: command.laneId, note: 'No remote branch recorded for this lane.' };
  }

  const fetched = await fetchWorkerBranch(lane.repoPath, workerRun.remoteBranch, workerRun.id);
  if (!fetched.ok) {
    console.error(`[remote-merge] Merge failed for lane ${lane.id} (packet ${lane.packetId ?? 'unbound'}): ${fetched.note}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error', { reason: fetched.note });
    return { ok: false, laneId: command.laneId, note: fetched.note };
  }

  const { execFile } = await import('@/lib/providers/child-process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let savedBranch: string | null = null;

  try {
    savedBranch = (await execFileAsync(resolveGitBinary(), ['rev-parse', '--abbrev-ref', 'HEAD'], {
      windowsHide: true,
      cwd: lane.repoPath,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();

    const sourceSha = (await laneGit(fetched.tempWorktreePath, lane.repoPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    const candidateGate = await checkReviewRunPolicy(lane, { cwd: fetched.tempWorktreePath, sha: sourceSha });
    if (!candidateGate.ok) return { ok: false, laneId: lane.id, reason: candidateGate.code, note: candidateGate.message };

    const attributedCommitMessage = command.commitMessage?.trim()
      ? resolveAttributedCommitMessage(command.commitMessage.trim())
      : undefined;
    if (attributedCommitMessage) {
      try {
        await laneGit(fetched.tempWorktreePath, lane.repoPath, ['add', '-A']);
        const { stdout: porcelain } = await laneGit(fetched.tempWorktreePath, lane.repoPath, ['status', '--porcelain'], { timeout: 5000 });
        if (porcelain.trim()) {
          await laneGit(fetched.tempWorktreePath, lane.repoPath, ['commit', '-m', attributedCommitMessage]);
        }
      } catch (error) {
        if (error instanceof LaneGitMetadataError) throw error;
        /* nothing to commit */
      }
    }

    const actualBranch = (await laneGit(fetched.tempWorktreePath, lane.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { maxBuffer: 1024 * 1024 })).stdout.trim();
    console.log(`[remote-merge] Actual worktree branch: ${actualBranch} (base ref: ${fetched.baseRef})`);

    const resolvedSha = (await laneGit(fetched.tempWorktreePath, lane.repoPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    const resolvedGate = await checkReviewRunPolicy(lane, { cwd: fetched.tempWorktreePath, sha: resolvedSha });
    if (!resolvedGate.ok) return { ok: false, laneId: lane.id, reason: resolvedGate.code, note: resolvedGate.message };
    let rebaseFailed = false;
    let typecheckSkipped: string | null = null;
    try {
      await laneGit(fetched.tempWorktreePath, lane.repoPath, ['rebase', lane.baseBranch]);
      console.log(`[remote-merge] Rebased ${actualBranch} onto ${lane.baseBranch}`);
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      try {
        await laneGit(fetched.tempWorktreePath, lane.repoPath, ['rebase', '--abort']);
      } catch {
        // already clean
      }
      rebaseFailed = true;
      console.log(`[remote-merge] Rebase failed for ${actualBranch}, attempting direct merge`);
    }

    if (!rebaseFailed) {
      const typecheck = await runLaneRebaseTypecheck({
        cwd: fetched.tempWorktreePath,
        installRoot: lane.repoPath,
        actualBranch,
        logPrefix: 'remote-merge',
      });
      // Held for the success note below. Dropping it here left the operator
      // reading an unqualified "Merged" for a merge that was never
      // typechecked (#2383).
      if (typecheck.ok && typecheck.skipped) typecheckSkipped = typecheck.skipped;
      if (!typecheck.ok) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'typecheck_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Typecheck failed after rebase onto ${lane.baseBranch}. Fix type errors before merging.\n\n${typecheck.output}`,
        };
      }
    }

    if (command.strategy === 'manual') {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'manual_resolution_unsupported');
      return {
        ok: false,
        laneId: command.laneId,
        note: 'Manual conflict resolution is not supported for remote-customer merges.',
      };
    }

    const historyPlan = await resolveGovernedMergeHistoryPlan({
      cwd: fetched.tempWorktreePath,
      runGit: (cwd, args, options) => laneGit(cwd, lane.repoPath, args, options),
      baseRef: lane.baseBranch,
      candidateRef: actualBranch,
      commitMessage: command.commitMessage,
    });
    if (historyPlan.kind === 'refuse') {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'wip_commit_requires_message');
      return { ok: false, laneId: command.laneId, note: historyPlan.note };
    }

    await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'checkout', lane.baseBranch], { windowsHide: true, cwd: lane.repoPath });
    const preMergeHeadSha = (await execFileAsync(resolveGitBinary(), ['rev-parse', 'HEAD'], {
      windowsHide: true,
      cwd: lane.repoPath,
      timeout: 5000,
    })).stdout.trim();

    try {
      const mergeArgs = historyPlan.kind === 'squash'
        ? ['merge', '--squash']
        : ['merge', '--no-ff', '-m', `Merge lane ${lane.label} (${actualBranch})`];
      if (command.strategy === 'ours' || command.strategy === 'theirs') {
        mergeArgs.push('-X', command.strategy);
      }
      mergeArgs.push(actualBranch);
      await withSessionMergePublication(lane.packetId, async () => {
        await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, ...mergeArgs], { windowsHide: true, cwd: lane.repoPath });
        if (historyPlan.kind === 'squash') {
          await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'commit', '-m', historyPlan.commitMessage], { windowsHide: true, cwd: lane.repoPath });
        }
      });
    } catch (mergeErr) {
      if (mergeErr instanceof SessionMergeRestrictionError) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'session_merge_restricted');
        return { ok: false, laneId: lane.id, note: mergeErr.message };
      }
      let conflictFiles: string[] = [];
      try {
        const { stdout: unmerged } = await execFileAsync(resolveGitBinary(), ['diff', '--name-only', '--diff-filter=U'], {
          windowsHide: true,
          cwd: lane.repoPath,
        });
        conflictFiles = unmerged.trim().split('\n').filter(Boolean);
      } catch {
        // best effort
      }

      if (historyPlan.kind === 'squash') {
        try {
          await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'reset', '--merge'], { windowsHide: true, cwd: lane.repoPath });
        } catch {
          await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'reset', '--hard', preMergeHeadSha], {
            windowsHide: true,
            cwd: lane.repoPath,
          });
        }
      } else {
        try {
          await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'merge', '--abort'], { windowsHide: true, cwd: lane.repoPath });
        } catch {
          // already clean
        }
      }

      const mergeMessage = formatLaneCommandError(mergeErr);
      const conflictLabel = rebaseFailed
        ? `Rebase failed, merge also failed: ${mergeMessage}`
        : `Merge failed after rebase: ${mergeMessage}`;
      const conflictSuffix = conflictFiles.length > 0
        ? `\n\nConflicting files:\n${conflictFiles.map((file) => `- ${file}`).join('\n')}`
        : '';
      console.warn(`[remote-merge] ${conflictLabel}`);
      setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_conflict');
      return {
        ok: false,
        laneId: command.laneId,
        note: `${conflictLabel}${conflictSuffix}`,
      };
    }

    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      const gitInRepo = (args: string[], options: { timeout: number }) => execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, ...args], {
        windowsHide: true,
        cwd: lane.repoPath,
        ...options,
      });
      await withSessionMergePublication(lane.packetId, async () => {
        await pushLfsObjects(gitInRepo, 'origin', lane.baseBranch, readLaneCreationBaseCommit(lane.id));
        await gitInRepo(['push', 'origin', lane.baseBranch], { timeout: 60_000 });
      });
      pushedToOrigin = true;
      console.log(`[remote-merge] Pushed ${lane.baseBranch} to origin after merging ${actualBranch}`);
    } catch (pushErr) {
      pushError = formatLaneCommandError(pushErr);
      console.warn(`[remote-merge] Push to origin failed for ${lane.baseBranch} after merging ${actualBranch}: ${pushError}`);
    }

    try {
      await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'push', 'origin', '--delete', workerRun.remoteBranch], {
        windowsHide: true,
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      console.log(`[remote-merge] Deleted remote branch ${workerRun.remoteBranch}`);
    } catch (deleteErr) {
      console.warn(
        `[remote-merge] Failed to delete remote branch ${workerRun.remoteBranch}: ${formatLaneCommandError(deleteErr)}`,
      );
    }

    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

    let decompositionNote = '';
    try {
      const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
      const decomposition = await enqueueDecompositionsAfterMerge({
        repoPath: lane.repoPath,
        runtime: lane.runtime,
      });
      if (decomposition.enqueued > 0) {
        const names = decomposition.candidates
          .map((candidate) => candidate.relativePath)
          .join(', ');
        decompositionNote = ` Enqueued ${decomposition.enqueued} decomposition dispatch${decomposition.enqueued === 1 ? '' : 'es'} for over-ceiling file${decomposition.enqueued === 1 ? '' : 's'}: ${names}.`;
      }
    } catch (decompositionError) {
      console.warn(
        `[remote-merge] Decomposition scan failed for ${lane.repoPath}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
      );
    }

    const updated = getLane(command.laneId);
    const skipNote = typecheckSkipped ? ` Typecheck did not run: ${typecheckSkipped}` : '';
    const mergeNote = pushedToOrigin
      ? `Merged ${lane.branch} into ${lane.baseBranch} and pushed to origin.${skipNote}${decompositionNote}`
      : `Merged ${lane.branch} into ${lane.baseBranch} LOCALLY, push to origin failed: ${pushError ?? 'unknown error'}. Run \`git push origin ${lane.baseBranch}\` to ship the commit.${skipNote}${decompositionNote}`;
    return {
      ok: true,
      laneId: command.laneId,
      note: mergeNote,
      lane: updated ?? undefined,
      pushedToOrigin,
      pushError,
    };
  } catch (error) {
    const message = formatLaneCommandError(error);
    console.error(`[remote-merge] Merge failed for lane ${lane.id} (packet ${lane.packetId ?? 'unbound'}): ${message}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error', { reason: message });
    return { ok: false, laneId: command.laneId, note: message };
  } finally {
    if (savedBranch) {
      try {
        await execFileAsync(resolveGitBinary(), [...NO_REPOSITORY_HOOKS, 'checkout', savedBranch], { windowsHide: true, cwd: lane.repoPath });
      } catch (restoreError) {
        console.warn(`[remote-merge] Failed to restore branch ${savedBranch}: ${formatLaneCommandError(restoreError)}`);
      }
    }

    try {
      await cleanupRemoteMergeWorktree(lane.repoPath, fetched.tempWorktreePath);
    } catch (cleanupError) {
      console.warn(
        `[remote-merge] Failed to clean up temp worktree ${fetched.tempWorktreePath}: ${formatLaneCommandError(cleanupError)}`,
      );
    }
  }
}
