import { recordProductMilestone } from '@/lib/analytics/activation';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isOwnedOrchestratorSessionKey, ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { summarizeTaskName } from '@/lib/runtime/project-launch-brief';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { confirmDiscoveredInterrupt } from '@/lib/runtime/confirmed-interrupt';
import { archiveOwnedRuntimeSession } from '@/lib/runtime/owned-session-archive';
import { linkSessionToWorktree } from '@/lib/worktree';
import { WorktreeManager } from '@/lib/worktree/manager';
import type { AgentRuntime, RuntimeActionResult } from '@/lib/runtimes/types';
import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '@/lib/runtime/actions';
import { assertOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';

/** A provider session exists, but its local governance registration did not settle. */
export class RuntimeLaunchPostEffectError extends Error {
  constructor(readonly result: RuntimeLaunchResult, cause?: unknown) {
    super(result.note, { cause });
    this.name = 'RuntimeLaunchPostEffectError';
  }
}

export async function settleRuntimeLaunchGovernance(input: {
  payload: RuntimeLaunchRequest;
  runtime: AgentRuntime;
  runtimeId: string;
  prompt: string;
  result: RuntimeActionResult;
  launchWorktree: Awaited<ReturnType<typeof import('@/lib/worktree').prepareLaunchWorktree>>;
  projectId: string | null;
  cwd: string;
  repoPath: string;
}): Promise<RuntimeLaunchResult> {
  const { payload, runtime, runtimeId, prompt, result, launchWorktree, projectId, cwd, repoPath } = input;
  if (!result.sessionKey) {
    if (!result.ok && result.sideEffect === 'none') {
      return {
        ok: false,
        runtime: runtimeId,
        clientMutationId: payload.clientMutationId,
        surfaceId: '',
        note: result.note || `Unable to launch ${runtimeId}.`,
        cwd,
        repoPath,
        worktree: launchWorktree?.worktree ?? null,
        laneId: payload.existingLaneId ?? null,
      };
    }
    throw new Error(result.note || `Unable to launch ${runtimeId}.`);
  }
  if (!result.ok) {
    const failedResult: RuntimeLaunchResult = {
      ok: false,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: result.note || `The ${runtimeId} launch failed after creating its session record.`,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId: payload.existingLaneId ?? null,
    };
    if (result.sideEffect === 'unknown') {
      throw new RuntimeLaunchPostEffectError(failedResult);
    }
    return failedResult;
  }

  try {
    if (launchWorktree?.worktree) {
      await linkSessionToWorktree(repoPath, launchWorktree.worktree.id, result.sessionKey);
    }
    let laneId: string | null = payload.existingLaneId ?? null;
    const laneRuntime: OrchestratorRuntime | null = ORCHESTRATOR_RUNTIMES[runtimeId as OrchestratorRuntime]
      ? runtimeId as OrchestratorRuntime
      : null;
    if (runtimeId === 'cloud' && laneRuntime) {
      try {
        const { createLane, attachSession, setLaneStatus } = await import('@/lib/lane/registry');
        assertOwnedActionGuard();
        if (!laneId) {
          const lane = createLane({
            repoPath,
            projectId,
            branch: payload.branchName?.trim() || '',
            baseBranch: payload.baseBranch?.trim() || 'main',
            runtime: laneRuntime,
            label: payload.taskName?.trim() || summarizeTaskName(prompt),
            packetId: payload.packetId,
            ownership: 'managed',
            actor: 'system',
          });
          laneId = lane.id;
        }
        const attached = attachSession(laneId, result.sessionKey, 'system');
        if (!attached || attached.sessionKey !== result.sessionKey) {
          throw new Error('The cloud lane could not be bound to its durable session.');
        }
        const running = setLaneStatus(laneId, 'running', 'system', 'cloud_job_queued');
        if (!running || running.status !== 'running') {
          throw new Error('The cloud lane could not enter its running state.');
        }
      } catch (error) {
        const cancellation = await runtime.interrupt(result.sessionKey).catch(() => null);
        throw new RuntimeLaunchPostEffectError({
          ok: false,
          runtime: runtimeId,
          clientMutationId: payload.clientMutationId,
          surfaceId: result.sessionKey,
          note: `Cloud job was enqueued but its governance lane did not settle; cancellation ${cancellation?.ok ? 'was requested' : 'could not be confirmed'}.`,
          cwd,
          repoPath,
          worktree: null,
          laneId,
        }, error);
      }
    }
    if (!laneId && launchWorktree?.worktree && laneRuntime) {
      let createdLaneId: string | null = null;
      try {
        const { createLane, attachSession } = await import('@/lib/lane/registry');
        const lane = createLane({
          repoPath,
          projectId,
          branch: launchWorktree.worktree.branch,
          baseBranch: payload.baseBranch?.trim() || 'main',
          runtime: laneRuntime,
          label: payload.taskName?.trim() || summarizeTaskName(prompt),
          ownership: 'managed',
          worktreePath: launchWorktree.worktree.path,
          actor: 'user',
        });
        createdLaneId = lane.id;
        attachSession(lane.id, result.sessionKey, 'system');
        laneId = lane.id;
      } catch (error) {
        const ownedKill = await escalateInterruptOwnedSurface(result.sessionKey);
        const fallbackKill = ownedKill ?? await confirmDiscoveredInterrupt(runtime, result.sessionKey);
        const confirmedDead = 'confirmedDead' in fallbackKill ? fallbackKill.confirmedDead : fallbackKill.confirmed;
        if (!confirmedDead) {
          throw new Error(
            `Runtime launched ${result.sessionKey}, but governance registration failed and process exit could not be confirmed. ${fallbackKill.note}`,
          );
        }
        if (isOwnedOrchestratorSessionKey(result.sessionKey)) {
          const archived = await archiveOwnedRuntimeSession(result.sessionKey);
          if (!archived?.archived) {
            throw new Error(
              `Runtime launched ${result.sessionKey} and was stopped, but its owned session could not be archived after governance registration failed. ${archived?.note ?? ''}`.trim(),
            );
          }
        }
        if (createdLaneId) {
          const { archiveLane } = await import('@/lib/lane/registry');
          archiveLane(createdLaneId, 'system');
        }
        const cleaned = await new WorktreeManager(repoPath).cleanup(launchWorktree.worktree.id, {
          force: true,
          deleteBranch: true,
        });
        if (!cleaned) {
          throw new Error(
            `Runtime launched ${result.sessionKey} and was stopped, but its worktree could not be cleaned after governance registration failed.`,
          );
        }
        return {
          ok: false,
          runtime: runtimeId,
          clientMutationId: payload.clientMutationId,
          surfaceId: result.sessionKey,
          note: `Runtime launch was rolled back because its governance lane could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          cwd,
          repoPath,
          worktree: null,
          laneId: null,
        };
      }
    }

    void recordProductMilestone('worker.first_launched');
    return {
      ok: true,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: launchWorktree?.worktree
        ? `${result.note} Worktree: ${launchWorktree.worktree.branch} at ${launchWorktree.worktree.path}.`
        : result.note,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId,
    };
  } catch (error) {
    if (error instanceof RuntimeLaunchPostEffectError) throw error;
    throw new RuntimeLaunchPostEffectError({
      ok: false,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: `Runtime ${result.sessionKey} was created, but governance registration did not settle: ${error instanceof Error ? error.message : String(error)}`,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId: payload.existingLaneId ?? null,
    }, error);
  }
}
