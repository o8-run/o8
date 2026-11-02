export type PullRequestListState = 'open' | 'closed' | 'all';
export type PullRequestListSort = 'updated' | 'oldest' | 'newest';

export interface PullRequestListItem {
  number: number;
  title: string;
  author: string;
  avatarUrl: string | null;
  additions: number | null;
  deletions: number | null;
  checks: 'success' | 'failure' | 'pending' | null;
  requestedReviewers: string[] | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRefName: string;
  headRepoFullName?: string | null;
  baseRefName: string;
  updatedAt: string;
  createdAt: string;
  url: string;
  labels: string[];
  /** Merge-readiness inputs; null when GitHub did not report them. */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
}

export interface PullRequestListPage {
  prs: PullRequestListItem[];
  repo: string | null;
  nextPage: number | null;
  unavailable?: boolean;
  error?: string;
  statsUnavailable?: boolean;
}
