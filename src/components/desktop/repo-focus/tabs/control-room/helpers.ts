import type { CSSProperties } from 'react';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../../types';
import {
  formatElapsed,
  normalizeRepoPath,
  repoOwnsCandidate,
} from '../../utils';
import type { ProjectRecord } from '../../../repo-registry/useProjects';
import type { GitHubIssueIntake, TaskPoolTask } from './types';
import {
  DETACHED_ATTENTION_MS,
  STALE_ATTENTION_MS,
  STALE_CLEANUP_SIGNALS,
  STALE_FAILURE_MS,
} from './constants';

export function projectSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function baseName(value: string | null | undefined): string {
  return normalizeRepoPath(value).split('/').filter(Boolean).pop() ?? '';
}

export function repoSlugFromRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export function repoIssueParam(repo: RepoFocusRepo): string {
  return repoSlugFromRemote(repo.remoteUrl) ?? repo.name;
}

export function issueKind(labels: string[]): GitHubIssueIntake['kind'] {
  return labels.some((label) => /(^|\b)(epic|initiative|milestone)(\b|$)/i.test(label)) ? 'epic' : 'issue';
}

export function issueAge(issue: { updatedAt?: string | null; createdAt?: string | null }): string {
  return formatElapsed(issue.updatedAt ?? issue.createdAt ?? null);
}

export function issueKey(repoPath: string | null | undefined, issue: { number?: number | null; url?: string | null }) {
  return `${normalizeRepoPath(repoPath)}::${issue.url ?? issue.number ?? ''}`;
}

export function intentLabel(value: string | null | undefined): string {
  switch (value) {
    case 'light_worker':
      return 'light worker';
    case 'heavy_worker':
      return 'heavy worker';
    case 'reviewer':
      return 'reviewer';
    case 'diagnostic':
      return 'diagnostic';
    case 'orchestrator':
      return 'orchestrator';
    default:
      return 'worker';
  }
}

export function runtimeLabel(value: string | null | undefined): string {
  switch (value) {
    case 'claude-code':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'codex':
      return 'Codex';
    default:
      return value || 'Codex';
  }
}

export function taskTime(task: TaskPoolTask): string {
  const value = task.lastEventAt ?? task.lane?.lastEventAt ?? task.lane?.lastHeartbeatAt ?? null;
  return formatElapsed(value);
}

export function taskSessionKey(task: TaskPoolTask): string | null {
  const laneKey = task.lane?.sessionKey ?? null;
  if (task.runtime !== 'cloud') return laneKey;
  return task.execution?.sessionKey === laneKey ? laneKey : null;
}

export interface PendingDispatch {
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
  requireExactSession: boolean;
  startedAt: number;
}

export function findDispatchSessionKey(
  pending: PendingDispatch,
  sessions: IdeWorkspaceSession[],
): string | null {
  if (pending.sessionKey) {
    return sessions.find((session) => session.sessionKey === pending.sessionKey)?.sessionKey ?? null;
  }
  if (pending.requireExactSession) return null;
  for (const session of sessions) {
    if (!session.sessionKey) continue;
    if (pending.packetId && session.orchestrationPacket?.packetId === pending.packetId) {
      return session.sessionKey;
    }
  }
  return null;
}

export function taskTimeLabel(task: TaskPoolTask): string {
  const elapsed = taskTime(task);
  return elapsed === 'now' ? 'now' : `${elapsed} ago`;
}

export function taskTimestampMs(task: TaskPoolTask): number | null {
  const raw = task.lastEventAt ?? task.lane?.lastEventAt ?? null;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const heartbeat = task.lane?.lastHeartbeatAt;
  return typeof heartbeat === 'number' && Number.isFinite(heartbeat) ? heartbeat : null;
}

export function isAttentionTask(task: TaskPoolTask): boolean {
  return task.group === 'blocked' || task.group === 'review';
}

export function isStaleTask(task: TaskPoolTask): boolean {
  const timestamp = taskTimestampMs(task);
  if (timestamp === null) return false;
  const age = Date.now() - timestamp;
  const signal = task.blockedReason || task.lastEventLabel || task.lane?.lastEventLabel || null;
  if (signal && STALE_CLEANUP_SIGNALS.has(signal) && age > STALE_FAILURE_MS) return true;
  if (isAttentionTask(task) && age > STALE_ATTENTION_MS) return true;
  if (isAttentionTask(task) && !taskSessionKey(task) && age > DETACHED_ATTENTION_MS) return true;
  return task.lane?.status === 'failed' && age > STALE_FAILURE_MS;
}

export function taskSignal(task: TaskPoolTask): string | null {
  const value = task.blockedReason || task.lastEventLabel || null;
  switch (value) {
    case 'zero_diff_failed':
      return 'No changes produced';
    // #2141 — a dead runtime and a deliberate no-op are different outcomes.
    case 'zero_diff_runtime_error':
      return 'Runtime errored before writing';
    case 'zero_diff_runtime_error_requeued':
      return 'Runtime errored — retrying';
    case 'zero_diff_unclassified':
      return 'No changes, cause unknown';
    case 'silent_exit_work_present':
      return 'Work present';
    case 'review_ready':
      return 'Ready to review';
    case 'needs_clarification':
      return 'Needs clarification';
    default:
      return value;
  }
}

export function taskMatchesProject(
  task: TaskPoolTask,
  project: ProjectRecord,
  repos: RepoFocusRepo[],
  selectedRepo: RepoFocusRepo | null | undefined,
): boolean {
  const repoPath = normalizeRepoPath(task.repoPath);
  const targets = selectedRepo ? [selectedRepo] : repos;
  if (repoPath && targets.some((repo) => repoOwnsCandidate(repo.localPath, repoPath))) return true;
  if (selectedRepo) return false;

  const ids = new Set([
    project.id.toLowerCase(),
    project.name.toLowerCase(),
    projectSlug(project.name),
  ].filter(Boolean));
  const taskProject = task.project;
  if (!taskProject) return false;
  return ids.has(taskProject.id.toLowerCase())
    || ids.has(taskProject.slug.toLowerCase())
    || ids.has(taskProject.name.toLowerCase());
}

export function supervisorIncidentMatchesProject(
  item: SupervisorInboxItem,
  repos: RepoFocusRepo[],
  selectedRepo: RepoFocusRepo | null | undefined,
): boolean {
  const repoPath = normalizeRepoPath(item.repoPath);
  const targets = selectedRepo ? [selectedRepo] : repos;
  if (!repoPath) return false;
  return targets.some((repo) => repoOwnsCandidate(repo.localPath, repoPath));
}

export function supervisorKindLabel(kind: SupervisorInboxItem['kind']): string {
  switch (kind) {
    case 'verification_failed':
      return 'Verification failed';
    case 'session_lost':
      return 'Session lost';
    case 'packet_missing':
      return 'Packet missing';
    case 'bounded_retry_exhausted':
      return 'Retry exhausted';
    case 'merge_blocked':
      return 'Merge blocked';
    case 'fetch_unreachable':
      return 'Fetch unreachable';
    case 'repo_misconfigured':
      return 'Repo misconfigured';
    case 'packet_no_changes':
      return 'Finished — no changes';
    case 'silent_exit_verification_failed':
      return 'Silent exit';
    case 'silent_exit_no_work':
      return 'No work';
    case 'silent_exit_but_work_present':
      return 'Work salvaged';
    default:
      return 'Agent triage';
  }
}

export function supervisorStatusTone(status: SupervisorInboxItem['status']) {
  switch (status) {
    case 'human_required':
      return {
        label: 'Needs decision',
        color: '#dc2626',
        background: 'rgba(239, 68, 68, 0.08)',
      };
    case 'healing':
      return {
        label: 'Healing',
        color: 'var(--t-accent)',
        background: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
      };
    case 'pending':
      return {
        label: 'Queued',
        color: 'var(--t-brand-orange, #FF5A1F)',
        background: 'rgba(255, 90, 31, 0.08)',
      };
    case 'escalated':
      return {
        label: 'In orchestrator',
        color: '#2563eb',
        background: 'rgba(37, 99, 235, 0.08)',
      };
    case 'self_healed':
      return {
        label: 'Fixed',
        color: '#16a34a',
        background: 'rgba(22, 163, 74, 0.08)',
      };
    case 'resolved':
      return {
        label: 'Resolved',
        color: '#16a34a',
        background: 'rgba(22, 163, 74, 0.08)',
      };
    default:
      return {
        label: 'Archived',
        color: 'var(--t-text-faint)',
        background: 'transparent',
      };
  }
}

/**
 * Active-row text cue — solid ink on a slow opacity pulse. The earlier form
 * swept a flare gradient through a background-clip:text fill, which made
 * WebKit re-rasterize the glyphs every frame for as long as the row stayed
 * active. Duplicate of chats/helpers.ts shimmerTextStyle — change both
 * together.
 */
export function shimmerTextStyle(base = 'var(--t-text)'): CSSProperties {
  return {
    color: base,
    animation: 'o8-text-shimmer 2.35s ease-in-out infinite',
  };
}
