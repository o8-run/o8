import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import type { ThinkingEffort } from './thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { WorkerRouting, WorkerLaunchContext } from '@/lib/orchestrator/types';

import { SharedCheckoutError, failSharedCheckoutMember, recordSharedCheckoutMember, reserveSharedCheckoutMember, validateSharedCheckoutPaths } from './shared-checkout-team';
import { captureSharedWorkerOrigin } from './shared-worker-origin';
import { registerSharedWorkerParent } from './shared-worker-returns';

export async function launchSharedCheckoutWorker(input: {
  repoPath: string;
  parentThreadId: string;
  prompt: string;
  taskName: string;
  runtime: OrchestratorRuntime;
  instanceId?: string;
  model: string | null;
  effort?: ThinkingEffort | null;
  carrier?: ClaudeCodeModelSource | null;
  executionCarrier?: ExecutionCarrierId | null;
  workerRouting?: WorkerRouting;
  readOnly: boolean;
  clientMutationId: string;
  repoInProject: boolean;
  assignedPaths: string[];
}) {
  const assignedPaths = validateSharedCheckoutPaths(input.assignedPaths);
  const origin = captureSharedWorkerOrigin(input.repoPath, input.parentThreadId);
  const team = await reserveSharedCheckoutMember({ ...input, runtime: input.runtime, paths: assignedPaths });
  const launchContext: WorkerLaunchContext = {
    source: 'agent',
    presentation: 'split',
    repoContext: input.repoInProject ? 'registered' : 'transient',
    workMode: input.readOnly ? 'read-only' : 'edit',
    caller: 'orchestrator',
    parentThreadId: input.parentThreadId,
    checkoutMode: 'shared',
  };
  const contract = input.readOnly
    ? 'Shared checkout worker. Read only. Do not modify files, commit, switch branches, reset, or clean the checkout.'
    : `Shared checkout worker on branch ${team.branch}. Other agents edit this same directory concurrently. `
      + `Edit only these assigned paths: ${assignedPaths.join(', ')}. Coordinate any scope change with the orchestrator. `
      + 'Do not commit, switch branches, reset, clean, stash, or delete files. '
      + 'Report changed paths and verification to the orchestrator. The orchestrator owns group review and the single final commit.';
  let result;
  try {
    const recovered = await findOwnedLaunchByMutationId(input.clientMutationId);
    if (recovered && recovered.cwd !== team.path) {
      throw new SharedCheckoutError('Worker mutation already belongs to another checkout.');
    }
    result = recovered ? {
      ok: recovered.outcome !== 'failed',
      surfaceId: recovered.surfaceId,
      note: 'Recovered the owned worker launch from its durable session record.',
    } : await launchRuntimeSurface({
      runtime: input.runtime,
      instanceId: input.instanceId,
      prompt: `${contract}\n\n${input.prompt}`,
      repoPath: team.path,
      projectRepoPath: team.path,
      taskName: input.taskName,
      model: input.model ?? undefined,
      effort: input.effort ?? undefined,
      executionCarrier: input.executionCarrier ?? undefined,
      ...(input.carrier ? { claudeCodeCarrier: input.carrier, claudeCodeModel: input.model ?? undefined } : {}),
      clientMutationId: input.clientMutationId,
      isolate: false,
      skipSetup: true,
      workMode: input.readOnly ? 'read-only' : 'edit',
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'RuntimeLaunchPostEffectError'
      || !('result' in error) || typeof error.result !== 'object' || error.result === null) {
      await failSharedCheckoutMember(input);
      throw error;
    }
    result = error.result as Awaited<ReturnType<typeof launchRuntimeSurface>>;
  }
  if (!result.ok || !result.surfaceId) {
    if (result.surfaceId) {
      await recordSharedCheckoutMember({ ...input, parentTurnId: origin?.turnId, surfaceId: result.surfaceId, runtime: input.runtime, taskName: input.taskName });
      if (origin) registerSharedWorkerParent({ repoPath: input.repoPath, surfaceId: result.surfaceId, origin });
    }
    await failSharedCheckoutMember(input);
    return { ok: false as const, error: result.note, teamId: team.id, surfaceId: result.surfaceId ?? null };
  }
  await recordSharedCheckoutMember({
    ...input,
    parentTurnId: origin?.turnId,
    surfaceId: result.surfaceId,
    runtime: input.runtime,
    taskName: input.taskName,
  });
  if (origin) registerSharedWorkerParent({ repoPath: input.repoPath, surfaceId: result.surfaceId, origin });
  try {
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({
        surfaceId: result.surfaceId,
        repoPath: input.repoPath,
        name: input.taskName,
        prompt: input.prompt,
        launchContext,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Supervisor watch returned ${response.status}.`);
  } catch (error) {
    console.warn('[shared-checkout] Supervisor watch registration failed:', error);
  }
  return {
    ok: true as const,
    teamId: team.id,
    laneId: null,
    packetId: null,
    surfaceId: result.surfaceId,
    branch: team.branch,
    worktreePath: team.path,
    checkoutMode: 'shared' as const,
    launchContext,
    note: `Worker joined orchestrator-owned shared checkout ${team.branch}.`,
  };
}
