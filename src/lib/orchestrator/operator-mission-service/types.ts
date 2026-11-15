import type { ReviewRunEvidence } from '@/lib/orchestrator/review-run-evidence';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import type {
  OrchestratorRuntime,
  PacketDispatcherAttribution,
  PacketTaskContract,
  WorkerLaunchContext,
  WorkerIntent,
  WorkerProvider,
} from '@/lib/orchestrator/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { RuntimePresetId } from '@/lib/orchestrator/runtime-capabilities';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';

export interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  /**
   * Optional per-issue worker runtime — lets one mission mix Codex + Gemini
   * packets (the swarm "split coding/thinking" path). Falls back to the
   * mission-level `runtime` when unset; routing still validates dispatchability.
   */
  runtime?: OrchestratorRuntime;
}

export type ExistingBranchPolicy = 'auto' | 'reset' | 'continue' | 'error';

export interface CreateMissionInput {
  issues: LoadedIssue[];
  repoPath: string;
  /** Exact project identity captured before preparation; omission resolves the creation context. */
  projectId?: string | null;
  runtime: OrchestratorRuntime;
  /** Durable packet origin for Design Mode follow-up routing. */
  origin?: 'design-mode';
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  /** Semantic model preset resolved independently for each packet runtime. */
  runtimePreset?: RuntimePresetId;
  /** Explicit per-packet model pin for Claude Code workers. */
  claudeCodeModel?: string | null;
  /** Explicit per-packet carrier pin for Claude Code workers. */
  claudeCodeCarrier?: ClaudeCodeModelSource | null;
  /** Optional execution wrapper. Omit to inherit the persisted operator setting. */
  executionCarrier?: ExecutionCarrierId | null;
  /** Requested worker reasoning effort. Applied at launch only for runtimes with
   *  a reasoning-effort surface (codex/claude-code); a no-op elsewhere. Omit for
   *  today's behavior (runtime default). */
  requestedEffort?: ThinkingEffort | null;
  constraints: string;
  /** Durable scheduler admission for callers that explicitly requested immediate dispatch. */
  dispatchOnCreate?: boolean;
  /** Persisted only for exact post-crash receipt reconciliation. */
  clientMutationId?: string | null;
  /** When true, packets are chained sequentially (P2 after P1, etc.). Default: false (parallel). */
  sequential?: boolean;
  /** How create_mission handles an existing issue/inline dispatch branch. Default: auto. */
  existingBranchPolicy?: ExistingBranchPolicy;
  /**
   * Per-mission Engineering Brain override (2026-06-11) — stamps every packet's
   * `useBrain`. Omit to inherit the operator `workersUseBrain` setting.
   */
  useBrain?: boolean;
  /** #3740: stamp every packet's `mergeHold`, so approved reviews wait for the operator's merge. */
  holdMerges?: boolean;
  /**
   * Originating orchestrator thread id (#1329). When set, every packet in the
   * mission inherits the thread's active session rules (via `buildPacketPrompt`)
   * and dispatch stamps a `rules_applied` lane event. Omit for thread-less
   * dispatches (no session-rule inheritance).
   */
  orchestratorThreadId?: string | null;
  /** Exact assistant transcript entry that receives successful worker launches. */
  orchestratorTurnId?: string | null;
  /** Durable origin for routing review-worthy terminal work back to its caller. */
  dispatcher?: PacketDispatcherAttribution | null;
  /** Outside-launch provenance; transient repos are not written to Projects. */
  launchContext?: WorkerLaunchContext | null;
  /**
   * Huddle mode (#1282) — stamps every packet's `huddle`. When true, each
   * worker aligns with the orchestrator (posts plan + pushback, then STOPS)
   * before editing. Armed per-mission; omit (default off) for clear packets.
   */
  huddle?: boolean;
  /** Disable the pre-edit task contract for every packet in this mission. */
  taskContract?: 'off';
  sealedTaskContract?: PacketTaskContract;
  /**
   * Best-of-N — stamps the seed packet's
   * `comparisonModels` so the scheduler fans it into N sibling candidates (one
   * per model string), each in its own worktree/lane. The operator then compares
   * the N diffs side-by-side and merges the winner through the review gate.
   * Same model repeated (e.g. `['codex','codex','codex']`) races N attempts of
   * the one runtime. Clamped to ≤4 at the route. Omit for a normal single packet.
   */
  comparisonModels?: string[];
  /** Opt-in bounded quality search. Restricted to one task and one sealed
   * contract so both candidates start from identical requirements. */
  qualitySearch?: {
    taskContract: PacketTaskContract;
  };
}

export interface DispatchMissionInput {
  force?: boolean;
  missionId?: string;
  runtime?: OrchestratorRuntime;
}

export interface MissionStatusInput {
  missionId?: string;
  includeCost: boolean;
  includeTiming?: boolean;
}

export interface SubmitReviewInput {
  /** Server-resolved caller; never read from request JSON. */
  submissionPrincipal?: import('@/lib/auth/review-submission').ReviewSubmissionPrincipal;
  runEvidence?: ReviewRunEvidence;
  packetId: string;
  findings: OrchestratorReviewFinding[];
  approved: boolean;
  reviewedHeadSha?: string;
  /** Per-requirement evidence bound to the sealed contract and reviewed HEAD. */
  contractCoverageEvidence?: ReviewCoverageEvidence;
  /** Operator-only, current-HEAD waiver when a runtime-default contract was never captured. */
  missingContractWaiverReason?: string;
  /** #732 — Directives the review verified were respected by the diff. */
  directivesApplied?: string[];
  /** #732 — Directives the review found contradicted by the diff. */
  directivesViolated?: Array<{
    directive: string;
    file?: string;
    line?: number | null;
    snippet?: string;
  }>;
}

export interface ApproveAndMergeInput {
  packetId: string;
  commitMessage?: string;
  expectedHeadSha?: string;
  /** 'user' when the call carries a live human-operator principal (the
   *  desktop Approve & merge click, the operator CLI). Under the surface
   *  posture this satisfies the dispatcher-review hop only; merge gates and
   *  other approval postures remain authoritative. Orchestrator/worker callers
   *  omit it and keep the full approval path. */
  actor?: 'user' | 'orchestrator';
}

export interface PickComparisonWinnerInput {
  packetId: string;
  commitMessage?: string;
}

export interface ResetPacketInput {
  packetId: string;
  /** Internal: an unbound cancelled creator retains its exact rollback authority. */
  pendingProvisioningLaneIds?: string[];
  reason?: string;
  clearWorktree?: boolean;
  /**
   * Generation scope for BACKGROUNDED cleanup (#1528 stop path). When set,
   * the reset only touches the lanes captured when the stop was issued —
   * never lanes bound afterwards — skips the prefix-glob orphan worktree
   * sweep (which would rm -rf a re-dispatched packet's LIVE worktree), and
   * only applies the mission-state hold if the packet is still in the
   * operator-stopped state this cleanup belongs to. Without it a stop's
   * background reset could silently revert and destroy a legitimate
   * re-dispatch that happened during the cleanup window.
   */
  scope?: {
    laneIds: string[];
    skipHoldIfStateMoved?: boolean;
    /** Stop cleanup retains its dispatch barrier; explicit Reset clears it. */
    preserveOperatorStopped?: boolean;
    expectedReleaseSource?: string;
  };
  /**
   * Correlation for the accepted request that owns this reset (#2313). When
   * present, the reset journals its intended generation, the salvage guard it
   * stamps, and its terminal receipt against `requestKey`, so an owner that
   * exits before the idempotency receipt is persisted still leaves the request
   * a supported path to a final result. Callers without an idempotency
   * identity (stop-packet cleanup, agent-control) omit it and journal nothing.
   */
  recovery?: {
    requestKey: string;
  };
}

export interface MergePacketResult {
  merged: boolean;
  note: string;
  /** True when the requested packet had already reached a released/closed state before this call. */
  alreadyReleased?: boolean;
  /** Verified merge commit for already-released or newly merged packets. */
  mergeSha?: string;
  /** True when `mergeSha` was checked as an ancestor of the main checkout HEAD. */
  ancestryVerified?: boolean;
  approvalId?: string;
  /**
   * Structured gate verdict (#623). Populated when the merge path ran the
   * gate — preview calls, pre-dispatch gate failures, and post-dispatch
   * approvals. Omitted when the failure came from a non-gate source
   * (e.g. policy approval, orphan lane error).
   */
  checks?: MergeCheckResult[];
  /** Short category labels for every blocking gate violation. */
  blockers?: string[];
  /**
   * Back-compat derived from `blockers.join(', ')` so older UI clients
   * that read a `reason` field still render something sane. New callers
   * should prefer `blockers` / `checks`.
   */
  reason?: string;
  /** Expected worktree HEAD when optimistic locking rejects drift. */
  expectedHeadSha?: string;
  /** Reviewed worktree HEAD when review integrity rejects drift. */
  reviewedHeadSha?: string;
  /** Actual worktree HEAD when optimistic locking rejects drift. */
  currentHeadSha?: string;
}
