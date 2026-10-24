import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';
import { assertReviewerPrCheckout } from '@/lib/orchestrator/reviewer-pr-source';
import { assertPreRunAdmission, retireCancelledPreRunWorktree } from '@/lib/lane/pre-run-cancellation';
import { AutomaticRecoveryRefusedError, withAutomaticRecoveryRequest, withOwnedAutomaticRecovery } from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import type { AgentSummary } from '@/lib/fleet/types';
import { recordLaneEvent } from '@/lib/lane/events';
import { listLanes, updateLane } from '@/lib/lane/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { OrchestratorRuntime, WorkerWorkMode } from '@/lib/orchestrator/types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import {
  listDeclarativeRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';
import { continueOwnedCodexSession, setOwnedCodexReviewDisposition } from '@/lib/codex/owned';
import { markRepoOriginMissing } from '@/lib/repos/origin-readiness';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime, type RuntimeId } from '@/lib/runtimes';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { performOwnedActionWithoutInventory } from '@/lib/runtime/owned-actions';
import { resolveLaunchWorkMode } from '@/lib/runtime/launch-work-mode';
import { packetRequiresWorktree, packetWorktreeProvisionError } from '@/lib/runtime/packet-worktree-guard';
import { buildLaunchPromptWithProjectBrief, summarizeTaskName } from '@/lib/runtime/project-launch-brief';
import {
  fetchUnreachableCooldownRetrySeconds,
  recordFetchUnreachableRecoverySuccess,
  recoverWorktreeFetchUnreachable,
} from '@/lib/runtime/fetch-unreachable-recovery';
import {
  prepareLaunchWorktree,
  DependencyMaterializationIncompleteError,
  WorktreeFetchUnreachableError,
  WorktreeOriginMissingError,
  WorktreeRebaseConflictError,
} from '@/lib/worktree';
import type { WorktreeInfo } from '@/lib/worktree/types';
import { confirmDiscoveredInterrupt } from '@/lib/runtime/confirmed-interrupt';
import { settleRuntimeLaunchGovernance } from '@/lib/runtime/launch-governance';
import { holdPendingOwnedCorrections } from '@/lib/runtimes/shared/owned-session/action-admission';
import { assertSingleAttemptLaunch } from '@/lib/runtime/single-attempt-launch';

export type RuntimeActionKind = 'steer' | 'stop' | 'send_input' | 'interrupt' | 'watch' | 'resolve' | 'launch';

export interface RuntimeActionRequest {
  /** Restricts automated steering to this uninterrupted owned run. */
  automaticRecoveryRunId?: string;
  action: RuntimeActionKind;
  surfaceId: string;
  clientMutationId?: string;
  message?: string;
  runId?: string;
  cwd?: string;
  attachments?: Array<{
    type?: string;
    mimeType: string;
    fileName: string;
    content: string;
  }>;
  auditSteer?: boolean;
  steerSource?: 'operator' | 'orchestrator' | 'heal-bot';
}

export interface RuntimeActionResult {
  ok: boolean;
  action: RuntimeActionKind;
  surfaceId: string;
  sessionKey?: string;
  runtime: string;
  clientMutationId?: string;
  status: 'queued' | 'completed' | 'unavailable';
  note: string;
  retryable?: boolean;
  reason?: 'surface_not_ready';
  runId?: string;
  aborted?: boolean;
  /** An idempotent duplicate found the original mutation still executing. */
  inProgress?: boolean;
}

export interface RuntimeLaunchRequest {
  controlledTask?: import('@/lib/mcp/task-execution-store').ControlledTaskBinding;
  executionPolicy?: 'single-attempt';
  controlledProvider?: import('@/lib/runtimes/shared/owned-session/controlled-provider').ControlledOpenRouterPolicy;
  automaticRecoverySurfaceId?: string;
  automaticRecoveryRunId?: string;
  runtime: RuntimeId;
  prompt: string;
  model?: string;
  claudeCodeModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
  executionCarrier?: ExecutionCarrierId;
  /** Requested reasoning effort — passed to the runtime's launch; per-runtime no-op. */
  effort?: ThinkingEffort;
  clientMutationId?: string;
  cwd?: string;
  repoPath?: string;
  /** Canonical repo root for project context when cwd/repoPath points at an isolated worktree. */
  projectRepoPath?: string;
  taskName?: string;
  /**
   * Pre-assigned lane branch the worktree must check out before the agent
   * spawns. Without this, prepareLaunchWorktree falls back to the legacy
   * `worktree/<agent>/<slug>` placeholder branch and the agent has to
   * self-correct via `git checkout -b <lane.branch>`. Weaker models miss
   * the prompt hint and silently commit on the wrong branch — the lane
   * merge then sees an empty diff. Dispatch passes `lane.branch` here.
   */
  branchName?: string;
  baseBranch?: string;
  isolate?: boolean;
  isolation?: 'main' | 'branch';
  skipSetup?: boolean;
  // When set, the caller already owns a lane for this launch (eg. packet
  // dispatch going through the lane command bus). launchRuntimeSurface will
  // skip its implicit lane creation and leave binding to the caller.
  existingLaneId?: string;
  // When the launch is bound to a packet, include its id so supervisor inbox
  // items surfaced during pre-launch (eg. rebase conflicts) can deep-link
  // back to the packet card. Leave undefined for scratch runs that aren't
  // tied to a packet. Also drives the worktree directory naming (one slot
  // per packet, instead of a shared taskName-derived slot).
  packetId?: string;
  spendCap?: PacketSpendCap;
  /**
   * Optional caller hint. The durable packet launch context wins when it is
   * stricter, so a caller can never widen a read-only packet by omitting it.
   */
  workMode?: WorkerWorkMode;
  /** Scheduler-owned storage reservation reused by the managed-worktree boundary. */
  storageAdmissionReservationId?: string;
}

export { resolveLaunchWorkMode, type LaunchWorkModeResolution } from './launch-work-mode';

export interface RuntimeLaunchResult {
  ok: boolean;
  outcomeUnknown?: boolean;
  retryable?: boolean;
  runtime: RuntimeId;
  clientMutationId?: string;
  surfaceId: string;
  note: string;
  cwd: string;
  repoPath: string;
  worktree: WorktreeInfo | null;
  laneId: string | null;
}

const loggedOriginMissingRepos = new Set<string>();

function auditRuntimeSteer(payload: RuntimeActionRequest, sessionKey: string): void {
  if (payload.auditSteer === false || (payload.action !== 'steer' && payload.action !== 'send_input')) return;
  const message = payload.message?.trim();
  if (!message) return;
  try {
    const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey && candidate.packetId);
    if (!lane?.packetId) return;
    recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId: lane.packetId,
      source: payload.steerSource ?? 'operator',
      message,
    });
  } catch {
    // Runtime action delivery should not fail because lane audit storage is temporarily unavailable.
  }
}

export async function launchRuntimeSurface(payload: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
  assertNotKnowledgeSource(payload.repoPath); assertNotKnowledgeSource(payload.cwd);
  if (payload.automaticRecoverySurfaceId || payload.automaticRecoveryRunId) {
    if (!payload.automaticRecoverySurfaceId?.startsWith(`${payload.runtime}-owned:`) || !payload.automaticRecoveryRunId) {
      throw new Error('Automatic retry requires the original owned runtime and generation.');
    }
    try {
      return await withOwnedAutomaticRecovery(payload.automaticRecoverySurfaceId, payload.automaticRecoveryRunId,
        () => launchRuntimeSurfaceInner(payload));
    } catch (error) {
      if (!(error instanceof AutomaticRecoveryRefusedError)) throw error;
      return { ok: false, runtime: payload.runtime, surfaceId: '', note: error.message,
        clientMutationId: payload.clientMutationId, cwd: payload.cwd ?? '', repoPath: payload.repoPath ?? payload.cwd ?? '',
        worktree: null, laneId: payload.existingLaneId ?? null };
    }
  }
  return launchRuntimeSurfaceInner(payload);
}

async function launchRuntimeSurfaceInner(payload: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
  const runtimeId = payload.runtime;
  const prompt = payload.prompt?.trim();
  const repoPath = payload.repoPath?.trim() || payload.cwd?.trim();

  if (!runtimeId) {
    throw new Error('runtime is required');
  }
  if (!prompt) {
    throw new Error('prompt is required');
  }
  if (!repoPath) {
    throw new Error('repoPath or cwd is required');
  }

  const runtime = getRuntime(runtimeId);
  if (!runtime) {
    throw new Error(`Runtime ${runtimeId} is not registered.`);
  }
  if (!runtime.capabilities.launch) {
    throw new Error(`Runtime ${runtimeId} does not support launch.`);
  }

  // Resolve the durable work mode BEFORE any side effect (worktree provisioning,
  // lane mutation). A refusal here must cost nothing and leave nothing behind.
  const workModeResolution = resolveLaunchWorkMode(payload);
  if (!workModeResolution.ok) {
    console.error(`[runtime-launch] ${workModeResolution.reason}`);
    return {
      ok: false,
      retryable: workModeResolution.retryable,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: '',
      note: workModeResolution.reason,
      cwd: payload.cwd?.trim() || repoPath,
      repoPath,
      worktree: null,
      laneId: payload.existingLaneId ?? null,
    };
  }

  assertSingleAttemptLaunch(payload, workModeResolution.workMode);
  if (payload.controlledTask && (payload.executionPolicy !== 'single-attempt' || payload.isolate !== false
    || payload.skipSetup !== true || payload.automaticRecoverySurfaceId || payload.automaticRecoveryRunId)) {
    throw new Error('Controlled task launch requires its pre-admitted isolated workspace and no recovery.');
  }
  const { prompt: launchPrompt, projectContext } = await buildLaunchPromptWithProjectBrief(payload, prompt, repoPath);
  const remoteManagedWorktree = runtimeId === 'cloud';
  const supportsWorktrees = remoteManagedWorktree || ['codex', 'claude-code', 'gemini', 'opencode', 'pi', 'pi-builtin', 'hermes', 'deepseek-harness', 'muse'].includes(runtimeId)
    || listDeclarativeRuntimes().includes(runtimeId as OrchestratorRuntime);
  const packetNeedsWorktree = packetRequiresWorktree(payload);

  // Scratch launches may degrade to a plain folder; packet launches fail closed.
  const { existsSync: launchDirHasGit } = await import('node:fs');
  const { join: joinLaunchPath } = await import('node:path');
  const repoIsGit = launchDirHasGit(joinLaunchPath(repoPath, '.git'));
  if (packetNeedsWorktree && !supportsWorktrees) {
    const note = `Runtime ${runtimeId} has no managed worktree integration.`;
    throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
  }
  if (packetNeedsWorktree && !repoIsGit) {
    const note = `${repoPath} is not a git repository.`;
    throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
  }
  if (!repoIsGit) {
    console.warn(`[runtime-launch] ${repoPath} is not a git repository — launching ${runtimeId} directly in the folder (no isolation, no branch)`);
  }

  // Dispatch can force isolation while still skipping environment setup.
  const shouldCreateWorktree = !remoteManagedWorktree && supportsWorktrees && repoIsGit && (payload.isolate || !payload.skipSetup);
  if (shouldCreateWorktree) {
    const retryInSeconds = fetchUnreachableCooldownRetrySeconds(repoPath, {
      packetId: payload.packetId ?? null,
      stage: 'pre_launch_fetch',
    });
    if (retryInSeconds != null) {
      const note = `Launch blocked: fetch_unreachable cooldown for ${repoPath}; retry in ${retryInSeconds}s`;
      throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
    }
  }
  const repoEntry = shouldCreateWorktree
    ? await import('@/lib/repos/registry').then((m) => m.findRepoByLocalPath(repoPath)).catch(() => null)
    : null;
  let launchWorktree: Awaited<ReturnType<typeof prepareLaunchWorktree>> = null;
  if (shouldCreateWorktree) {
    try {
      launchWorktree = await prepareLaunchWorktree({
        repoRoot: repoPath,
        agentType: runtimeId,
        taskName: payload.taskName?.trim() || summarizeTaskName(prompt),
        branchName: payload.branchName?.trim() || undefined,
        baseBranch: payload.baseBranch?.trim() || undefined,
        isolate: payload.isolate,
        skipSetup: payload.skipSetup,
        envMode: repoEntry?.setup.envMode,
        envFiles: repoEntry?.setup.envFiles,
        repoSetup: repoEntry?.setup,
        isolationPreference: repoEntry?.setup.workspaceIsolationPreference,
        packetId: payload.packetId,
        laneId: payload.existingLaneId,
        storageAdmissionReservationId: payload.storageAdmissionReservationId,
      });
      const cancelled = retireCancelledPreRunWorktree(repoPath, launchWorktree?.worktree);
      if (cancelled) await cancelled;
      if (launchWorktree?.worktree) {
        recordFetchUnreachableRecoverySuccess(repoPath);
      }
    } catch (err) {
      assertPreRunAdmission();
      if (err instanceof DependencyMaterializationIncompleteError) throw err;
      // Known failures keep their existing operator-facing escalation details.
      if (err instanceof WorktreeRebaseConflictError) {
        const baseBranchForInbox = err.baseBranch;
        const conflictFiles = err.conflictFiles;
        const conflictBranch = err.branch;

        if (payload.existingLaneId) {
          try {
            const { setLaneStatus } = await import('@/lib/lane/registry');
            setLaneStatus(payload.existingLaneId, 'awaiting_input', 'system', 'rebase_conflict');
          } catch (laneErr) {
            console.warn(
              `[worktree-rebase] Failed to mark lane ${payload.existingLaneId} as awaiting_input: ${laneErr instanceof Error ? laneErr.message : laneErr}`,
            );
          }
        } else {
          // Scratch launches have no lane — log explicitly so the trail is
          // obvious. The supervisor inbox row (below) + thrown error (further
          // down) are the only surfaces operators will see.
          console.warn(
            `[worktree-rebase] Scratch ${runtimeId} launch blocked by rebase conflict onto origin/${baseBranchForInbox} (no lane to mark, branch ${conflictBranch}).`,
          );
        }

        try {
          const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
          enqueueInboxItem({
            repoPath,
            packetId: payload.packetId ?? null,
            kind: 'merge_blocked',
            payload: {
              stage: 'pre_launch_rebase',
              baseBranch: baseBranchForInbox,
              branch: conflictBranch,
              conflictFiles,
              laneId: payload.existingLaneId ?? null,
              packetId: payload.packetId ?? null,
              runtime: runtimeId,
              errorMessage: err.message,
              errorExcerpt: conflictFiles.length > 0
                ? `Rebase onto origin/${baseBranchForInbox} failed. ${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}: ${conflictFiles.slice(0, 5).join(', ')}${conflictFiles.length > 5 ? '…' : ''}`
                : `Rebase onto origin/${baseBranchForInbox} failed. ${err.message}`,
            },
            status: 'human_required',
          });
        } catch (inboxErr) {
          console.warn(
            `[worktree-rebase] Failed to enqueue supervisor inbox item: ${inboxErr instanceof Error ? inboxErr.message : inboxErr}`,
          );
        }

        const note = `Rebase onto origin/${baseBranchForInbox} failed before launching ${runtimeId}. Resolve the conflict manually and retry.${conflictFiles.length > 0 ? ` Conflicting files: ${conflictFiles.join(', ')}` : ''}`;
        throw packetWorktreeProvisionError(payload, runtimeId, repoPath, err, note, 'awaiting_input');
      }

      if (err instanceof WorktreeOriginMissingError) {
        markRepoOriginMissing(repoPath);
        if (!loggedOriginMissingRepos.has(repoPath)) {
          loggedOriginMissingRepos.add(repoPath);
          console.warn(`[supervisor-inbox] Repo ${repoPath} has no origin remote; skipping inbox escalation.`);
        }
        const note = `Cannot launch ${runtimeId}: origin remote is not configured for ${repoPath}. Configure origin and retry.`;
        throw packetWorktreeProvisionError(payload, runtimeId, repoPath, err, note);
      }

      // Fetch failures preserve the existing inbox escalation.
      if (err instanceof WorktreeFetchUnreachableError) {
        const recovery = recoverWorktreeFetchUnreachable({
          error: err,
          repoPath,
          packetId: payload.packetId ?? null,
          laneId: payload.existingLaneId ?? null,
          runtime: runtimeId,
          stage: 'pre_launch_fetch',
        });
        throw packetWorktreeProvisionError(payload, runtimeId, repoPath, err, recovery.note, 'awaiting_input');
      }

      const note = err instanceof Error ? err.message : String(err);
      throw packetWorktreeProvisionError(payload, runtimeId, repoPath, err, note);
    }
  }
  if (packetNeedsWorktree && !remoteManagedWorktree && !launchWorktree?.worktree) {
    const note = 'Managed worktree preparation returned no worktree.';
    throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
  }

  const cwd = launchWorktree?.cwd ?? repoPath;
  if (remoteManagedWorktree && payload.existingLaneId) {
    const lane = listLanes().find((candidate) => candidate.id === payload.existingLaneId);
    if (!lane
      || lane.packetId !== payload.packetId
      || lane.runtime !== 'cloud'
      || lane.status !== 'launching'
      || lane.sessionKey !== null
      || lane.repoPath !== repoPath
      || lane.branch !== payload.branchName) {
      const note = 'Remote execution requires an exact unbound cloud lane for this packet and branch.';
      return {
        ok: false,
        runtime: runtimeId,
        clientMutationId: payload.clientMutationId,
        surfaceId: '',
        note,
        cwd,
        repoPath,
        worktree: null,
        laneId: payload.existingLaneId,
      };
    }
  }
  if (packetNeedsWorktree && payload.existingLaneId && payload.packetId && launchWorktree?.worktree) {
    const lane = listLanes().find((candidate) => candidate.id === payload.existingLaneId);
    if (!lane
      || lane.packetId !== payload.packetId
      || lane.status !== 'launching'
      || lane.sessionKey !== null
      || lane.repoPath !== repoPath
      || lane.branch !== payload.branchName
      || (lane.worktreePath !== null && lane.worktreePath !== cwd)) {
      const note = 'Managed worktree was prepared without an exact unbound pre-launch lane.';
      throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
    }
    if (!updateLane(lane.id, { worktreePath: cwd }, 'system')) {
      const note = 'Managed replacement worktree could not be bound before launch.';
      throw packetWorktreeProvisionError(payload, runtimeId, repoPath, note, note);
    }
  }
  await assertReviewerPrCheckout(payload.packetId, cwd);
  assertPreRunAdmission();
  const result = await runtime.launch({
    cwd,
    sourceRepoPath: repoPath,
    branchName: payload.branchName,
    baseBranch: payload.baseBranch,
    prompt: launchPrompt,
    taskName: payload.taskName,
    clientMutationId: payload.clientMutationId,
    model: payload.model,
    claudeCodeModel: payload.claudeCodeModel,
    claudeCodeCarrier: payload.claudeCodeCarrier,
    executionCarrier: payload.executionCarrier,
    effort: payload.effort,
    worktreeFlag: launchWorktree?.claudeWorktreeFlag,
    worktreePath: launchWorktree?.worktree?.path,
    laneId: payload.existingLaneId ?? undefined,
    packetId: payload.packetId,
    spendCap: payload.spendCap,
    workMode: workModeResolution.workMode,
    executionPolicy: payload.executionPolicy,
    controlledTask: payload.controlledTask,
    controlledProvider: payload.controlledProvider,
  });

  return settleRuntimeLaunchGovernance({
    payload,
    runtime,
    runtimeId,
    prompt,
    result,
    launchWorktree,
    projectId: projectContext?.id ?? null,
    cwd,
    repoPath,
  });
}

function findRuntimeAgent(snapshot: Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>, surfaceId: string) {
  return snapshot.agents.find(
    (agent) => agent.sessionKey === surfaceId || agent.runtimeSurface?.id === surfaceId || agent.id === surfaceId,
  );
}

function unavailable(
  agent: AgentSummary,
  action: RuntimeActionKind,
  note: string,
  clientMutationId?: string,
  options: Pick<RuntimeActionResult, 'retryable' | 'reason'> = {},
): RuntimeActionResult {
  return {
    ok: false,
    action,
    surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
    runtime: agent.runtime,
    clientMutationId,
    status: 'unavailable',
    note,
    ...options,
  };
}

function ownedCodexSurfaceNotReady(
  agent: AgentSummary,
  action: RuntimeActionKind,
  clientMutationId?: string,
): RuntimeActionResult {
  return unavailable(
    agent,
    action,
    'This worker is still finishing its current turn. The message can be delivered when it is ready.',
    clientMutationId,
    { retryable: true, reason: 'surface_not_ready' },
  );
}

function isOwnedCodexSurfaceNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /still has an active run|does not have a thread id yet/i.test(message);
}

function actionUnavailable(
  payload: RuntimeActionRequest,
  surfaceId: string,
  runtime: string,
  note: string,
): RuntimeActionResult {
  return {
    ok: false,
    action: payload.action,
    surfaceId,
    runtime,
    clientMutationId: payload.clientMutationId,
    status: 'unavailable',
    note,
  };
}

export async function performRuntimeAction(payload: RuntimeActionRequest): Promise<RuntimeActionResult> {
  if (payload.automaticRecoveryRunId !== undefined) {
    if ((payload.action !== 'steer' && payload.action !== 'send_input') || !payload.automaticRecoveryRunId.trim()) {
      return actionUnavailable(payload, payload.surfaceId, '', 'Invalid automatic recovery action or generation.');
    }
    try {
      return await withAutomaticRecoveryRequest(payload.surfaceId, payload.automaticRecoveryRunId,
        () => performRuntimeActionInner(payload));
    } catch (error) {
      if (!(error instanceof AutomaticRecoveryRefusedError)) throw error;
      return actionUnavailable(payload, payload.surfaceId, '', error.message);
    }
  }
  return performRuntimeActionInner(payload);
}

async function performRuntimeActionInner(payload: RuntimeActionRequest): Promise<RuntimeActionResult> {
  const surfaceId = payload.surfaceId?.trim();
  // Fix #3: return structured error instead of throwing across the API boundary (CLAUDE.md rule)
  if (!surfaceId) {
    return actionUnavailable(payload, '', '', 'surfaceId is required');
  }

  if (payload.action === 'stop' || payload.action === 'interrupt') holdPendingOwnedCorrections(surfaceId);

  // Try cached snapshot first to avoid expensive full re-discovery on every action.
  // Only fall back to a fresh fetch if the agent isn't in cache (e.g. just spawned).
  const cached = await getRuntimeInventorySnapshot();
  let agent = findRuntimeAgent(cached, surfaceId);
  if (!agent) {
    const fresh = await getRuntimeInventorySnapshot({ fresh: true });
    agent = findRuntimeAgent(fresh, surfaceId);
  }
  if (!agent) {
    const ownedResult = await performOwnedActionWithoutInventory(payload, surfaceId);
    if (ownedResult) return ownedResult;
    // Fix #3: return structured error instead of throwing across the API boundary
    return actionUnavailable(payload, surfaceId, '', 'Runtime surface not found.');
  }

  const isOwnedCodexSteer = agent.runtime === 'codex'
    && agent.runtimeSurface?.ownership === 'owned'
    && (payload.action === 'steer' || payload.action === 'send_input');
  if (isOwnedCodexSteer) {
    const fresh = await getRuntimeInventorySnapshot({ fresh: true });
    agent = findRuntimeAgent(fresh, surfaceId) ?? agent;
  }

  const runtimeSurface = agent.runtimeSurface;
  if (!runtimeSurface) {
    return actionUnavailable(payload, agent.sessionKey, agent.runtime, 'Runtime surface metadata is unavailable.');
  }
  if (!isOwnedCodexSteer) {
    auditRuntimeSteer(payload, agent.sessionKey);
  }

  switch (agent.runtime) {
    case 'codex': {
      if (runtimeSurface.ownership !== 'owned') {
        const runtime = getRuntime('codex');
        if (!runtime) {
          return unavailable(agent, payload.action, 'Codex runtime is not registered.');
        }

        if (payload.action === 'steer' || payload.action === 'send_input') {
          const message = payload.message?.trim();
          if (!message) {
            return unavailable(agent, payload.action, 'message is required to steer a Codex session', payload.clientMutationId);
          }
          const result = await runtime.resume(agent.sessionKey, message);
          return {
            ok: result.ok,
            action: payload.action,
            surfaceId: runtimeSurface.id,
            sessionKey: result.sessionKey ?? agent.sessionKey,
            runtime: agent.runtime,
            clientMutationId: payload.clientMutationId,
            status: result.ok ? 'queued' : 'unavailable',
            note: result.note,
          };
        }

        if (payload.action === 'stop' || payload.action === 'interrupt') {
          if (!runtimeSurface.capabilities.interrupt) {
            return unavailable(
              agent,
              payload.action,
              'No live Codex process is attached to this discovered session, so there is nothing to interrupt.',
            );
          }
          const result = await confirmDiscoveredInterrupt(runtime, agent.sessionKey);
          return {
            ok: result.confirmed,
            action: payload.action,
            surfaceId: runtimeSurface.id,
            runtime: agent.runtime,
            clientMutationId: payload.clientMutationId,
            status: result.confirmed ? 'completed' : 'unavailable',
            note: result.note,
            aborted: result.confirmed,
          };
        }

        return unavailable(
          agent,
          payload.action,
          'This Codex surface was discovered from a local terminal. Only steer and interrupt are supported while the live pid is still attached.',
        );
      }

      if (payload.action === 'steer' || payload.action === 'send_input') {
        const message = payload.message?.trim();
        if (!message) {
          return unavailable(agent, payload.action, 'message is required to resume an owned Codex session', payload.clientMutationId);
        }
        // Inventory can lag a confirmed Stop. The owned store rechecks the
        // durable run and process under its lock; cached capabilities are not admission.
        let result: Awaited<ReturnType<typeof continueOwnedCodexSession>>;
        try {
          result = await continueOwnedCodexSession(runtimeSurface.id, message);
        } catch (error) {
          if (isOwnedCodexSurfaceNotReadyError(error)) {
            return ownedCodexSurfaceNotReady(agent, payload.action, payload.clientMutationId);
          }
          throw error;
        }
        if (result.ok) {
          auditRuntimeSteer(payload, agent.sessionKey);
        }
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          sessionKey: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.ok ? 'queued' : 'unavailable',
          note: result.note,
        };
      }

      if (payload.action === 'stop' || payload.action === 'interrupt') {
        if (!runtimeSurface.capabilities.interrupt) {
          return unavailable(
            agent,
            payload.action,
            'No active IDE-owned Codex run is currently in flight, so there is nothing to interrupt.',
          );
        }
        const result = await escalateInterruptOwnedSurface(runtimeSurface.id);
        if (!result) {
          return unavailable(agent, payload.action, 'Owned Codex interrupt target could not be resolved.');
        }
        return {
          ok: result.confirmedDead,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.confirmedDead ? 'completed' : 'unavailable',
          note: result.note,
          aborted: result.confirmedDead,
        };
      }

      if (payload.action === 'watch' || payload.action === 'resolve') {
        const result = await setOwnedCodexReviewDisposition(
          runtimeSurface.id,
          payload.action === 'resolve' ? 'resolved' : 'watching',
        );
        return {
          ok: true,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'completed',
          note: result.note,
        };
      }

      return unavailable(
        agent,
        payload.action,
        'This IDE-owned Codex surface supports launch/resume/interrupt and review-state disposition changes only in the bounded owned-session lane for now.',
      );
    }
    default: {
      // Registry-based dispatch for all other runtimes (claude-code, aider, etc.)
      const runtime = getRuntime(agent.runtime);
      if (!runtime) {
        return unavailable(agent, payload.action, `Runtime action ${payload.action} is not supported for ${agent.runtime}.`);
      }

      if (payload.action === 'steer' || payload.action === 'send_input') {
        const message = payload.message?.trim();
        if (!message) return unavailable(agent, payload.action, 'message is required', payload.clientMutationId);
        if (!runtime.capabilities.resume) {
          return unavailable(agent, payload.action, `${agent.runtime} does not support resume/steer.`);
        }
        const result = await runtime.resume(agent.sessionKey, message);
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          sessionKey: result.sessionKey ?? agent.sessionKey,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.ok ? 'queued' : 'unavailable',
          note: result.note,
        };
      }

      if (payload.action === 'stop' || payload.action === 'interrupt') {
        const ownedResult = await performOwnedActionWithoutInventory(payload, runtimeSurface.id);
        if (ownedResult) return ownedResult;
        if (runtimeSurface.ownership === 'owned') {
          const result = await escalateInterruptOwnedSurface(runtimeSurface.id);
          if (!result) {
            return unavailable(agent, payload.action, 'Owned runtime process evidence is unavailable.');
          }
          return {
            ok: result.confirmedDead,
            action: payload.action,
            surfaceId: runtimeSurface.id,
            runtime: agent.runtime,
            clientMutationId: payload.clientMutationId,
            status: result.confirmedDead ? 'completed' : 'unavailable',
            note: result.note,
            aborted: result.confirmedDead,
          };
        }
        if (!runtime.capabilities.interrupt) {
          return unavailable(agent, payload.action, `${agent.runtime} does not support interrupt.`);
        }
        const result = await confirmDiscoveredInterrupt(runtime, agent.sessionKey);
        return {
          ok: result.confirmed,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.confirmed ? 'completed' : 'unavailable',
          note: result.note,
          aborted: result.confirmed,
        };
      }

      return unavailable(agent, payload.action, `Runtime action ${payload.action} is not wired for ${agent.runtime} yet.`);
    }
  }
}

/**
 * Launch a new owned Codex session from mobile.
 * Doesn't require an existing surface — creates one from scratch.
 */
export async function launchCodexFromMobile(
  cwd: string,
  prompt: string,
  clientMutationId?: string,
): Promise<RuntimeActionResult> {
  const result = await launchRuntimeSurface({ runtime: 'codex', cwd, prompt, clientMutationId });
  return {
    ok: result.ok,
    action: 'launch',
    surfaceId: result.surfaceId,
    runtime: 'codex',
    clientMutationId: result.clientMutationId,
    status: result.ok ? 'queued' : 'unavailable',
    note: result.note,
  };
}
