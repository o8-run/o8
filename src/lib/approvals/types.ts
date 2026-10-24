import type { EventSeverity } from '@/lib/fleet/types';
import type { NoulAnswer, ScoreAnswer } from '@/lib/judgment/types';
import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalActor = 'system' | 'desktop' | 'mobile' | 'orchestrator' | 'test';
export type ApprovalSource = 'llm-chat' | 'runtime' | 'test';

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  risk: ApprovalRisk;
  blocked?: boolean;
  workspacePath?: string;
  enabled?: boolean;
  requiresApproval?: boolean;
}

export interface PolicyRuleOverride {
  id: string;
  name?: string;
  description?: string;
  risk?: ApprovalRisk;
  blocked?: boolean;
  workspacePath?: string;
  enabled?: boolean;
  requiresApproval?: boolean;
}

export interface ApprovalDiffPreview {
  before?: string;
  after?: string;
  path?: string;
  files?: Array<{
    path: string;
    status: 'A' | 'M' | 'D' | 'R';
    patch: string;
  }>;
}

/** Structured merge gate result attached to lane-merge approval cards */
export interface ApprovalGateResult {
  passed: boolean;
  diffBase?: PacketDiffBaseResolution;
  violations: Array<{
    category: 'security' | 'budget' | 'integrity';
    severity: 'block' | 'warn';
    label: string;
    detail: string;
    file?: string;
  }>;
}

/** Conflict data attached to merge-conflict approval cards */
export interface ApprovalConflictReport {
  files: string[];
  strategy?: MergeStrategy;
  mergeError?: string;
}

export interface OrchestratorReviewFinding {
  file: string;
  line?: number;
  severity: 'bug' | 'rule_violation' | 'note';
  description: string;
  resolution: 'fixed' | 'accepted' | 'deferred';
  fixSuggestion?: string;
}

/**
 * Referee answers about an approval's diff (#2435). ADVISORY ONLY: nothing in
 * the decision path reads this. Stored inside `metadata_json` under the
 * `referee` key; record-only answers stay on the receipt.
 */
export interface ApprovalReferee {
  receiptId: string | null;
  model: string;
  answers: {
    docsOnly: NoulAnswer;
    addsTests: NoulAnswer;
    touchesMiddlewareOrAuth: NoulAnswer;
    containsPlaceholderOrMockData: NoulAnswer;
    risk: ScoreAnswer;
  };
  truncated: boolean;
  hiddenText: boolean;
  filesAddedFromDiff: number;
  /** o8's own path check, shown beside the referee's `touchesMiddlewareOrAuth`. */
  pathTouchesMiddlewareOrAuth: boolean;
  /** sha256 of the diff text and sorted file paths the referee read; a write is skipped when the row's diff no longer matches. */
  diffFingerprint: string;
  askedAt: number;
}

export interface ApprovalAuditEvent {
  /** Exact structured terminal projection used for an operator decision. */
  terminalAdapter?: import('@/lib/terminal-status/approval-adapter').TerminalApprovalAdapter;
  type: 'created' | 'updated' | 'approved' | 'rejected' | 'resumed' | 'resume_failed'
    | 'orchestrator_review' | 'continuation_completed' | 'continuation_failed' | 'continuation_outcome_unknown';
  actor: ApprovalActor;
  timestamp: number;
  note?: string;
  findings?: OrchestratorReviewFinding[];
  reviewer?: string;
  approved?: boolean;
  diffSha?: string;
  reviewedHeadSha?: string;
  parseWarning?: string;
  rawText?: string;
  patterns?: string[];
  conflictZones?: string[];
  /** Approved from a phone inbox card with referee chips shown (#2439); the chip kinds that were shown. */
  approvedFromCard?: { via: 'chip'; chipsShown: string[] };
}

export interface LlmApprovalContinuation {
  kind: 'llm-chat';
  tabId: string;
  model: string;
  provider: 'openai' | 'anthropic' | 'google' | 'chatgpt';
  planOwner?: string;
  planAccountId?: string;
  planGeneration?: number;
  planDesktopEpoch?: string;
  messages: Array<{ role: string; content: string }>;
  /** Legacy field retained for persisted approvals; never grants authorization. */
  approvedTools?: string[];
  repoPath?: string;
}

export interface RuntimeApprovalContinuation {
  kind: 'runtime';
  runtimeId: string;
  sessionKey: string;
  /** What to do after approval: 'resume' sends a follow-up, 'launch' starts a new session */
  action: 'resume' | 'launch';
  /** Original prompt (for launch actions) */
  prompt?: string;
  /** Follow-up message (for resume actions) */
  message?: string;
  /** Working directory */
  cwd?: string;
}

export type MergeStrategy = 'ours' | 'theirs' | 'manual';

export interface LaneApprovalContinuation {
  kind: 'lane';
  laneId: string;
  verb: 'resume' | 'merge' | 'create_pr';
  commitMessage?: string;
  /** Reviewed worktree HEAD expected when approving a lane merge. */
  expectedHeadSha?: string;
  /** Conflict resolution strategy — set by operator on conflict approval cards */
  strategy?: MergeStrategy;
}

export interface PlanApprovalContinuation {
  kind: 'plan';
  repoPath: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  tasks: Array<{ title: string; body: string }>;
  runtime: OrchestratorRuntime;
  constraints?: string;
}

/**
 * Agent-proposed packet spec update — closes #857.
 *
 * The orchestrator agent calls `cortex_propose_spec` to suggest a new spec.md
 * body for a packet. The proposal is held in the approval queue until the
 * operator approves (apply via `writePacketSpec`) or rejects (no change).
 * Changes only land for NEW dispatches, never an in-flight agent.
 */
export interface SpecUpdateApprovalContinuation {
  kind: 'spec-update';
  packetId: string;
  proposedSpec: string;
}

export type ApprovalContinuation =
  | LlmApprovalContinuation
  | RuntimeApprovalContinuation
  | LaneApprovalContinuation
  | PlanApprovalContinuation
  | SpecUpdateApprovalContinuation;

export interface ApprovalRecord {
  id: string;
  projectId: string | null;
  source: ApprovalSource;
  runtime: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  summary: string;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  editable?: boolean;
  diff?: ApprovalDiffPreview;
  gateResult?: ApprovalGateResult;
  conflictReport?: ApprovalConflictReport;
  risk: ApprovalRisk;
  metadata?: Record<string, string>;
  /** Advisory referee read of the diff (#2435); absent when the setting is off or the call failed. */
  referee?: ApprovalReferee;
  /** Policy rule that triggered this approval */
  policyRuleId?: string;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolution?: {
    action: Exclude<ApprovalStatus, 'pending'>;
    actor: ApprovalActor;
    note?: string;
    /** Unique compare-and-swap owner for post-resolution continuation work. */
    claimId?: string;
    /** The approval decision and its follow-on side effect settle separately. */
    continuationStatus?: 'pending' | 'completed' | 'failed' | 'outcome_unknown';
  };
  audit: ApprovalAuditEvent[];
  fingerprint: string;
  continuation?: ApprovalContinuation;
}

export interface CreateApprovalInput {
  projectId?: string | null;
  source: ApprovalSource;
  runtime: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  summary: string;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  editable?: boolean;
  diff?: ApprovalDiffPreview;
  gateResult?: ApprovalGateResult;
  conflictReport?: ApprovalConflictReport;
  risk: ApprovalRisk;
  metadata?: Record<string, string>;
  /** Policy rule that triggered this approval (from evaluatePolicy) */
  policyRuleId?: string;
  continuation?: ApprovalContinuation;
}

export interface MobileApprovalCard {
  id: string;
  approvalId?: string;
  sessionKey: string;
  agent: string;
  severity: EventSeverity;
  title: string;
  description: string;
  metadata?: Record<string, string>;
  repo?: string;
  repoPath?: string;
  repoSlug?: string;
  branch?: string;
  changedFilePaths?: string[];
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  previewUrl?: string | null;
  terminalSessionName?: string | null;
  gateResult?: ApprovalGateResult;
  conflictReport?: ApprovalConflictReport;
  actions: {
    approve: { label: string };
    reject: { label: string };
  };
  createdAt: number;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  assistantMessage?: {
    id: string;
    role: 'assistant';
    content: string;
    timestamp: number;
    model?: string;
    toolCalls?: MobileTranscriptToolCall[];
    sources?: MobileTranscriptSource[];
    thinking?: string;
  };
  nextApproval?: ApprovalRecord;
  note: string;
}
