import type { PullRequestListPage, PullRequestListSort, PullRequestListState } from '@/lib/github-broker/pull-request-list.types';

export type GitProviderKind = 'github' | 'gitlab';
export type GitProviderMergeMethod = 'merge' | 'squash' | 'rebase';

export interface GitProviderListQuery {
  state: PullRequestListState;
  page: number;
  sort: PullRequestListSort;
  fresh: boolean;
  signal?: AbortSignal;
}

/** Inline (file/line) review remark in the shape the PR panel renders. */
export interface GitProviderReviewComment {
  id: number; author: string; body: string; path: string; line: number | null; side: string;
  createdAt: string; state: string; diffHunk: string; inReplyTo: number | null;
}

/** Conversation remark in the shape the PR panel renders. */
export interface GitProviderIssueComment { id: number; body: string; user: string; created_at: string }

export interface GitProviderDiscussion {
  comments: GitProviderReviewComment[];
  issueComments: GitProviderIssueComment[];
  reviews: Array<{ id: number; state: string }>;
  discussionIncomplete?: boolean;
}

export interface GitProviderMergeOptions {
  mergeMethod: GitProviderMergeMethod;
  expectedHeadSha: string;
  expectedMergeGate?: string;
}

/**
 * The forge operations the PR panel and review surface depend on. `repo` is the
 * provider's own repository key: `owner/name` on GitHub, `host/group/project`
 * on GitLab.
 */
export interface GitProvider {
  readonly kind: GitProviderKind;
  listPullRequests(repo: string, query: GitProviderListQuery): Promise<PullRequestListPage>;
  readDiscussion(repo: string, number: number): Promise<GitProviderDiscussion>;
  comment(repo: string, number: number, body: string): Promise<void>;
  /** Re-checks the provider's merge gate against the reviewed head before publishing. */
  merge(repo: string, number: number, options: GitProviderMergeOptions): Promise<void>;
}
