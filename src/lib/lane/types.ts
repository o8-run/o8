/**
 * Lane Domain Model
 *
 * A lane is the durable operator-facing unit in o8.
 * It binds purpose + repo + optional worktree + runtime + current session.
 *
 * Entity hierarchy:
 *   Repo → Worktree → Lane → Session → Tab
 *                       ↑
 *                     Packet
 *
 * Lanes persist across session rotations. A session may die and be replaced
 * without breaking the user's mental model of the work in progress.
 */

import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import { isWorkerTerminal } from '@/lib/lane/terminal-states';

// ── Lane Status ──

/**
 * Lifecycle states a lane moves through from creation to archive.
 * Mirrors the user's mental model — they see status, not implementation details.
 */
export type LaneStatus =
  | 'idle'            // exists, no active work
  | 'launching'       // session being spawned
  | 'running'         // agent actively working
  | 'paused'          // agent idle, can resume
  | 'awaiting_input'  // agent needs a human decision
  | 'awaiting_orchestrator' // agent reported a blocker/question for o8
  | 'awaiting_human'  // layer-5 escalation: orchestrator gave up, operator must decide (NOT terminal)
  | 'recovering'      // agent/session died; operator can retry the packet
  | 'reviewing'       // work done, review needed
  | 'merging'         // merge in progress
  | 'failed'          // terminal failure, operator must redispatch or archive
  | 'completed'       // done and merged
  | 'archived';       // no longer active

const LANE_STATUS_RECORD = {
  idle: true,
  launching: true,
  running: true,
  paused: true,
  awaiting_input: true,
  awaiting_orchestrator: true,
  awaiting_human: true,
  recovering: true,
  reviewing: true,
  merging: true,
  failed: true,
  completed: true,
  archived: true,
} satisfies Record<LaneStatus, true>;

export const LANE_STATUSES = Object.keys(LANE_STATUS_RECORD) as LaneStatus[];

/** Terminal outcome of a lane's work — stamped once at the seam that ends
 *  the work (merge success, no-commit reconciliation, operator discard) so
 *  the rail can show truthful "what happened" chips after archive. */
export type LaneOutcome = 'no_changes' | 'merged' | 'discarded' | 'closed_unmerged' | 'pr_opened' | 'asked' | 'archived_recoverable';

/**
 * @deprecated Thin delegate kept for back-compat. The unified terminal-state
 * truth now lives in `lane/terminal-states.ts`. This predicate is the
 * WORKER-terminal notion (includes `reviewing`); call `isWorkerTerminal`
 * directly at new call sites, or `isLaneTerminal` when you mean the
 * lifecycle-over set.
 */
export function isTerminalLaneStatus(status: LaneStatus | null | undefined): boolean {
  return isWorkerTerminal(status);
}

/**
 * Managed = IDE spawned it, full control (steer, interrupt, review).
 * Attached = discovered existing session, inspect + capability-gated.
 */
export type LaneOwnership = 'managed' | 'attached';

// LaneRuntime intentionally mirrors OrchestratorRuntime so packets with any
// runtime can be routed through the lane system. The lane command bus
// dispatches to the correct CLI adapter at launch time.
export type LaneRuntime = OrchestratorRuntime;

// ── Lane ──

export interface Lane {
  id: string;
  projectId: string | null;
  label: string;
  repoPath: string;
  worktreePath: string | null;
  branch: string;
  baseBranch: string;
  runtime: LaneRuntime;
  model?: string | null;
  sessionKey: string | null;
  packetId: string | null;
  prNumber: number | null;
  status: LaneStatus;
  outcome?: LaneOutcome | null;
  outcomeNote?: string | null;
  ownership: LaneOwnership;
  writerToken: string | null;
  lastHeartbeatAt: number | null;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

// ── Lane Events ──

export type LaneEventActor = 'user' | 'orchestrator' | 'system';

export interface LaneTurnContextUsage {
  inputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
}

export interface LaneEvent {
  id: string;
  laneId: string;
  verb: LaneEventVerb;
  actor: LaneEventActor;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ── Lane Commands ──

export type LaneCommand =
  | {
      verb: 'open_lane';
      repoPath: string;
      projectId?: string | null;
      branch: string;
      baseBranch?: string;
      runtime: LaneRuntime;
      label?: string;
      packetId?: string;
      ownership?: LaneOwnership;
      actor?: LaneEventActor;
    }
  | {
      verb: 'bind_worktree';
      laneId: string;
      worktreePath: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'launch_session';
      promptMemoryRevision?: string;
      laneId: string;
      prompt: string;
      model?: string;
      claudeCodeModel?: string;
      claudeCodeCarrier?: ClaudeCodeModelSource;
      executionCarrier?: ExecutionCarrierId;
      spendCap?: PacketSpendCap;
      effort?: ThinkingEffort;
      /** Stable for one packet launch attempt so a crash can reconcile the owned session. */
      clientMutationId?: string;
      storageAdmissionReservationId?: string;
      launchContext?: WorkerLaunchContext;
      actor?: LaneEventActor;
    }
  | {
      verb: 'attach_session';
      laneId: string;
      sessionKey: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'send_turn';
      laneId: string;
      message: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'interrupt';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      // Operator hard-stop: interrupt the live session AND mark the packet
      // operator-stopped so the scheduler can never auto-redispatch it. Cleared
      // by reset_packet / explicit relaunch. (2026-06-22)
      verb: 'stop';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'resume';
      laneId: string;
      message?: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'request_review';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'create_pr';
      laneId: string;
      commitMessage?: string;
      /** Orchestrator review verdict — shown on the approval card */
      reviewSummary?: string;
      /** Exact spoken-review diff fingerprint expected at action time */
      expectedDiffFingerprint?: string;
      /** Receipt-bound governance fingerprint expected at action time */
      expectedGovernanceFingerprint?: string;
      /** Approval whose exact governed continuation was spoken */
      spokenReviewApprovalId?: string;
      /** Exact CAS claim that owns this spoken approval resolution */
      spokenReviewClaimId?: string;
      /** Approval version and lane state that were spoken before resolution */
      spokenReviewUpdatedAt?: number;
      spokenReviewLaneStatus?: LaneStatus;
      actor?: LaneEventActor;
    }
  | {
      verb: 'merge';
      laneId: string;
      commitMessage?: string;
      /** Orchestrator review verdict — shown on the approval card */
      reviewSummary?: string;
      /** Set true when the orchestrator has already reviewed and approved the packet */
      orchestratorReviewed?: boolean;
      /** Conflict resolution strategy from operator approval */
      strategy?: 'ours' | 'theirs' | 'manual';
      /** Reviewed worktree HEAD expected by the operator at merge time */
      expectedHeadSha?: string;
      /** Canonical mission repository; packet clones must never publish into themselves. */
      canonicalRepoPath?: string;
      /** Exact spoken-review diff fingerprint expected at merge time */
      expectedDiffFingerprint?: string;
      /** Receipt-bound governance fingerprint expected at merge time */
      expectedGovernanceFingerprint?: string;
      /** Approval whose exact governed continuation was spoken */
      spokenReviewApprovalId?: string;
      /** Exact CAS claim that owns this spoken approval resolution */
      spokenReviewClaimId?: string;
      /** Approval version and lane state that were spoken before resolution */
      spokenReviewUpdatedAt?: number;
      spokenReviewLaneStatus?: LaneStatus;
      /** An authenticated dispatcher explicitly invoked approve_and_merge.
       * Satisfies only the surface dispatcher-review policy; merge gates and
       * all other approval postures remain authoritative. */
      surfaceDispatcherApproved?: boolean;
      actor?: LaneEventActor;
    }
  | {
      verb: 'complete';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'archive';
      laneId: string;
      outcome?: LaneOutcome;
      outcomeNote?: string | null;
      actor?: LaneEventActor;
    };

export type LaneVerb = LaneCommand['verb'];
export type LaneEventVerb =
  | LaneVerb
  | 'status_change'
  | 'update'
  | 'session_lost'
  | 'detach_session'
  | 'auto_archive'
  | 'merge_cleanup'
  | 'agent_report'
  | 'zombie_reap'
  | 'merge_head_drift'
  | 'review_invalidated'
  | 'review_risk_classified'
  | 'explainer_queued'
  | 'explainer_started'
  | 'explainer_deferred'
  | 'explainer_completed'
  | 'explainer_failed'
  | 'runtime_drift'
  | 'execution_carrier_preflight'
  // A packet-scoped worker attempted an input mutation against an o8-owned
  // terminal. Persisted before the PTY write so no agent terminal mutation can
  // occur without a durable trace. Payload: { packetId, sessionId, byteCount,
  // reason, principal: 'worker', result: 'attempted' }.
  | 'terminal_action'
  | 'worker_capacity_wait'
  | 'capacity_snapshot'
  | 'pr_merged_reconciled'
  | 'merged_by_ancestry_reconciled'
  // The ancestry sweep proved a merge, then found the branch had advanced past
  // the commit it proved before the release could land — a steer inside the
  // detect→write window. Release truth is withheld and the reason recorded.
  // Payload: { packetId, evidenceKind, branchRef, baseRef, provedHeadSha, reason }
  | 'merge_ancestry_release_declined'
  // Post-rebase typecheck escalation (#1108):
  // typecheck_auto_retry — layer 1 fired a programmatic rerun_with_feedback
  // typecheck_escalation — layer 2 promoted the lane to awaiting_orchestrator
  | 'typecheck_auto_retry'
  | 'typecheck_escalation'
  // Advisory referee gate-failure risk for the packet's diff, recorded just
  // before a layer-1 auto-rerun when judgment.provider is on (#2437). Nothing
  // reads it; the rerun fires the same either way.
  // Payload: { receiptId, packetId, risk, legend, confidence, abstain, truncated, hiddenText, diffFingerprint }
  | 'gate_failure_warning'
  // Advisory claim-versus-evidence check on the worker's final report (#2447),
  // recorded after a completion writes its outcome row when judgment.provider
  // is on and a claim is unbacked. Record-only: nothing reads it.
  // Payload: { receiptId, packetId, claims: ('tests' | 'files')[], answers, verificationOutputPresent, reportFlags, outputFlags, reportTruncated, outputTruncated, changedFileCount, diffFingerprint, reportFingerprint }
  | 'claim_unbacked'
  // Advisory rule citations for the merge preview (#2446), recorded when the
  // detached per-file calls settle with judgment.provider on. The merge gate
  // never reads it. Payload: { diffFingerprint, recipe, rulesFound, rulesMissing, files, citations, receiptIds }
  | 'directive_citations'
  // Record-only push gate answer for an outgoing push (#2441). The push is sent
  // either way; nothing reads this. Payload: { receiptId, kind, p, wouldSuppress, operatorGated }
  | 'push_gate'
  // Loop check on the supervisor tick (#2448), recorded every time the
  // detached call answers with judgment.provider on. Record-only.
  // Payload: { receiptId, packetId, p, window, counts }
  | 'loop_check'
  // Advisory: two consecutive loop checks at or above the PROVISIONAL band
  // (0.6). Raised once per run; nothing is stopped. Payload: { receiptId,
  // receiptIds, packetId, sessionKey, p, band, advisory, pattern: { toolName, argsHash, count, resultHead, failed } }
  | 'possible_loop'
  // Record-only triage of an orchestrator wake (#2467), recorded when the
  // detached call settles with judgment.provider on. The wake runs unchanged;
  // nothing reads this. Payload: { receiptId, source, choice, probabilities, confidence, abstain, factsHash }
  | 'wake_triage'
  // A repo publication action exhausted its bounded resource-lease wait.
  // Payload: { resource, waitedMs, holder, retryCount, willRetry }
  | 'lease_wait_timeout'
  // Worker consulted the Engineering Brain via `o8 ask` (2026-06-11).
  // Payload: { question, class, cacheHit, sourcesConsidered, citedCount, topTitles }
  | 'brain_consulted'
  // A typed judgment call ran with this lane in context (#2434). Payload is the
  // receipt: { receiptId, provider, model, ok, questions, answers, inputTokens,
  // outputTokens, latencyMs, attempts, truncated, error, packetId, approvalId, surface }
  | 'judgment'
  // Reserved Broadcast event kind for future agent-to-agent communication.
  // No producer exists yet; this keeps the ledger schema forward-compatible.
  | 'message'
  // A governed packet obligation crossed an orchestrator handoff seam.
  // Payload: { handoffId, threadId, from, to, carries, lossless }
  | 'handoff'
  // Pre-launch refresh of an already-bound worktree onto current origin/base
  // (#1522 — queued dispatch:false missions must not launch on a create-time
  // base snapshot). Payload: { packetId, baseBranch, note }
  | 'worktree_refreshed'
  | 'worktree_refresh_failed'
  // A checked-in workspace manifest allocated service ports and completed its
  // setup and one-shot health probes. Payload:
  // { services: [{ name, port }], preview?, durationMs, state: 'completed' }
  | 'workspace_manifest_services_stopped'
  | 'workspace_manifest_applied'
  // Operator policy prevented a checked-in manifest from executing. Payload:
  // { policy, manifestHash, approvalId?, reason? }
  | 'workspace_manifest_skipped'
  // Workspace manifest application failed without blocking packet launch.
  // Payload: { step, commandId?, error, state }
  | 'workspace_manifest_failed'
  | 'ui_loop_preview_ready'
  // Interactive task artifacts (#1699). created: { artifactId, title, actions }
  // action: { artifactId, actionId, action, payloadHash, actor, delivery, note? }
  | 'task_artifact_created'
  | 'task_artifact_action'
  | 'ui_loop_preview_failed'
  | 'ui_loop_proof'
  // Discard could not prove its preserved branch exists. Payload:
  // { code, reason, packetId, branch, ref, note, gcRisk }
  | 'branch_preservation_failed'
  | 'close_timing'
  // Packet dispatch refused to launch without a managed worktree.
  // Payload adds storageRelease: { decision, ownerGeneration,
  // releasedReservations, releasedBytes, retainedOwnerIds, reason }.
  | 'worktree_provision_failed'
  | 'worktree_provision_queued'
  | 'worktree_provision_started'
  | 'pre_run_cancelled'
  | 'environment_files_not_inherited'
  | 'artifact_admission_retry'
  // Cleanup positively confirmed the tracked child directory was gone. This
  // records observation only; it never claims retirement completed.
  // Payload: { reason: 'confirmed-missing-directory', action, workspacePath }
  | 'workspace_absence_observed'
  // Cleanup finished retiring that observed-absent workspace and removed its
  // durable metadata. Emitted only after removal, so a late failure leaves no
  // completion claim behind. Payload: { reason, action, workspacePath }
  | 'workspace_retirement_confirmed'
  // Dependency setup completed and its package-script binaries were checked
  // before a worker could start. The incomplete event is a launch blocker.
  | 'dependency_materialized'
  | 'worktree_preparation_timing'
  | 'runtime_launch_step'
  // Durable task launch admission; payload: { dispatchId, intentHash, packetId }.
  | 'task_dispatch_accepted'
  | 'task_dispatch_failed'
  | 'task_dispatch_cleanup'
  | 'dependency_materialization_incomplete'
  // Worker-requested bounded scope expansion. Payload records requested paths,
  // effective allowlist, reason, and whether the request widened the scope.
  | 'scope_expansion_requested'
  // An owned runtime child exited. Payload includes exit code/signal, stderr,
  // and whether the runtime emitted its protocol-level result event.
  | 'runtime_process_exit'
  // Packet stop settled its separately owned `o8 run` process trees, or could
  // not prove one of them dead. Payload: { packetId, targeted, confirmed, failures? }
  | 'managed_runs_stopped'
  | 'managed_run_stop_failed'
  // A native worker failed its isolated-config authentication preflight.
  | 'worker_not_authenticated'
  // An opted-in macOS worker sandbox blocked a concrete resource. Payload:
  // { runtime, surfaceId, runId, operation, resource, denialLine, message }
  | 'sandbox_denied'
  // Operator-registered MCP servers attached to a packet worker. Payload:
  // { servers, configPath?, mode: 'launch' | 'resume' }
  | 'mcp_injected'
  // An MCP server or attachment set was skipped without blocking spawn. Payload:
  // { server?, command?, servers?, reason }
  | 'mcp_injection_skipped'
  // A subscription-backed model surface crossed houses at the same policy
  // tier after quota exhaustion. These events are operator-visible audit rows.
  | 'review_fallback'
  // The auto-reviewer produced no machine-readable verdict even after a
  // stricter retry (#1812). A reviewer outage, never a packet rejection:
  // no approval row is written and any existing verdict stands.
  // Payload: { surface, reviewer, packetId, reason, attempts, rawText, note }
  | 'review_unavailable'
  | 'second_pass_rearmed'
  // A durable review row is waiting for a bounded reviewer slot.
  // Payload: { packetId, reviewId, state, queueDepth, concurrencyLimit }
  | 'review_queued'
  | 'review_queue_blocked'
  // A claimed review_queue row that never ran a reviewer turn (#1856). The
  // reason is durable so a skipped job can never read as a completed review.
  // Payload: { packetId, reviewId, reason }
  | 'review_skipped'
  // Reconciliation requeued a second-pass review whose queue row went terminal
  // without producing a turn. Payload:
  // { packetId, approvalId, reviewedHeadSha, reviewId, queued, requeue }
  | 'review_requeue_reconciled'
  // An active review attempt was pinned to a commit that HEAD has moved past —
  // a steer landed a successor. The attempt settles durably instead of holding
  // the lane's active-row slot against the new HEAD (#1844).
  // Payload: { packetId, reviewId, reviewedHeadSha, currentHeadSha, previousStatus, reason }
  | 'review_superseded'
  // A claimed attempt whose lease expired without settling. Reclaimed back into
  // the normal failure ladder rather than waiting on a ws-server restart.
  // Payload: { reviewId, claimedAt, claimOwner, leaseMs, attempts }
  | 'review_attempt_abandoned'
  // A reviewer backend was temporarily unavailable. The row returned to
  // pending without consuming its terminal failure budget.
  // Payload: { packetId, reviewId, reason }
  | 'review_deferred'
  // Startup repaired a legacy row that exhausted only on reviewer contention.
  // Payload: { packetId, reviewId, previousAttempts, reason, currentHeadSha, releaseRepaired }
  | 'review_transient_recovered'
  // An auto-review submit_review call no longer described the claimed HEAD.
  // No approval is recorded; the successor HEAD must receive its own turn.
  // Payload: { packetId, reviewTurnId, expectedHeadSha, submittedHeadSha, currentHeadSha }
  | 'review_head_drift_rejected'
  | 'review_format_decision_rejected'
  // Second-pass agreement dispatched a merge (#1856). Written BEFORE the
  // dispatch so a process that dies mid-transition still leaves a trace.
  // Payload: { packetId, approvalId, reviewedHeadSha, trigger }
  | 'merge_dispatch_attempted'
  // The claimed dispatch reached a durable merge settlement. Payload adds
  // { attemptId, attempt, mergeSha, status, note }.
  | 'merge_dispatch_succeeded'
  // The merge path started its own bounded recovery (for example an automatic
  // typecheck rerun or a retryable fetch outage). This remains claimable after
  // the dispatch lease expires; it is not a terminal failure.
  | 'merge_dispatch_deferred'
  // That dispatch did not merge. Payload adds { note, reason, routedApprovalId }
  // — routedApprovalId set means it became an operator approval card.
  | 'merge_dispatch_failed'
  // A terminal status-only transition retained an ambiguously owned storage
  // reservation while preserving the packet association for a later retry.
  | 'storage_release_deferred'
  // Pre-edit contract turn usage, recorded when the first valid contract is captured.
  // Payload: { runtime, turns, inputTokens?, outputTokens?, durationMs }
  | 'task_contract_cost'
  // A runtime-default contract was not captured, so review preserved the legacy gate behavior.
  // Payload: { runtime, reason }
  | 'task_contract_missing'
  | 'review_turn_started'
  | 'review_turn_finished'
  | 'review_turn_stopped'
  // Operator close receipt. Payload includes packetId, worktreeCleanup,
  // reason, and whether missing-worktree acknowledgement was supplied.
  | 'packet_discarded'
  | 'worker_quota_exhausted'
  | 'worker_fallback'
  | 'worker_fallback_terminal'
  | 'spend_cap_hit'
  // Orchestrator review verdict, append-only (#1476 lie 3). Lane events are
  // never rescored or evicted, so review-state can always recover the verdict
  // even after mission-state resets or approval-context drift.
  // Payload: { approved, summary, reviewedHeadSha, auditApprovalId }
  | 'review_recorded'
  // Agent drove o8's embedded browser via `o8 browser` / o8_browser_* (#1232 phase 1).
  // Payload: { verb, selector?, surface?, ok, url? }
  | 'browser_acted'
  // Operator picked a best-of-N comparison winner (item 3). Recorded on the
  // winner's lane. Payload: { groupId, winnerPacketId, archivedPacketIds }
  | 'comparison_resolved'
  // Review card invalidated because the worker resumed activity after review.
  // Payload: { reason, source, surfaceId, packetId, worktreePath }
  | 'review_invalidated'
  // Review pin carried across a rebase because patch-id proved identical content.
  // Payload: { from, to, patchId, packetId }
  | 'review_carried_across_rebase'
  // Session rules governed this packet at dispatch (#1329). Snapshot of the
  // exact operator session rules injected into the worker prompt, so review is
  // "what changed, under which constraints." Payload: { threadId, ruleCount, rules }
  | 'rules_applied'
  // Packet steer injected into an existing warm session. Payload: { packetId, source, message }
  | 'steered_packet'
  // Accepted steered turn may register managed runs until its next lifecycle boundary.
  | 'steer_run_admitted'
  // Durable delivery state linked to one steer intent.
  | 'steer_delivery'
  // Design Mode follow-up reused the packet's warm lane. Payload: { packetId, elementSummary }
  | 'ui_loop_steered'
  // Design Mode steer did not settle before its writer deadline. Payload: { packetId, laneId, waitedMs }
  | 'ui_loop_turn_unsettled'
  // Design Mode packet reached an operator-configured iteration/time/diff bound.
  // Payload: { reason, iterations, elapsedMs, diffBytes, diffFiles }
  | 'ui_loop_budget_exhausted'
  // Packet steer failed before a worker turn could start. Payload: { packetId, source, message, note, stderrHead? }
  | 'steer_failed'
  // Operator stop could not kill the live worker. Payload: { packetId?, sessionKey, note, pid?, tmuxSession?, steps }
  | 'interrupt_failed'
  // Silent-exit detector found that the lane worktree HEAD is already an
  // ancestor of the refreshed base. Payload: { headSha, comparisonRef }
  | 'silent_exit_already_merged'
  // Reaper wedge-timeout enforcement (Rock 1 item 2): a parked lane sat past
  // its conservative timeout so the reaper escalated it — the invariant is
  // "nothing parks silently". Payload:
  // { from, to, elapsedMs, thresholdMs, blockedReason, action }
  | 'wedge_timeout'
  // Prune gate (Rock 1 item 3): a worktree/clone deletion was refused because
  // the tree had uncommitted work / recent activity / a non-terminal lane.
  // Payload: { worktreePath, reason, forced:false }
  | 'prune_refused'
  // Prune gate: an operator/recovery override deleted a tree the gate would
  // otherwise have refused. Payload: { worktreePath, reason, forced:true }
  | 'prune_forced'
  // Confirmed-kill escalation (Rock 1, #1471 S1): one event per ladder stage.
  // Payload: { stage, pid, confirmed }
  | 'kill_escalated'
  // Session-binding fault detector (Rock 1, #1502): an active lane reported
  // progress/heartbeat with no sessionKey bound. Payload: { packetId, source }
  | 'no_session_binding';

export type AgentReportReason =
  | 'needs_clarification'
  | 'missing_context'
  | 'out_of_scope'
  | 'dependency_blocked'
  | 'context_full'
  | 'nondeterministic_test'
  | 'external_api_down'
  | 'unknown';

// ── Lane Policy ──

export interface LanePolicy {
  branchWritable: boolean;
  requiresApproval: boolean;
  autoSpawnAllowed: boolean;
}

// ── Command Result ──

export interface LaneCommandResult {
  ok: boolean;
  laneId: string;
  note: string;
  lane?: Lane;
  /** Dependency setup path selected while provisioning this lane's worktree. */
  dependencyMaterializationMode?: 'native' | 'image' | null;
  /** Set when the command requires human approval before proceeding */
  approvalId?: string;
  /** Merge-specific — true only when `git push origin <baseBranch>` also succeeded */
  pushedToOrigin?: boolean;
  /** Merge-specific — main checkout HEAD after a successful fast-forward */
  mergeSha?: string;
  /** Merge-specific — captured when the push failed so the caller can surface it */
  pushError?: string;
  /** Merge-specific — expected worktree HEAD when optimistic locking rejects drift */
  expectedHeadSha?: string;
  /** Merge-specific — reviewed worktree HEAD when review integrity rejects drift */
  reviewedHeadSha?: string;
  /** Merge-specific — actual worktree HEAD when optimistic locking rejects drift */
  currentHeadSha?: string;
  /** Merge-specific structured refusal reason */
  reason?: string;
  /** Merge-specific verification receipt, including post-rebase checks. */
  checks?: MergeCheckResult[];
  /** Merge-specific blocking check names. */
  blockers?: string[];
}

// ── Persisted State ──

export interface LaneStoreState {
  version: 1;
  lanes: Record<string, Lane>;
  events: LaneEvent[];
  updatedAt: string;
}
