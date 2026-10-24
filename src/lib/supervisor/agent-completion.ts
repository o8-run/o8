import { readStandingLane } from '@/lib/lane/standing-store';
import { findLaneBySession, setLaneStatus, updateLane } from '@/lib/lane/registry';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import type { Lane } from '@/lib/lane/types';
import type { AgentCompletionDecision } from './agent-supervisor-types';
import type { SupervisorInboxKind } from './inbox';
import { createCompletionTurnGuard, SupersededCompletionError } from './completion-turn';
import { completionHandoffTurnCheck } from '@/lib/orchestrator/completion-handoff';

interface CompletionDependencies {
  enqueueAutoReview(laneId: string): Promise<unknown>;
  triggerHeadlessSprintTick(): Promise<unknown>;
  queueReviewContinuation(lane: Lane): void;
  enqueueVerificationFailureInboxItem(input: {
    repoPath: string;
    packetId?: string | null;
    kind: SupervisorInboxKind;
    laneId: string;
    worktreePath: string;
    sessionKey: string;
    baseBranch?: string | null;
    packetTitle?: string | null;
    packetReferenceLabel?: string | null;
    verificationKind?: string | null;
    attempts?: string | null;
    error: string;
    note?: string | null;
    retryError?: string | null;
  }): Promise<string>;
}

/** Completion callbacks may outlive their turn while verification is running. */
export async function handleAgentCompletion(
  surfaceId: string,
  outcome: 'completed' | 'failed',
  dependencies: CompletionDependencies,
): Promise<AgentCompletionDecision | void> {
  const lane = findLaneBySession(surfaceId);
  if (!lane) return;
  if (readStandingLane(lane.id)) {
    const { reconcileStandingLane } = await import('@/lib/lane/standing');
    await reconcileStandingLane(lane.id);
    return;
  }
  const handoffTurn = completionHandoffTurnCheck(lane);
  const guard = createCompletionTurnGuard(lane, { checkCurrent: handoffTurn.check });
  const { enqueueAutoReview, triggerHeadlessSprintTick,
    queueReviewContinuation, enqueueVerificationFailureInboxItem } = dependencies;
  try {
    if (outcome === 'completed') {
      const { shouldDeferCompletionForLiveRuntime } = await guard.wait(() => import('@/lib/supervisor/completion-liveness'));
      if (await guard.wait(() => shouldDeferCompletionForLiveRuntime(lane))) {
        const packetId = lane.packetId?.trim();
        const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
        const detail = `${label} still has a live owned runtime process. Deferring completion.`;
        console.warn(`[supervisor] ${detail}`);
        return {
          resume: true,
          detail,
        };
      }
    }
    const completionCwd = lane.worktreePath ?? lane.repoPath;
    try {
      const { persistRuntimeSessionCost } = await guard.wait(() => import('@/lib/orchestrator/cost-persistence'));
      await guard.wait(() => persistRuntimeSessionCost({
        sessionKey: surfaceId,
        runtime: lane.runtime,
        repoPath: completionCwd,
        laneId: lane.id,
        packetId: lane.packetId,
      }));
    } catch (error) {
      guard.check();
      console.error('[cost-persistence] Failed to persist lane session cost:', error);
    }
    if (outcome === 'completed') {
      try {
        // #1103 — commit any staged/dirty work BEFORE judging zero-diff.
        // The supervisor's completion grace keys on transcript growth, not
        // the worktree, so a Codex turn that commits after its last
        // transcript line races this probe and gets a false
        // no_changes_produced. Auto-commit first, then probe, with one
        // bounded settle + re-probe to catch a commit that lands inside
        // the exec/poll window. (Any commit later than this is recovered
        // by the silent-exit detector, not lost.)
        const { autoCommitCompletionWorktree } = await guard.wait(() => import('@/lib/supervisor/completion-verification'));
        try {
          await guard.wait(() => autoCommitCompletionWorktree(completionCwd, lane.repoPath, lane.label));
        } catch { /* non-fatal — fall through to probe */
          guard.check();
        }
        let probe = await guard.wait(() => probeNoChangesProduced(completionCwd, lane.baseBranch));
        if (probe.noChangesProduced) {
          await guard.wait(() => new Promise((resolve) => setTimeout(resolve, 2000)));
          try {
            await guard.wait(() => autoCommitCompletionWorktree(completionCwd, lane.repoPath, lane.label));
          } catch { /* non-fatal */
            guard.check();
          }
          probe = await guard.wait(() => probeNoChangesProduced(completionCwd, lane.baseBranch));
        }
        if (probe.noChangesProduced) {
          const packetId = lane.packetId?.trim();
          const { captureSettledReadOnlyCompletionContext, completeReadOnlyZeroDiffLane, isReadOnlyPacketLane, } = await guard.wait(() => import('@/lib/orchestrator/read-only-completion'));
          let readOnlyContext = null;
          if (isReadOnlyPacketLane(lane) && packetId && lane.sessionKey) {
            try {
              const { capturePacketCompletionContext } = await guard.wait(() => import('@/lib/orchestrator/context-relay'));
              readOnlyContext = await guard.wait(() => captureSettledReadOnlyCompletionContext(() => capturePacketCompletionContext(packetId, lane.sessionKey!)));
            } catch (error) {
              guard.check();
              console.error(`[context-relay] Failed to capture read-only completion context for packet ${packetId}:`, error);
            }
          }
          guard.check();
          const readOnlyCompletion = await completeReadOnlyZeroDiffLane(lane, readOnlyContext);
          if (readOnlyCompletion.completed) {
            const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
            const detail = `${label} completed its read-only inspection with no repository changes.`;
            console.log(`[supervisor] ${detail}`);
            return {
              detail,
            };
          }
          guard.check();
          if (readOnlyCompletion.blocked) {
            console.warn(`[supervisor] ${readOnlyCompletion.detail}`);
            return {
              block: true,
              detail: readOnlyCompletion.detail,
            };
          }
          const { parkHuddleReadyZeroDiffLane } = await guard.wait(() => import('@/lib/orchestrator/huddle-zero-diff'));
          const huddlePark = await guard.wait(() => parkHuddleReadyZeroDiffLane(lane, guard.check));
          if (huddlePark.parked) {
            const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
            const detail = `${label} completed its huddle turn with no changes; awaiting orchestrator alignment.`;
            console.warn(`[supervisor] ${detail}`);
            return {
              block: true,
              detail,
            };
          }
          if (huddlePark.operatorBlocked) {
            const blockedLane = huddlePark.lane ?? lane;
            const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
            const detail = `${label} stopped for operator input: ${blockedLane.lastEventLabel ?? 'worker_blocked'}.`;
            console.warn(`[supervisor] ${detail}`);
            return {
              block: true,
              detail,
            };
          }
          // #2141 — an empty worktree has two causes and only one is worth
          // retrying. A runtime that ERRORED before writing anything is the
          // most transient failure we own and has no partial work to lose; a
          // run that finished cleanly and legitimately changed nothing must
          // never be retried or a no-op packet loops forever. The normalized
          // transcript is the signal that separates them.
          const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
          const {
            markZeroDiffTerminal,
            readZeroDiffClassification,
            requeueZeroDiffRuntimeFault,
          } = await guard.wait(() => import('@/lib/supervisor/zero-diff-runtime-fault'));
          const zeroDiff = await guard.wait(() => readZeroDiffClassification(lane.sessionKey ?? surfaceId));
          if (zeroDiff.cause === 'runtime_error') {
            try {
              const requeue = await guard.wait(() => requeueZeroDiffRuntimeFault({
                lane,
                packetId,
                worktreePath: completionCwd,
                detail: zeroDiff.detail,
              }));
              if (requeue.requeued) {
                // This RUN failed — the lane is terminal and the retry mints a
                // fresh one. `block: true` is what records it as failed instead
                // of leaving the operator waiting on a finished agent.
                setLaneStatus(lane.id, 'failed', 'system', 'zero_diff_runtime_error_requeued');
                const requeuedDetail = `${label} errored before writing anything (${zeroDiff.detail}). Re-queued - retry ${requeue.retryNumber}/${requeue.cap}.`;
                console.warn(`[supervisor] ${requeuedDetail}`);
                void triggerHeadlessSprintTick().catch((error) => {
                  console.error(`[supervisor] Failed to trigger the zero-diff retry dispatch for ${label}:`, error);
                });
                return {
                  block: true,
                  detail: requeuedDetail,
                };
              }
            } catch (error) {
              guard.check();
              console.error(`[supervisor] Zero-diff runtime retry failed for ${label}:`, error);
            }
          }
          try {
            await guard.wait(() => markZeroDiffTerminal({
              lane,
              packetId,
              sessionKey: surfaceId,
              cause: zeroDiff.cause,
            }));
          } catch (error) {
            guard.check();
            console.error(`[supervisor] Failed to persist the zero-diff outcome for ${label}:`, error);
          }
          const detail = zeroDiff.cause === 'runtime_error'
            ? `${label} errored before writing anything (${zeroDiff.detail}) and its retry budget is spent - operator input is required.`
            : zeroDiff.cause === 'clean_no_op'
              ? `${label} completed with no changes - needs redispatch with clearer guidance.`
              : `${label} completed with no changes, and the runtime gave no evidence either way (${zeroDiff.detail}) - operator input is required.`;
          console.warn(`[supervisor] ${detail}`);
          return {
            block: true,
            detail,
          };
        }
      } catch (error) {
        guard.check();
        console.warn(`[supervisor] No-changes completion probe failed for ${completionCwd}:`, error);
      }
      const { autoCommitCompletionWorktree, runCompletionVerification, } = await guard.wait(() => import('@/lib/supervisor/completion-verification'));
      const verification = await guard.wait(() => runCompletionVerification(completionCwd, lane.baseBranch, lane.repoPath));
      if (!verification.ok) {
        console.warn(`[supervisor] Agent ${surfaceId} failed post-completion ${verification.kind} in ${completionCwd}`);
        let retryPacketId = lane.packetId?.trim() || undefined;
        try {
          const { withLockedState } = await guard.wait(() => import('@/lib/orchestrator/control-plane'));
          const { capturePacketCompletionContext } = await guard.wait(() => import('@/lib/orchestrator/context-relay'));
          const { buildAttemptLearningFromFailure, persistAttemptLearnings, readPacketAttemptLearnings, } = await guard.wait(() => import('@/lib/orchestrator/attempt-log'));
          const { markRalphRetryRequeued, resolvePostCompletionPacket, } = await guard.wait(() => import('@/lib/supervisor/post-completion-packet'));
          const packetResolution = await guard.wait(() => resolvePostCompletionPacket(lane.id, lane.packetId));
          if (!packetResolution) {
            setLaneStatus(lane.id, 'awaiting_input', 'system', 'post_completion_typecheck_packet_not_found');
            await guard.wait(() => enqueueVerificationFailureInboxItem({
              repoPath: lane.repoPath,
              packetId: lane.packetId?.trim() || undefined,
              kind: 'packet_missing',
              laneId: lane.id,
              worktreePath: completionCwd,
              sessionKey: surfaceId,
              baseBranch: lane.baseBranch,
              packetTitle: lane.label,
              verificationKind: verification.kind,
              error: verification.output,
              note: 'Cannot enter the bounded retry flow because the packet metadata is missing.',
            }));
            return {
              block: true,
              detail: `Post-completion ${verification.kind} failed, but the packet could not be found in mission state. Operator input is required.`,
            };
          }
          const { packetId, snapshot: packetSnapshot } = packetResolution;
          retryPacketId = packetId;
          const currentAttempt = packetSnapshot.attemptCount;
          const maxAttempts = Math.max(1, packetSnapshot.maxAttempts);
          const attemptNumber = currentAttempt + 1;
          if (currentAttempt < maxAttempts - 1) {
            const completionContext = await guard.wait(() => capturePacketCompletionContext(packetId, surfaceId));
            await guard.wait(() => persistAttemptLearnings(completionCwd, packetId, attemptNumber, buildAttemptLearningFromFailure(verification.output, completionContext.selfReview)));
            await guard.wait(() => autoCommitCompletionWorktree(completionCwd, lane.repoPath, lane.label));
            markRalphRetryRequeued(lane.id, packetId);
            await guard.wait(() => withLockedState((state) => {
              guard.check();
              const packet = state.packets.find((candidate) => candidate.id === packetId);
              if (!packet) {
                throw new Error(`Packet ${packetId} disappeared before bounded retry requeue.`);
              }
              const now = new Date().toISOString();
              packet.attemptCount = attemptNumber;
              packet.queueState = 'queued';
              packet.status = 'queued';
              packet.blockedReason = null;
              packet.lastEventAt = now;
              packet.lastEventLabel = 'ralph_retry_requeued';
              packet.lane = null;
              handoffTurn.acceptRetryGeneration(packet);
            }));
            console.warn(`[ralph-loop] Attempt ${attemptNumber}/${maxAttempts} failed for packet ${packetId}, re-queuing with learnings`);
            void triggerHeadlessSprintTick().catch((error) => {
              console.error(`[ralph-loop] Failed to trigger headless retry dispatch for packet ${packetId}:`, error);
            });
            return;
          }
          const currentLearning = buildAttemptLearningFromFailure(verification.output);
          const priorLearnings = await guard.wait(() => readPacketAttemptLearnings(packetId, completionCwd));
          const learningSummary = [
            ...priorLearnings.map((learning) => `- Attempt ${learning.attempt}: ${learning.summary}`),
            `- Attempt ${attemptNumber}: ${currentLearning.summary}`,
          ].join('\n') || '- No attempt learnings recorded.';
          setLaneStatus(lane.id, 'awaiting_input', 'system', 'ralph_retry_exhausted');
          await guard.wait(() => enqueueVerificationFailureInboxItem({
            repoPath: lane.repoPath,
            packetId,
            kind: 'bounded_retry_exhausted',
            laneId: lane.id,
            worktreePath: completionCwd,
            sessionKey: surfaceId,
            baseBranch: lane.baseBranch,
            packetTitle: packetSnapshot.title,
            packetReferenceLabel: packetSnapshot.referenceLabel,
            verificationKind: verification.kind,
            attempts: `${attemptNumber}/${maxAttempts}`,
            error: verification.output,
            note: `Learnings summary:\n${learningSummary}`,
          }));
          console.warn(`[ralph-loop] Max attempts (${maxAttempts}) exhausted for packet ${packetId}, escalating to operator`);
          return {
            block: true,
            detail: `Post-completion ${verification.kind} failed after ${attemptNumber}/${maxAttempts} attempts. Operator input is required.`,
          };
        } catch (retryError) {
          guard.check();
          if (retryPacketId) {
            updateLane(lane.id, { packetId: retryPacketId }, 'system');
          }
          setLaneStatus(lane.id, 'awaiting_input', 'system', 'ralph_retry_failed');
          await guard.wait(() => enqueueVerificationFailureInboxItem({
            repoPath: lane.repoPath,
            packetId: retryPacketId,
            kind: 'verification_failed',
            laneId: lane.id,
            worktreePath: completionCwd,
            sessionKey: surfaceId,
            baseBranch: lane.baseBranch,
            packetTitle: lane.label,
            verificationKind: verification.kind,
            error: verification.output,
            note: 'The bounded retry handoff failed after the verification error.',
            retryError: retryError instanceof Error ? retryError.message : String(retryError),
          }));
          console.error('[ralph-loop] Failed to process bounded retry handoff:', retryError);
          return {
            block: true,
            detail: `Post-completion ${verification.kind} failed and the bounded retry handoff also failed. Operator input is required.`,
          };
        }
      }
      try {
        const committed = await guard.wait(() => autoCommitCompletionWorktree(completionCwd, lane.repoPath, lane.label));
        if (committed) {
          console.log(`[supervisor] Agent ${surfaceId} left dirty worktree, auto-committing in ${completionCwd}`);
        }
      } catch (commitErr) {
        guard.check();
        console.warn(`[supervisor] Auto-commit check failed for ${completionCwd}:`, commitErr);
      }
      const { transitionPostCompletionLaneToReviewing } = await guard.wait(() => import('@/lib/supervisor/post-completion-packet'));
      const reviewTransition = transitionPostCompletionLaneToReviewing(lane.id, lane.packetId);
      const updated = reviewTransition.lane;
      if (updated) {
        const packetId = reviewTransition.packetId ?? updated.packetId ?? lane.packetId;
        const sessionKey = updated.sessionKey ?? surfaceId;
        if (packetId) {
          try {
            const { capturePacketCompletionContext } = await guard.wait(() => import('@/lib/orchestrator/context-relay'));
            await guard.wait(() => capturePacketCompletionContext(packetId, sessionKey));
          } catch (error) {
            guard.check();
            console.error(`[context-relay] Failed to capture completion context for packet ${packetId}:`, error);
          }
        }
        // #1110 — Both calls are "kick off a downstream job"; their HTTP
        // round-trip is just an enqueue ack. When /api/orchestrator/headless-tick
        // wedges (a stuck singleton tickPromise can hang for 15s+; auto-review
        // is fast at ~4ms), awaiting them propagates a TimeoutError up to the
        // outer catch and the supervisor callback aborts mid-flight — which
        // silently breaks the auto-loop. Detach them: the enqueue still lands,
        // and any slowness in the handler doesn't poison the supervisor.
        void enqueueAutoReview(updated.id).catch((err) => {
          console.warn(`[supervisor] enqueueAutoReview kicked off but errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        });
        // Reviewable work is not a release. Only wake dependency scheduling.
        void triggerHeadlessSprintTick().catch((err) => {
          console.warn(`[supervisor] triggerHeadlessSprintTick errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        });
        queueReviewContinuation({ ...updated, packetId: packetId ?? updated.packetId });
      }
      console.log(`[supervisor] Agent ${surfaceId} completed, lane ${lane.id} -> reviewing`);
      return;
    }
    const failedProbe = await guard.wait(() => probeNoChangesProduced(completionCwd, lane.baseBranch)
      .catch(() => ({ noChangesProduced: true })));
    const { transitionFailedPostCompletionLane } = await guard.wait(() => import('@/lib/supervisor/post-completion-packet'));
    transitionFailedPostCompletionLane(lane.id, !failedProbe.noChangesProduced);
    console.log(`[supervisor] Agent ${surfaceId} failed, lane ${lane.id} -> awaiting_input`);
  } catch (error) {
    if (error instanceof SupersededCompletionError)
      return { superseded: true };
    console.error('[supervisor] Completion callback failed:', error);
  }
}
