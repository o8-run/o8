import { holdStandingLane, readStandingLane } from './standing-store';
import { withWorkAdmission } from '@/lib/app-update/work-launch-admission';
/**
 * Lane Command Bus
 *
 * Single entry point for all lane mutations. Human UI, Claude orchestrator,
 * and automations all call the same verbs.
 *
 * Verbs: open_lane, bind_worktree, launch_session, attach_session,
 *        send_turn, interrupt, request_review, complete, archive
 */

import type {
  LaneCommand,
  LaneCommandResult,
  LaneEventActor,
  Lane,
} from '@/lib/lane/types';
import {
  createLane,
  getLane,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
  appendEvent,
} from '@/lib/lane/registry';
import { buildLanePolicyContext, createLaneActionApproval } from '@/lib/lane/commands-approval';
import { launchSession } from '@/lib/lane/commands-launch';
import { performRemoteCustomerMerge } from '@/lib/lane/commands-remote-merge';
import { worktreeExistsOnDisk } from '@/lib/lane/commands-worktree';
import { parsePullRequestNumber } from '@/lib/lane/pr-number';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import { isProtectedBranch } from '@/lib/lane/policy';
import { evaluatePolicy } from '@/lib/approvals/policies';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/dispatch';
import { assessDurableApprovedReview, hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { resolvePacketTaskContractGate } from '@/lib/lane/task-contract-gate';
import { decideSurfaceMerge } from '@/lib/lane/surface-merge-decision';
import { resolveRequireApprovalSync } from '@/lib/operator/defaults';
import { formatOversizedFiles, getOversizedChangedFilesForLane } from '@/lib/lane/file-size-policy';
import { runMergeGate, formatMergeGateViolations } from '@/lib/lane/merge-gate';
import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import { performWorktreeSideMerge } from '@/lib/lane/worktree-side-merge';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import { isPacketMergeHeld, MERGE_HOLD_POLICY_RULE_ID } from '@/lib/lane/merge-hold';
import { assertSessionMergeAllowed } from '@/lib/orchestrator/session-merge-restriction';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getLaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import {
  commitSpokenReviewSnapshot,
  rejectInvalidSpokenReviewExecution,
  rejectSpokenReviewGovernanceDrift,
  resolveSpokenReviewSnapshotSha,
  spokenReviewResolutionTransition,
  SpokenReviewSnapshotChangedError,
  validateSpokenReviewEvidenceBundle,
} from '@/lib/lane/spoken-review-snapshot';
import { commitDirtyWorktree, readHeadSha } from '@/lib/lane/worktree-merge-git';
import { withRepoActionRecovery } from '@/lib/lane/repo-action-lock';
import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { enqueueLaneReview } from '@/lib/lane/review-queue';
import { assertPacketCreationBaseAuthority, resolvePacketCreationBase, PacketCreationBaseError, type PacketCreationBaseAuthority } from '@/lib/lane/packet-creation-base';
import { readPinnedLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { withStandingStopMutation } from '@/lib/runtimes/shared/owned-session/standing-launch';
import { persistLanePacketHold } from '@/lib/lane/packet-stop-hold';
import { killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';
import { liveWorkerSessionLanes } from '@/lib/lane/worker-session-state';
import { terminatePacketManagedRuns } from '@/lib/runtimes/managed-runs/packet-lifecycle';
import { isDiscoveredCliSessionKey } from '@/lib/runtime/discovered-cli-session';
import {
  withWorkspaceMaterializedMutation,
  WorkspaceMutationUnavailableError,
} from '@/lib/workspace/mutation-materialization-guard';

/**
 * #2 Stage 5b — worker-context merge governance. A dispatched worker that calls
 * `o8 packet approve-merge` cannot merge its own work to main; this raises an
 * operator approval card (the SAME primitive + lane-merge continuation as the
 * file-size gate above). When the operator approves it, /api/panel/approvals
 * dispatches the continuation through the full merge gate. Capability symmetry
 * for the agent, the review-inversion moat intact for the operator.
 */
export async function raiseWorkerMergeApproval(
  lane: Lane,
  input: { commitMessage?: string; expectedHeadSha?: string; reviewSummary?: string } = {},
): Promise<LaneCommandResult> {
  return createLaneActionApproval(lane, 'orchestrator', {
    verb: 'merge',
    commitMessage: input.commitMessage,
    expectedHeadSha: input.expectedHeadSha,
    reviewSummary: input.reviewSummary,
    title: 'Worker requested merge to main',
    description: 'A dispatched worker reached the merge step via `o8 packet approve-merge`. Per governance a worker cannot merge its own work to main — approve to run the merge through the gate, or reject to send it back.',
    summary: `Worker merge request: ${lane.branch} → ${lane.baseBranch}`,
    risk: 'medium',
    policyRuleId: 'worker-merge-governance',
    note: 'Worker-initiated merge held for operator approval.',
  });
}

export async function dispatch(
  command: LaneCommand,
  dependencies: {
    afterWorkspaceMaterializationProof?: () => Promise<void>;
    repoActionLeaseMaxWaitMs?: number;
    packetCreationBase?: PacketCreationBaseAuthority;
  } = {},
): Promise<LaneCommandResult> {
  if (command.verb === 'merge' || command.verb === 'create_pr') {
    const lane = getLane(command.laneId);
    if (lane) {
      try {
        return await withWorkspaceMaterializedMutation(lane, async () => {
          await dependencies.afterWorkspaceMaterializationProof?.();
          return dispatchUnlocked(command, dependencies);
        });
      } catch (error) {
        if (error instanceof WorkspaceMutationUnavailableError) {
          return { ok: false, laneId: command.laneId, note: error.message, reason: error.code };
        }
        throw error;
      }
    }
  }
  return dispatchUnlocked(command, dependencies);
}

async function dispatchUnlocked(
  command: LaneCommand,
  dependencies: { repoActionLeaseMaxWaitMs?: number; packetCreationBase?: PacketCreationBaseAuthority } = {},
): Promise<LaneCommandResult> {
  const actor: LaneEventActor = command.actor ?? 'user';

  switch (command.verb) {
    case 'open_lane': {
      const workerRouting = resolveWorkerRouting({
        requestedRuntime: command.runtime,
        source: 'lane-open',
      });
      const existing = (await import('@/lib/lane/registry')).findLaneByRepoAndBranch(
        command.repoPath,
        command.branch,
      );
      if (dependencies.packetCreationBase && command.packetId) {
        assertPacketCreationBaseAuthority(dependencies.packetCreationBase, {
          repoPath: command.repoPath, packetId: command.packetId, branch: command.branch,
          baseBranch: command.baseBranch?.trim() || 'main',
        });
        if (existing && readPinnedLaneCreationBaseCommit(existing.id) !== dependencies.packetCreationBase.baseCommit) {
          throw new Error('Existing lane creation base differs from the admitted checkout.');
        }
      }
      if (existing) {
        if (!listDispatchableRuntimes({ includeExperimental: true }).includes(existing.runtime) && !(existing.runtime === 'cloud' && command.packetId === existing.packetId)) {
          return {
            ok: false,
            laneId: existing.id,
            note: `Runtime "${existing.runtime}" is not dispatchable (existing lane ${existing.id}). Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}. Archive or migrate the lane before launching new work.`,
            lane: existing,
          };
        }
        const updatedExisting = command.packetId && existing.packetId !== command.packetId
          ? updateLane(existing.id, { packetId: command.packetId }, actor) ?? existing
          : existing;
        return { ok: true, laneId: updatedExisting.id, note: 'Lane already exists for this repo and branch.', lane: updatedExisting };
      }
      const baseBranch = command.baseBranch?.trim() || 'main';
      let baseCommit: string | undefined;
      if (command.packetId) {
        try {
          const authority = dependencies.packetCreationBase ?? await resolvePacketCreationBase({
            repoPath: command.repoPath, packetId: command.packetId, branch: command.branch,
            baseBranch, runtime: workerRouting.selectedRuntime,
          });
          baseCommit = authority.baseCommit;
        } catch (error) {
          if (!(error instanceof PacketCreationBaseError)) throw error;
          return { ok: false, laneId: '', note: error.message, reason: error.reason };
        }
      }

      const lane = createLane({
        repoPath: command.repoPath,
        projectId: command.projectId,
        branch: command.branch,
        baseBranch,
        baseCommit,
        runtime: workerRouting.selectedRuntime,
        label: command.label,
        packetId: command.packetId,
        ownership: command.ownership,
        actor,
      });

      return { ok: true, laneId: lane.id, note: `Lane opened: ${lane.label}. ${workerRouting.reason}`, lane };
    }

    case 'bind_worktree': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = updateLane(
        command.laneId,
        { worktreePath: command.worktreePath },
        actor,
      );
      return { ok: true, laneId: command.laneId, note: `Worktree bound: ${command.worktreePath}`, lane: updated ?? undefined };
    }

    case 'launch_session': {
      return launchSession(command, actor);
    }

    case 'attach_session': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = attachSession(command.laneId, command.sessionKey, actor);
      return { ok: true, laneId: command.laneId, note: `Session attached: ${command.sessionKey}`, lane: updated ?? undefined };
    }

    case 'send_turn': {
      if (readStandingLane(command.laneId)?.stopped) return { ok: false, laneId: command.laneId, note: 'Standing lane is stopped.' };
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session on this lane.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = readStandingLane(lane.id)
          ? await (await import('@/lib/runtimes')).getRuntime(lane.runtime)!.resume(lane.sessionKey, command.message)
          : await performRuntimeAction({ action: 'steer', surfaceId: lane.sessionKey, message: command.message });

        if (result.ok) {
          rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
          setLaneStatus(command.laneId, 'running', actor, 'turn_sent');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Send failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'interrupt': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session to interrupt.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = await performRuntimeAction({
          action: 'interrupt',
          surfaceId: lane.sessionKey,
        });

        if (result.ok) {
          setLaneStatus(command.laneId, 'paused', actor, 'interrupted');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Interrupt failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'stop': {
      holdStandingLane(command.laneId);
      return withStandingStopMutation(command.laneId, async () => {
        const lane = getLane(command.laneId);
        if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

        // 1) Flag the packet operator-stopped FIRST, inside the control-plane lock.
        //    The order is the correctness point: interrupting the session can end it
        //    and trip a stall/ralph requeue, and a concurrent dispatch tick reads
        //    state under the same lock — setting operatorStopped + held atomically
        //    here means getDispatchBlocker rejects every relaunch path before the
        //    interrupt can race a re-dispatch in. (2026-06-22)
        const standing = readStandingLane(lane.id);
        if (lane.packetId && (!standing || standing.tasks.some(task => task.phase === 'running' || task.phase === 'dispatching'))) {
          try {
            if (!await persistLanePacketHold(lane.packetId, lane)) {
              return {
                ok: false,
                laneId: command.laneId,
                note: 'Stop refused because the packet hold could not be persisted.',
                lane,
              };
            }
          } catch (err) {
            console.warn('[lane] stop: could not mark packet operator-stopped', err);
            return {
              ok: false,
              laneId: command.laneId,
              note: `Stop refused because the packet hold could not be persisted: ${err instanceof Error ? err.message : String(err)}`,
              lane,
            };
          }
        }

        // 2) Interrupt the live session if one exists. Truthful status matters:
        //    only show paused after the runtime confirms the worker is gone.
        let stopOk = true;
        let stopNote = 'No active session was attached.';
        if (lane.sessionKey) {
          const liveWorkerLanes = liveWorkerSessionLanes([lane]);
          if (liveWorkerLanes.length === 0) {
            stopNote = 'Worker exit was already recorded.';
          } else {
            try {
              const [result] = await killLaneSessionsConfirmed(liveWorkerLanes);
              stopOk = Boolean(result?.confirmed || result?.alreadyDead);
              stopNote = result?.note ?? 'No confirmed process result was returned.';
            } catch (err) {
              stopOk = false;
              stopNote = err instanceof Error ? err.message : 'Interrupt failed.';
            }
          }
        }

        if (!stopOk) {
          appendEvent(command.laneId, 'interrupt_failed', actor, {
            packetId: lane.packetId,
            sessionKey: lane.sessionKey,
            note: stopNote,
          });
          setLaneStatus(command.laneId, 'running', actor, 'interrupt_failed');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Stop guard is held, but the live worker did not exit: ${stopNote}`,
            lane: getLane(command.laneId) ?? undefined,
          };
        }

        // `o8 packet stop` and mission stop both enter through this lane command
        // path. A packet-owned `o8 run --detach` lives in its own tmux process
        // tree, so confirming only the worker session would leave that workload
        // running against a held packet. Settle the packet-bound runs after the
        // worker can no longer register new ones, while preserving runs owned by
        // sibling packets.
        if (lane.packetId) {
          const managedRuns = await terminatePacketManagedRuns(lane.packetId);
          if (managedRuns.failures.length > 0) {
            appendEvent(command.laneId, 'managed_run_stop_failed', actor, {
              packetId: lane.packetId,
              targeted: managedRuns.targeted,
              confirmed: managedRuns.confirmed,
              failures: managedRuns.failures,
            });
            setLaneStatus(command.laneId, 'paused', actor, 'managed_run_stop_failed');
            return {
              ok: false,
              laneId: command.laneId,
              note: `Agent stopped, but ${managedRuns.failures.length} packet-managed run${managedRuns.failures.length === 1 ? '' : 's'} could not be confirmed dead. The packet remains held.`,
              lane: getLane(command.laneId) ?? undefined,
            };
          }
          if (managedRuns.confirmed > 0) {
            appendEvent(command.laneId, 'managed_runs_stopped', actor, {
              packetId: lane.packetId,
              targeted: managedRuns.targeted,
              confirmed: managedRuns.confirmed,
            });
          }
        }

        setLaneStatus(command.laneId, 'paused', actor, 'operator_stopped');
        return {
          ok: true,
          laneId: command.laneId,
          note: 'Agent stopped. It will not auto-redispatch — reset or relaunch to continue.',
          lane: getLane(command.laneId) ?? undefined,
        };
      });
    }

    case 'resume': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      if (isDiscoveredCliSessionKey(lane.runtime, lane.sessionKey)) {
        return {
          ok: false,
          laneId: command.laneId,
          reason: 'cli_resume_requires_explicit_action',
          note: 'This lane is bound to an external CLI session. Resume cannot safely continue it or start another run. Continue in the original terminal.',
          lane,
        };
      }

      // If lane has a live session, resume it with a message
      if (lane.sessionKey && command.message) {
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          const result = await performRuntimeAction({
            action: 'steer',
            surfaceId: lane.sessionKey,
            message: command.message,
          });
          if (result.ok) {
            rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
            setLaneStatus(command.laneId, 'running', actor, 'resumed');
          }
          return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
        } catch {
          // Session dead — fall through to re-launch
        }
      }

      // No session or session dead — re-launch in the same worktree
      const prompt = command.message || 'Continue the previous task. Check what was done and what remains.';
      setLaneStatus(command.laneId, 'launching', actor, 'relaunching');

      try {
        const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
        const result = await launchRuntimeSurface({
          runtime: lane.runtime,
          prompt,
          repoPath: lane.worktreePath ?? lane.repoPath,
          projectRepoPath: lane.repoPath,
          baseBranch: lane.baseBranch,
          isolate: false,
          skipSetup: true,
          existingLaneId: command.laneId,
          packetId: lane.packetId ?? undefined,
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        setLaneStatus(command.laneId, 'running', actor, 'resumed');

        // Register with supervisor (ws-server process) via HTTP
        try {
          const { wsPort } = resolvePortInfo();
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({ surfaceId: result.surfaceId, repoPath: lane.repoPath, name: lane.label || lane.branch, prompt }),
            signal: AbortSignal.timeout(3000),
          });
        } catch { /* best effort */ }

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `Resumed in ${lane.worktreePath ?? lane.repoPath}.`, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_error');
        const message = err instanceof Error ? err.message : 'Resume failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'request_review': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // #454 — Guard: auto-commit dirty worktrees before allowing review transition
      const reviewCwd = lane.worktreePath ?? lane.repoPath;
      try {
        const { stdout: porcelain } = await laneGit(reviewCwd, lane.repoPath, ['status', '--porcelain'], {
          maxBuffer: 10 * 1024 * 1024,
        });
        if (porcelain.trim().length > 0) {
          console.log(`[lane] request_review: dirty worktree detected in ${reviewCwd}, auto-committing`);
          await laneGit(reviewCwd, lane.repoPath, ['add', '-A', '--', '.'], {
            maxBuffer: 10 * 1024 * 1024,
          });
          // Unstage o8-injected worktree artifacts so they never land in the review
          // commit: the safety-hook `.claude/settings.json` (otherwise blows the
          // diff-budget merge gate) and the `node_modules` symlink (otherwise pollutes
          // the target repo's main). Use `git reset` to unstage rather than a negative
          // `git add` pathspec — the latter errors ("paths are ignored") when an ignored
          // dir like node_modules exists in the worktree.
          await laneGit(reviewCwd, lane.repoPath, ['reset', '-q', '--', '.claude', 'node_modules'], {
            maxBuffer: 10 * 1024 * 1024,
          });
          await laneGit(reviewCwd, lane.repoPath, ['commit', '-m', 'auto-commit: agent work before review'], {
            maxBuffer: 10 * 1024 * 1024,
          });
        }
      } catch (err) {
        console.warn(`[lane] request_review: git status/commit check failed for ${reviewCwd}:`, err);
        if (err instanceof LaneGitMetadataError) {
          return { ok: false, laneId: command.laneId, note: err.message };
        }
        // Other commit failures retain the existing review transition.
      }

      // Empty-commit guard — if the worktree has zero commits ahead of base
      // AND the working tree is clean, the runtime reported success but produced
      // no diff. Surface this as a failed lane with a clear note instead of
      // opening an empty review packet. (Observed with Gemini 3.1 Pro: emitted
      // a clean <self-review> block but never actually landed a commit.)
      try {
        const baseBranch = lane.baseBranch || 'main';
        const probe = await probeNoChangesProduced(reviewCwd, baseBranch, (args) => laneGit(reviewCwd, lane.repoPath, args));
        if (probe.noChangesProduced) {
          if (lane.lastEventLabel === 'launch_failed' || lane.lastEventLabel === 'launch_error') {
            return {
              ok: false,
              laneId: command.laneId,
              note: lane.outcomeNote ?? lane.lastEventLabel,
              lane: getLane(command.laneId) ?? undefined,
            };
          }
          const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
          const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
          if (huddlePark.parked) {
            console.warn(`[lane] request_review: ${command.laneId} produced no diff after huddle report — parking for orchestrator.`);
            return {
              ok: false,
              laneId: command.laneId,
              note: 'huddle_ready',
              lane: huddlePark.lane ?? undefined,
            };
          }
          if (huddlePark.operatorBlocked) {
            const blockedLane = huddlePark.lane ?? getLane(command.laneId) ?? lane;
            return {
              ok: false,
              laneId: command.laneId,
              note: blockedLane.lastEventLabel ?? 'worker_blocked',
              lane: blockedLane,
            };
          }
          const { shouldDeferCompletionForLiveRuntime } = await import('@/lib/supervisor/completion-liveness');
          if (await shouldDeferCompletionForLiveRuntime(lane)) {
            console.warn(`[lane] request_review: ${command.laneId} has no diff yet, but its owned runtime is still live. Keeping it running.`);
            return {
              ok: false,
              laneId: command.laneId,
              note: 'runtime_still_running',
              lane,
            };
          }
          console.warn(`[lane] request_review: ${command.laneId} has 0 commits ahead of ${baseBranch} — runtime reported success but produced no diff. Marking failed.`);
          const failed = setLaneStatus(command.laneId, 'failed', 'system', 'zero_diff_failed');
          return {
            ok: false,
            laneId: command.laneId,
            note: 'no_changes_produced',
            lane: failed ?? undefined,
          };
        }
      } catch (err) {
        console.warn(`[lane] request_review: empty-commit check failed for ${reviewCwd}:`, err);
        if (err instanceof LaneGitMetadataError) {
          return { ok: false, laneId: command.laneId, note: err.message };
        }
        if (lane.lastEventLabel === 'launch_failed' || lane.lastEventLabel === 'launch_error') {
          return {
            ok: false,
            laneId: command.laneId,
            note: lane.outcomeNote ?? lane.lastEventLabel,
            lane: getLane(command.laneId) ?? undefined,
          };
        }
        // Non-fatal for a worker that ran; the review panel can still show its diff.
      }

      const updated = setLaneStatus(command.laneId, 'reviewing', actor, 'review_requested');
      if (updated) enqueueLaneReview(updated);
      return { ok: true, laneId: command.laneId, note: 'Review requested.', lane: updated ?? undefined };
    }

    case 'create_pr': {
      if (readStandingLane(command.laneId)?.stopped) return { ok: false, laneId: command.laneId, note: 'Standing lane is stopped.' };
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to create PR from. Lane is on the main working tree.' };
      const spokenEvidence = validateSpokenReviewEvidenceBundle(command);
      if (!spokenEvidence.complete) {
        return {
          ok: false,
          laneId: command.laneId,
          note: 'Spoken review evidence is incomplete. Review the packet again before creating the pull request.',
          reason: 'spoken_review_evidence_incomplete',
        };
      }

      // Policy gate — require approval for PR creation
      const hasApprovedReview = actor === 'user' ? true : await hasDurableApprovedReview(lane);
      const prPolicy = evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', actor, {
        hasApprovedReview,
      }));
      if (prPolicy.requiresApproval && actor !== 'user') {
        return createLaneActionApproval(lane, actor, {
          verb: 'create_pr',
          commitMessage: command.commitMessage,
          reviewSummary: command.reviewSummary,
          title: 'Create pull request',
          description: command.reviewSummary || `Create PR from lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Create PR: ${lane.branch} → ${lane.baseBranch}`,
          risk: prPolicy.risk,
          policyRuleId: prPolicy.ruleId,
          note: `Approval required: ${prPolicy.reason}`,
        });
      }

      if (prPolicy.ruleId === 'auto_approve_orchestrator_review') {
        console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (create_pr)`);
      }

      return withWorkAdmission(`PR publication ${command.laneId}`, () => withRepoActionRecovery(lane.repoPath, {
        laneId: command.laneId,
        packetId: lane.packetId,
        maxWaitMs: dependencies.repoActionLeaseMaxWaitMs,
      }, async () => {
        const lockedLane = getLane(command.laneId);
        if (!lockedLane) {
          return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
        }
        const executionDrift = rejectInvalidSpokenReviewExecution({
          ...command,
          lane: lockedLane,
          actor,
          verb: 'create_pr',
        });
        if (executionDrift) return executionDrift;
        const governanceDrift = await rejectSpokenReviewGovernanceDrift({
          lane: lockedLane,
          actor,
          approvalId: command.spokenReviewApprovalId,
          expectedFingerprint: command.expectedGovernanceFingerprint,
          resolutionTransition: spokenReviewResolutionTransition(command),
          action: 'creating the pull request',
        });
        if (governanceDrift) return governanceDrift;

        if (readStandingLane(command.laneId)?.stopped) return { ok: false, laneId: command.laneId, note: 'Standing lane is stopped.' };
        setLaneStatus(command.laneId, 'merging', actor, 'creating_pr');

        try {
          if (!lockedLane.worktreePath || !(await worktreeExistsOnDisk(lockedLane.worktreePath))) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Worktree not found on disk: ${lockedLane.worktreePath ?? '<unset>'}`,
          };
        }

        if (command.expectedDiffFingerprint) {
          const current = await getLaneSpokenDiffFacts(lockedLane);
          if (current.fingerprint !== command.expectedDiffFingerprint) {
            setLaneStatus(command.laneId, 'reviewing', 'system', 'spoken_review_invalidated');
            return {
              ok: false,
              laneId: command.laneId,
              note: 'Packet diff changed after the spoken review. Review it again before creating the pull request.',
              reason: 'diff_changed_since_spoken_review',
            };
          }
        }

        // Freeze the reviewed bytes to one immutable commit. A later worker
        // write or stage can change the local branch, but the push below names
        // this SHA directly and cannot publish those unreviewed bytes.
        // F32 (#1024): match the merge-path fix — only commit when there are
        // real uncommitted changes. --allow-empty here created duplicate
        // commits on every create_pr call when Codex had already committed.
        let reviewedSnapshotSha: string;
        if (spokenEvidence.present) {
          try {
            reviewedSnapshotSha = command.commitMessage
              ? await commitSpokenReviewSnapshot({
                lane: lockedLane,
                commitMessage: command.commitMessage,
                expectedFingerprint: command.expectedDiffFingerprint,
              })
              : await resolveSpokenReviewSnapshotSha({
                lane: lockedLane,
                expectedFingerprint: command.expectedDiffFingerprint,
              });
          } catch (error) {
            if (error instanceof SpokenReviewSnapshotChangedError) {
              setLaneStatus(command.laneId, 'reviewing', 'system', 'spoken_review_invalidated');
              return {
                ok: false,
                laneId: command.laneId,
                note: error.message,
                reason: 'diff_changed_since_spoken_review',
              };
            }
            throw error;
          }
        } else {
          if (command.commitMessage) {
            try {
              await commitDirtyWorktree(lockedLane.worktreePath, command.commitMessage);
            } catch {
              // Preserve legacy PR behavior when an optional auto-commit fails.
            }
          }
          reviewedSnapshotSha = await readHeadSha(lockedLane.worktreePath);
        }

        const publicationGovernanceDrift = await rejectSpokenReviewGovernanceDrift({
          lane: lockedLane,
          actor,
          approvalId: command.spokenReviewApprovalId,
          expectedFingerprint: command.expectedGovernanceFingerprint,
          resolutionTransition: spokenReviewResolutionTransition(command),
          action: 'creating the pull request',
        });
        if (publicationGovernanceDrift) return publicationGovernanceDrift;

        if (readStandingLane(command.laneId)?.stopped) throw new Error('Standing lane was stopped before publication.');
        // Push the immutable reviewed commit, never the mutable local branch.
        await laneGit(lockedLane.worktreePath, lockedLane.repoPath, [
          'push',
          'origin',
          `${reviewedSnapshotSha}:refs/heads/${lockedLane.branch}`,
        ]);

        if (readStandingLane(command.laneId)?.stopped) throw new Error('Standing lane was stopped before PR creation.');
        // Create PR via gh CLI
        const prTitle = lockedLane.label || `${lockedLane.branch}`;
        const prResult = await materializationAwareExecFile('gh', [
          'pr', 'create',
          '--base', lockedLane.baseBranch,
          '--head', lockedLane.branch,
          '--title', prTitle,
          '--body', command.reviewSummary?.trim() || `Automated PR from lane \`${lockedLane.id}\`.\n\nRuntime: ${lockedLane.runtime}\nPacket: ${lockedLane.packetId ?? 'none'}`,
        ], { windowsHide: true, cwd: lockedLane.repoPath });

        const prUrl = prResult.stdout.trim();
        const prNumber = parsePullRequestNumber(prUrl);
        updateLane(command.laneId, {
          ...(prNumber !== null ? { prNumber } : {}),
          outcome: 'pr_opened',
          outcomeNote: `Pull request opened: ${prUrl}`,
        }, actor);
        let associationNote = '';
        if (prNumber !== null) {
          try { await (await import('@/lib/orchestrator/pull-request-delivery')).recordConversationPrDelivery(command.laneId, prUrl); }
          catch {
            // Publication succeeded. Never turn a local provenance failure into a duplicate PR retry.
            associationNote = ' Conversation link could not be verified; inspect packet ownership and GitHub access before attaching it manually.';
            updateLane(command.laneId, { outcomeNote: `Pull request opened: ${prUrl}.${associationNote}` }, actor);
          }
        }
        setLaneStatus(command.laneId, 'reviewing', actor, 'pr_created');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `PR created: ${prUrl}${associationNote}`, lane: updated ?? undefined };
        } catch (err) {
          if (!readStandingLane(command.laneId)?.stopped) setLaneStatus(command.laneId, 'reviewing', 'system', 'pr_failed');
          const message = err instanceof Error ? err.message : 'PR creation failed.';
          return { ok: false, laneId: command.laneId, note: message };
        }
      }), error => ({ ok: false, laneId: command.laneId, reason: 'app_restart_pending',
        note: error instanceof Error ? error.message : 'Publication admission is unavailable.' }));
    }

    case 'merge': {
      if (readStandingLane(command.laneId)) return { ok: false, laneId: command.laneId, note: 'Standing worker lanes never merge.' };
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      const spokenEvidence = validateSpokenReviewEvidenceBundle(command);
      if (!spokenEvidence.complete) {
        return {
          ok: false,
          laneId: command.laneId,
          note: 'Spoken review evidence is incomplete. Review the packet again before merging.',
          reason: 'spoken_review_evidence_incomplete',
        };
      }
      // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
      if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
      const isRemoteCustomerLane = (lane.runtime as string) === 'remote-customer';
      if (!lane.worktreePath && !isRemoteCustomerLane) {
        return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
      }

      // submit_review persists its ApprovalRecord before updating mission state.
      // Read that durable row before every budget check so an accepted finding
      // waives the same HEAD atomically from the merge gate's perspective.
      const durableReview = await assessDurableApprovedReview(lane);
      const orchestratorReviewedForBudget = command.orchestratorReviewed === true
        || durableReview.diffBudgetWaived;
      const oversizedFiles = await getOversizedChangedFilesForLane(lane);
      if (oversizedFiles.length > 0) {
        const largestFile = oversizedFiles[0];
        const fileSizePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
          orchestratorReviewed: orchestratorReviewedForBudget,
          fileSizeLimitExceeded: true,
        }));

        if (fileSizePolicy.requiresApproval && actor !== 'user') {
          return createLaneActionApproval(lane, actor, {
            verb: 'merge',
            commitMessage: command.commitMessage,
            expectedHeadSha: command.expectedHeadSha,
            reviewSummary: command.reviewSummary,
            title: 'Override file size limit',
            description: `Merge blocked by file size governance. Oversized changed file${oversizedFiles.length === 1 ? '' : 's'}: ${formatOversizedFiles(oversizedFiles)}. Operator approval is required to override.`,
            summary: `File size limit override: ${lane.branch} → ${lane.baseBranch}`,
            risk: fileSizePolicy.risk,
            policyRuleId: fileSizePolicy.ruleId,
            metadata: {
              'File path': oversizedFiles.length === 1
                ? largestFile.path
                : `${largestFile.path} (+${oversizedFiles.length - 1} more)`,
              'Current line count': String(largestFile.lineCount),
              'Original line count': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.originalLineCount),
              'Net line change': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.lineCount - largestFile.originalLineCount),
              Threshold: String(FILE_SIZE_BLOCK_THRESHOLD_LINES),
            },
            note: `Approval required: ${fileSizePolicy.reason}`,
          });
        }
      }

      // ── Merge gate enforcement ──
      // Security, budget, and integrity violations can require operator approval.
      //
      // When the orchestrator has already approved the review, pass that
      // through — the gate downgrades budget violations to warn so a
      // human-in-the-loop refactor with intentional large deletions can
      // land. Security + integrity always stay block-level. See F25 / #1001.
      const gateResult = await runMergeGate(lane, undefined, orchestratorReviewedForBudget);
      if (!gateResult.passed && actor !== 'user') {
        const blockCount = gateResult.violations.filter((v) => v.severity === 'block').length;
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: `Merge gate: ${blockCount} violation${blockCount === 1 ? '' : 's'}`,
          description: formatMergeGateViolations(gateResult.violations),
          summary: `Merge blocked: ${lane.branch} → ${lane.baseBranch}`,
          risk: 'high',
          policyRuleId: 'merge-gate-violation',
          note: 'Merge gate enforcement: human review required.',
          gateResult: { passed: gateResult.passed, violations: gateResult.violations, diffBase: gateResult.diffBase },
        });
      }

      const contractGate = await resolvePacketTaskContractGate({ lane });
      if (contractGate.enforceCoverage
        && durableReview.contractCoverage?.status !== 'passed'
        && durableReview.contractCoverage?.status !== 'waived') {
        return { ok: false, laneId: command.laneId, note: `Task-contract coverage is required. ${durableReview.reason}` };
      }
      if (actor !== 'user' && !durableReview.approved) {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: 'Review required before merge',
          description: `This merge has no durable approval for the current worktree HEAD. ${durableReview.reason} Operator approval is required to continue.`,
          summary: `Review required: ${lane.branch} → ${lane.baseBranch}`,
          risk: 'high',
          policyRuleId: 'lane-merge',
          note: `Merge refused: ${durableReview.reason} Operator approval required.`,
        });
      }
      let hasApprovedReview = actor === 'user' ? true : durableReview.approved;
      let surfaceReasons: string[] = [];
      if (actor !== 'user' && resolveRequireApprovalSync() === 'surface') {
        const surfaceDecision = await decideSurfaceMerge(lane, {
          passed: gateResult.passed,
          violations: gateResult.violations,
          diffBase: gateResult.diffBase,
        });
        hasApprovedReview = surfaceDecision.hasApprovedReview;
        surfaceReasons = surfaceDecision.reasons;
      }

      // Policy gate — require approval for merge
      const mergePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
        orchestratorReviewed: orchestratorReviewedForBudget,
        gatePassed: gateResult.passed,
        hasApprovedReview,
        surfaceReviewRequired: surfaceReasons.length > 0,
      }));
      const routesToDispatcher = mergePolicy.ruleId === 'surface-dispatcher-review';
      const dispatcherApprovalSatisfied = routesToDispatcher && command.surfaceDispatcherApproved === true;
      if (mergePolicy.requiresApproval && actor !== 'user' && !dispatcherApprovalSatisfied) {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: routesToDispatcher ? 'Dispatcher review requested' : 'Merge lane',
          description: routesToDispatcher
            ? `This packet needs review before merge: ${surfaceReasons.join(' ')}`
            : command.reviewSummary || `Merge lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: routesToDispatcher
            ? `Review requested: ${lane.branch} → ${lane.baseBranch}`
            : `Merge: ${lane.branch} → ${lane.baseBranch}`,
          risk: mergePolicy.risk,
          policyRuleId: mergePolicy.ruleId,
          metadata: routesToDispatcher ? { 'Surface reasons': surfaceReasons.join(' | ') } : undefined,
          note: routesToDispatcher
            ? 'Review-worthy merge routed to the packet dispatcher.'
            : `Approval required: ${mergePolicy.reason}`,
        });
      }

      if (dispatcherApprovalSatisfied) {
        console.log(`[surface-approval] Dispatcher explicitly approved merge for lane ${lane.id}.`);
      }

      if (mergePolicy.ruleId === 'auto_approve_orchestrator_review') {
        console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (merge)`);
      }

      try { assertSessionMergeAllowed(lane.packetId); }
      catch (error) { return { ok: false, laneId: lane.id, note: error instanceof Error ? error.message : 'Session restriction unavailable; merge held.' }; }

      // #3740 — a held mission merges only by the operator's hand. Checked after
      // every other gate, so the card means "ready to merge, held by the mission".
      if (actor !== 'user' && isPacketMergeHeld(lane.packetId)) {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: 'Merge held by mission',
          description: `This packet's mission was created with merges held. Approve to merge "${lane.label}" (${lane.branch} → ${lane.baseBranch}), or leave it held.`,
          summary: `Merge held: ${lane.branch} → ${lane.baseBranch}`,
          risk: 'medium',
          policyRuleId: MERGE_HOLD_POLICY_RULE_ID,
          note: 'Merge held: the mission was created with merges held, so the operator decides. An approval card is waiting.',
        });
      }

      if (isRemoteCustomerLane) {
        setLaneStatus(command.laneId, 'merging', actor, 'merging');
        return performRemoteCustomerMerge(lane, command, actor);
      }

      const worktreePath = lane.worktreePath;
      if (!worktreePath) {
        return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
      }

      if (!(await worktreeExistsOnDisk(worktreePath))) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Worktree not found on disk: ${worktreePath}`,
        };
      }

      return performWorktreeSideMerge({
        lane,
        command,
        actor,
        gateResult: {
          passed: gateResult.passed,
          violations: gateResult.violations,
          diffBase: gateResult.diffBase,
        },
        createLaneActionApproval,
      });
    }

    case 'complete': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      if (isProtectedBranch(lane.baseBranch) && lane.worktreePath) {
        // Protected target — require PR instead of direct complete
        setLaneStatus(command.laneId, 'reviewing', actor, 'review_required');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: 'Protected branch. Use create_pr or merge to complete.', lane: updated ?? undefined };
      }

      const updated = setLaneStatus(command.laneId, 'completed', actor, 'completed');
      return { ok: true, laneId: command.laneId, note: 'Lane completed.', lane: updated ?? undefined };
    }

    case 'archive': {
      const lane = getLane(command.laneId);
      if (lane?.packetId && lane.worktreePath && lane.ownership === 'managed') {
        await import('./retire-finished-worktree').then(({ retireFinishedWorktree }) => retireFinishedWorktree(lane));
      }
      const updated = archiveLane(command.laneId, actor, command.outcome ? {
        outcome: command.outcome,
        outcomeNote: command.outcomeNote,
      } : undefined);
      if (!updated) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      return { ok: true, laneId: command.laneId, note: 'Lane archived.', lane: updated };
    }

    default: {
      const _exhaustive: never = command;
      return { ok: false, laneId: '', note: `Unknown verb: ${(_exhaustive as LaneCommand).verb}` };
    }
  }
}
