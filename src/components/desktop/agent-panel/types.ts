import type { RuntimeSurfaceSummary } from '@/lib/fleet/types';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';
import type { LeftPanelProjectFocusState } from '../repo-focus/useLeftPanelProjectFocus';
import type { PullRequestStackObservation } from '@/lib/github-client/pr-stack';

export interface AgentDetail {
  id: string;
  name: string;
  squadId: string;
  model: string;
  primaryModel?: string;
  heartbeatModel?: string;
  status: string;
  currentTask: string;
  workspace: string;
  repo?: string;
  sessionKey: string;
  lastEventAt: string;
  surfaceLabel: string;
  isCurrentSession: boolean;
  alerts: number;
  context?: { usedPercent: number; trend: string };
  tokenUsage?: { totalTokens: number; remainingTokens: number };
  branch?: string;
  pr?: {
    number: number;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    state: 'open' | 'merged' | 'closed';
    url: string;
  };
  localDiff?: { additions: number; deletions: number; changedFiles: number };
  activity?: { coding: number; thinking: number; testing: number; idle: number };
  workspaceStatus?: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';
  workflowStage?: WorkflowStageBadge | null;
  tmuxSession?: string;
  runtimeSurface?: RuntimeSurfaceSummary;
  worktree?: WorktreeInfo;
  lifecycleState?: 'active' | 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
  lifecycleTs?: number;
  statusEvidence?: TerminalStatusEvidence;
  repoReadiness?: RepoReadiness;
}

export interface EventEntry {
  id: string;
  agentId: string;
  squadId: string;
  severity: string;
  title: string;
  track?: string;
  subLabel?: string;
  detail: string;
  timestamp: string;
  repo?: string;
}

export interface GHIssue {
  number: number;
  title: string;
  labels: { name: string; color: string }[];
  state?: string;
  author?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }>;
  comments?: number;
  body?: string;
  createdAt?: string;
}

export interface GHPullRequest {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  labels: { name: string; color: string }[];
  reviewDecision?: string;
  statusCheckRollup?: Array<{ name?: string | null; conclusion?: string | null; status?: string | null }>;
}

export interface PRHoverDetail {
  mergeable: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: string | null;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  stack?: PullRequestStackObservation;
}

export interface CIHoverDetail {
  failingJobs: Array<{ name: string; failingStep?: string | null }>;
  summaryLine: string | null;
}

export interface WorkspaceGroup {
  workspace: string;
  displayName: string;
  repo: string;
  agents: AgentDetail[];
  hasRunning: boolean;
  bestContextPct: number;
  primaryModel: string;
  totalAlerts: number;
}

export interface CommitSummary {
  hash: string;
  message: string;
  age: string;
}

export interface ActivityCiItem {
  kind: 'ci';
  id: number;
  title: string;
  status: string;
  conclusion: string;
  branch: string;
  workflow: string;
  age: string;
  ts: number;
  repo: string;
  headSha?: string;
}

export interface ActivityCommitItem {
  kind: 'commit';
  hash: string;
  message: string;
  age: string;
  ts: number;
  repo?: string;
  groupedCiRun?: ActivityCiItem;
  groupedPushEvent?: EventEntry;
}

export type ActivityItem =
  | ActivityCommitItem
  | { kind: 'event'; data: EventEntry; ts: number }
  | {
      kind: 'issue';
      number: number;
      title: string;
      state: string;
      labels: { name: string; color: string }[];
      age: string;
      ts: number;
      repo: string;
      author: string;
      assignees: string[];
      comments: number;
      body: string;
    }
  | {
      kind: 'pr';
      number: number;
      title: string;
      state: string;
      author: string;
      branch: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      age: string;
      ts: number;
      repo: string;
      reviewDecision?: string;
      checkSummary?: { passed: number; failed: number; pending: number };
      failingChecks?: string[];
    }
  | ActivityCiItem
  | { kind: 'packet'; packet: OrchestratorPacket; ts: number; repo?: string };

export type RepoTaskLaunchRequest =
  | { kind: 'issue'; repo: string; number: number; title: string; body?: string }
  | { kind: 'pr'; repo: string; number: number; title: string; branch?: string };

export type FeedFilter = 'all' | 'commit' | 'issue' | 'pr' | 'ci' | 'packet';

export interface WorkspaceAgentLaunchRequest {
  repoPath: string;
  runtime?: OrchestratorRuntime;
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
}

export interface AgentPanelProps {
  onOpenChatReview?: (laneId: string, repoPath: string | null) => void;
  /** Global destinations and account controls live in the adjacent navigation rail. */
  navigationRail?: boolean;
  activeSessionKey?: string | null;
  selectedRepo?: string | null;
  selectedRepoBranch?: string | null;
  selectedRepoLocalPath?: string | null;
  /** Repository bound to the focused workspace tab, independent of browsing. */
  workingRepoPath?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceTabKind?: 'terminal' | 'chat' | 'llm-chat' | 'chatgpt-plan' | 'canvas' | 'orchestrator' | 'fleet-canvas' | null;
  onFocusOrchestratorTab?: () => void;
  onFocusAssistantTab?: () => void;
  /** Spawn a fresh Orchestrator tab. The optional repo scopes the new
   *  session to a specific repo — used by the sidebar repo-header [+]
   *  (contextual New Agent). No arg = the classic global
   *  New session behavior. */
  onCreateWorkspaceOrchestrator?: (repo?: { name: string; localPath: string; remoteUrl?: string; branch?: string | null } | null) => void;
  onCreateWorkspaceChat?: () => void;
  onCreateWorkspaceTerminal?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenProjectManagement?: (projectId?: string) => void;
  onOpenSettings?: () => void;
  /** Pair-mobile, rendered on the account row beside the gear (Q 2026-07-16). */
  onOpenMobilePairing?: () => void;
  selectedRepoReadiness?: RepoReadiness | null;
  onLaunchWorkspaceAgent?: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  onLaunchWorkspaceTask?: (request: RepoTaskLaunchRequest) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  onSelectRepo?: (repoId: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onRepoAdded?: (repo: RepoRegistryEntry) => void | Promise<void>;
  onRepoRemoved?: (repo: RepoRegistryEntry) => void;
  onOpenSpecInWorkspace?: (repoPath: string) => void;
  onExpandWorkspace?: (workspace: string, repo: string | null) => void;
  onSelectFile?: (filePath: string, workspace?: string) => void;
  onOpenCI?: (repo: string) => void;
  onCreateIssue?: (repo?: string) => void;
  onOpenGitLog?: (workspace?: string) => void;
  onOpenDeploy?: (project?: string) => void;
  onAgentsUpdate?: (agents: AgentDetail[]) => void;
  onAgentKill?: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  lifecycleEvents?: Map<string, { state: string; exitCode?: number; ts: number }>;
  orchestratorPackets?: OrchestratorPacket[];
  orchestratorMissionState?: OrchestratorMissionState;
  registeredRepos?: RepoRegistryEntry[];
  ideWorkspaceSessions?: MobileInboxSnapshot['sessions'];
  // Lifted from inside AgentPanel so the dashboard can drive column width
  // on focus toggle. When omitted (legacy callers / tests), AgentPanel
  // falls back to its internal hook for back-compat.
  leftPanelFocus?: LeftPanelProjectFocusState;
}
