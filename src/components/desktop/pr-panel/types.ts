// Types for PrPanel — mirrors the shape returned by /api/panel/prs/[number].
// The detail endpoint sources from `fetchGitHubPullRequestDetail` +
// `fetchGitHubPullRequestComments` then layers `resolvedRepo`, `readiness`,
// `workflowStage`, `reviewComments`, `issueComments`, `diffStat` on top.

export type PrTabId = 'summary' | 'timeline' | 'changes' | 'checks' | 'commits' | 'reviews';
export type PrComposerMode = 'brain' | 'comment' | 'review';
export type PrReviewAction = 'review-comment' | 'approve' | 'request-changes';
export type PrMergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrTimelineEvent {
  id: string;
  kind: string;
  title: string;
  actor: string;
  avatarUrl: string | null;
  at: string;
  body: string;
  url: string;
  commitSha?: string;
}

export interface PrTimelinePage {
  events: PrTimelineEvent[];
  nextPage: number | null;
}

export interface PrFile {
  path: string;
  previousPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PrCheck {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
}

export interface PrReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: string;
  createdAt: string;
  state: string;
  diffHunk: string;
  inReplyTo: number | null;
}

export interface PrIssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

export interface PrDetail {
  mergeGate?: import('@/lib/github-broker/pr-merge-gate').PrMergeGate;
  stack?: import('@/lib/github-client/pr-stack').PullRequestStackObservation;
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  avatarUrl?: string | null;
  labels?: string[];
  requestedReviewers?: string[];
  headRefName: string;
  baseRefName: string;
  headSha?: string;
  baseSha?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  draft?: boolean;
  autoMergeEnabled?: boolean;
  allowedMergeMethods?: PrMergeMethod[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeable: boolean;
  reviewDecision: string | null;
  statusCheckRollup: PrCheck[];
  url: string;
  files: PrFile[];
  checksUnavailable?: boolean;
  discussionIncomplete?: boolean;
  watch?: { changes: Array<'head' | 'checks' | 'state' | 'comments' | 'reviews'>; commentUpdatesPaused: boolean };
  resolvedRepo?: string;
  reviewComments: PrReviewComment[];
  issueComments: PrIssueComment[];
  diffStat?: string;
}

export interface PrDetailResponse {
  pr: PrDetail;
}

export type CheckBucket = 'failing' | 'running' | 'passed' | 'neutral' | 'skipped';

export interface PrPanelProps {
  readOnly?: boolean;
  onSelectLayer?: (number: number) => void;
  active?: boolean;
  id?: string;
  prNumber: number;
  repoSlug?: string | null;
  repoPath?: string | null;
  onClose: () => void;
}
