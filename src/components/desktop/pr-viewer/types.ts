import type { RepoReadiness } from '@/lib/repos/types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';

export interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: { login: string } | null;
  labels: { name: string; color: string }[];
  reviews: { author: { login: string }; state: string; body: string }[];
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: {
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    startedAt?: string;
    completedAt?: string;
  }[];
  reviewComments: { id: number; body: string; user: string; path: string; line: number | null; created_at: string }[];
  issueComments: { id: number; body: string; user: string; created_at: string }[];
  diffStat: string;
  url: string;
  readiness?: RepoReadiness | null;
  workflowStage?: WorkflowStageBadge | null;
}

export type ReviewThreadStatus = 'active' | 'outdated' | 'resolved';

export interface ReviewThreadComment {
  id: string;
  databaseId: number | null;
  author: string;
  body: string;
  createdAt: string;
  diffHunk: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  url: string;
  isOptimistic?: boolean;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: string;
  startDiffSide: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  status: ReviewThreadStatus;
  subjectType: string;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: string | null;
  latestCommentAt: string;
  comments: ReviewThreadComment[];
}

export interface PersistedReviewThreadUiState {
  viewed: string[];
  collapsed: string[];
}

export type PRSection = 'overview' | 'files' | 'checks' | 'comments' | 'reviews';

export interface PRSectionTab {
  id: PRSection;
  label: string;
  count?: number;
  shortcut: string;
}

export interface ActionResult {
  type: 'success' | 'error';
  message: string;
}

export interface ReviewThreadTone {
  label: string;
  color: string;
  accent: string;
  border: string;
  background: string;
  pillBackground: string;
  pillBorder: string;
  summaryDecoration: string;
}

export interface PRViewerProps {
  active?: boolean;
  prNumber: number;
  repo?: string;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
}
