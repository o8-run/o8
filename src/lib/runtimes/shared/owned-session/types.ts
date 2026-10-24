/**
 * Public types for the owned-session primitive.
 *
 * These are consumed by runtime adapters (Codex today; Gemini, opencode next)
 * that wrap `createOwnedSessionStore` from `./store`.
 */

import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewCommandEvidence,
  SquadSummary,
} from '@/lib/fleet/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { LaneTurnContextUsage } from '@/lib/lane/types';
import type { ResolvedWorkerMcpServer } from '@/lib/mcp/worker-injection';
import type { SandboxDenial } from './sandbox-denial';
import type { OwnedExecutionPolicy } from './execution-policy';
import type { ControlledTaskBinding } from '@/lib/mcp/task-execution-store';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import type { OwnedIdentitySource } from './process-identity';
import type { SupervisorReference } from '@/lib/runtime/o8d-supervisor';

// ── Run / session primitives ─────────────────────────────────────────────────

export type OwnedRunMode = 'launch' | 'resume';

export type OwnedRunOutcome = 'running' | 'finished' | 'interrupted' | 'failed';

export type OwnedReviewDisposition = 'watching' | 'resolved';

export type OwnedSessionState = 'active' | 'archived' | 'missing';

export interface OwnedChildExitOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  classification: 'clean-exit' | 'nonzero-exit' | 'signal-kill';
  stderrTail?: string;
}

export interface OwnedRunRecord {
  /** Failed stop attempts for this run — bounds the orphan-sweep retry. */
  stopAttempts?: number;
  id: string;
  mode: OwnedRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  pid: number;
  supervisor?: SupervisorReference;
  /** Captured at spawn; identified runs reattach only through the same source. */
  processIdentity?: MetadataLockProcessIdentity;
  processIdentitySource?: OwnedIdentitySource;
  processIdentityRequired?: boolean;
  /** Spawned executable basename, used to reject recycled PIDs before signaling. */
  commandIdentity?: string;
  /** Durable POSIX process-group identity, retained after the leader exits. */
  processGroupId?: number;
  /** Unique inherited env marker used to find descendants that escape the original group. */
  processMarker?: string;
  /**
   * Durable spawn journal phase. `prepared` is persisted before any process
   * side effect; `started` means PID/tmux identity was advanced after spawn;
   * `reconciled_clear` means a marker scan proved the prepared intent left no
   * process behind.
   */
  spawnState?: 'prepared' | 'started' | 'reconciled_clear';
  stdoutPath: string;
  stderrPath: string;
  /** Finite provider input inherited as a regular file, independent of server stdin. */
  stdinPath?: string;
  outcome: OwnedRunOutcome;
  interruptRequestedAt?: string;
  tmuxSession?: string;
  // #4 crash-survival — how this run's process was spawned, so boot re-discovery
  // knows whether to re-bind it (detached survivors keep running through a
  // ws-server/app crash) vs salvage it. 'bridge' = ws-server-owned PTY (dies with
  // ws-server, today's default); 'detached' = setsid+unref child that outlives
  // both node processes, transcript streaming to stdoutPath.
  detachMode?: 'bridge' | 'detached';
  /** True only when this run was wrapped by sandbox-exec. */
  sandboxed?: boolean;
  /** Persisted so refresh/restart cannot re-emit the same denial event. */
  sandboxDenial?: SandboxDenial;
  childExit?: OwnedChildExitOutcome;
  /** Compatibility retry receipt, shown once beside the rejected run. */
  modelFallback?: { fromModel: string; toModel: string; notice: string };
}

export interface OwnedSessionRecord {
  surfaceId: string;
  controlledTask?: ControlledTaskBinding;
  /** Durable limits checked by every spawn and recovery entry point. */
  executionPolicy?: OwnedExecutionPolicy;
  /** Launch receipt correlation, persisted before the external process starts. */
  launchMutationId?: string;
  /** Lane known at spawn time, so an immediate child exit can reach its audit stream. */
  laneId?: string;
  /** Packet that owns this worker credential and every packet-scoped API call. */
  packetId?: string;
  sessionDir: string;
  cwd: string;
  repoPath: string;
  /** Stable logical workspace identity. The cwd may disappear while a packet is parked. */
  workspaceBinding?: OwnedWorkspaceBinding;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  initialPrompt?: string;
  latestPrompt: string;
  latestSummary: string;
  model?: string;
  /** Requested reasoning effort — applied per-runtime at launch (codex only today). */
  effort?: ThinkingEffort;
  /** Credential-free adapter configuration pinned when this session was created. */
  runtimeConfig?: Record<string, string>;
  /** Server-only config-home binding captured once at launch. */
  identity?: {
    id: string;
    label: string;
    configHomeRef: string;
  };
  reviewDisposition?: OwnedReviewDisposition;
  reviewDispositionUpdatedAt?: string;
  activeRun?: OwnedRunRecord;
  recentRuns: OwnedRunRecord[];
  /**
   * Durable proof that recentRuns still contains every run ever started for
   * this session. Once retention truncates an identity, complete stays false.
   * Legacy records omit this object and must be treated as incomplete.
   */
  runIdentityLedger?: {
    version: 1;
    totalRuns: number | null;
    complete: boolean;
  };
  /** Durable, generation-bound subscription capacity wait. */
  capacityWait?: {
    runId: string; resetsAt: string; stopVersion: number; nextProbeAt?: number;
    laneCheckpoint?: { updatedAt: string; status: string; lastEventLabel: string | null };
  };
  /** Consumed schedule; a restart holds an unproven spawn instead of replaying it. */
  capacityResumeClaim?: { runId: string; resetsAt: string; stopVersion: number };
  capacityResumeCount?: number;
  workerFailureHandledRunId?: string;
  autoRetry?: boolean;
  retryCount?: number;
  orphanedAt?: string;
  orphanedReason?: string;
  orphanedCostLine?: string;
  /** Packet ownership ended without process-exit proof; keep recovery data but hide active discovery. */
  detachedAt?: string;
  detachedReason?: string;
}

export interface OwnedWorkspaceBinding {
  logicalWorkspaceId: string;
  repositoryUuid: string | null;
  packetId: string | null;
  cwd: string;
  version: number;
  verifiedAt: string;
}

export interface OwnedWorkspaceBindingReceipt {
  /** Exact persisted record proof for quiescent archive recovery. */
  recordFingerprint?: string;
  detached?: boolean;
  surfaceId: string;
  runtimeId: string;
  sessionState: OwnedSessionState;
  binding: OwnedWorkspaceBinding;
  activeRun: Pick<OwnedRunRecord, 'pid' | 'commandIdentity' | 'processGroupId' | 'processMarker' | 'spawnState' | 'tmuxSession'> | null;
  /**
   * Every bounded run identity retained by the session that could still own a
   * process. Finished leaders stay here because a process-group member or an
   * escaped marker-bearing descendant can outlive them.
   */
  retainedRuns: Array<Pick<
    OwnedRunRecord,
    'id' | 'outcome' | 'pid' | 'commandIdentity' | 'processGroupId' | 'processMarker' | 'spawnState' | 'tmuxSession'
  >>;
  /** False means the bounded ledger omitted or conflicted with persisted run identity. */
  retainedRunsComplete: boolean;
  /** Total runs ever recorded when durable ledger truth is valid; null for legacy/corrupt state. */
  retainedRunTotal: number | null;
}

export interface RebindOwnedWorkspaceInput {
  logicalWorkspaceId: string;
  repositoryUuid: string;
  packetId: string;
  expectedCwd: string;
  nextCwd: string;
  expectedVersion: number;
}

export type RebindOwnedWorkspaceResult =
  | { status: 'rebound' | 'idempotent'; receipt: OwnedWorkspaceBindingReceipt }
  | { status: 'conflict' | 'missing' | 'archived'; receipt: OwnedWorkspaceBindingReceipt | null; note: string };

// ── Tail entries / groups ────────────────────────────────────────────────────

export interface OwnedTailEntry {
  model?: string;
  tokens?: import('@/lib/mobile/types').MobileTranscriptEntry['tokens'];
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  label: string;
  text: string;
  timestamp?: string;
  timestampLabel?: string;
  /** Provider reasoning content, kept separate from the visible answer text. */
  thinking?: string;
  /** The provider started a reasoning block but did not expose its contents. */
  thinkingActive?: boolean;
  /** A structured tool event that can be paired with its later result. */
  toolCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
    preview?: string;
    status: 'running' | 'done' | 'error';
    result?: string;
  };
}

export interface OwnedTailGroup {
  id: string;
  title: string;
  mode: OwnedRunMode;
  outcome: OwnedRunOutcome;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: OwnedTailEntry[];
}

export interface ParsedRunLog {
  threadId?: string;
  entries: OwnedTailEntry[];
  outcome: OwnedRunOutcome;
  completedTurn: boolean;
  /** Structured terminal failure reported by the provider despite a clean process exit. */
  providerFailure?: {
    subtype?: string;
    message?: string;
  };
  turnContextUsage?: LaneTurnContextUsage;
}

export interface OwnedRunEvidence {
  assistantSummary?: string;
  commands: RuntimeReviewCommandEvidence[];
}

// ── Fleet additions ──────────────────────────────────────────────────────────

export interface OwnedFleetAdditions {
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
  ownedThreadIds: string[];
}

/** Backwards-compat alias — Codex originally exported this name. */
export type OwnedCodexFleetAdditions = OwnedFleetAdditions;

// ── Public launch I/O ────────────────────────────────────────────────────────

export interface OwnedLaunchRequest {
  cwd: string;
  controlledTask?: ControlledTaskBinding;
  executionPolicy?: 'single-attempt';
  prompt: string;
  taskName?: string;
  clientMutationId?: string;
  laneId?: string;
  packetId?: string;
  model?: string;
  /** Requested reasoning effort — a per-runtime no-op unless the adapter uses it. */
  effort?: ThinkingEffort;
  /** Credential-free adapter configuration to pin for launch and retry. */
  runtimeConfig?: Record<string, string>;
}

export interface OwnedLaunchResponse {
  ok: boolean;
  runtime: string;
  surfaceId: string;
  note: string;
  sideEffect?: 'none' | 'unknown';
}

export interface OwnedArchiveResponse {
  archived: boolean;
  note: string;
  archivePath?: string;
}

// ── Adapter contract ─────────────────────────────────────────────────────────

/**
 * Per-runtime adapter passed to `createOwnedSessionStore`. Contains everything
 * that must vary between Codex, Gemini, opencode, etc.
 */
export interface OwnedRuntimeAdapter {
  /** Fresh capacity for this exact session/account; never performs model inference. */
  observeCapacity?: (session: OwnedSessionRecord) => Promise<import('@/lib/runtimes/types').RuntimeCapacitySnapshot>;
  /** Internal id: 'codex' | 'gemini' | 'opencode'. */
  runtimeId: string;

  /**
   * Prefix for surface ids. Codex uses 'codex-owned:' and must not change
   * (existing sessions on disk depend on it). New runtimes pick their own
   * prefix, e.g. 'gemini-owned:'.
   */
  surfaceIdPrefix: string;

  /** Env var name whose value overrides the root session dir. */
  rootEnvVar: string;

  /** Absolute path used when `rootEnvVar` is unset. */
  rootDefault: string;

  /** CLI binary name used by the shared cli-resolver. */
  binaryName: string;

  /** Env-var override for the CLI binary (e.g. `'O8_CODEX_BIN'`). */
  binaryEnvOverride: string;

  /** Additional env-var overrides for the CLI binary. */
  binaryExtraEnvOverrides?: string[];

  /**
   * Optional env-var augmentation for the spawned CLI child. Returned values
   * are merged on top of the allowlisted worker env (overriding existing keys).
   * Used by adapters that need to translate one auth-var alias into another
   * (e.g. gemini CLI in stream-json mode reads GEMINI_API_KEY but the user
   * may only have GOOGLE_GENERATIVE_AI_API_KEY set in their shell). Called
   * lazily at spawn time so env reads stay current.
   */
  extraSpawnEnv?: (session: OwnedSessionRecord) => Record<string, string> | Promise<Record<string, string>>;

  /** Capture trusted adapter state before initial persistence, never during spawn preparation. */
  captureRuntimeConfig?: (config?: Record<string, string>) => Record<string, string>;

  /** Supported isolated config-home variable for session-pinned identities. */
  isolatedConfigHomeEnv?: string;
  /** A runtime state folder below a shared configuration root, so sandbox grants stay narrow. */
  configStateSubdir?: string;
  /** Separate mutable session-data root for CLIs using XDG configuration and data directories. */
  sessionDataHomeEnv?: string;
  sessionDataSubdir?: string;

  /** How this adapter attaches operator-registered MCP servers to packet workers. */
  workerMcpInjection?: 'config-file' | 'config-override';

  /** Current local config home captured when a packet has no named identity. */
  defaultConfigHome?: () => string;

  /**
   * Human-readable label used in fleet metadata. Codex: 'Owned Codex'.
   * Interpolated into source labels, current-task copy, etc.
   */
  humanLabel: string;

  /** Short name used in squad/agent labels. Codex: `'Codex'`. */
  squadShortName: string;

  /** Session-id prefix. Codex uses `'codex-owned-'`. */
  sessionIdPrefix?: string;

  /** Default model when the launcher omits it. */
  defaultModel?: string;

  /** Build argv for a fresh (launch) run. */
  launchArgs(ctx: {
    cwd: string;
    sessionDir?: string;
    prompt: string;
    model?: string;
    effort?: ThinkingEffort;
    workerMcpConfigPath?: string;
    workerMcpServers?: ResolvedWorkerMcpServer[];
    /** Config pinned when the session was created (carrier, spend cap, work mode). */
    runtimeConfig?: Record<string, string>;
  }): string[];

  /** Optional stdin payload for runtimes launched as interactive stream processors. */
  launchStdin?(ctx: { cwd: string; prompt: string; model?: string; effort?: ThinkingEffort }): string | null;

  /** Optional input for a fresh process continuing a saved conversation. */
  resumeStdin?(ctx: { cwd: string; prompt: string; model?: string; effort?: ThinkingEffort }): string | null;

  /**
   * Build argv for a resume run. Return null to signal this runtime cannot
   * thread-resume via CLI — the store will raise a friendly "no resume
   * available" error so callers can route through the dispatcher.
   */
  resumeArgs(ctx: {
    threadId: string;
    sessionDir?: string;
    prompt: string;
    model?: string;
    effort?: ThinkingEffort;
    workerMcpConfigPath?: string;
    workerMcpServers?: ResolvedWorkerMcpServer[];
    /** Config pinned when the session was created (carrier, spend cap, work mode). */
    runtimeConfig?: Record<string, string>;
  }): string[] | null;

  /** Parse a run's stdout into normalized entries + outcome + discovered thread id. */
  parseRunLog(raw: string, run: OwnedRunRecord, fallbackTimestamp?: string): ParsedRunLog;

  /**
   * Extract command/tool evidence + an assistant summary for the review packet.
   * When omitted, the review packet still builds but without structured
   * command evidence.
   */
  parseRunEvidence?(raw: string, run: OwnedRunRecord, resolvedOutcome: OwnedRunOutcome): OwnedRunEvidence;

  /** Stderr patterns ignored when deciding run outcome. */
  stderrNoise?: RegExp[];

  /** Optional run summarizer. Default uses the latest prompt. */
  summarizeRun?(parsed: ParsedRunLog, run: OwnedRunRecord): string;

  /** Delay before auto-retrying a fresh failure. Default `5000ms`. */
  retryDelayMs?: number;

  /** Tail group copy for a launch turn. Default `'Launch turn'`. */
  launchGroupLabel?: string;

  /** Tail group copy for a resume turn. Default `'Resume turn'`. */
  resumeGroupLabel?: string;

  /**
   * Optional model-fallback hook. Called when a run has just failed and the
   * store is about to auto-retry. Return a new model id to swap the session's
   * model before the retry (and emit a `runtime_fallback` notification), or
   * null to keep the current model. Used by Gemini to cascade from
   * gemini-3-pro-preview → gemini-3.1-pro-preview → gemini-2.5-pro when a
   * model hits its daily quota.
   */
  chooseRetryModel?(ctx: {
    failedRunRaw: string;
    currentModel: string | undefined;
  }): { nextModel: string; reason: string } | null;

  /** One pre-turn model rejection may recover even when general auto-retry is disabled. */
  modelCompatibilityFallback?(model: string | undefined, diagnostic: string): { nextModel: string; notice: string } | null;
}

// ── Store contract ───────────────────────────────────────────────────────────

import type { RuntimeReviewPacket, RuntimeSurfaceSummary } from '@/lib/fleet/types';

/**
 * Store contract returned from `createOwnedSessionStore`. Every method keeps
 * the same behavioural contract the Codex implementation had — the adapter
 * only changes what's runtime-specific (argv, parser, noise).
 */
export interface OwnedSessionStore {
  readonly runtimeId: string;
  readonly surfaceIdPrefix: string;

  launch(request: OwnedLaunchRequest): Promise<OwnedLaunchResponse>;
  resume(surfaceId: string, prompt: string): Promise<{
    ok: boolean;
    note: string;
    sideEffect?: 'none' | 'unknown';
  }>;
  interrupt(surfaceId: string): Promise<{ interrupted: boolean; note: string }>;
  getRuntimeTail(surfaceId: string, limit?: number): Promise<{
    surface: RuntimeSurfaceSummary;
    entries: OwnedTailEntry[];
    groups: OwnedTailGroup[];
  }>;
  getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket>;
  getFleetAdditions(options?: { fresh?: boolean }): Promise<OwnedFleetAdditions>;
  sessionState(surfaceId: string): Promise<OwnedSessionState>;
  archiveSession(surfaceId: string): Promise<OwnedArchiveResponse>;
  setDetachedSession?(surfaceId: string, reason: string | null): Promise<{
    updated: boolean;
    previouslyDetached: boolean;
    note: string;
  }>;
  /** #1292 — archive owned-session dirs not bound to an active lane (orphans) so
   *  discovery can't re-spawn phantom lanes. Skips active/in-flight sessions. */
  sweepOrphanedSessions(activeSurfaceIds: Set<string>, maxAgeMs: number): Promise<number>;
  getTelemetrySources(surfaceId: string): Promise<{
    threadId?: string;
    model?: string;
    stdoutPaths: string[];
  } | null>;
  getSessionIdentityId(surfaceId: string): Promise<string | null>;
  getWorkspaceBinding?(surfaceId: string): Promise<OwnedWorkspaceBindingReceipt | null>;
  recoverArchivedWorkspace?(
    surfaceId: string, expected: OwnedWorkspaceBindingReceipt, publish: () => void,
  ): Promise<OwnedWorkspaceBindingReceipt>;
  rebindWorkspace?(
    surfaceId: string,
    input: RebindOwnedWorkspaceInput,
  ): Promise<RebindOwnedWorkspaceResult>;
  setReviewDisposition(
    surfaceId: string,
    disposition: OwnedReviewDisposition,
  ): Promise<{ disposition: OwnedReviewDisposition; note: string }>;
  invalidateFleetCache(): void;
}
