import 'server-only';

import { basename } from 'node:path';
import { getProjectsLedger, type ProjectRecord } from '@/lib/repos/projects';
import { taskPanelProjectId } from './panel-project-identity';
import { getSqlite } from '@/lib/db';
import { completedServiceResultSha } from '@/lib/cloud/review-service-authority';
import { getLatestPacketJob } from '@/lib/cloud/job-queue';
import type { CloudJob, CloudJobStatus } from '@/lib/cloud/job-store';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';

import { listLanes } from '@/lib/lane/registry';
import type { Lane, LaneStatus } from '@/lib/lane/types';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import type {
  OrchestratorPacket,
  OrchestratorPacketStatus,
  OrchestratorRuntime,
  WorkerIntent,
  WorkerRouting,
} from '@/lib/orchestrator/types';
import { buildProjectTaskBrief, getProjectContext, ProjectNotFoundError, type ProjectContext } from '@/lib/projects/context';

export type TaskPoolGroup = 'ready' | 'running' | 'review' | 'blocked' | 'done';

export interface TaskPoolRepoSummary {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

export interface TaskPoolProjectSummary {
  id: string;
  panelProjectId?: string | null;
  name: string;
  slug: string;
  mainRepo: TaskPoolRepoSummary | null;
  currentRepo: TaskPoolRepoSummary | null;
  relatedRepos: TaskPoolRepoSummary[];
}

export interface TaskPoolLaneSummary {
  id: string;
  label: string;
  status: LaneStatus;
  runtime: Lane['runtime'];
  branch: string;
  baseBranch: string;
  sessionKey: string | null;
  worktreePath: string | null;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

export interface TaskPoolRemoteExecution {
  kind: 'remote_worker';
  jobId: string;
  sessionKey: string;
  status: CloudJobStatus;
  attempt: number;
  workerId: string | null;
  leaseState: 'active' | 'expired' | 'none';
  updatedAt: string;
  workspaceAccess: 'unavailable';
  previewAccess: 'requestable' | 'unavailable';
}

export interface TaskPoolTask {
  id: string;
  packetId: string | null;
  laneId: string | null;
  title: string;
  summary: string;
  group: TaskPoolGroup;
  status: OrchestratorPacketStatus | LaneStatus;
  runtime: OrchestratorRuntime | Lane['runtime'];
  workerIntent: WorkerIntent | null;
  workerRouting: WorkerRouting | null;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  repoName: string | null;
  queueState: OrchestratorPacket['queueState'] | null;
  releaseState: OrchestratorPacket['releaseState'] | null;
  blockedReason: string | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  allowedFiles: string[];
  sourceIssue: OrchestratorPacket['issue'] | null;
  problemDossierId: string | null;
  problemRemedyId: string | null;
  project: TaskPoolProjectSummary | null;
  lane: TaskPoolLaneSummary | null;
  execution: TaskPoolRemoteExecution | null;
  taskBrief?: string;
}

export interface TaskPool {
  schema: 'o8/task.pool/v1';
  tasks: TaskPoolTask[];
  groups: Record<TaskPoolGroup, TaskPoolTask[]>;
  counts: Record<TaskPoolGroup, number>;
}

export interface TaskPoolOptions {
  includeMissionHistory?: boolean;
  projectId?: string | null;
  repoPath?: string | null;
  includeDone?: boolean;
  includeBrief?: boolean;
}

const GROUP_ORDER: TaskPoolGroup[] = ['blocked', 'review', 'running', 'ready', 'done'];
const DONE_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['released', 'archived']);
const DONE_LANE_STATUSES = new Set<LaneStatus>(['completed', 'archived']);
const REVIEW_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['awaiting_review']);
const REVIEW_LANE_STATUSES = new Set<LaneStatus>(['reviewing']);
const BLOCKED_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['blocked', 'failed', 'recovering']);
const BLOCKED_LANE_STATUSES = new Set<LaneStatus>([
  'awaiting_input',
  'awaiting_orchestrator',
  'recovering',
  'failed',
]);
const RUNNING_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['launching', 'running']);
const RUNNING_LANE_STATUSES = new Set<LaneStatus>(['launching', 'running', 'paused', 'merging']);

function normalizePath(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function packetAllowedFiles(packet: OrchestratorPacket | null): string[] {
  if (!packet) return [];
  const paths = packet.allowedFiles && packet.allowedFiles.length > 0
    ? packet.allowedFiles
    : packet.predictedFiles ?? [];
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function chooseGroup(packet: OrchestratorPacket | null, lane: Lane | null, remoteJob?: CloudJob): TaskPoolGroup {
  if (packet?.releaseState === 'released' || (packet && DONE_PACKET_STATUSES.has(packet.status))) return 'done';
  if (lane && DONE_LANE_STATUSES.has(lane.status)) return 'done';
  // Recover display truth for jobs dispatched before the explicit hold was
  // cleared. Operator holds remain authoritative; only an exact remote binding
  // can supersede the old pre-dispatch marker.
  if (remoteJob && packet?.holdIntent === 'explicit-dispatch') {
    if (remoteJob.status === 'leased') return 'running';
    if (remoteJob.status === 'completed') return 'review';
    if (remoteJob.status === 'parked' || remoteJob.status === 'cancelled') return 'blocked';
  }
  if ((packet && REVIEW_PACKET_STATUSES.has(packet.status)) || (lane && REVIEW_LANE_STATUSES.has(lane.status))) {
    return 'review';
  }
  if ((packet && BLOCKED_PACKET_STATUSES.has(packet.status)) || (lane && BLOCKED_LANE_STATUSES.has(lane.status))) {
    return 'blocked';
  }
  if ((packet && RUNNING_PACKET_STATUSES.has(packet.status)) || (lane && RUNNING_LANE_STATUSES.has(lane.status))) {
    return 'running';
  }
  return 'ready';
}

function groupSortRank(group: TaskPoolGroup): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function toLaneSummary(lane: Lane | null): TaskPoolLaneSummary | null {
  if (!lane) return null;
  return {
    id: lane.id,
    label: lane.label,
    status: lane.status,
    runtime: lane.runtime,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    sessionKey: lane.sessionKey,
    worktreePath: lane.worktreePath,
    lastHeartbeatAt: lane.lastHeartbeatAt,
    lastEventAt: lane.lastEventAt,
    lastEventLabel: lane.lastEventLabel,
  };
}

function toRemoteExecution(job: CloudJob | undefined, nowMs: number): TaskPoolRemoteExecution | null {
  if (!job) return null;
  const leaseState = job.status !== 'leased' ? 'none'
    : job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > nowMs ? 'active' : 'expired';
  return {
    kind: 'remote_worker',
    jobId: job.id,
    sessionKey: `cloud:${job.sessionId}`,
    status: job.status,
    attempt: job.claimCount,
    workerId: leaseState === 'active' ? job.claimedBy ?? null : null,
    leaseState,
    updatedAt: job.updatedAt,
    workspaceAccess: 'unavailable',
    previewAccess: job.launch.remotePreview && (leaseState === 'active' || (job.status === 'completed'
      && job.launch.remoteSource && job.launch.remoteManifestHash && completedServiceResultSha(getSqlite(), job.id)))
      ? 'requestable' : 'unavailable',
  };
}

function toRepoSummary(context: ProjectContext, repoId: string | null | undefined): TaskPoolRepoSummary | null {
  const repo = repoId ? context.repos.find((candidate) => candidate.id === repoId) : null;
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    role: repo.role,
    isMain: repo.isPrimary,
    isCurrent: repo.isCurrent,
  };
}

function toProjectSummary(context: ProjectContext, projects: ProjectRecord[]): TaskPoolProjectSummary {
  return {
    id: context.id,
    panelProjectId: taskPanelProjectId(context, projects),
    name: context.name,
    slug: context.slug,
    mainRepo: toRepoSummary(context, context.primaryRepo?.id),
    currentRepo: toRepoSummary(context, context.currentRepo?.id),
    relatedRepos: context.relatedRepos
      .filter((repo) => repo.id !== context.currentRepo?.id)
      .map((repo) => ({
        id: repo.id,
        name: repo.name,
        localPath: repo.localPath,
        role: repo.role,
        isMain: repo.isPrimary,
        isCurrent: repo.isCurrent,
      })),
  };
}

function groupTasks(tasks: TaskPoolTask[]): TaskPool['groups'] {
  return {
    ready: tasks.filter((task) => task.group === 'ready'),
    running: tasks.filter((task) => task.group === 'running'),
    review: tasks.filter((task) => task.group === 'review'),
    blocked: tasks.filter((task) => task.group === 'blocked'),
    done: tasks.filter((task) => task.group === 'done'),
  };
}

function taskSortKey(task: TaskPoolTask): string {
  return task.lastEventAt ?? task.lane?.lastEventAt ?? task.lane?.lastHeartbeatAt?.toString() ?? '';
}

async function resolveProjectContext(
  cache: Map<string, ProjectContext | null>,
  repoPath: string | null,
  projectId: string | null,
): Promise<ProjectContext | null> {
  if (!repoPath && !projectId) return null;
  const key = `${projectId ?? ''}::${repoPath ?? ''}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const context = await getProjectContext({ repoPath, projectId });
    cache.set(key, context);
    return context;
  } catch (error) {
    // Historical lanes can outlive a project. Do not retarget them to the
    // active project, or hide unrelated tasks behind one stale identity.
    if (!(error instanceof ProjectNotFoundError)) throw error;
    cache.set(key, null);
    return null;
  }
}

export async function getTaskPool(options: TaskPoolOptions = {}): Promise<TaskPool> {
  const panelProjects = (await getProjectsLedger()).projects;
  const mission = currentMissionState();
  const packets = options.includeMissionHistory
    ? [...new Map([...listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets), ...mission.packets].map(packet => [packet.id, packet])).values()]
    : mission.packets;
  const lanes = listLanes();
  const lanesByPacketId = new Map(lanes.flatMap((lane) => (
    lane.packetId ? [[lane.packetId, lane] as const] : []
  )));
  const packetIds = new Set(packets.map((packet) => packet.id));
  const projectCache = new Map<string, ProjectContext | null>();
  const tasks: TaskPoolTask[] = [];
  const nowMs = Date.now();

  for (const packet of packets) {
    const lane = lanesByPacketId.get(packet.id) ?? null;
    const remoteJob = lane?.runtime === 'cloud'
      ? getLatestPacketJob(DEFAULT_CLOUD_TEAM_ID, packet.id)
      : undefined;
    const execution = remoteJob && lane?.sessionKey === `cloud:${remoteJob.sessionId}`
      ? toRemoteExecution(remoteJob, nowMs)
      : null;
    const repoPath = normalizePath(lane?.repoPath ?? packet.workspaceTargetPath);
    const context = await resolveProjectContext(projectCache, repoPath, lane?.projectId ?? packet.projectId ?? null);
    if (options.projectId && context?.id !== options.projectId && context?.slug !== options.projectId) continue;
    if (options.repoPath && repoPath !== normalizePath(options.repoPath)) continue;

    const group = chooseGroup(packet, lane, execution ? remoteJob : undefined);
    if (!options.includeDone && group === 'done') continue;

    tasks.push({
      id: packet.id,
      packetId: packet.id,
      laneId: lane?.id ?? packet.lane?.laneId ?? null,
      title: packet.title,
      summary: packet.summary,
      group,
      status: lane?.status ?? packet.status,
      runtime: lane?.runtime ?? packet.runtime,
      workerIntent: packet.workerIntent ?? null,
      workerRouting: packet.workerRouting ?? null,
      branch: lane?.branch ?? packet.branchTarget ?? null,
      baseBranch: lane?.baseBranch ?? null,
      repoPath,
      repoName: context?.currentRepo?.name ?? (repoPath ? basename(repoPath) : null),
      queueState: packet.queueState,
      releaseState: packet.releaseState,
      blockedReason: execution && group !== 'blocked' ? null : packet.blockedReason ?? null,
      lastEventAt: lane?.lastEventAt ?? packet.lastEventAt ?? null,
      lastEventLabel: lane?.lastEventLabel ?? packet.lastEventLabel ?? null,
      allowedFiles: packetAllowedFiles(packet),
      sourceIssue: packet.issue ?? null,
      problemDossierId: packet.problemDossierId ?? null,
      problemRemedyId: packet.problemRemedyId ?? null,
      project: context ? toProjectSummary(context, panelProjects) : null,
      lane: toLaneSummary(lane),
      execution,
      taskBrief: options.includeBrief && context
        ? buildProjectTaskBrief(context, {
          repoPath,
          taskTitle: packet.title,
          taskBody: packet.summary,
        })
        : undefined,
    });
  }

  for (const lane of lanes) {
    if (lane.packetId && packetIds.has(lane.packetId)) continue;
    const repoPath = normalizePath(lane.repoPath);
    const context = await resolveProjectContext(projectCache, repoPath, lane.projectId);
    if (options.projectId && context?.id !== options.projectId && context?.slug !== options.projectId) continue;
    if (options.repoPath && repoPath !== normalizePath(options.repoPath)) continue;

    const group = chooseGroup(null, lane);
    if (!options.includeDone && group === 'done') continue;

    tasks.push({
      id: lane.id,
      packetId: null,
      laneId: lane.id,
      title: lane.label,
      summary: lane.lastEventLabel ?? '',
      group,
      status: lane.status,
      runtime: lane.runtime,
      workerIntent: null,
      workerRouting: null,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      repoPath,
      repoName: context?.currentRepo?.name ?? (repoPath ? basename(repoPath) : null),
      queueState: null,
      releaseState: null,
      blockedReason: null,
      lastEventAt: lane.lastEventAt,
      lastEventLabel: lane.lastEventLabel,
      allowedFiles: [],
      sourceIssue: null,
      problemDossierId: null,
      problemRemedyId: null,
      project: context ? toProjectSummary(context, panelProjects) : null,
      lane: toLaneSummary(lane),
      execution: null,
      taskBrief: options.includeBrief && context
        ? buildProjectTaskBrief(context, {
          repoPath,
          taskTitle: lane.label,
          taskBody: lane.lastEventLabel,
        })
        : undefined,
    });
  }

  tasks.sort((left, right) => {
    const groupDelta = groupSortRank(left.group) - groupSortRank(right.group);
    if (groupDelta !== 0) return groupDelta;
    return taskSortKey(right).localeCompare(taskSortKey(left));
  });

  const groups = groupTasks(tasks);
  return {
    schema: 'o8/task.pool/v1',
    tasks,
    groups,
    counts: {
      ready: groups.ready.length,
      running: groups.running.length,
      review: groups.review.length,
      blocked: groups.blocked.length,
      done: groups.done.length,
    },
  };
}

export async function getTaskPoolTask(
  taskId: string,
  options: Omit<TaskPoolOptions, 'includeBrief'> = {},
): Promise<TaskPoolTask | null> {
  const pool = await getTaskPool({ ...options, includeDone: true, includeBrief: true });
  return pool.tasks.find((task) => task.id === taskId || task.packetId === taskId || task.laneId === taskId) ?? null;
}
