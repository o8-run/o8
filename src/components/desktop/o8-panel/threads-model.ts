import { threadProjectMatches } from './thread-project-identity';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import type { FleetAgent } from '../thoughts/types';
import type { ProjectRecord } from '../repo-registry/useProjects';

export const THREAD_GROUPS = [
  { id: 'blocked', label: 'Waiting on you' },
  { id: 'review', label: 'Ready for review' },
  { id: 'running', label: 'Working' },
  { id: 'done', label: 'Resolved' },
] as const;

export interface ThreadScope {
  projectId: string | null;
  repoPaths: string[];
}

const normalizedPath = (path: string | null | undefined) => path?.replace(/\/+$/, '') || null;

export function resolveThreadProject(projects: ProjectRecord[], active: ProjectRecord | null, repoPath: string | null, allRepos: boolean): ProjectRecord | null {
  if (allRepos || !repoPath) return active;
  const contains = (project: ProjectRecord) => project.repoPaths.some((path) => normalizedPath(path) === normalizedPath(repoPath));
  return active && contains(active) ? active : projects.find(contains) ?? null;
}

export function scopeThreads(tasks: TaskPoolTask[], scope: ThreadScope): TaskPoolTask[] {
  const paths = new Set(scope.repoPaths.map(normalizedPath));
  return tasks.filter((task) => {
    if (!threadProjectMatches(task.project, scope.projectId) && !(task.thread && !task.project && !['packet', 'lane', 'approval', 'inbox'].includes(task.thread.kind))) return false;
    return Boolean(task.repoPath && paths.has(normalizedPath(task.repoPath)));
  });
}

export function scopeThreadAgents(agents: FleetAgent[], tasks: TaskPoolTask[], scope: ThreadScope): FleetAgent[] {
  const sessions = new Set(tasks.map((task) => task.lane?.sessionKey).filter(Boolean));
  const paths = new Set(scope.repoPaths.map(normalizedPath));
  return agents.filter((agent) => (
    Boolean(agent.sessionKey && sessions.has(agent.sessionKey))
    || Boolean(agent.workspace && paths.has(normalizedPath(agent.workspace)))
  ));
}

export function threadStatusLine(task: TaskPoolTask): string {
  if (task.blockedReason) {
    const reason = task.blockedReason;
    return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(reason) ? reason.replace(/_/g, ' ') : reason;
  }
  if (task.execution?.leaseState === 'expired') return 'Worker connection expired. Reconnect or retry this task.';
  if (task.lastEventLabel && !/^[a-z]+(?:_[a-z0-9]+)+$/.test(task.lastEventLabel)) return task.lastEventLabel;
  return task.summary || THREAD_GROUPS.find((group) => group.id === task.group)?.label || 'Waiting for an update';
}

export function threadModelLabel(task: TaskPoolTask): string {
  const model = task.workerRouting?.selectedModel;
  const effort = task.workerRouting?.selectedEffort;
  return [model, effort].filter(Boolean).join(' · ') || task.workerRouting?.selectedRuntime || task.runtime;
}
