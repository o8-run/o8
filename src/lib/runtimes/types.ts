import type { BrowserSurfaceSummary } from '@/lib/browser/types';
import type { CompactionEvent } from '@/lib/runtimes/compaction-detector';
import type { DispatchCapability } from '@/lib/runtimes/shared/turn-dispatcher';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { PacketCostSource, PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';

/**
 * Universal Agent Runtime Contract
 *
 * Every coding agent runtime (Codex, Claude Code, Aider, etc.) implements
 * this interface. The UI talks to the registry, never to a specific runtime.
 *
 * Adding a new agent = one file implementing AgentRuntime.
 */

export type RuntimeKind = 'acp' | 'codex' | 'claude-code' | 'custom';
export type RuntimeId = 'codex' | 'claude-code' | 'remote-customer' | (string & {});

// ── Capabilities ──

/**
 * What a runtime can do. UI uses this to show/hide controls.
 * All default to false — a runtime opts IN to capabilities.
 */
export interface RuntimeCapabilities {
  /** Can discover existing sessions on disk/network */
  discover: boolean;
  /** Can read session transcript/history */
  readTranscript: boolean;
  /** Can launch a new session with a prompt */
  launch: boolean;
  /** Can send follow-up messages to an existing session */
  resume: boolean;
  /** Can interrupt/stop a running session */
  interrupt: boolean;
  /** Can provide changed files / diff context */
  reviewDiffs: boolean;
  /** Can provide cost/token telemetry */
  costTelemetry: boolean;
  /** Supports real-time streaming of output */
  streaming: boolean;
  /** Provider-native transforms available for durable sessions. */
  sessionTransforms?: RuntimeSessionTransformCapabilities;
  /** Capacity observation and safe local identity selection support. */
  capacity?: RuntimeCapacityCapabilities;
}

export interface RuntimeCapacityCapabilities {
  observe: boolean;
  identitySelection: boolean;
  /** Why identity switching is unavailable even when capacity can be observed. */
  identitySelectionReason?: string;
}

export type RuntimeCapacitySource = 'app-server' | 'structured-cli' | 'local-state' | 'error-inference';
export type RuntimeCapacityConfidence = 'exact' | 'estimated' | 'exhausted-only';
export type RuntimeCapacityStatus = 'available' | 'stale' | 'unavailable' | 'malformed';
export type RuntimeCapacityUnit = 'tokens' | 'requests' | 'credits';

export interface RuntimeCapacityBucket {
  id: string;
  label: string;
  usedRatio: number | null;
  used: number | null;
  unit: RuntimeCapacityUnit | null;
  remaining: number | null;
  resetsAt: string | null;
  expiresAt: string | null;
}

export interface RuntimeCapacitySnapshot {
  runtime: string;
  identityId: string | null;
  status: RuntimeCapacityStatus;
  reason: string | null;
  observedAt: string | null;
  source: RuntimeCapacitySource | null;
  confidence: RuntimeCapacityConfidence | null;
  buckets: RuntimeCapacityBucket[];
}

export interface RuntimeIdentityConfigValidation {
  ok: boolean;
  /** Canonical server-only config-home reference. Never project this to clients. */
  configHomeRef?: string;
  reason?: string;
}

export type RuntimeSessionTransformAction = 'import' | 'checkpoint' | 'fork' | 'rewind';

export type RuntimeSessionTransformCapabilities = Record<RuntimeSessionTransformAction, boolean>;

export interface RuntimeSessionTransformCapabilityDetail {
  supported: boolean;
  reason?: string;
}

export type RuntimeSessionTransformCapabilityDetails = Record<
  RuntimeSessionTransformAction,
  RuntimeSessionTransformCapabilityDetail
>;

// ── Session ──

export type RuntimeSessionStatus = 'running' | 'idle' | 'waiting' | 'reviewing' | 'failed' | 'completed';
export type RuntimeSessionOwnership = 'discovered' | 'owned' | 'provider';

/**
 * Normalized session shape. Every runtime maps its internal format to this.
 */
export interface RuntimeSession {
  /** Unique key for this session across all runtimes */
  sessionKey: string;
  /** Runtime that owns this session */
  runtimeId: RuntimeId;
  /** Human-readable name (e.g., "o8 • main") */
  displayName: string;
  /** Working directory */
  cwd: string;
  /** Git branch if known */
  branch?: string;
  /** Git commit SHA if known */
  headSha?: string;
  /** Repository slug if known (e.g., '') */
  repoSlug?: string;
  /** Current status */
  status: RuntimeSessionStatus;
  /** Ownership model */
  ownership: RuntimeSessionOwnership;
  /** What can be done with this session right now */
  sessionCapabilities: {
    canSendInput: boolean;
    canInterrupt: boolean;
    canReviewDiffs: boolean;
  };
  /** When this session was last active */
  lastActivityAt: Date;
  /** The initial task/prompt */
  initialTask?: string;
  /** Model being used */
  model?: string;
  /** Lifecycle state for owned sessions */
  lifecycle?: {
    availability: 'awaiting-thread' | 'running' | 'ready-for-resume';
    lastOutcome?: 'finished' | 'interrupted' | 'failed';
    lastRunMode?: 'launch' | 'resume';
    lastRunStartedAt?: string;
    lastRunFinishedAt?: string;
    summary?: string;
  };
  /** Process ID if running locally */
  pid?: number;
  /** Context window usage percentage (0-100) */
  contextUsedPercent?: number;
  /** tmux session name for interactive terminal attachment */
  tmuxSession?: string;
  /** Attached or mirrored browser lane, if the runtime exposes one */
  browserSurface?: BrowserSurfaceSummary;
  /** Server-safe identity reference pinned when o8 launched this session. */
  identityId?: string;
}

// ── Transcript ──

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Normalized transcript entry. Every runtime maps its log format to this.
 */
export interface RuntimeTranscriptToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  preview?: string;
  status?: 'calling' | 'running' | 'done' | 'error';
  result?: string;
}

export interface RuntimeTranscriptEntry {
  model?: string;
  tokens?: import('@/lib/mobile/types').MobileTranscriptEntry['tokens'];
  id: string;
  role: TranscriptRole;
  text: string;
  timestamp: Date;
  type?: 'message' | 'compaction';
  /** Tool name if role=tool */
  toolName?: string;
  /** File path if the entry involves a file */
  filePath?: string;
  /** Structured compaction metadata when type=compaction */
  compaction?: CompactionEvent;
  /** Structured tool calls — UI renders as italic collapsible cards (Codex parity) */
  toolCalls?: RuntimeTranscriptToolCall[];
  /** Provider reasoning content, rendered separately from the assistant answer. */
  thinking?: string;
  /** The provider started reasoning but did not expose its contents. */
  thinkingActive?: boolean;
}

// ── Review ──

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * Changed file from a session's work.
 */
export interface RuntimeChangedFile {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  originalPath?: string;
}

// ── Actions ──

/**
 * Result of a launch/resume/interrupt action.
 */
export interface RuntimeActionResult {
  ok: boolean;
  note: string;
  sessionKey?: string;
  /** Whether a failed launch is proven pre-effect or may have reached the provider. */
  sideEffect?: 'none' | 'unknown';
  /** Live process ids affected by the action, when the adapter can prove them. */
  pids?: number[];
}

export interface RuntimeSessionTransformInput {
  action: RuntimeSessionTransformAction;
  sessionKey: string;
  /** Opaque server-safe identity that owns the provider session. */
  identityId?: string;
  /** Adapter-private checkpoint reference resolved by the control service. */
  providerCheckpointRef?: string;
  /** o8-generated idempotency/reconciliation marker, never a provider id. */
  operationId?: string;
}

export interface RuntimeSessionTransformRecoveryInput {
  action: 'fork' | 'rewind';
  sessionKey: string;
  /** Opaque server-safe identity that owns the provider session. */
  identityId?: string;
  providerCheckpointRef: string;
  operationId: string;
  startedAt: string;
  /** Present when the provider replied before catalog persistence failed. */
  resultingSessionKey?: string;
}

export interface RuntimeSessionTransformProviderResult {
  ok: boolean;
  note: string;
  reason?: 'unsupported' | 'session_not_found' | 'stale_checkpoint' | 'provider_error';
  retryable?: boolean;
  /** Required on failures after a mutating provider request may have started. */
  sideEffect?: 'none' | 'unknown';
  originalSession: RuntimeSession;
  resultingSession?: RuntimeSession;
  /** Opaque outside the adapter and durable control catalog. */
  providerCheckpointRef?: string;
  providerSessionCreated?: boolean;
}

/**
 * Options for launching a new session.
 */
export interface LaunchOptions {
  /** Server-resolved account shared by admission and owned execution. */
  runtimeIdentity?: import('@/lib/runtime/identity-catalog').RuntimeLaunchIdentity;
  /** Recall epoch bound before assembling this launch prompt. */
  promptMemoryRevision?: string;
  cwd: string;
  controlledTask?: import('@/lib/mcp/task-execution-store').ControlledTaskBinding;
  executionPolicy?: 'single-attempt';
  controlledProvider?: import('@/lib/runtimes/shared/owned-session/controlled-provider').ControlledOpenRouterPolicy;
  prompt: string;
  /** Coordinator-side registered repository root; never sent to an external worker. */
  sourceRepoPath?: string;
  /** Explicit packet branch and base ref for remote execution. */
  branchName?: string;
  baseBranch?: string;
  /** Validated, immutable remote checkout contract persisted with a cloud job. */
  remoteSource?: { repoUrl: string; baseSha: string; branch: string };
  /** SHA-256 of operator-authorized manifest bytes at the dispatched base revision. */
  remoteManifestHash?: string;
  /** Resolved exclusively from the reviewed immutable workspace manifest. */
  remotePreview?: import('@/lib/cloud/preview-contract').RemotePreviewService;
  /** Coordinator-created service-only child; never supplied by a worker. */
  remoteServiceSession?: import('@/lib/cloud/review-service-contract').RemoteServiceSession;
  /** Operator-facing task name for an owned worker surface. */
  taskName?: string;
  /** Stable caller correlation persisted before an owned process is spawned. */
  clientMutationId?: string;
  model?: string;
  /** Explicit packet-only model/carrier pins for the Claude Code adapter. */
  claudeCodeModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
  executionCarrier?: ExecutionCarrierId;
  /** Requested reasoning effort — applied per-runtime (codex today); a no-op elsewhere. */
  effort?: ThinkingEffort;
  worktreeFlag?: string;
  worktreePath?: string;
  laneId?: string;
  packetId?: string;
  spendCap?: PacketSpendCap;
  /**
   * Durable packet work mode resolved from the persisted launch context.
   * 'read-only' means the runtime must launch with enforced read-only
   * permissions, not merely a read-only prompt.
   */
  workMode?: WorkerWorkMode;
}

// ── Telemetry ──

export interface RuntimeTelemetry {
  /** Billable usage across this session and any child work attributed to it. */
  totalTokens?: number;
  /** Tokens that entered this session's own context window; excludes child internals. */
  contextTokens?: number;
  /** Origin of the context measurement, separate from billable usage. */
  contextSource?: string;
  remainingTokens?: number;
  estimatedCostUsd?: number;
  costSource?: PacketCostSource;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

// ── THE CONTRACT ──

/**
 * Every agent runtime implements this interface.
 *
 * Simple runtimes can implement only discover + readTranscript.
 * Complex ones implement all methods.
 * The `capabilities` property tells the UI what's available.
 */
export interface AgentRuntime {
  /** Unique runtime identifier */
  readonly id: RuntimeId;
  /** Display name for UI */
  readonly displayName: string;
  /** What this runtime supports */
  readonly capabilities: RuntimeCapabilities;
  /**
   * How this runtime handles follow-up turns.
   * Optional during Wave 2a — adapters declare this as they migrate to
   * dispatchTurn(). Existing resume() methods remain authoritative until
   * Wave 2b/2c completes the migration.
   */
  readonly dispatchCapability?: DispatchCapability;

  // ── Discovery ──

  /**
   * Find all sessions this runtime knows about.
   * Passive reads should prefer o8-owned state and existing adapter caches;
   * explicit fresh reads may probe external CLI history and live processes.
   */
  discoverSessions(options?: { fresh?: boolean }): Promise<RuntimeSession[]>;

  // ── Transcript ──

  /**
   * Read transcript entries for a session.
   * @param sessionKey - The session to read
   * @param sinceId - Only return entries after this ID (for incremental fetch)
   * @param limit - Max entries to return
   */
  readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]>;

  // ── Lifecycle ──

  /**
   * Launch a new session with a prompt.
   */
  launch(opts: LaunchOptions): Promise<RuntimeActionResult>;

  /**
   * Send a follow-up message to an existing session.
   */
  resume(sessionKey: string, message: string): Promise<RuntimeActionResult>;

  /**
   * Interrupt/stop a running session.
   */
  interrupt(sessionKey: string): Promise<RuntimeActionResult>;

  // ── Review ──

  /**
   * Get changed files from a session's work.
   */
  getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]>;

  // ── Telemetry (optional) ──

  /**
   * Get cost/usage data for a session. Optional — return undefined if not supported.
   */
  getTelemetry?(sessionKey: string): Promise<RuntimeTelemetry | undefined>;

  /** Read one normalized, credential-free capacity snapshot. */
  getCapacity?(identityId?: string | null, options?: { fresh?: boolean }): Promise<RuntimeCapacitySnapshot> | RuntimeCapacitySnapshot;

  /** Read only the opaque launch identity ID for a session. */
  getSessionIdentityId?(sessionKey: string): Promise<string | null> | string | null;

  /** Validate and canonicalize this runtime's supported isolated config home. */
  validateIdentityConfigHome?(configHomeRef: string): Promise<RuntimeIdentityConfigValidation>;

  /** Session-scoped transform truth, which may narrow runtime-wide support. */
  getSessionTransformCapabilities?(
    sessionKey: string,
  ): Promise<RuntimeSessionTransformCapabilityDetails> | RuntimeSessionTransformCapabilityDetails;

  /** Provider-native import/checkpoint/fork/rewind implementation. */
  transformSession?(
    input: RuntimeSessionTransformInput,
  ): Promise<RuntimeSessionTransformProviderResult>;

  /** Recover a provider fork whose durable o8 catalog commit was interrupted. */
  recoverSessionTransform?(
    input: RuntimeSessionTransformRecoveryInput,
  ): Promise<RuntimeSessionTransformProviderResult | null>;
}
