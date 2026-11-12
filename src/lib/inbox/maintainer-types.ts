import type { IdleDraft } from '@/lib/github-broker/idle-drafts';
export interface MaintainerContribution {
  idleDraft?: IdleDraft;
  id: string;
  kind: 'pull_request' | 'claim' | 'reply';
  repo: string;
  repoPaths: string[];
  number: number;
  title: string;
  author: string | null;
  authorAssociation?: string | null;
  assignees: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  baseRefName?: string;
  headRefName?: string;
  threadKind?: 'issue' | 'pr';
  waitingSince?: string;
}

export interface MaintainerFeed {
  idleDraftsUnavailable?: string[];
  contributions: MaintainerContribution[];
  replies: MaintainerContribution[];
  sources: Array<{ repo: string; repoPaths: string[]; lastSuccessfulAt: string | null; stale: boolean }>;
  truncated: boolean;
  repliesTruncated: boolean;
}

export type InboxScope = 'repo' | 'project' | 'all';
export type InboxLane = 'replies' | 'contributions' | 'approvals' | 'agents' | 'history';

export function matchesInboxScope(paths: string[], scope: InboxScope, repoPath: string | null, projectPaths: string[]): boolean {
  if (scope === 'all') return true;
  return paths.some((path) => scope === 'repo' ? path === repoPath : projectPaths.includes(path));
}
