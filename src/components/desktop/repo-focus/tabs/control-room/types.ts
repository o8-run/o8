import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../../types';
import type { ProjectRecord } from '../../../repo-registry/useProjects';

export type TaskPoolGroup = 'ready' | 'running' | 'review' | 'blocked' | 'done';

export interface TaskPoolLaneSummary {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  sessionKey: string | null;
  worktreePath: string | null;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

export interface TaskPoolWorkerRouting {
  workerIntent: string;
  requestedProvider: string | null;
  requestedRuntime: string | null;
  requestedModel: string | null;
  selectedProvider: string;
  selectedRuntime: string;
  selectedModel: string | null;
  selectedEffort?: string | null;
  enforcement: string;
  confidence: string;
  reason: string;
  decidedAt: string;
}

export interface TaskPoolProjectSummary {
  id: string;
  panelProjectId?: string | null;
  name: string;
  slug: string;
}

export interface TaskPoolTask {
  thread?: import('@/lib/threads/types').ThreadEvidence;
  id: string;
  packetId: string | null;
  laneId: string | null;
  title: string;
  summary: string;
  group: TaskPoolGroup;
  status: string;
  runtime: string;
  workerIntent: string | null;
  workerRouting: TaskPoolWorkerRouting | null;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  repoName: string | null;
  blockedReason: string | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  allowedFiles: string[];
  sourceIssue: {
    number?: number | null;
    body?: string | null;
    url?: string | null;
  } | null;
  project: TaskPoolProjectSummary | null;
  lane: TaskPoolLaneSummary | null;
  execution?: {
    kind: 'remote_worker';
    jobId: string;
    sessionKey: string;
    status: 'pending' | 'leased' | 'completed' | 'parked' | 'cancelled';
    attempt: number;
    workerId: string | null;
    leaseState: 'active' | 'expired' | 'none';
    updatedAt: string;
    workspaceAccess: 'unavailable';
    previewAccess: 'requestable' | 'unavailable';
  } | null;
}

export interface TaskPoolPayload {
  schema: 'o8/task.pool/v1';
  tasks: TaskPoolTask[];
}

export interface SupervisorInboxPayload {
  items?: SupervisorInboxItem[];
}

export interface TaskMutationPayload {
  schema: 'o8/task.mutation/v1';
  ok: boolean;
  action: 'create' | 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune' | 'remove';
  taskId: string;
  packetId: string | null;
  laneId: string | null;
  note: string;
  task: TaskPoolTask | null;
}

export interface GitHubIssueIntake {
  id: string;
  kind: 'issue' | 'epic';
  repoId: string;
  repoName: string;
  repoPath: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  comments: number;
  updatedAt: string | null;
  age: string;
}

export interface PanelIssuePayload {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  comments?: unknown;
  body?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  url?: unknown;
}

export interface ControlRoomTabProps {
  project: ProjectRecord;
  repos: RepoFocusRepo[];
  selectedRepo?: RepoFocusRepo | null;
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
}

export type TaskAction = 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune' | 'remove';

export interface TaskActionMenuState {
  task: TaskPoolTask;
  x: number;
  y: number;
}
