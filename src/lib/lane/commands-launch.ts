import { assertLaunchAttachment } from '@/lib/lane/commands-launch-admission';
import { withPreRunLaunchCancellation } from '@/lib/lane/pre-run-cancellation';
import { assertOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { emitProductEvent } from '@/lib/analytics/server';
import { getLanePolicy } from '@/lib/lane/policy';
import { appendEvent, attachSession, getLane, getLaneEvents, setLaneStatus, updateLane } from '@/lib/lane/registry';
import {
  CODEX_AUTH_RECOVERY_LANE_LABEL,
  acceptedLaunchAttachmentProvenance,
  findCurrentAuthExit,
} from '@/lib/lane/current-auth-exit';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getRuntimeCapability, listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { capturePacketCapacitySnapshot } from '@/lib/orchestrator/capacity-snapshots';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { RuntimeLaunchPostEffectError } from '@/lib/runtime/launch-governance';
import type { LaneCommand, LaneCommandResult, LaneEventActor, LaneRuntime } from '@/lib/lane/types';
import { scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';

const LAUNCH_ATTEMPT_CAP = 5;

type LaunchSessionCommand = Extract<LaneCommand, { verb: 'launch_session' }>;

function resolvedLaunchModel(command: LaunchSessionCommand, runtime: LaneRuntime): string | null {
  return command.claudeCodeModel?.trim() || command.model?.trim() || getRuntimeCapability(runtime).defaultModel?.trim() || null;
}

function recordLaunchFailure(
  lane: NonNullable<ReturnType<typeof getLane>>,
  status: 'idle' | 'failed',
  eventLabel: string,
  reason: string,
) {
  const binaryName = getRuntimeCapability(lane.runtime).binaryName;
  const resolvedBinaryPath = lane.runtime === 'cloud' ? null : scanForBinary(binaryName);
  const now = new Date().toISOString();
  return updateLane(lane.id, {
    status,
    outcomeNote: reason,
    lastEventAt: now,
    lastEventLabel: eventLabel,
  }, 'system', {
    eventLabel,
    reason,
    error: reason,
    runtime: lane.runtime,
    binaryName,
    resolvedBinaryPath,
  });
}

export async function launchSession(
  command: LaunchSessionCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  return withPreRunLaunchCancellation(command.laneId, () => launchSessionInner(command, actor));
}

async function launchSessionInner(
  command: LaunchSessionCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  assertOwnedActionGuard();
  const lane = getLane(command.laneId);
  if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
  if (!listDispatchableRuntimes({ includeExperimental: true }).includes(lane.runtime) && !(lane.runtime === 'cloud' && lane.packetId)) {
    return {
      ok: false,
      laneId: command.laneId,
      note: `Runtime "${lane.runtime}" is not dispatchable. Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}.`,
      lane,
    };
  }

  const policy = getLanePolicy(lane.branch);
  if (!policy.branchWritable && !policy.requiresApproval) {
    return { ok: false, laneId: command.laneId, note: `Branch ${lane.branch} is not writable.` };
  }

  const priorLaunchAttempts = getLaneEvents(command.laneId, 200).filter(
    (event) => event.verb === 'status_change' && event.payload?.status === 'launching',
  ).length;
  const launchAttemptCapReached = lane.status === 'launching'
    ? priorLaunchAttempts > LAUNCH_ATTEMPT_CAP
    : priorLaunchAttempts >= LAUNCH_ATTEMPT_CAP;
  if (launchAttemptCapReached) {
    const reason = `Launch failed ${priorLaunchAttempts}× — giving up. Reset the packet to retry.`;
    recordLaunchFailure(lane, 'failed', 'launch_attempts_exhausted', reason);
    try {
      updateLane(command.laneId, { sessionKey: null }, 'system');
    } catch (err) {
      console.warn(`[lane] Failed to clear session binding on exhausted lane ${command.laneId}:`, err);
    }
    return {
      ok: false,
      laneId: command.laneId,
      note: reason,
    };
  }

  const launchCwd = lane.worktreePath ?? lane.repoPath;
  if (launchCwd && !existsSync(launchCwd)) {
    const reason = `Working directory no longer exists: ${launchCwd}. Reset the packet to re-provision.`;
    recordLaunchFailure(lane, 'failed', 'launch_aborted_missing_cwd', reason);
    return {
      ok: false,
      laneId: command.laneId,
      note: reason,
    };
  }

  if (command.clientMutationId) {
    const recovered = await findOwnedLaunchByMutationId(command.clientMutationId);
    const recoveredRefusal = assertLaunchAttachment(command.laneId, recovered?.surfaceId);
    if (recoveredRefusal) await recoveredRefusal;
    if (recovered) {
      if (recovered.outcome === 'failed') {
        const reason = 'Recovered a failed owned launch from its durable session record.';
        recordLaunchFailure(lane, 'idle', 'launch_failed', reason);
        return {
          ok: false,
          laneId: command.laneId,
          note: reason,
        };
      }
      assertOwnedActionGuard();
      updateLane(command.laneId, { model: resolvedLaunchModel(command, lane.runtime) }, 'system');
      attachSession(command.laneId, recovered.surfaceId, actor);
      setLaneStatus(command.laneId, 'running', actor, 'session_launch_recovered');
      const recoveredLane = getLane(command.laneId);
      // #2498 — the start snapshot shells out per runtime (seconds); detach it
      // so the launch result never waits on it.
      if (recoveredLane && lane.runtime !== 'cloud') {
        void capturePacketCapacitySnapshot(recoveredLane, 'start').catch((err) => {
          console.warn('[capacity-snapshot] start snapshot failed for lane', command.laneId, err);
        });
      }
      return {
        ok: true,
        laneId: command.laneId,
        note: 'Recovered the owned launch after an interrupted dispatch response.',
        lane: getLane(command.laneId) ?? undefined,
      };
    }
  }

  const refreshTarget = (() => {
    if (!lane.worktreePath) return null;
    try {
      const wt = realpathSync(lane.worktreePath);
      return wt === realpathSync(lane.repoPath) ? null : wt;
    } catch {
      return null;
    }
  })();
  if (refreshTarget) {
    const [{ getWorktreeManager, WorktreeFetchUnreachableError }, fetchRecovery] = await Promise.all([
      import('@/lib/worktree'),
      import('@/lib/runtime/fetch-unreachable-recovery'),
    ]);
    const retryInSeconds = fetchRecovery.fetchUnreachableCooldownRetrySeconds(lane.repoPath, {
      packetId: lane.packetId,
      stage: 'pre_launch_fetch',
    });
    if (retryInSeconds != null) {
      const note = `Launch blocked: fetch_unreachable cooldown for ${lane.repoPath}; retry in ${retryInSeconds}s`;
      return {
        ok: false,
        laneId: command.laneId,
        note,
        reason: 'fetch_unreachable',
        lane: getLane(command.laneId) ?? undefined,
      };
    }
    if (lane.status !== 'launching') {
      setLaneStatus(command.laneId, 'launching', actor, 'launching_session');
    }
    try {
      await getWorktreeManager(lane.repoPath).rebaseOntoMain(refreshTarget, {
        baseBranch: lane.baseBranch,
        branchName: lane.branch,
      });
      assertOwnedActionGuard();
      appendEvent(command.laneId, 'worktree_refreshed', 'system', {
        packetId: lane.packetId,
        baseBranch: lane.baseBranch,
        note: `Existing worktree rebased onto current origin/${lane.baseBranch} before launch.`,
      });
      fetchRecovery.recordFetchUnreachableRecoverySuccess(lane.repoPath);
    } catch (err) {
      try { assertOwnedActionGuard(); } catch {
        return { ok: false, laneId: command.laneId, note: 'Task launch was stopped or superseded.' };
      }
      const note = err instanceof Error ? err.message : String(err);
      appendEvent(command.laneId, 'worktree_refresh_failed', 'system', {
        packetId: lane.packetId,
        baseBranch: lane.baseBranch,
        note,
      });
      if (err instanceof WorktreeFetchUnreachableError) {
        const recovery = fetchRecovery.recoverWorktreeFetchUnreachable({
          error: err,
          repoPath: lane.repoPath,
          packetId: lane.packetId,
          laneId: lane.id,
          runtime: lane.runtime,
          stage: 'pre_launch_fetch',
        });
        return {
          ok: false,
          laneId: command.laneId,
          note: recovery.note,
          reason: 'fetch_unreachable',
          lane: getLane(command.laneId) ?? undefined,
        };
      }
      const rebasing = ['rebase-merge', 'rebase-apply'].some((marker) => {
        try {
          return existsSync(join(refreshTarget, '.git', marker));
        } catch {
          return false;
        }
      });
      if (rebasing) {
        const reason = `Worktree at ${refreshTarget} is stuck mid-rebase after a failed refresh (${note}). Reset the packet to re-provision.`;
        recordLaunchFailure(lane, 'failed', 'worktree_mid_rebase', reason);
        return {
          ok: false,
          laneId: command.laneId,
          note: reason,
        };
      }
      console.warn(`[lane] pre-launch worktree refresh failed for ${command.laneId} — launching on the existing base: ${note}`);
    }
  } else if (lane.status !== 'launching') {
    setLaneStatus(command.laneId, 'launching', actor, 'launching_session');
  }

  try {
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    const result = await launchRuntimeSurface({
      runtime: lane.runtime,
      prompt: command.prompt,
      promptMemoryRevision: command.promptMemoryRevision,
      repoPath: lane.worktreePath ?? lane.repoPath,
      projectRepoPath: lane.repoPath,
      branchName: lane.branch,
      baseBranch: lane.baseBranch,
      model: command.model,
      claudeCodeModel: command.claudeCodeModel,
      claudeCodeCarrier: command.claudeCodeCarrier,
      executionCarrier: command.executionCarrier,
      effort: command.effort,
      clientMutationId: command.clientMutationId,
      isolate: !lane.worktreePath,
      skipSetup: Boolean(lane.worktreePath),
      existingLaneId: command.laneId,
      packetId: lane.packetId ?? undefined,
      spendCap: command.spendCap,
      storageAdmissionReservationId: command.storageAdmissionReservationId,
    });

    const attachmentRefusal = assertLaunchAttachment(command.laneId, result.surfaceId || undefined);
    if (attachmentRefusal) await attachmentRefusal;
    if (!result.ok) {
      recordLaunchFailure(lane, 'idle', 'launch_failed', result.note);
      return { ok: false, laneId: command.laneId, note: result.note };
    }

    const attachProvenance = acceptedLaunchAttachmentProvenance({
      lane,
      events: getLaneEvents(command.laneId, 200),
      surfaceId: result.surfaceId,
      clientMutationId: command.clientMutationId,
    });
    attachSession(command.laneId, result.surfaceId, actor, attachProvenance ?? {});
    updateLane(command.laneId, { model: resolvedLaunchModel(command, lane.runtime) }, 'system');
    if (result.worktree?.path && !lane.worktreePath) {
      updateLane(command.laneId, { worktreePath: result.worktree.path }, 'system');
    }
    const attachedLane = getLane(command.laneId);
    let authExit = attachedLane
      ? findCurrentAuthExit(attachedLane, getLaneEvents(command.laneId, 200))
      : null;
    if (authExit) {
      setLaneStatus(command.laneId, 'awaiting_input', actor, CODEX_AUTH_RECOVERY_LANE_LABEL);
    } else {
      setLaneStatus(command.laneId, 'running', actor, 'session_launched');
      const postStatusLane = getLane(command.laneId);
      authExit = postStatusLane
        ? findCurrentAuthExit(postStatusLane, getLaneEvents(command.laneId, 200))
        : null;
      if (authExit) {
        setLaneStatus(command.laneId, 'awaiting_input', actor, CODEX_AUTH_RECOVERY_LANE_LABEL);
      }
    }
    void emitProductEvent('dispatch.started', { runtime: lane.runtime });

    if (lane.runtime !== 'cloud' && !authExit) {
      const { wsPort } = resolvePortInfo();
      let watchRegistered = false;
      for (let attempt = 1; attempt <= 2 && !watchRegistered; attempt += 1) {
        try {
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({
              surfaceId: result.surfaceId,
              repoPath: lane.repoPath,
              name: lane.label || lane.branch,
              prompt: command.prompt,
              launchContext: command.launchContext,
            }),
            signal: AbortSignal.timeout(3000),
          });
          watchRegistered = true;
        } catch (regErr) {
          if (attempt === 2) {
            console.warn(`[lane] Supervisor watch registration failed for lane ${command.laneId} (${result.surfaceId}) after 2 attempts — completion will rely on the push signal + salvage nets:`, regErr);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      }
    }

    const launchedLane = getLane(command.laneId);
    // #2498 — same as the recovered path: the launch result never waits on
    // the per-runtime capacity shell-outs.
    if (launchedLane && lane.runtime !== 'cloud' && !authExit) {
      void capturePacketCapacitySnapshot(launchedLane, 'start').catch((err) => {
        console.warn('[capacity-snapshot] start snapshot failed for lane', command.laneId, err);
      });
    }
    const updated = getLane(command.laneId);
    return {
      ok: true,
      laneId: command.laneId,
      note: result.note,
      lane: updated ?? undefined,
      dependencyMaterializationMode: result.worktree?.dependencyMaterialization?.mode ?? null,
    };
  } catch (err) {
    const refusal = assertLaunchAttachment(command.laneId,
      err instanceof RuntimeLaunchPostEffectError ? err.result.surfaceId : undefined);
    if (refusal) {
      try { await refusal; } catch {
        return { ok: false, laneId: command.laneId, note: 'Task launch was stopped or superseded.' };
      }
    }
    const message = err instanceof Error ? err.message : 'Launch failed.';
    if (getLane(command.laneId)?.status === 'launching') {
      recordLaunchFailure(lane, 'idle', 'launch_error', message);
    }
    return { ok: false, laneId: command.laneId, note: message };
  }
}
