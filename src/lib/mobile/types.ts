import type {
  AgentSummary,
  EventSeverity,
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
} from '@/lib/fleet/types';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorPacketRecovery } from '@/lib/orchestrator/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { CompactionTrigger } from '@/lib/runtimes/compaction-detector';

export type MobileInboxItemKind = 'alert' | 'approval' | 'review' | 'run_watch';
export type MobileAgentStatus = 'queued' | 'running' | 'huddling' | 'awaiting_review' | 'merged' | 'failed';

export type MobileControlActionKind =
  | 'inspect'
  | 'steer'
  | 'send'
  | 'approve'
  | 'request_changes'
  | 'deny'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'watch'
  | 'resolve'
  | 'launch'
  | 'open_review'
  | 'open_desktop';

export interface MobileControlAction {
  kind: MobileControlActionKind;
  label: string;
  sessionKey?: string;
  href?: string;
  destructive?: boolean;
  available: boolean;
  reasonUnavailable?: string;
}

/**
 * Advisory referee read of how urgently an item needs the operator (#2440).
 * Ordering only: no threshold, gate, or auto-decision reads it. `abstain` marks
 * a confidence under the abstain floor, which keeps the item in today's order.
 */
export interface MobileInboxUrgency {
  score: number;
  confidence: number;
  abstain: boolean;
  receiptId: string | null;
}

export interface MobileInboxItem {
  id: string;
  kind: MobileInboxItemKind;
  severity: EventSeverity;
  title: string;
  detail: string;
  agentStatus?: MobileAgentStatus;
  approvalId?: string;
  metadata?: Record<string, string>;
  sessionKey?: string;
  timestampLabel?: string;
  actions: MobileControlAction[];
  /** Absent when the setting is off, the call failed, or no score is cached yet. */
  urgency?: MobileInboxUrgency;
  /**
   * ADVISORY referee chips (#2439), computed on the desktop from the stored
   * merge-card referee facts. Nothing decides on them. Absent when the setting
   * is off, the approval has no stored facts, or no chip clears its threshold.
   */
  refereeChips?: MobileInboxRefereeChip[];
}

/** One calibrated referee fact shown on an inbox card. Only `docs-only` is calibrated today. */
export interface MobileInboxRefereeChip {
  kind: 'docs-only';
  /** The referee's answer, 0..1. */
  probability: number;
  receiptId: string | null;
}

export interface MobileInboxSummary {
  alerts: number;
  approvals: number;
  reviewItems: number;
  inspectOnlyReviews?: number;
  activeRuns: number;
}

export type MobileFleetRuntime = OrchestratorRuntime | 'openclaw' | 'hermes' | 'unknown';
export type MobileFleetStatus =
  | 'queued'
  | 'running'
  | 'huddling'
  | 'paused'
  | 'stopped'
  | 'blocked'
  | 'awaiting_review'
  | 'needs_merge'
  | 'merged'
  | 'failed'
  | 'idle';
export type MobileFleetAction =
  | 'inspect'
  | 'open_terminal'
  | 'open_preview'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'approve'
  | 'request_changes'
  | 'merge';

export interface MobileFleetSession {
  id: string;
  sessionKey: string;
  runtime: MobileFleetRuntime;
  runtimeLabel: string;
  runtimeAccent: string;
  status: MobileFleetStatus;
  title: string;
  repo: string;
  repoPath: string;
  branch: string;
  worktreePath?: string | null;
  terminalSessionName?: string | null;
  terminalAvailable?: boolean;
  previewUrl?: string | null;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  approvalId?: string;
  reviewAuthority?: 'approval_gate' | 'inspect_only' | null;
  actions: MobileFleetAction[];
  lastEventAt?: string | null;
  lastActivityAt?: number | null;
  /** Worker-posted implementation plan while status is `huddling`. */
  huddlePlan?: string;
}

export interface MobileReviewFocus {
  repoSlug: string;
  branch: string;
  desktopHref: string;
  pullRequest?: ReviewPullRequestSummary;
  issues: ReviewIssueSummary[];
  changedFiles: ReviewChangedFile[];
  diffStat?: string;
}

export interface MobileReviewUnit {
  id: string;
  sessionKey: string;
  approvalId?: string;
  authority: 'approval_gate' | 'inspect_only';
  status: 'awaiting_review' | 'running' | 'blocked' | 'failed' | 'merged' | 'stale';
  title: string;
  agent: string;
  runtime: string;
  repo: string;
  repoSlug?: string;
  repoPath: string;
  branch: string;
  baseBranch?: string;
  baseSha?: string;
  headSha?: string;
  worktreePath?: string;
  changedFiles: ReviewChangedFile[];
  fileCount: number;
  additions: number;
  deletions: number;
  diffAvailable: boolean;
  previewUrl?: string | null;
  terminalSessionName?: string | null;
  actions: Array<'inspect' | 'comment' | 'approve' | 'request_changes' | 'deny' | 'steer' | 'stop'>;
  staleReason?: string;
}

export interface MobileReviewFileDetail {
  path: string;
  status: ReviewChangedFile['status'];
  additions?: number | null;
  deletions?: number | null;
  originalPath?: string;
  currentPath?: string;
  note: string;
  preview: string;
  /** Producer provenance: partial patches require complete-source certification. */
  previewKind?: 'file' | 'diff';
  /** Last commit message that touched this file (free — from git log) */
  commitSummary?: string;
  /** Commit author */
  commitAuthor?: string;
  /** Relative time of last commit */
  commitAge?: string;
}

export interface MobileInboxSnapshot {
  generatedAt: string;
  mode: 'live' | 'demo' | 'stale';
  sourceLabel: string;
  primarySessionKey?: string;
  note?: string;
  sessions: AgentSummary[];
  fleetSessions: MobileFleetSession[];
  approvals: MobileApprovalCard[];
  reviewUnits: MobileReviewUnit[];
  items: MobileInboxItem[];
  summary: MobileInboxSummary;
  review?: MobileReviewFocus;
}

export type MobileTranscriptMediaKind = 'image' | 'pdf' | 'file';

export interface MobileTranscriptMedia {
  kind: MobileTranscriptMediaKind;
  path: string;
  name: string;
  mimeType?: string;
}

/**
 * Tool-call rendering class. The orchestrator chat tile picks a visual
 * weight per tool based on what that tool actually does to the world:
 *
 *   - `read`  — inspection only (Read, Grep, list_* MCP queries, read-only
 *               shell). Renders as a single-line chip, dim color. REPL vibe.
 *   - `write` — mutates state (Edit/Write, dispatch_mission, approve_*,
 *               side-effecting Bash). Renders as a bordered card with an
 *               amber left-accent and, when targeting a file, a
 *               "View in Changes" affordance that pivots the O8 panel.
 *   - `meta`  — ambient status pings (fleet status, health checks). One-line
 *               collapsed summary, even dimmer than reads.
 *
 * When unset, the chat falls back to the legacy unified card rendering.
 * See `src/components/desktop/thoughts/toolClassifier.ts`.
 */
export type ToolSideEffectClass = 'read' | 'write' | 'meta';

export interface MobileTranscriptToolLaunchLink {
  surfaceId: string;
  repoPath?: string | null;
  laneId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  label: string;
}

/** One titled source the Brain cited in a cortex_ask answer (Fable
 *  transparency card). Mirrors the Citation contract from qa/types.ts —
 *  every citation carries a human-readable `title` (2026-06-11 parity pass). */
export interface BrainFeedCitation {
  kind: string;
  rowId: string;
  title?: string;
  excerpt?: string;
  url?: string | null;
}

/**
 * Parsed cortex_ask tool RESULT — what the Brain fed the orchestrator this
 * turn. Populated by the orchestrator stream's `tool-result` handler (only
 * for cortex_ask calls); drives the Brain→Fable transparency card rendered
 * when the turn's backend is metered.
 */
export interface BrainFeed {
  question: string;
  answer: string;
  citations: BrainFeedCitation[];
  sourcesConsidered: number | null;
  retrievalMs: number | null;
  cacheHit: 'exact' | 'semantic' | null;
  /** Chars of source text the Brain read (composer-visible, ~1500/row cap) —
   *  the "what a raw read would have cost" offload denominator. Null when the
   *  server didn't derive it (cache hits, older servers). */
  consideredChars: number | null;
}

export interface MobileTranscriptToolCall {
  startedAt?: number;
  finishedAt?: number;
  id?: string | null;
  name: string;
  args?: Record<string, unknown>;
  /** `stopped`: the operator's Stop ended the call before it reported a result (#3659). */
  status?: 'calling' | 'running' | 'done' | 'error' | 'stopped';
  preview?: string;
  result?: string;
  sideEffectClass?: ToolSideEffectClass;
  launchLink?: MobileTranscriptToolLaunchLink | null;
  /** Orchestrator backend id of the turn that made this call — stamped from
   *  the ws event's `data.backend` by the tool-result handler. Gates the
   *  Brain→Fable transparency card to metered backends. */
  backend?: string;
  /** Structured cortex_ask answer payload — see BrainFeed. */
  brainFeed?: BrainFeed;
}

export interface MobileTranscriptSource {
  title: string;
  url?: string;
  path?: string;
  index?: number;
}

export interface MobileTranscriptThinkingStep {
  type: 'thinking' | 'tool' | 'search' | 'reading' | 'analyzing';
  label: string;
  description?: string;
  status: 'active' | 'complete' | 'pending';
  detail?: string;
}

export interface MobileTranscriptCommandChip {
  label: string;
  tone?: 'blue' | 'amber' | 'emerald' | 'slate' | 'red';
}

export interface BrainAnswerCitation {
  kind: string;
  rowId: string;
  excerpt: string;
  url?: string | null;
}

export interface MobileTranscriptCommand {
  name: string;
  summary: string;
  details?: string[];
  chips?: MobileTranscriptCommandChip[];
  /** Present on /ask command entries — the streamed Brain answer + citations. */
  brainAnswer?: {
    tokens: string;
    citations: BrainAnswerCitation[];
  };
}

export interface MobileTurnReceipt {
  /** Server-correlated outcome; idle state and assistant text are not completion. */
  terminal?: { userMessageId: string; outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed' };
  permissionMode?: import('@/lib/orchestrator/permission-mode').OrchestratorPermissionMode;
  leadModel: string;
  effort: ThinkingEffort;
  mode: 'solo' | 'multitask' | 'fast' | 'moa' | 'fusion';
  pickedMode?: 'solo' | 'multitask' | 'fast' | 'moa' | 'fusion';
  workers?: Array<{
    packetId: string;
    runtime: OrchestratorRuntime;
    model: string;
  }>;
}

export type MobilePendingTurnWorkers = Record<string, NonNullable<MobileTurnReceipt['workers']>>;

// Shared transcript shape used across mobile history and runtime tails.
export interface MobileTranscriptEntry {
  /** Spoken captions are display evidence, never a runtime completion receipt. */
  voice?: import('@/lib/transcripts/voice-captions').VoiceCaption;
  /** Matching send acknowledgement or live turn activity; not turn completion. */
  deliveryConfirmed?: boolean;
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  /** Monotonic server persistence revision for this message. */
  persistedVersion?: number;
  pinned?: boolean;
  type?: 'message' | 'compaction' | 'command' | 'handoff';
  media?: MobileTranscriptMedia[];
  toolCalls?: MobileTranscriptToolCall[];
  timestamp?: number;
  timestampLabel?: string;
  /** Runtime family that authored this individual turn. */
  backend?: OrchestratorBackendId;
  model?: string;
  receipt?: MobileTurnReceipt;
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheRetentionMs?: number; cacheObserved?: boolean };
  costUsd?: number;
  sources?: MobileTranscriptSource[];
  thinking?: string;
  thinkingSteps?: MobileTranscriptThinkingStep[];
  thinkingDurationMs?: number;
  /** True while a reasoning phase is in flight for this entry. Claude 5-family
   *  thinking streams signature-only (content redacted at the API), so this
   *  marker — set on the thinking block start, cleared when the first answer
   *  token or tool call ends reasoning — is what lets the transcript show a
   *  live "Thinking" line even when `thinking` text never arrives. */
  thinkingActive?: boolean;
  claudeCodeEvents?: ClaudeCodeStreamJsonChatEvent[];
  recalledFacts?: number;
  command?: MobileTranscriptCommand;
  handoff?: {
    handoffId: string;
    from: { backend: string; model: string | null } | null;
    to: { backend: string; model: string | null };
    lossless: boolean;
    carries: Record<'narrative' | 'intent' | 'workspace' | 'governance' | 'provenance', 'full' | 'summary' | 'omitted'>;
    /** Serializable HandoffPacket snapshot for the inline detail drawer. */
    packet?: Record<string, unknown>;
  };
  compaction?: {
    timestamp: number;
    tokensBefore?: number;
    contextSource?: string;
    tokensAfter?: number;
    trigger: CompactionTrigger;
    source?: 'explicit' | 'summary' | 'inferred';
    summary?: string;
    compactedBy?: {
      backend: OrchestratorBackendId;
      model: string;
      reasoningEffort: string | null;
    };
    /** Stable archive basename; the full turns remain retrievable through /recall. */
    archiveRef?: string;
    /** Record-only judgment scores per compacted entry (#2465); nothing reads them. */
    scorer?: import('@/lib/orchestrator/compaction-scorer').CompactionScorerRecord;
  };
  /** Structured orchestrator status event (mission complete / merge / heal) — rendered as OrchestratorStatusCard. */
  statusEvent?: import('@/lib/orchestrator/status-events').OrchestratorStatusEventData;
  /**
   * Marks a system entry as an in-chat error notice (delivery failure, stream
   * error) so it renders with the warning tint instead of the neutral system
   * card. Entries persisted before this flag existed fall back to text
   * detection — see `isErrorNoticeText` in `@/lib/transcripts/error-notice`.
   */
  isError?: boolean;
  /**
   * Collide (MoA) pre-roll — the faint, collapsible "two proposals collided"
   * card that precedes the synthesized answer. Present only on Collide turns;
   * rendered as CollideProposalCard instead of the default message body.
   */
  collide?: {
    phase: 'proposing' | 'synthesizing';
    proposers: string[];
    proposals: Array<{ proposer: string; text: string; breach: boolean }>;
  };
}

export interface MobileRuntimeTailGroup {
  id: string;
  title: string;
  mode: 'launch' | 'resume';
  outcome: 'running' | 'finished' | 'interrupted' | 'failed';
  prompt: string;
  startedAt?: string;
  finishedAt?: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: MobileTranscriptEntry[];
}

export interface MobileHistoryResponse {
  sessionKey: string;
  transcript: MobileTranscriptEntry[];
  groups?: MobileRuntimeTailGroup[];
  page?: import('@/lib/llm/chat-history-pagination').ChatHistoryPageMetadata;
}

export interface MobileReviewFileResponse {
  file: MobileReviewFileDetail;
}

export interface MobileActionAttachment {
  type?: string;
  mimeType: string;
  fileName: string;
  content: string;
}

export interface MobileActionRequest {
  action: Extract<MobileControlActionKind, 'send' | 'steer' | 'stop' | 'approve' | 'request_changes' | 'deny' | 'pause' | 'resume' | 'watch' | 'resolve' | 'launch'>;
  sessionKey: string;
  clientMutationId?: string;
  approvalId?: string;
  message?: string;
  attachments?: MobileActionAttachment[];
  runId?: string;
  cwd?: string;
}

export interface MobileActionResponse {
  ok: boolean;
  action: MobileActionRequest['action'];
  sessionKey: string;
  clientMutationId?: string;
  approvalId?: string;
  status: 'queued' | 'completed' | 'unavailable' | 'sent' | 'error';
  note: string;
  runId?: string;
  aborted?: boolean;
  inProgress?: boolean;
}

// ── Mobile orchestrator surface ──
//
// The mobile Orchestrator tab reads from /api/mobile/orchestrator/threads (a
// thin projection of ~/.o8/chat-history/thoughts-*.json) and subscribes to
// the existing `orchestrator` WS channel. These shapes are deliberately
// minimal — alpha is read-mostly with a single composer.

export type MobileOrchestratorRuntime = OrchestratorRuntime | 'unknown';

/** The orchestrator backend that ran a thread — distinct from the worker `runtime`.
 *  Derived from the single backend-id source so it tracks new backends (hermes/acp). */
export type MobileOrchestratorBackend = OrchestratorBackendId;

export type MobileOrchestratorThreadStatus = 'idle' | 'ready' | 'busy' | 'failed';

export interface MobileOrchestratorThread {
  id: string;
  title: string;
  lastMessageAt: string;
  runtime: MobileOrchestratorRuntime;
  status: MobileOrchestratorThreadStatus;
  messageCount: number;
  /** Stable desktop project identity; null for legacy threads. */
  projectId: string | null;
  repoPath: string | null;
  repoName: string | null;
  repoBranch: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  /** Orchestrator backend, when the thread was tagged; null for legacy threads. */
  backend: MobileOrchestratorBackend | null;
  /** openclaw agent id that ran the thread; null for non-openclaw/untagged. */
  agent: string | null;
  /** Whether the chat-history thread is pinned on the desktop. */
  pinned?: boolean;
}

/**
 * One dispatched agent / packet for the mobile orchestrator pill (the strip
 * above the orchestrator chat listing what the orchestrator has dispatched).
 * Projected by /api/mobile/orchestrator/packets from an OrchestratorPacket +
 * its live lane.
 */
export interface MobileOrchestratorAgent {
  /** Packet id. */
  id: string;
  /** What the agent was dispatched to do (packet title, falling back to summary). */
  title: string;
  runtime: MobileOrchestratorRuntime;
  /** Collapsed packet lifecycle — see mapPacketStatus in the route. */
  status: MobileAgentStatus;
  /** Worker-posted huddle plan, when status === 'huddling'. */
  huddlePlan?: string;
  /** Latest lane/packet event label for additive mobile rendering. */
  lastEventLabel?: string | null;
  /** Preserved work details when an unreleased packet was archived recoverably. */
  recovery?: OrchestratorPacketRecovery | null;
  /** Worktree branch the agent commits to. */
  branch: string;
  /** Diff stats for the agent's worktree (zeros for queued packets). */
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Lane runtime session key when the lane is live, else null. */
  sessionKey: string | null;
}

/**
 * One entry in the mobile fleet activity feed. Projected by
 * /api/mobile/activity from recent git commits across the repos in o8's
 * registry, optionally folded together with orchestrator packet lifecycle
 * events. Newest-first, capped at ~40 entries.
 */
export interface MobileActivityEvent {
  /** Stable id — `commit:<sha>` for commits, `packet:<id>` for packet events. */
  id: string;
  /**
   * Additive provenance for clients that distinguish observed repository work
   * from activity initiated through o8's control plane. Older clients can
   * ignore this field.
   */
  source?: 'git' | 'orchestrator';
  /** Stable tracked-repository id when the event came from the repo registry. */
  repoId?: string;
  /** Full commit SHA when source === 'git'. */
  commitSha?: string;
  /** Git author display name when source === 'git'. */
  author?: string;
  /**
   * Ref through which Git surfaced the commit, e.g. `main`,
   * `agent/mobile-activity`, or `origin/main`.
   */
  observedRef?: string;
  /** Exact aggregate file count reported by Git for this commit. */
  filesChanged?: number;
  /** Exact text-line additions reported by Git; binary files contribute zero. */
  additions?: number;
  /** Exact text-line deletions reported by Git; binary files contribute zero. */
  deletions?: number;
  /** Bounded sample of Git-reported paths touched by this commit. */
  relatedFiles?: string[];
  /** True when relatedFiles omits paths beyond its server-side cap. */
  relatedFilesTruncated?: boolean;
  /**
   *   - `commit`          — a non-merge git commit.
   *   - `merge`           — a git merge commit (>1 parent) or a released packet.
   *   - `dispatched`      — a packet that is launching / running.
   *   - `awaiting_review` — a packet whose work is done and awaiting review.
   *   - `huddle`          — a worker posted its huddle plan and is awaiting alignment.
   *   - `alert`           — a failed / blocked packet.
   */
  kind: 'dispatched' | 'huddle' | 'awaiting_review' | 'merge' | 'commit' | 'alert';
  /** Primary line — commit subject or packet title. */
  title: string;
  /** Secondary line, e.g. `"main · 9393504"` or `"agent/x → main"`. */
  detail?: string;
  /** Optional URL the mobile app can open to inspect/test this work. */
  previewUrl?: string;
  /** Optional review/operator comments displayed in mobile activity details. */
  comments?: string[];
  /** Short repo name, e.g. `"o8"`. */
  repo?: string;
  /** Event time as epoch milliseconds. */
  timestamp: number;
}

/**
 * Per-day commit counts returned by /api/mobile/activity as `commitCounts`.
 * Computed from a dated `git log --all --since` query per tracked repo, so the
 * counts cover the whole window regardless of the capped `events` list.
 */
export interface MobileCommitDayCounts {
  /**
   * Day boundary used for bucketing, in minutes east of UTC. Echoes the
   * `utcOffsetMinutes` query param; 0 (UTC days) when absent or invalid.
   */
  utcOffsetMinutes: number;
  /**
   * Today plus the seven preceding days, oldest first. Every day is present;
   * a day without commits has `count: 0`. Commits are deduplicated per repo
   * and summed across tracked repos, dated by committer date.
   */
  days: Array<{ /** Local calendar date, `YYYY-MM-DD`. */ date: string; count: number }>;
}

/** Response body of GET /api/mobile/activity. */
export interface MobileActivityResponse {
  /** Newest-first receipts, capped at 40. */
  events: MobileActivityEvent[];
  /** Additive field; older clients ignore it. */
  commitCounts: MobileCommitDayCounts;
}

export type MobileOrchestratorTranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MobileOrchestratorTranscriptEntry {
  id: string;
  role: MobileOrchestratorTranscriptRole;
  text: string;
  thinking?: boolean;
  toolName?: string;
  /** Tool entries flip to true when the matching tool-result arrives. */
  toolDone?: boolean;
  /** Short preview of the tool's output (first line, truncated). */
  toolPreview?: string;
  timestamp: number;
  /** User entry waiting for a reconnect/replay (offline send queue). */
  queued?: boolean;
  /** Stable id matching the pending-queue entry — used for retry/discard. */
  queueId?: string;
  /** Queued >= 1h — UI shows Retry / Discard instead of auto-replaying. */
  queueStale?: boolean;
}
