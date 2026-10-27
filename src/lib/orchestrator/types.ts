import type { OutcomeMemoryProvenance } from '@/lib/cortex/memory-provenance';
// Orchestrator domain types — runtimes, packets, lanes
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { QualitySearchPacketState } from '@/lib/orchestrator/quality-search';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime, RuntimeWorkerProvider } from '@/lib/orchestrator/runtime-capabilities';
import type { PacketSpendCap, PacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import type { PacketContextTelemetry } from '@/lib/orchestrator/packet-context-telemetry';
import type { AgentSummary } from '@/lib/fleet/types';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';

export type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
export type OrchestratorExecutionMode = 'fleet' | 'single' | 'fusion';
export type OrchestrationMode = OrchestratorExecutionMode | 'chat';
export type OrchestratorPacketReviewSeverity = 'info' | 'warning' | 'high';
export type WorkerIntent = 'light_worker' | 'heavy_worker' | 'reviewer' | 'diagnostic' | 'orchestrator';
export type WorkerProvider = RuntimeWorkerProvider | 'minimax';
export type WorkerRoutingConfidence = 'high' | 'medium' | 'low';
export type WorkerModelDisposition = 'requested' | 'runtime-default' | 'rejected-incompatible';

export type WorkerLaunchSource = 'desktop' | 'cli' | 'mcp' | 'agent';
export type WorkerLaunchPresentation = 'tab' | 'split';
export type WorkerRepoContext = 'registered' | 'transient';
export type WorkerWorkMode = 'edit' | 'read-only';

/**
 * Durable context for work launched outside the desktop UI. A transient repo
 * is supervised for this mission without being added to the user's saved
 * Projects list. The presentation hint only controls how the desktop reveals
 * the worker; it does not change packet governance or persistence.
 */
export interface WorkerLaunchContext {
  source: WorkerLaunchSource;
  presentation: WorkerLaunchPresentation;
  repoContext: WorkerRepoContext;
  workMode?: WorkerWorkMode;
  caller?: string | null;
  /** Durable desktop placement for reconnects. Omit for parentless launches. */
  parentWorkspaceId?: string | null;
  /** Durable orchestrator thread that launched the worker. */
  parentThreadId?: string | null;
  /** Shared workers stay in one checkout and must not be auto-relaunched. */
  checkoutMode?: 'shared' | 'isolated';
}

export interface WorkerRouting {
  workerIntent: WorkerIntent;
  requestedProvider: WorkerProvider | null;
  requestedRuntime: OrchestratorRuntime | null;
  requestedModel: string | null;
  /** Requested reasoning effort — carried through so it survives round-trips. */
  requestedEffort: ThinkingEffort | null;
  selectedProvider: WorkerProvider;
  selectedRuntime: OrchestratorRuntime;
  selectedModel: string | null;
  modelDisposition: WorkerModelDisposition;
  /** Effort actually applied — the request when the selected runtime supports a
   *  reasoning-effort surface (codex / claude-code), else null (gemini/opencode
   *  don't, so it's a clean no-op). */
  selectedEffort: ThinkingEffort | null;
  enforcement: 'dispatchable_runtimes';
  confidence: WorkerRoutingConfidence;
  reason: string;
  decidedAt: string;
}

export type OrchestratorPacketStatus =
  | 'draft'
  | 'queued'
  | 'launching'
  | 'idle'
  | 'running'
  | 'awaiting_review'
  | 'recovering'
  | 'failed'
  | 'blocked'
  | 'released'
  | 'archived';

export type OrchestratorQueueState = 'draft' | 'queued' | 'held';
export type OrchestratorReleaseState = 'pending' | 'released';

export interface OrchestratorReleaseStatePayload {
  mergeCommit?: string | null;
  releasedAt?: string | null;
  source?: string | null;
  /** Packet HEAD the release was proved against, so later drift is detectable. */
  headSha?: string | null;
  /** How the merge was proven: 'ancestor' | 'patch-id' | path-specific. */
  evidenceKind?: string | null;
}

export interface OrchestratorPacketRecovery {
  outcome: 'archived_recoverable';
  preservedRef: string;
  preservedHeadSha: string | null;
  message: string;
  recommendedAction: 'retry_packet';
}

export interface OrchestratorWorkspaceTarget {
  id: string;
  label: string;
  repoName: string;
  localPath: string;
  branch?: string | null;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

/**
 * Sentinel `tileId` / `tabId` written into the lane binding when a packet
 * is dispatched server-side (the MCP `dispatch_mission` path) without a
 * caller-provided UI tile context. Empty strings used to live here — but
 * `hasInteractiveLane` and `hasLaneBinding` use truthy checks on these
 * fields, so empty strings silently hid the Focus button for every
 * MCP-dispatched packet (#1113). The sentinel keeps those checks truthy
 * while still being distinguishable from a real workspace-tile binding.
 */
export const MCP_DISPATCH_TILE_SENTINEL = 'mcp-dispatch';

export interface OrchestratorLaneBinding {
  tileId: string;
  tabId: string;
  repoPath: string | null;
  worktreePath?: string | null;
  runtime: OrchestratorRuntime;
  model?: string | null;
  sessionKey?: string | null;
  laneId?: string | null;
  lastHeartbeatAt?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
  mergeMode?: LaneMergeMode;
  mergeModeNote?: string | null;
  /** Worktree dependency setup selected during launch. */
  dependencyMaterializationMode?: 'native' | 'image' | null;
}

export interface OrchestratorPacketReviewFinding {
  file: string;
  line?: number | null;
  severity: OrchestratorPacketReviewSeverity;
  description: string;
  resolution: 'fixed' | 'accepted' | 'deferred';
  fixSuggestion?: string | null;
}

export interface OrchestratorPacketReviewDirectiveViolation {
  /** Directive identifier — title from front matter, filename, or first-line slug. */
  directive: string;
  /** File path where the violation was found, relative to the repo root. */
  file?: string | null;
  /** Line number of the violating change. */
  line?: number | null;
  /** Optional short code snippet (single line) showing the violation. */
  snippet?: string | null;
}

export interface OrchestratorPacketReview {
  approved: boolean;
  findings: OrchestratorPacketReviewFinding[];
  recordedAt: string;
  reviewedHeadSha?: string | null;
  summary: string;
  auditApprovalId?: string | null;
  /**
   * #732 — Directives the review verified were respected by the diff. Names
   * align with directive titles / filenames returned by `get_packet_scope`.
   */
  directivesApplied?: string[];
  /**
   * #732 — Directives the review found contradicted by the diff. Each entry
   * names the directive plus the offending file:line so the operator can
   * jump straight to the violation.
   */
  directivesViolated?: OrchestratorPacketReviewDirectiveViolation[];
}

/**
 * Tagged packet variants the pipeline can recognize. Default (undefined) is
 * a regular feature/fix packet driven by an issue. `decompose` is reserved
 * for post-merge decomposition packets fanned out by the governance
 * pipeline (#538) — those run at queue tail and carry {@link
 * OrchestratorDecompositionMetadata}.
 */
export type OrchestratorPacketType = 'decompose';

/**
 * Metadata carried by a `decompose` packet. `targetFile` is the repo-relative
 * path that tripped the 800-line ceiling; `postMergeSha` is the merge commit
 * whose diff pushed the file over the threshold (used to diff the parent and
 * confirm the merge actually added lines, so pre-existing debt is skipped).
 */
export interface OrchestratorDecompositionMetadata {
  targetFile: string;
  postMergeSha: string;
  lineCount: number;
}

export interface PacketTaskContractRequirement {
  id: string;
  /** Exact task wording or a concise, traceable anchor to it. */
  source: string;
  /** Observable behavior the implementation must produce. */
  expectedBehavior: string;
  /** Real entry point and call path expected to exercise the behavior. */
  productionPath: string;
  /** Command or concrete evidence that will prove the requirement. */
  verification: string;
}

export interface PacketTaskContractRoute {
  /** Repo-relative file or bounded change unit in the smallest credible design. */
  path: string;
  /** Requirement IDs served by this change unit. */
  requirements: string[];
  /** Why this unit belongs in the smallest complete route. */
  reason: string;
}

export interface PacketTaskContractProcessConstraint {
  id: string;
  /** Exact task wording or a traceable anchor to it. */
  source: string;
  /** Process result that the reviewer must assess separately from the diff. */
  expectedBehavior: string;
  /** Transcript, event, or command evidence that could verify the result. */
  verification: string;
}

export interface PacketTaskContract {
  version: 1;
  requirements: PacketTaskContractRequirement[];
  smallestRoute: PacketTaskContractRoute[];
  /** Obligations that cannot honestly be proven by citing a changed file. */
  processConstraints?: PacketTaskContractProcessConstraint[];
  exclusions: string[];
}

export type PacketTaskContractSource = 'explicit' | 'default';

export interface OrchestratorPacketStorageAdmission {
  schema: 'o8/packet-storage-admission/v1';
  state: 'reserved' | 'committed' | 'held' | 'released' | 'quarantined';
  reason: string;
  reservationId: string;
  mutationId: string;
  ownerId: string;
  ownerGeneration: number;
  estimateBytes: number;
  estimateSource: 'same-repo-history' | 'source-size-fallback' | 'unknown';
  historySamples: number;
  volumeId: string | null;
  physicalAvailableBytes: number | null;
  reservedBeforeBytes: number | null;
  requiredReserveBytes: number | null;
  dispatchHeadroomBytes: number | null;
  /** Optional for backward-compatible packet receipts written before pressure policy existed. */
  pressure?: OrchestratorStoragePressureReceipt | null;
  recordedAt: number;
}

export interface OrchestratorStoragePressureCandidateReceipt {
  packetId: string;
  repositoryUuid: string | null;
  laneId: string;
  operationId: string;
  /** Workspace path the operator would reclaim; null when the lane never proved one. */
  workspacePath: string | null;
  measuredAllocatedBytes: number | null;
  verifiedReclaimedAvailableBytes: number | null;
  outcome: 'candidate' | 'parked' | 'already_parked' | 'refused';
  reason: string;
}

export interface OrchestratorStoragePressureReceipt {
  schema: 'o8/storage-pressure-decision/v1';
  mode: 'manual' | 'pressure';
  status: 'disabled' | 'manual_review' | 'admitted_after_parking' | 'exhausted';
  trigger: 'reserve_breached';
  launchGeneration: number;
  candidates: OrchestratorStoragePressureCandidateReceipt[];
  recordedAt: number;
}

export interface OrchestratorPacket {
  id: string;
  referenceLabel: string;
  title: string;
  summary: string;
  /** Project identity captured at task creation; independent of active UI selection. */
  projectId?: string | null;
  /** Packet was created from the Design Mode element-edit loop. */
  origin?: 'design-mode';
  workspaceTargetPath: string | null;
  branchTarget: string;
  runtime: OrchestratorRuntime;
  /** Resolved model that actually launched, after routing guards and defaults. */
  model?: string | null;
  dependencyLabels: string[];
  dependencyPacketIds: string[];
  queueState: OrchestratorQueueState;
  /** A staged or reset hold may be re-armed by explicit mission dispatch; an operator hold may not. */
  holdIntent?: 'explicit-dispatch' | 'operator';
  /** Server-owned claim while a manual lane is being prepared. */
  manualLaunchClaim?: { token: string; ownerPid: number; startedAt: string } | null;
  releaseState: OrchestratorReleaseState;
  releaseStatePayload?: OrchestratorReleaseStatePayload | null;
  status: OrchestratorPacketStatus;
  attemptCount?: number;
  maxAttempts?: number;
  recoveryCount?: number;
  lastRecoveryAt?: string | null;
  /**
   * Typecheck auto-rerun budget spent (#1108 layer 1). Lives ON the packet —
   * a per-lane count resets every redispatch (auto-rerun archives the lane),
   * which silently defeated the "1 extra worker turn" cost ceiling. Preserved
   * across rerun_with_feedback; zeroed only by operator reset_packet.
   */
  typecheckAutoRetries?: number;
  /**
   * Repo-tree lease-wait retry budget spent. Preserved across redispatch and
   * zeroed only by operator reset_packet, matching typecheckAutoRetries.
   */
  leaseWaitAutoRetries?: number;
  /** Follow-up Design Mode steers already accepted for this packet. */
  uiLoopIterations?: number;
  /** Wall-clock origin for this packet's Design Mode budget. */
  uiLoopStartedAt?: string;
  /**
   * Self-review-stall auto-retry budget spent (loop bound, 2026-06-22). Same
   * lifecycle as {@link typecheckAutoRetries} — lives ON the packet because a
   * per-lane count resets on every stall redispatch (the bug: a stalling packet
   * re-dispatched ~4× in an infinite loop). Capped (STALL_RETRY_CAP) so after N
   * stalls the packet goes terminal (awaiting_human) instead of relaunching.
   * Zeroed only by operator reset_packet.
   */
  stallRetries?: number;
  /**
   * Launch/attach retry budget spent. Lives ON the packet for the same reason
   * as {@link recoveryCount}: the per-LANE `LAUNCH_ATTEMPT_CAP` (lane/commands.ts)
   * resets to 0 whenever a fresh lane is minted on redispatch, so it never
   * accumulated — a launch that fails to attach fell back to idle and was
   * relaunched every ~5-10s indefinitely (observed: one lane relaunched 4,119×
   * over ~6h, never attaching). A time-based 90s launch-timeout net existed but
   * the fast relaunch reset the clock every cycle. The cure is a COUNT bound,
   * not a delay (proven via TLA+/TLC, LaunchHandshake.tla). Reset on operator
   * reset_packet and on rerun_with_feedback (a fresh dispatch earns a fresh
   * launch budget); the intra-cycle cap still stops the thrash.
   */
  launchAttempts?: number;
  /**
   * Zero-diff runtime-fault retry budget spent (#2141). Same lifecycle as
   * {@link stallRetries}: a worker that errors before writing anything gets one
   * fresh dispatch, and the count lives ON the packet because the retry mints a
   * new lane, so any per-lane counter would reset and bound nothing. Reset only
   * by operator reset_packet.
   */
  zeroDiffRuntimeRetries?: number;
  /**
   * Dispatch-preflight refusal budget spent (#2195). A refusal throws before any
   * lane exists, so every lane-bound terminal branch in reconcile is unreachable
   * and the fall-through re-derives the packet back to `queued` — the scheduler's
   * `blocked` write was un-written on the next tick and the refusal repeated
   * forever, spawning an auth probe each time. The count lives ON the packet for
   * the same reason {@link launchAttempts} does: nothing else survives the tick.
   * Cleared on a successful dispatch (the refusal was transient) and by operator
   * reset_packet.
   */
  preflightRefusals?: number;
  /**
   * Operator hit Stop — terminal "do not re-dispatch" marker. Checked first in
   * getDispatchBlocker so NO path (headless loop, stall escalation, ralph
   * requeue) can relaunch it. Cleared by reset_packet / explicit relaunch.
   */
  operatorStopped?: boolean;
  spendCap?: PacketSpendCap;
  spendTelemetry?: PacketSpendTelemetry;
  contextTelemetry?: PacketContextTelemetry;
  blockedReason?: string | null;
  /** Worker-reported or recovered completion text shown by mission status. */
  completionSummary?: string | null;
  /** Read-time status projection; recomputed from runtime or lane evidence. */
  statusEvidence?: TerminalStatusEvidence;
  /** Durable dispatch admission decision; reserved bytes are not physical usage. */
  storageAdmission?: OrchestratorPacketStorageAdmission | null;
  /** Durable lifecycle floor incremented by reset/rerun before any fresh dispatch. */
  storageAdmissionEpoch?: number;
  /** Recoverable reviewed work banked before a merge-failure escalation or
   * terminal cleanup. This remains visible even when the lane is archived. */
  recovery?: OrchestratorPacketRecovery | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
  archivedAt?: string | null;
  review?: OrchestratorPacketReview | null;
  lane?: OrchestratorLaneBinding | null;
  /**
   * Tag for governance-issued packets. When `decompose`, the packet is a
   * post-merge cleanup fanned out by the decomposition pipeline (#538); the
   * concrete metadata lives in {@link OrchestratorPacket.decomposition}.
   */
  packetType?: OrchestratorPacketType;
  /**
   * Decomposition metadata. Only populated when `packetType === 'decompose'`.
   * Allows downstream consumers (dashboards, rule-check, audit) to identify
   * a governance cleanup packet without parsing titles.
   */
  decomposition?: OrchestratorDecompositionMetadata;
  /** When set, dispatch fans out N parallel lanes — one per model. */
  comparisonModels?: string[];
  /** Links sibling packets spawned from the same best-of-n group. */
  comparisonGroupId?: string | null;
  /** Index within a comparison group (0, 1, 2...). */
  comparisonIndex?: number;
  /** The model this specific packet runs on (set during fan-out). */
  assignedModel?: string | null;
  /** Explicit model pin for a Claude Code packet. It wins over the global worker profile. */
  claudeCodeModel?: string | null;
  /** Explicit carrier pin for a Claude Code packet. It wins over the global worker profile. */
  claudeCodeCarrier?: ClaudeCodeModelSource | null;
  /** Optional argv/credential wrapper. The runtime remains the session identity owner. */
  executionCarrier?: ExecutionCarrierId | null;
  /** Opt-in two-candidate search state. The seed has a null role; fan-out
   * assigns one bounded role to each isolated candidate. */
  qualitySearch?: QualitySearchPacketState;
  /** Cheap-tier packet has had a same-house frontier escalation suggested. */
  tierEscalated?: boolean;
  /** Files predicted to be touched, computed from packet scope vs skeleton cache */
  predictedFiles?: string[];
  /** Routing scaffold: what kind of worker this task wants before runtime selection. */
  workerIntent?: WorkerIntent;
  /**
   * Per-packet Engineering Brain override (2026-06-11). When set, wins over
   * the operator-level `workersUseBrain` setting: true injects `o8 ask`
   * instructions into the worker prompt, false suppresses them. Undefined
   * inherits the setting ('auto' = on for non-frontier runtime tiers).
   */
  useBrain?: boolean;
  /**
   * Merge hold (#3740). When true, an approved review does not merge this
   * packet: any merge not made by the operator routes to an approval card.
   */
  mergeHold?: boolean;
  /**
   * Huddle mode (per-packet, armed by the orchestrator). When true,
   * `buildPacketPrompt` instructs the worker to read the repo, post its plan +
   * any pushback via `o8 packet report --event huddle`, and STOP before
   * editing — a bidirectional alignment turn. The orchestrator reviews the
   * huddle (lane → awaiting_orchestrator) and steers it (`steer_packet`, a warm
   * resume) before the worker implements. Default off — armed only on packets
   * the orchestrator wants to align on first (#1282 / Huddle).
   */
  huddle?: boolean;
  /**
   * Timestamp of the first operator response that released this packet from
   * its one-time alignment turn. The original huddle flag stays intact as
   * historical intent, while prompt assembly and zero-diff classification use
   * this marker to avoid re-arming alignment on later generations.
   */
  alignmentResolvedAt?: string;
  /**
   * Provider/runtime routing decision. Production currently enforces Codex as
   * the selected runtime while preserving requested future providers.
   */
  workerRouting?: WorkerRouting;
  /**
   * Runtime explicitly requested when this packet was created for dispatch.
   * Unlike workerRouting.requestedRuntime, normalizePacket() must not backfill
   * this from packet.runtime; boot recovery uses absence as "do not spawn".
   */
  dispatchRuntimePin?: OrchestratorRuntime | null;
  /**
   * Originating orchestrator thread id (#1329). Stamped at mission creation
   * when the dispatch came from an orchestrator thread that has session rules.
   * `buildPacketPrompt` reads it to inherit that thread's "Operator session
   * rules (binding)" block, and dispatch records a `rules_applied` lane event
   * snapshotting the exact rules. Undefined on legacy / thread-less dispatches
   * — absence simply means no session-rule inheritance (graceful degrade,
   * mirrors the {@link OrchestratorPacket.useBrain} precedent).
   */
  orchestratorThreadId?: string | null;
  /** Exact assistant transcript entry that owns this packet's turn receipt. */
  orchestratorTurnId?: string | null;
  /** Surface that created this packet. Review-worthy work routes back here. */
  dispatcher?: PacketDispatcherAttribution | null;
  /** Exact host-fetched source for an isolated pull request reviewer. */
  reviewSource?: import('@/lib/orchestrator/reviewer-pr-source-types').ReviewerPrSource;
  /** Exact host-fetched source for an isolated failed-check repair. */
  repairSource?: import('@/lib/orchestrator/reviewer-pr-source-types').ReviewerPrSource;
  /** Outside-launch provenance and desktop reveal behavior. */
  launchContext?: WorkerLaunchContext | null;
  /** Rendered packet prompt body (surfaced in details popover). Optional. */
  prompt?: string;
  /** Effective writable paths after predictions are reconciled with the task brief. */
  allowedFiles?: string[];
  /** Learned guardrails injected into the packet's prompt (surfaced in details popover). */
  learnedRules?: string[];
  /** Snapshot of the originating GitHub issue for the details popover. */
  issue?: {
    number?: number;
    body?: string;
    url?: string;
  } | null;
  /**
   * Read-before-write scaffolding (#535). Pre-computed at dispatch time by
   * `computeReadBudget` and rendered into the packet prompt so weaker models
   * behave like Codex xhigh: read the adjacent surface first, write second.
   *
   * Undefined on legacy packets — absence must NOT change behaviour.
   */
  readBudget?: {
    /** Minimum read-only tool calls required before write tools should unlock. */
    minToolCalls: number;
    /** Pre-computed 1–2 hop import-graph fan-out that should be read first. */
    requiredReads: string[];
    /** When true, the first assistant turn must emit a plan before writes. */
    planBeforeWrite: boolean;
  };
  /**
   * Edge-case surfacer output (#536). Populated by the static AST walker at
   * dispatch-prep time — plain-text descriptions of conditional branches,
   * error handlers, and reconciliation paths the model should watch for.
   *
   * Undefined on legacy packets — absence must NOT change behaviour.
   */
  edgeCaseSites?: Array<{
    /** `src/lib/foo.ts:120` — stable human-readable location. */
    location: string;
    /** One-sentence description of what could go wrong at this site. */
    description: string;
    /** Optional category for grouping in the prompt. */
    kind?: 'conditional' | 'error-handler' | 'reconciliation' | 'archive' | 'loop-exit' | 'other';
  }>;
  /**
   * Worker deviations log (#1490). Captured when the packet reaches review by
   * reading the ignored packet notes artifact from the lane worktree and
   * extracting its `## Deviations` section. Rendered ABOVE the diff in the human review
   * surfaces and fed into the auto-review context. Null/undefined → the surface
   * renders the asserted "No deviations reported" empty state.
   */
  deviations?: {
    raw: string;
    entries: string[];
    capturedAt: string;
  } | null;
  /**
   * First machine-readable task contract emitted by the worker before edits.
   * Captured from the runtime transcript at completion, persisted on the packet,
   * and supplied unchanged to every review pass. Missing means coverage and the
   * claimed smallest route were never made auditable.
   */
  taskContract?: PacketTaskContract | null;
  /** Explicit contract gate for newly created packets. Legacy/in-flight packets
   * omit it so review does not retroactively fail work dispatched before the
   * worker received contract instructions. */
  taskContractRequired?: boolean;
  /** Why the contract gate was armed. Default-armed packets can fail soft when
   * transcript capture never produced a contract; explicit packets remain hard. */
  taskContractSource?: PacketTaskContractSource;
  /** Recurring-problem provenance. Execution still belongs to the normal task packet. */
  problemDossierId?: string | null;
  /** One dossier can reopen; each accepted remedy attempt gets a stable id. */
  problemRemedyId?: string | null;
  /**
   * HTML packet explainer + quiz (#1491). Generated fire-and-forget when the
   * packet reaches review — a self-contained explainer artifact plus a
   * structured quiz the human-UI approve gate reads. `status` drives the review
   * surface: 'generating' shows a pending note, 'ready' renders the explainer,
   * 'failed' degrades to the raw diff. Undefined on legacy packets and whenever
   * explainer generation is disabled.
   */
  explainer?: {
    status: 'generating' | 'ready' | 'failed';
    /** Artifact id of the stored HTML report (kind: 'report'). */
    artifactId?: string | null;
    /** Structured quiz parsed out of the explainer; drives the approve gate. */
    quiz?: PacketExplainerQuiz | null;
    /** Files changed in the reviewed diff — the quiz-gate threshold input. */
    changedFileCount?: number | null;
    generatedAt?: string | null;
    error?: string | null;
  } | null;
  /**
   * Auto buy-in doc (#1492). Generated fire-and-forget on a successful merge —
   * a single self-contained, shareable HTML doc (demo-first, plain-language
   * what/why, deviations, verification, objections pre-answered) stored as a
   * report artifact. `status` drives the released-card affordance: 'ready'
   * surfaces a "Buy-in doc" link, other states surface nothing. Undefined on
   * legacy packets and whenever buy-in generation is disabled.
   */
  buyinDoc?: {
    status: 'generating' | 'ready' | 'failed';
    /** Artifact id of the stored HTML report (kind: 'report'). */
    artifactId?: string | null;
    generatedAt?: string | null;
    error?: string | null;
  } | null;
}

export type PacketDispatcherSurface = 'orchestrator' | 'operator' | 'agent';

export interface PacketDispatcherAttribution {
  surface: PacketDispatcherSurface;
  id: string;
}

/** A single multiple-choice quiz question in a packet explainer (#1491). */
export interface PacketExplainerQuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** Index into `options` of the correct answer. */
  answerIndex: number;
}

export interface PacketExplainerQuiz {
  questions: PacketExplainerQuizQuestion[];
}

export interface OrchestratorMissionState {
  version: 2;
  missionId?: string;
  prompt: string;
  summary: string;
  repoPath?: string | null;
  runtime?: OrchestratorRuntime;
  constraints?: string;
  /** Exact caller mutation that created this mission, used for crash receipt reconciliation. */
  creationMutationId?: string | null;
  creationReceipt?: {
    missionId: string;
    packets: Array<{ id: string; title: string; wave: number }>;
    branchPreparation: unknown[];
  } | null;
  packets: OrchestratorPacket[];
  /** Active comparison group IDs for rendering the picker UI. */
  activeComparisonGroups?: string[];
  /** Temporary admission barrier installed while a mission-wide lifecycle
   * action stabilizes every packet. Dispatch and comparison fan-out must not
   * create new work until the matching generation releases it. */
  lifecycleHold?: {
    source: string;
    reason: 'operator_stop';
    startedAt: string;
    ownerPid: number;
    leaseExpiresAt: string;
  } | null;
  updatedAt: string;
}

export type PacketSelfReviewConfidence = 'high' | 'medium' | 'low';
export type PacketSelfReviewDecision = 'implementation_ready' | 'finding_ready' | 'partial' | 'blocked';

export interface PacketSelfReview {
  passed: boolean;
  confidence: PacketSelfReviewConfidence;
  summary: string;
  issuesFound?: string[];
  /** Observable task result the worker believes its implementation supports. */
  outcome?: string;
  /** Concrete commands, artifacts, or real-path observations supporting outcome. */
  evidence?: string[];
  /** Remaining uncertainty or follow-up; `none` when the worker found no residual. */
  residual?: string;
  /** Worker handoff state. Independent review remains the closure authority. */
  decision?: PacketSelfReviewDecision;
  /** Test, invariant, validation, automation, or durable learning added against recurrence. */
  recurrenceProtection?: string;
}

export interface PacketContext extends OutcomeMemoryProvenance {
  /** Current recovery availability; the immutable completion handoff remains historical. */
  recovery?: {
    source: 'retained-source' | 'verified-preservation' | 'unavailable';
    instructions: string;
    preservationId?: string;
    bundleSha256?: string;
  };
  packetId: string;
  projectId?: string | null;
  sessionKey: string;
  /** Exact worktree HEAD captured with this completion attempt. */
  headSha?: string;
  /** Fingerprint of committed, dirty, and untracked evidence at completion. */
  diffFingerprint?: string;
  summary: string;
  changedFiles: string[];
  attemptLearnings?: string[];
  selfReview?: PacketSelfReview;
  taskContract?: PacketTaskContract;
  reviewFindings?: OrchestratorReviewFinding[];
  patterns?: string[];
  conflictZones?: string[];
  completedAt: string;
  model: string;
  review?: {
    reviewer?: string;
    approved: boolean;
    diffSha?: string;
    findings: OrchestratorReviewFinding[];
    reviewedAt: string;
  };
}

export interface DagNode {
  packetId: string;
  title: string;
  status: OrchestratorPacketStatus;
  dependsOn: string[];
  blockedBy: string[];
  wave: number;
}

export interface OrchestratorDagWave {
  wave: number;
  packetIds: string[];
  packets: DagNode[];
}

export interface OrchestratorDagMetadata {
  currentWave: number;
  totalWaves: number;
  waves: OrchestratorDagWave[];
}

export interface OrchestratorStateApiResponse {
  mission: OrchestratorMissionState;
  dag: OrchestratorDagMetadata;
  agents: AgentSummary[];
}

export interface OrchestratorStateApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface WorkspaceOrchestrationPacketBadge {
  packetId: string;
  referenceLabel: string;
  title: string;
  status: OrchestratorPacketStatus;
  runtime: OrchestratorRuntime;
  branchTarget?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

export interface OrchestratorLaneSnapshot {
  tileId: string;
  tabId: string;
  label: string;
  runtime: OrchestratorRuntime;
  sessionKey: string | null;
  repoPath: string | null;
  branch: string | null;
  status: 'idle' | 'running';
  lastActivityAt: string | null;
  packetId?: string | null;
}

export interface OrchestratorRuntimeTruth {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  status: string;
  currentTask?: string | null;
  lastEventAt?: string | null;
  workflowStageLabel?: string | null;
  canSendInput?: boolean | null;
  canInterrupt?: boolean | null;
  runtimeAvailability?: 'awaiting-thread' | 'running' | 'ready-for-resume' | null;
  ownership?: 'provider' | 'discovered' | 'owned' | null;
}

export type WorkspaceLaneTranscriptState =
  | 'no_lane'
  | 'waiting_activity'
  | 'recovering'
  | 'missing'
  | 'ready';

export interface WorkspaceLaneState {
  tileId: string;
  tabId: string | null;
  kind: 'chat' | 'llm-chat' | 'chatgpt-plan' | 'terminal' | 'canvas' | 'orchestrator' | 'fleet-canvas' | null;
  title: string;
  subtitle: string | null;
  repoPath: string | null;
  branch: string | null;
  runtime: OrchestratorRuntime | null;
  sessionKey: string | null;
  packet: WorkspaceOrchestrationPacketBadge | null;
  status: OrchestratorPacketStatus | null;
  transcriptState: WorkspaceLaneTranscriptState;
  isAdHoc: boolean;
}
