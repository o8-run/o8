import { NextResponse } from 'next/server';
import type { MobileOrchestratorThread } from './types';
import type { LinkedWork } from './linked-work';
import type { inboxProjection } from '@/lib/inbox/store';
import type { parkedWorkspaceProjection } from '@/lib/inbox/parked-workspaces';
import type { ThreadGitContext } from '@/lib/repos/thread-git-context';
import type { mobileThreadPullRequests } from './pull-request-projection';

export const THREAD_LIST_COMPOSE_LIMIT = 8 * 1024 * 1024;
export interface MobileThreadListPiece {
  thread: MobileOrchestratorThread;
  projection: ReturnType<typeof inboxProjection>;
  linkedWork: LinkedWork | null;
  parked: ReturnType<typeof parkedWorkspaceProjection>;
  git: Pick<ThreadGitContext, 'repoSlug' | 'branch' | 'isWorktree' | 'worktreePath'>;
  runStartedAt: string | null;
}
export interface MobileThreadListPieces {
  version: 1;
  pieces: MobileThreadListPiece[];
  machineDisplayName: string;
}

/** Shared wire composition only. No filesystem, database, git or broker reads. */
export function composeMobileThreadList({ pieces, machineDisplayName }: MobileThreadListPieces,
  pulls: Awaited<ReturnType<typeof mobileThreadPullRequests>>) {
  return NextResponse.json({ threads: pieces.map(({ thread, projection, linkedWork, parked, git, runStartedAt }) => {
    const pr = pulls.find(pr => pr.threadId === thread.id);
    const remoteSlug = thread.githubOwner && thread.githubRepo ? `${thread.githubOwner}/${thread.githubRepo}` : null;
    return { ...thread, ...projection, linkedWork, machineDisplayName,
      ...(pr ? { pullRequestNumber: pr.number, pullRequestState: pr.state, changeCount: pr.changedFiles } : {}), ...parked, pinned: projection.pinnedAt != null,
      isWorktree: git.isWorktree, worktreePath: git.worktreePath,
      repoSlug: remoteSlug ?? git.repoSlug ?? thread.repoName, branch: git.branch ?? thread.repoBranch,
      ...(thread.status === 'busy' ? { runStartedAt: runStartedAt ?? undefined } : {}) };
  }), updatedAt: [...pieces.map(({ thread }) => thread.lastMessageAt), ...pulls.map(pr => pr.updatedAt ?? '')].sort().at(-1) ?? null },
  { headers: { 'Cache-Control': 'private, max-age=5' } });
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 16 * 1024;
const nullable = (value: unknown) => value === null || text(value);
const keys = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
/** The authenticated compose backhaul still treats protocol drift as a refusal. */
export function isMobileThreadListPieces(value: unknown): value is MobileThreadListPieces {
  if (!object(value) || !keys(value, ['version', 'pieces', 'machineDisplayName']) || value.version !== 1
    || !text(value.machineDisplayName) || !Array.isArray(value.pieces) || value.pieces.length > 500) return false;
  return value.pieces.every(piece => {
    if (!object(piece) || !keys(piece, ['thread', 'projection', 'linkedWork', 'parked', 'git', 'runStartedAt'])) return false;
    const { thread: t, projection: p, linkedWork: l, parked, git: g } = piece;
    if (!object(t) || !text(t.id) || !t.id.startsWith('thoughts-') || !text(t.title) || !text(t.lastMessageAt)
      || !text(t.runtime) || !['idle', 'busy', 'ready', 'failed'].includes(String(t.status))
      || !Number.isSafeInteger(t.messageCount) || Number(t.messageCount) < 0
      || !['projectId', 'repoPath', 'repoName', 'repoBranch', 'githubOwner', 'githubRepo', 'backend', 'agent'].every(field => nullable(t[field]))
      || (t.pinned !== undefined && typeof t.pinned !== 'boolean') || (t.source !== undefined && t.source !== 'bot-network')
      || (t.networkQuestion !== undefined && !object(t.networkQuestion))) return false;
    if (!object(p) || !object(p.inboxSubject) || p.inboxSubject.kind !== 'conversation' || p.inboxSubject.id !== t.id
      || !nullable(p.inboxSubject.workspace) || p.inboxSubject.projectId !== t.projectId || p.parentInboxSubject !== null
      || !['settledOverride', 'settledAt', 'unsettledAt', 'pinnedAt', 'pinOrderKey', 'activeOrderKey', 'autoSettleDisabledAt', 'autoSettledReason'].every(field => nullable(p[field]))
      || !Number.isSafeInteger(p.inboxRevision)) return false;
    if (l !== null && (!object(l) || !object(l.pullRequests) || !Number.isSafeInteger(l.branches)
      || !Number.isSafeInteger(l.pullRequests.total)
      || !['open', 'merged', 'closed'].every(field => l.pullRequests && object(l.pullRequests)
        && (l.pullRequests[field] === undefined || Number.isSafeInteger(l.pullRequests[field]))))) return false;
    if (!object(parked) || Object.keys(parked).some(key => key !== 'parkedWorkspaces')
      || (parked.parkedWorkspaces !== undefined && (!Array.isArray(parked.parkedWorkspaces)
        || !parked.parkedWorkspaces.every(entry => object(entry) && keys(entry, ['packetId', 'repositoryUuid', 'reclaimedAvailableBytes'])
          && text(entry.packetId) && text(entry.repositoryUuid) && (entry.reclaimedAvailableBytes === null || Number.isSafeInteger(entry.reclaimedAvailableBytes)))))) return false;
    return object(g) && keys(g, ['repoSlug', 'branch', 'isWorktree', 'worktreePath']) && nullable(g.repoSlug) && nullable(g.branch)
      && typeof g.isWorktree === 'boolean' && nullable(g.worktreePath) && nullable(piece.runStartedAt);
  });
}
