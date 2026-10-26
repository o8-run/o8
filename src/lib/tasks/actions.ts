import 'server-only';

import { randomUUID } from 'node:crypto';
import { inspectPacketManagedRunAdmission } from '@/lib/lane/packet-stop-hold';
import { dispatchWithReceipt } from './dispatch-receipt';

import {
  archiveLane,
  appendEvent,
  findLaneByPacket,
  getLane,
  setLaneStatus,
  updateLane,
} from '@/lib/lane/registry';
import { cleanupAndDeleteLane } from '@/lib/lane/cleanup-and-delete';
import {
  isAgentReportReason,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
  reportAgentEvent,
} from '@/lib/lane/agent-report';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import type { AgentReportReason, Lane, LaneEventActor } from '@/lib/lane/types';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { resolveEffortAliases, resolveRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { settlePacketStorageBeforeRemoval } from '@/lib/orchestrator/packet-storage-removal';
import { nextPacketReferenceLabel } from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneBinding,
  OrchestratorPacket,
  OrchestratorPacketStatus,
  WorkerRouting,
} from '@/lib/orchestrator/types';
import { buildProjectTaskBrief, getProjectContext } from '@/lib/projects/context';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';
import { resolveTaskContractRequired } from '@/lib/orchestrator/task-contract-required';
import { assertRuntimeDispatchable, DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { remoteWorkerPreflightError } from '@/lib/cloud/worker-readiness';
import { getTaskPoolTask, type TaskPoolTask } from './pool';

export type TaskMutationAction = 'create' | 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune' | 'remove';

export interface TaskMutationResult {
  schema: 'o8/task.mutation/v1';
  ok: boolean;
  action: TaskMutationAction;
  taskId: string;
  packetId: string | null;
  laneId: string | null;
  note: string;
  eventId?: string;
  statusChanged?: boolean;
  workerRouting?: WorkerRouting;
  task: TaskPoolTask | null;
  status?: TaskPoolTask['status'];
  dispatchId?: string;
  replayed?: boolean;
}

export interface TaskMutationInput {
  actor?: LaneEventActor;
  projectId?: string | null;
  repoPath?: string | null;
}

export interface TaskCreateInput extends TaskMutationInput {
  title: string;
  summary?: string | null;
  model?: string | null;
  requestedEffort?: ThinkingEffort | null;
  workerIntent?: string | null;
  requestedProvider?: string | null;
  requestedRuntime?: string | null;
  allowedFiles?: string[] | null;
  sourceIssue?: {
    number?: number | null;
    body?: string | null;
    url?: string | null;
  } | null;
  problemDossierId?: string | null;
  problemRemedyId?: string | null;
}

export interface TaskClaimInput extends TaskMutationInput {
  note?: string | null;
}

export interface TaskDispatchInput extends TaskMutationInput {
  /** MCP returns the durable admission before worktree provisioning finishes. */
  waitForLaunch?: boolean;
  message?: string | null;
  model?: string | null;
  requestedEffort?: ThinkingEffort | null;
  workerIntent?: string | null;
  requestedProvider?: string | null;
  requestedRuntime?: string | null;
}

export interface TaskBlockInput extends TaskMutationInput {
  reason: string;
  code?: AgentReportReason | null;
}

export interface TaskReportInput extends TaskMutationInput {
  event?: string | null;
  status?: string | null;
  reason?: AgentReportReason | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TaskArchiveInput extends TaskMutationInput {
  reason?: string | null;
}

export interface TaskPruneInput extends TaskMutationInput {
  reason?: string | null;
}

export class TaskMutationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskMutationError';
  }
}

export function readTaskEffortSelection(body: Record<string, unknown>): ThinkingEffort | null {
  const selection = resolveEffortAliases(body.requestedEffort, body.thinkingEffort);
  if (!selection.ok) throw new TaskMutationError(400, selection.message);
  return selection.requestedEffort;
}

async function resolveTaskWorkerRouting(input: NonNullable<Parameters<typeof resolveWorkerRouting>[0]>, cwd: string | null): Promise<WorkerRouting> {
  const routing = resolveWorkerRouting(input);
  const pin = await resolveRuntimeEffortPin({
    requestedEffort: input.requestedEffort,
    runtime: routing.selectedRuntime,
    model: routing.selectedModel ?? getRuntimeCapability(routing.selectedRuntime).defaultModel ?? null,
    explicitModel: typeof input.requestedModel === 'string' ? input.requestedModel : null,
    modelDisposition: routing.modelDisposition,
  }, { cwd: cwd ?? undefined });
  if (!pin.ok) throw new TaskMutationError(400, pin.message);
  return routing;
}

function nowIso() {
  return new Date().toISOString();
}

function slugifyTask(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    || 'task';
}

function normalizeAllowedFiles(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].slice(0, 50);
}

function normalizeActor(actor: LaneEventActor | undefined): LaneEventActor {
  return actor === 'user' || actor === 'system' || actor === 'orchestrator'
    ? actor
    : 'orchestrator';
}

async function resolveTask(
  taskId: string,
  input: TaskMutationInput,
): Promise<TaskPoolTask> {
  const task = await getTaskPoolTask(taskId, {
    projectId: input.projectId ?? null,
    repoPath: input.repoPath ?? null,
  });
  if (!task) {
    throw new TaskMutationError(404, `Task not found: ${taskId}`);
  }
  return task;
}

function buildLaneBinding(
  packet: OrchestratorPacket,
  lane: Lane,
  lastEventLabel: string | null,
  workerRouting?: WorkerRouting,
): OrchestratorLaneBinding {
  return {
    tileId: packet.lane?.tileId ?? '',
    tabId: packet.lane?.tabId ?? '',
    repoPath: packet.workspaceTargetPath ?? lane.repoPath,
    worktreePath: lane.worktreePath,
    runtime: workerRouting?.selectedRuntime ?? packet.runtime,
    sessionKey: lane.sessionKey,
    laneId: lane.id,
    lastHeartbeatAt: null,
    lastEventAt: lane.lastEventAt ?? nowIso(),
    lastEventLabel,
  };
}

async function syncPacketForLane(
  task: TaskPoolTask,
  lane: Lane,
  patch: {
    status?: OrchestratorPacketStatus;
    blockedReason?: string | null;
    lastEventLabel?: string | null;
    workerRouting?: WorkerRouting;
  } = {},
  guard?: () => void,
) {
  if (!task.packetId) return;

  await withLockedState((state) => {
    guard?.();
    const index = state.packets.findIndex((packet) => packet.id === task.packetId);
    if (index === -1) return null;

    const packet = state.packets[index];
    const lastEventLabel = patch.lastEventLabel ?? lane.lastEventLabel ?? packet.lastEventLabel ?? null;
    const nextPacket: OrchestratorPacket = {
      ...packet,
      runtime: patch.workerRouting?.selectedRuntime ?? packet.runtime,
      workerIntent: patch.workerRouting?.workerIntent ?? packet.workerIntent,
      workerRouting: patch.workerRouting ?? packet.workerRouting,
      lane: buildLaneBinding(packet, lane, lastEventLabel, patch.workerRouting),
      lastEventAt: nowIso(),
      lastEventLabel,
    };

    if (patch.status) {
      nextPacket.status = patch.status;
      if ((patch.status === 'running' || patch.status === 'launching')
        && nextPacket.queueState === 'held' && nextPacket.holdIntent === 'explicit-dispatch') {
        nextPacket.queueState = 'queued';
        nextPacket.holdIntent = undefined;
      }
    }
    if (patch.blockedReason !== undefined) nextPacket.blockedReason = patch.blockedReason;

    state.packets = state.packets.map((candidate, candidateIndex) => (
      candidateIndex === index ? nextPacket : candidate
    ));
    state.updatedAt = nowIso();
    return null;
  });
}

async function ensureLaneForTask(
  task: TaskPoolTask,
  actor: LaneEventActor,
  requestedRuntime?: OrchestratorPacket['runtime'],
): Promise<Lane> {
  if (task.laneId) {
    const lane = getLane(task.laneId);
    if (lane) {
      if (requestedRuntime && lane.runtime !== requestedRuntime) {
        throw new TaskMutationError(
          409,
          `Task is claimed by a ${lane.runtime} lane; reset or reclaim it before dispatching with ${requestedRuntime}.`,
        );
      }
      return lane;
    }
  }
  if (task.packetId) {
    const lane = findLaneByPacket(task.packetId);
    if (lane) {
      if (requestedRuntime && lane.runtime !== requestedRuntime) {
        throw new TaskMutationError(
          409,
          `Task is claimed by a ${lane.runtime} lane; reset or reclaim it before dispatching with ${requestedRuntime}.`,
        );
      }
      return lane;
    }
  }
  if (!task.packetId) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }
  if (!task.repoPath) {
    throw new TaskMutationError(409, `Task ${task.id} has no repo path to claim.`);
  }
  if (!task.branch) {
    throw new TaskMutationError(409, `Task ${task.id} has no branch to claim.`);
  }

  const context = await getProjectContext({
    repoPath: task.repoPath,
    projectId: task.project?.id ?? null,
  });
  const laneResult = await dispatchLaneCommand({
    verb: 'open_lane',
    repoPath: task.repoPath,
    projectId: context.id,
    branch: task.branch,
    baseBranch: context.currentRepo?.defaultBranch ?? context.primaryRepo?.defaultBranch ?? 'main',
    runtime: requestedRuntime ?? task.runtime,
    label: task.title,
    packetId: task.packetId,
    actor,
  });
  if (!laneResult.ok || !laneResult.lane) {
    throw new TaskMutationError(409, laneResult.note || `Unable to open lane for task ${task.id}.`);
  }
  return laneResult.lane;
}

async function mutationResult(
  action: TaskMutationAction,
  task: TaskPoolTask,
  lane: Lane | null,
  note: string,
  extra: Partial<Pick<TaskMutationResult, 'ok' | 'eventId' | 'statusChanged'>> = {},
): Promise<TaskMutationResult> {
  const freshTask = await getTaskPoolTask(task.id);
  return {
    schema: 'o8/task.mutation/v1',
    ok: extra.ok ?? true,
    action,
    taskId: task.id,
    packetId: task.packetId,
    laneId: lane?.id ?? task.laneId,
    note,
    eventId: extra.eventId,
    statusChanged: extra.statusChanged,
    task: freshTask,
  };
}

function buildDispatchPrompt(task: TaskPoolTask, workerRouting: WorkerRouting, message?: string | null): string {
  return [
    'You are being dispatched from the o8 task pool.',
    `Worker routing:\nIntent: ${workerRouting.workerIntent}\nSelected runtime: ${workerRouting.selectedRuntime}\nRouting note: ${workerRouting.reason}`,
    task.taskBrief ? `Project task brief:\n${task.taskBrief}` : null,
    task.summary ? `Task detail:\n${task.summary}` : null,
    message?.trim() ? `Dispatch note:\n${message.trim()}` : null,
    'Before editing, confirm the repo you are in and call out any cross-repo dependency you need.',
  ].filter((line): line is string => Boolean(line)).join('\n\n');
}

export async function createTask(input: TaskCreateInput): Promise<TaskMutationResult> {
  const title = input.title?.trim();
  if (!title) {
    throw new TaskMutationError(400, 'title is required.');
  }

  const context = await getProjectContext({
    projectId: input.projectId ?? null,
    repoPath: input.repoPath ?? null,
  });
  const targetRepo = context.currentRepo ?? context.primaryRepo;
  if (!targetRepo) {
    throw new TaskMutationError(409, 'No repo available for this project task.');
  }

  const repoPath = targetRepo.localPath;
  const summary = input.summary?.trim() || title;
  const now = nowIso();
  const workerRouting = await resolveTaskWorkerRouting({
    workerIntent: input.workerIntent,
    requestedProvider: input.requestedProvider,
    requestedRuntime: input.requestedRuntime,
    requestedModel: input.model,
    requestedEffort: input.requestedEffort,
    source: 'task-create',
  }, repoPath);
  const allowedFiles = normalizeAllowedFiles(input.allowedFiles);
  const taskBrief = buildProjectTaskBrief(context, {
    repoPath,
    taskTitle: title,
    taskBody: summary,
  });
  const packetId = `pkt-${randomUUID()}`;
  const sourceIssueNumber = typeof input.sourceIssue?.number === 'number' && Number.isFinite(input.sourceIssue.number)
    ? Math.trunc(input.sourceIssue.number)
    : null;
  const branchTarget = sourceIssueNumber
    ? `issue/${sourceIssueNumber}-${slugifyTask(title)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    : `agent/${slugifyTask(title)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`;

  let resolvedPacketId = packetId;
  await withLockedState((current) => {
    const existingProblemTask = input.problemRemedyId
      ? current.packets.find((candidate) => candidate.problemRemedyId === input.problemRemedyId)
      : null;
    if (existingProblemTask) {
      resolvedPacketId = existingProblemTask.id;
      return;
    }
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: nextPacketReferenceLabel(current.packets),
      projectId: context.id,
      title,
      summary,
      workspaceTargetPath: repoPath,
      branchTarget,
      runtime: workerRouting.selectedRuntime,
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: workerRouting.selectedRuntime === 'cloud' ? 'held' : 'queued',
      holdIntent: workerRouting.selectedRuntime === 'cloud' ? 'explicit-dispatch' : undefined,
      releaseState: 'pending',
      status: workerRouting.selectedRuntime === 'cloud' ? 'draft' : 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      blockedReason: null,
      lastEventAt: now,
      lastEventLabel: 'task_created',
      archivedAt: null,
      review: null,
      lane: null,
      workerIntent: workerRouting.workerIntent,
      workerRouting,
      issue: input.sourceIssue ? {
        number: sourceIssueNumber ?? undefined,
        body: input.sourceIssue.body ?? summary,
        url: input.sourceIssue.url ?? undefined,
      } : null,
      taskContractRequired: resolveTaskContractRequired({
        runtime: workerRouting.selectedRuntime,
        explicit: true,
      }),
      taskContractSource: 'explicit',
      problemDossierId: input.problemDossierId ?? null,
      problemRemedyId: input.problemRemedyId ?? null,
      prompt: buildProjectBriefPromptV1(taskBrief, summary),
      ...(allowedFiles.length > 0 ? { allowedFiles, predictedFiles: allowedFiles } : {}),
    };

    current.packets.push(packet);
    if (!current.missionId) current.missionId = `task-pool-${Date.now().toString(36)}`;
    if (!current.prompt) current.prompt = `Task pool for ${context.name}`;
    if (!current.summary) current.summary = `Task pool for ${context.name}.`;
    if (!current.repoPath) current.repoPath = repoPath;
    if (!current.runtime) current.runtime = workerRouting.selectedRuntime;
    current.updatedAt = now;
  });

  const freshTask = await getTaskPoolTask(resolvedPacketId, {
    projectId: context.id,
    repoPath,
  });

  return {
    schema: 'o8/task.mutation/v1',
    ok: true,
    action: 'create',
    taskId: resolvedPacketId,
    packetId: resolvedPacketId,
    laneId: null,
    note: `Task added to ${context.name}.`,
    workerRouting,
    task: freshTask,
  };
}

export async function claimTask(taskId: string, input: TaskClaimInput = {}): Promise<TaskMutationResult> {
  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor, task.runtime);
  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event: 'claimed',
    message: normalizeAgentReportMessage(input.note),
    metadata: { taskId: task.id, packetId: task.packetId },
  });
  const updatedLane = report?.lane ?? updateLane(lane.id, {
    lastEventAt: nowIso(),
    lastEventLabel: 'claimed',
  }, actor) ?? lane;
  await syncPacketForLane(task, updatedLane, { lastEventLabel: 'claimed' });
  return mutationResult('claim', task, updatedLane, 'Task claimed.', {
    eventId: report?.event.id,
    statusChanged: report?.statusChanged,
  });
}

export async function dispatchTask(taskId: string, input: TaskDispatchInput = {}): Promise<TaskMutationResult> {
  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const workerRouting = await resolveTaskWorkerRouting({
    workerIntent: input.workerIntent ?? task.workerIntent ?? undefined,
    requestedProvider: input.requestedProvider ?? task.workerRouting?.requestedProvider ?? undefined,
    requestedRuntime: input.requestedRuntime ?? task.workerRouting?.requestedRuntime ?? task.runtime,
    requestedModel: input.model ?? task.workerRouting?.requestedModel ?? undefined,
    requestedEffort: input.requestedEffort ?? task.workerRouting?.requestedEffort ?? undefined,
    source: 'task-dispatch',
  }, task.repoPath);
  try {
    if (workerRouting.selectedRuntime === 'cloud') {
      const error = remoteWorkerPreflightError(input.model ?? task.workerRouting?.requestedModel);
      if (error) throw new TaskMutationError(409, error);
    } else {
      await assertRuntimeDispatchable(workerRouting.selectedRuntime, workerRouting.selectedModel, task.repoPath);
    }
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      throw new TaskMutationError(409, `${error.status.detail} ${error.status.fix}`);
    }
    throw error;
  }
  const prompt = buildDispatchPrompt(task, workerRouting, input.message);
  const priorLane = task.laneId ? getLane(task.laneId) : null;
  if (priorLane && priorLane.runtime !== workerRouting.selectedRuntime) throw new TaskMutationError(409, `Task is claimed by a ${priorLane.runtime} lane; reset or reclaim it before dispatching with ${workerRouting.selectedRuntime}.`);
  if (!task.packetId && !task.laneId) throw new TaskMutationError(409, 'Task has no lane or packet to dispatch.');
  return dispatchWithReceipt({
    packetId: task.packetId, laneId: task.laneId, actor,
    intent: { runtime: workerRouting.selectedRuntime, model: workerRouting.selectedModel, effort: workerRouting.selectedEffort, prompt },
    waitForLaunch: input.waitForLaunch !== false,
    conflict: (message) => new TaskMutationError(409, message),
    prepare: async (admission) => {
      const fresh = await resolveTask(taskId, input);
      const lane = await ensureLaneForTask(fresh, actor, workerRouting.selectedRuntime);
      if (['completed', 'archived'].includes(lane.status)) throw new TaskMutationError(409, 'Reset the completed task before dispatching it.');
      let accepted = lane;
      const admit = () => {
        if (fresh.packetId) {
          const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === fresh.packetId);
          const explicit = packet?.queueState === 'held' && packet.holdIntent === 'explicit-dispatch'
            && !packet.operatorStopped && !packet.archivedAt && packet.releaseState !== 'released'
            && ['queued', 'draft', 'blocked'].includes(packet.status)
            && (!packet.blockedReason || packet.blockedReason === 'Awaiting explicit dispatch');
          if (!explicit && !inspectPacketManagedRunAdmission(fresh.packetId).allowed) throw new TaskMutationError(409, 'Task is held or stopped. Reset it before dispatching.');
        }
        appendEvent(lane.id, 'task_dispatch_accepted', actor, { ...admission });
        accepted = setLaneStatus(lane.id, 'launching', actor, 'dispatch_accepted') ?? lane;
      };
      try {
        if (!fresh.packetId) admit();
        await syncPacketForLane(fresh, lane, { status: 'launching', blockedReason: null, lastEventLabel: 'dispatch_accepted', workerRouting }, admit);
      } catch (error) {
        if (getLane(lane.id)?.lastEventLabel === 'dispatch_accepted') setLaneStatus(lane.id, lane.status, actor, lane.lastEventLabel ?? 'dispatch_refused');
        throw error;
      }
      return accepted;
    },
    receipt: async (lane, admission, replayed) => ({
      ...(await mutationResult('dispatch', task, lane, 'Dispatch accepted. Follow progress with mission_tail.')),
      status: lane.status, dispatchId: admission?.dispatchId, replayed, workerRouting,
    }),
    launch: (lane, clientMutationId) => dispatchLaneCommand({
      verb: 'launch_session', laneId: lane.id, prompt,
      model: workerRouting.selectedModel ?? undefined, effort: workerRouting.selectedEffort ?? undefined, actor, clientMutationId,
    }),
    settle: async (lane, result, guard) => {
      guard();
      const latest = result.lane ?? getLane(lane.id) ?? lane;
      const settled = !result.ok
        ? setLaneStatus(latest.id, 'awaiting_orchestrator', actor, 'dispatch_failed') ?? latest : latest;
      await syncPacketForLane(task, settled, {
        status: result.ok ? settled.status === 'running' ? 'running' : 'launching' : 'blocked',
        blockedReason: result.ok ? null : result.note,
        lastEventLabel: result.ok ? settled.lastEventLabel ?? 'session_launched' : 'dispatch_failed', workerRouting,
      }, guard);
      return { ...(await mutationResult('dispatch', task, settled, result.note || 'Task dispatched.', { ok: result.ok })), workerRouting };
    },
  });
}

export async function blockTask(taskId: string, input: TaskBlockInput): Promise<TaskMutationResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new TaskMutationError(400, 'reason is required.');
  }
  if (input.code && !isAgentReportReason(input.code)) {
    throw new TaskMutationError(400, 'code must be a valid agent report reason.');
  }

  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor);
  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event: 'blocked',
    reason: input.code ?? undefined,
    message: reason,
    metadata: { taskId: task.id, packetId: task.packetId },
  });
  const blockedLane = setLaneStatus(lane.id, 'awaiting_orchestrator', actor, reason) ?? report?.lane ?? lane;
  await syncPacketForLane(task, blockedLane, {
    status: 'blocked',
    blockedReason: reason,
    lastEventLabel: reason,
  });
  return mutationResult('block', task, blockedLane, `Task blocked: ${reason}`, {
    eventId: report?.event.id,
    statusChanged: true,
  });
}

export async function reportTask(taskId: string, input: TaskReportInput = {}): Promise<TaskMutationResult> {
  const event = normalizeAgentReportEvent(input.event ?? input.status ?? 'progress');
  if (!event) {
    throw new TaskMutationError(400, 'event is required.');
  }
  if (input.reason && !isAgentReportReason(input.reason)) {
    throw new TaskMutationError(400, 'reason must be a valid agent report reason.');
  }

  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor);
  const metadata = input.metadata === undefined || input.metadata === null
    ? undefined
    : normalizeAgentReportMetadata(input.metadata);
  if (input.metadata !== undefined && input.metadata !== null && !metadata) {
    throw new TaskMutationError(400, 'metadata must be a JSON object.');
  }

  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event,
    reason: input.reason ?? undefined,
    message: normalizeAgentReportMessage(input.message),
    metadata: { taskId: task.id, packetId: task.packetId, ...(metadata ?? {}) },
  });
  if (!report) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }

  await syncPacketForLane(task, report.lane, {
    status: report.statusChanged ? 'blocked' : undefined,
    blockedReason: report.statusChanged ? input.message ?? input.reason ?? event : undefined,
    lastEventLabel: report.lane.lastEventLabel ?? event,
  });
  return mutationResult('report', task, report.lane, `Reported ${event}.`, {
    eventId: report.event.id,
    statusChanged: report.statusChanged,
  });
}

export async function archiveTask(taskId: string, input: TaskArchiveInput = {}): Promise<TaskMutationResult> {
  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = task.laneId ? getLane(task.laneId) : task.packetId ? findLaneByPacket(task.packetId) : null;
  const archivedAt = nowIso();
  const note = input.reason?.trim() || 'Archived from task pool cleanup.';
  let archivedLane: Lane | null = null;

  if (lane) {
    archivedLane = archiveLane(lane.id, actor);
  }

  if (task.packetId) {
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === task.packetId);
      if (!packet) return null;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.archivedAt = archivedAt;
      packet.lastEventAt = archivedAt;
      packet.lastEventLabel = 'archived';
      if (packet.lane) {
        packet.lane.lastEventAt = archivedAt;
        packet.lane.lastEventLabel = 'archived';
      }
      state.updatedAt = archivedAt;
      return null;
    });
  }

  if (!task.packetId && !lane) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }

  return mutationResult('archive', task, archivedLane, note, { statusChanged: true });
}

export async function pruneTask(taskId: string, input: TaskPruneInput = {}): Promise<TaskMutationResult> {
  const task = await resolveTask(taskId, input);
  if (task.group !== 'done') {
    throw new TaskMutationError(409, `Task ${task.id} is ${task.group}; archive it before pruning.`);
  }

  const lane = task.laneId ? getLane(task.laneId) : task.packetId ? findLaneByPacket(task.packetId) : null;
  const note = input.reason?.trim() || 'Pruned terminal task-pool row.';
  const prunedAt = nowIso();
  const packet = task.packetId
    ? readOrchestratorControlPlaneState().packets.find((item) => item.id === task.packetId)
    : undefined;

  const deletedLane = lane ? await cleanupAndDeleteLane(lane.id, {
    beforeDelete: packet ? () => settlePacketStorageBeforeRemoval(packet) : undefined,
  }) : null;

  if (task.packetId) {
    if (packet && !lane) await settlePacketStorageBeforeRemoval(packet);
    await withLockedState((state) => {
      const before = state.packets.length;
      state.packets = state.packets.filter((packet) => packet.id !== task.packetId);
      if (state.packets.length !== before) {
        state.updatedAt = prunedAt;
      }
      return null;
    });
  }

  if (!task.packetId && !deletedLane) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }

  return mutationResult('prune', task, deletedLane, note, { statusChanged: true });
}

export async function removeTask(taskId: string, input: TaskPruneInput = {}): Promise<TaskMutationResult> {
  const task = await resolveTask(taskId, input);
  if (task.group === 'running') {
    throw new TaskMutationError(409, `Task ${task.id} is running; block or report it before removing.`);
  }

  const lane = task.laneId ? getLane(task.laneId) : task.packetId ? findLaneByPacket(task.packetId) : null;
  const note = input.reason?.trim() || 'Removed task-pool row.';
  const removedAt = nowIso();
  const packet = task.packetId
    ? readOrchestratorControlPlaneState().packets.find((item) => item.id === task.packetId)
    : undefined;

  const deletedLane = lane ? await cleanupAndDeleteLane(lane.id, {
    beforeDelete: packet ? () => settlePacketStorageBeforeRemoval(packet) : undefined,
  }) : null;

  if (task.packetId) {
    if (packet && !lane) await settlePacketStorageBeforeRemoval(packet);
    await withLockedState((state) => {
      const before = state.packets.length;
      state.packets = state.packets.filter((packet) => packet.id !== task.packetId);
      if (state.packets.length !== before) {
        state.updatedAt = removedAt;
      }
      return null;
    });
  }

  if (!task.packetId && !deletedLane) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }

  return mutationResult('remove', task, deletedLane, note, { statusChanged: true });
}
