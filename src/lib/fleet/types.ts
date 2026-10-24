import type { BrowserSurfaceSummary } from '@/lib/browser/types';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'huddling'
  | 'blocked'
  | 'waiting'
  | 'reviewing'
  | 'failed'
  | 'completed';

export type SquadStatus = 'healthy' | 'watching' | 'degraded' | 'blocked';

export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'denied';

export type EventSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface ContextPressure {
  usedPercent: number;
  trend: 'falling' | 'stable' | 'rising';
}

export interface CostSnapshot {
  sessionUsd: number;
  dailyUsd: number;
}

export interface TokenUsageSnapshot {
  totalTokens?: number | null;
  remainingTokens?: number | null;
  fresh?: boolean;
}

export interface RuntimeSurfaceCapabilities {
  attach: boolean;
  readTail: boolean;
  sendInput: boolean;
  interrupt: boolean;
  resize: boolean;
  diffContext: boolean;
  reviewContext: boolean;
}

export interface RuntimeSurfaceLifecycle {
  availability?: 'awaiting-thread' | 'running' | 'ready-for-resume';
  lastOutcome?: 'finished' | 'interrupted' | 'failed';
  lastRunMode?: 'launch' | 'resume';
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  summary?: string;
}

export interface RuntimeSurfaceSummary {
  id: string;
  runtime: string;
  kind: 'chat-session' | 'terminal-session' | 'runtime-session';
  ownership: 'provider' | 'discovered' | 'owned';
  title: string;
  cwd?: string;
  branch?: string;
  sourceLabel: string;
  tailSourceLabel?: string;
  capabilities: RuntimeSurfaceCapabilities;
  lifecycle?: RuntimeSurfaceLifecycle;
  browserSurface?: BrowserSurfaceSummary;
  reviewContext?: {
    repoSlug?: string;
    branch?: string;
    head?: string;
  };
}

import type { WorkspaceOrchestrationPacketBadge } from '@/lib/orchestrator/types';

export interface AgentActivity {
  /** One-line summary: "Editing auth.ts", "Running build", "Thinking…" */
  headline: string;
  /** Tool name if a tool call was the last action */
  toolName?: string;
  /** File path if activity involves a file */
  filePath?: string;
  /** Timestamp of the activity */
  timestamp?: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  squadId: string;
  runtime: string;
  model: string;
  primaryModel?: string;
  heartbeatModel?: string;
  status: AgentStatus;
  /** Normalized terminal status explanation for orchestrator runtime sessions. */
  statusEvidence?: TerminalStatusEvidence;
  currentTask: string;
  standingLane?: { laneId: string; currentTask: string | null; queueDepth: number; stopped: boolean };
  /** Worker-posted implementation plan while the lane is huddling. */
  huddlePlan?: string;
  workspace: string;
  branch: string;
  sessionKey: string;
  approvalStatus: ApprovalStatus;
  lastEventAt: string;
  lastActivityAt?: number | null;
  context: ContextPressure;
  cost?: CostSnapshot;
  alerts: number;
  sessionId?: string;
  /** Opaque, credential-free launch identity used for attribution. */
  identityId?: string;
  sessionKind?: string;
  surfaceLabel?: string;
  isCurrentSession?: boolean;
  tokenUsage?: TokenUsageSnapshot;
  runtimeSurface?: RuntimeSurfaceSummary;
  browserSurface?: BrowserSurfaceSummary;
  activity?: AgentActivity;
  tmuxSession?: string;
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
}

export interface SquadSummary {
  id: string;
  name: string;
  status: SquadStatus;
  throughputLabel: string;
  blockers: number;
  alerts: number;
  liveSessions: number;
  members: string[];
}

export interface ReviewArtifact {
  kind: 'diff' | 'pull_request' | 'doc' | 'screenshot' | 'run_log';
  title: string;
  href?: string;
  state: 'new' | 'reviewing' | 'approved';
  agentId?: string;
  detail?: string;
}

export interface RuntimeReviewCommandEvidence {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  exitCode?: number | null;
  outputPreview?: string;
}

export interface RuntimeReviewPacket {
  surfaceId: string;
  runtime: string;
  title: string;
  summary: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  diffStat: string;
  changedFiles: ReviewChangedFile[];
  recentCommits: string[];
  reviewDisposition: 'watching' | 'resolved';
  reviewDispositionUpdatedAt?: string;
  reviewDispositionUpdatedAtLabel?: string;
  worktree?: {
    id: string;
    path: string;
    branch: string;
    baseBranch: string;
    status: string;
    dirtyFiles: string[];
  } | null;
  lastRun?: {
    id: string;
    mode: 'launch' | 'resume';
    outcome: 'running' | 'finished' | 'interrupted' | 'failed';
    prompt: string;
    startedAt?: string;
    finishedAt?: string;
    startedAtLabel?: string;
    finishedAtLabel?: string;
    assistantSummary?: string;
    commands: RuntimeReviewCommandEvidence[];
  };
  nextActions: string[];
  notes: string[];
}

export interface ReviewChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions?: number | null;
  deletions?: number | null;
  /** Has staged (index) changes. Set by the local working-tree snapshot path. */
  staged?: boolean;
  /** Has unstaged (working-tree) changes; untracked files count as unstaged. */
  unstaged?: boolean;
}

export interface ReviewWorktreeSummary {
  path: string;
  /** Filesystem identity for navigation; `path` may be shortened for display. */
  absolutePath?: string;
  branch?: string;
  head?: string;
  isCurrent: boolean;
  isDetached?: boolean;
  isBare?: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

export interface ReviewPullRequestSummary {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  body?: string;
  linkedIssueNumbers?: number[];
}

export interface ReviewIssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface WorkflowReviewSnapshot {
  generatedAt: string;
  repoSlug: string;
  repoPath: string;
  branch: string;
  headSha?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: ReviewChangedFile[];
  diffStat: string;
  recentCommits: string[];
  worktrees: ReviewWorktreeSummary[];
  pullRequests: ReviewPullRequestSummary[];
  activeIssue?: ReviewIssueSummary;
  activeIssues: ReviewIssueSummary[];
  warnings?: string[];
}

export interface EventItem {
  id: string;
  agentId?: string;
  squadId?: string;
  severity: EventSeverity;
  title: string;
  track?: string;
  subLabel?: string;
  detail: string;
  timestamp: string;
  repo?: string;
}

export interface FleetMeta {
  mode: 'live' | 'demo' | 'stale';
  sourceLabel: string;
  gatewayLabel?: string;
  gatewayFreshness?: 'fresh' | 'stale' | 'warming';
  gatewayReachable?: boolean;
  observablePending?: boolean;
  warmingRetryAfterMs?: number;
  primarySessionKey?: string;
  mirrorMode: 'current-session-first' | 'demo-only';
  note?: string;
  staleReason?: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  meta: FleetMeta;
  squads: SquadSummary[];
  agents: AgentSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
}
