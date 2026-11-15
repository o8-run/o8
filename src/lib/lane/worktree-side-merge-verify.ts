import type { ApprovalGateResult } from '@/lib/approvals/types';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import { assessGateFailureRisk } from '@/lib/lane/gate-failure-warning';
import { buildCheckList, type MergePreviewResult } from '@/lib/lane/preview-merge';
import { startWakeTriage } from '@/lib/orchestrator/wake-triage';
import {
  appendEvent,
  countLaneEventsByVerbSinceLastLaunch,
  setLaneStatus,
} from '@/lib/lane/registry';
import type { LaneRebaseVerifyResult } from '@/lib/lane/rebase-verify';
import type { Lane, LaneCommand, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import type { MergePacketResult } from '@/lib/orchestrator/operator-mission-service/types';

const VERIFY_FEEDBACK_MAX_BYTES = 4 * 1024;

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;
type VerifyFailure = Extract<LaneRebaseVerifyResult, { ok: false }>;

interface PostRebaseVerifyFailureInput {
  lane: Lane;
  command: MergeCommand;
  actor: LaneEventActor;
  gateResult: ApprovalGateResult;
  /**
   * The detached integration worktree the rebase and verification ran in. The
   * lane's own worktree still holds the pre-rebase tree, so the advisory
   * referee read must use this one (#2437).
   */
  verifiedWorktreePath?: string | null;
}

export function mergePacketResultFromLaneCommand(result: LaneCommandResult): MergePacketResult {
  return {
    merged: result.ok,
    note: result.note,
    ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.checks ? { checks: result.checks } : {}),
    ...(result.blockers ? { blockers: result.blockers } : {}),
    ...(result.expectedHeadSha ? { expectedHeadSha: result.expectedHeadSha } : {}),
    ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
    ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
  };
}

function truncateForBlocker(output: string): string {
  if (output.length <= VERIFY_FEEDBACK_MAX_BYTES) return output;
  return `${output.slice(0, VERIFY_FEEDBACK_MAX_BYTES)}\n\n[truncated — full output in lane_events]`;
}

function verificationLabel(kind: VerifyFailure['kind']): string {
  if (kind === 'tests') return 'Tests';
  return kind === 'lint' ? 'Lint' : 'Typecheck';
}

function formatVerificationFeedback(lane: Lane, failure: VerifyFailure): string {
  const label = verificationLabel(failure.kind);
  return [
    `Post-rebase ${label.toLowerCase()} failed after rebasing ${lane.branch} onto ${lane.baseBranch}.`,
    `Fix the ${label.toLowerCase()} errors below, then commit so the operator can re-attempt the merge.`,
    '',
    truncateForBlocker(failure.output),
  ].join('\n');
}

/** Read the packet-scoped retry budget, falling back to lane events when absent. */
async function readPacketTypecheckRetries(packetId: string | null | undefined): Promise<number | null> {
  if (!packetId) return null;
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    return packet ? (packet.typecheckAutoRetries ?? 0) : null;
  } catch {
    return null;
  }
}

type DurableStopState = 'stopped' | 'clear' | 'unavailable';

/**
 * Durable operator-stop signal, read from whichever store owns the packet (active
 * control plane or mission registry). An ordinary `queueState=held` without
 * `operatorStopped` is NOT a stop: reset_packet uses held for ordinary recovery.
 * A failed read returns `unavailable` so callers fail closed instead of treating
 * unreadable state as permission to recover.
 */
async function readDurableStopState(packetId: string | null | undefined): Promise<DurableStopState> {
  if (!packetId) return 'clear';
  const normalized = packetId.trim();
  if (!normalized) return 'clear';
  try {
    const { packetSteerHoldReason } = await import('@/lib/lane/packet-stop-hold');
    return packetSteerHoldReason(normalized) === 'operator_stopped' ? 'stopped' : 'clear';
  } catch {
    return 'unavailable';
  }
}

/**
 * Retain the late failure as diagnostic evidence without touching the lane,
 * packet hold, retry budget, or saved review, and without dispatching. Used for
 * both a proven Stop and an unreadable stop state; the diagnostic reason keeps
 * the two distinguishable and never claims a Stop was proven when it was not.
 */
function nonRecoveringVerificationResult(
  input: PostRebaseVerifyFailureInput,
  failure: VerifyFailure,
  truncatedOutput: string,
  checks: LaneCommandResult['checks'],
  blockers: string[],
  priorAutoRetries: number,
  outcome: 'stopped' | 'unavailable',
): LaneCommandResult {
  const { lane, command } = input;
  const label = verificationLabel(failure.kind);
  const stopped = outcome === 'stopped';
  appendEvent(command.laneId, 'typecheck_escalation', 'system', {
    kind: failure.kind,
    reason: stopped ? 'operator_stopped' : 'operator_stop_state_unavailable',
    priorAutoRetries,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    packetId: lane.packetId,
    output: truncatedOutput,
  });
  return {
    ok: false,
    laneId: command.laneId,
    note: stopped
      ? `${label} failed after rebase onto ${lane.baseBranch}, but the packet is operator-stopped. The failure is retained for diagnosis; no auto-rerun was dispatched and the existing lane state was preserved.\n\n${truncatedOutput}`
      : `${label} failed after rebase onto ${lane.baseBranch}, and the durable operator-stop state could not be read. Automatic recovery was withheld, the failure was retained for diagnosis, and the existing lane state was preserved.\n\n${truncatedOutput}`,
    reason: stopped ? 'operator_stopped' : 'operator_stop_state_unavailable',
    checks,
    blockers,
  };
}

/** Feed every post-rebase verification failure through the existing bounded retry chain. */
export async function handlePostRebaseVerifyFailure(
  input: PostRebaseVerifyFailureInput,
  failure: VerifyFailure,
): Promise<LaneCommandResult> {
  const { lane, command, actor } = input;
  const truncatedOutput = truncateForBlocker(failure.output);
  const checks = buildCheckList(input.gateResult, failure.checks);
  const blockers = [failure.kind];
  const label = verificationLabel(failure.kind);
  const priorAutoRetries = (await readPacketTypecheckRetries(lane.packetId))
    ?? countLaneEventsByVerbSinceLastLaunch(command.laneId, 'typecheck_auto_retry');

  // A durable operator Stop is newer authority than this late verification
  // outcome. Preserve the paused lane/hold/budget/review and retain the
  // diagnostic without dispatching. An unreadable stop state also withholds
  // recovery. Re-checked under the control-plane lock in both branches so a
  // Stop landing during an await cannot be overwritten.
  const initialStop = await readDurableStopState(lane.packetId);
  if (initialStop !== 'clear') {
    return nonRecoveringVerificationResult(
      input, failure, truncatedOutput, checks, blockers, priorAutoRetries, initialStop,
    );
  }

  const { withControlPlaneLock, withLockedState } = await import('@/lib/orchestrator/control-plane');

  if (priorAutoRetries >= 1 || !lane.packetId) {
    const escalationReason = priorAutoRetries >= 1 ? 'retry_exhausted' : 'no_packet';
    const blockedReason = !lane.packetId
      ? `${label} failed after rebase onto ${lane.baseBranch}. No packetId on lane, cannot auto-rerun. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`
      : `${label} failed after 1 auto-retry. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`;
    const outcome = await withControlPlaneLock(async (): Promise<'applied' | 'stopped' | 'unavailable'> => {
      const stop = await readDurableStopState(lane.packetId);
      if (stop !== 'clear') return stop;
      appendEvent(command.laneId, 'typecheck_escalation', 'system', {
        kind: failure.kind,
        reason: escalationReason,
        priorAutoRetries,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
        output: truncatedOutput,
      });
      startWakeTriage({ source: 'typecheck-escalation', laneId: command.laneId });
      setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', `typecheck_escalated:${escalationReason}`);
      return 'applied';
    });
    if (outcome !== 'applied') {
      return nonRecoveringVerificationResult(
        input, failure, truncatedOutput, checks, blockers, priorAutoRetries, outcome,
      );
    }
    return { ok: false, laneId: command.laneId, note: blockedReason, checks, blockers };
  }

  // Advisory gate-failure risk for the verified tree (#2437), asked before the
  // lock so the bounded referee call never holds it. Null records nothing.
  const gateFailureWarning = await assessGateFailureRisk(lane, input.verifiedWorktreePath);

  // Initial retry. The stop check, lane status, review supersede, and retry
  // budget all run under the same control-plane lock the Stop path takes, so a
  // concurrent Stop either wins before this block or overwrites it after.
  const retry = await withLockedState(async (current): Promise<'applied' | 'stopped' | 'unavailable'> => {
    const packet = current.packets.find((candidate) => candidate.id === lane.packetId);
    if (packet) {
      if (packet.operatorStopped) return 'stopped';
    } else {
      const stop = await readDurableStopState(lane.packetId);
      if (stop !== 'clear') return stop;
    }

    if (gateFailureWarning) {
      appendEvent(command.laneId, 'gate_failure_warning', 'system', { ...gateFailureWarning });
    }
    appendEvent(command.laneId, 'typecheck_auto_retry', 'system', {
      kind: failure.kind,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      packetId: lane.packetId,
      output: truncatedOutput,
    });
    setLaneStatus(command.laneId, 'reviewing', actor, 'typecheck_auto_retry');
    await supersedeDurableApprovedReviews(
      lane.packetId!,
      failure.kind === 'typecheck'
        ? 'Superseded by typecheck auto-rerun.'
        : `Superseded by post-rebase ${label.toLowerCase()} auto-rerun.`,
    );
    if (packet) packet.typecheckAutoRetries = (packet.typecheckAutoRetries ?? 0) + 1;
    return 'applied';
  });

  if (retry.result !== 'applied') {
    return nonRecoveringVerificationResult(
      input, failure, truncatedOutput, checks, blockers, priorAutoRetries, retry.result,
    );
  }

  const feedback = formatVerificationFeedback(lane, failure);
  void (async () => {
    try {
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      const currentPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === lane.packetId);
      if (!currentPacket || currentPacket.queueState === 'held') {
        console.log(
          `[lane-merge] Skipping auto-rerun for packet ${lane.packetId} — ${currentPacket ? 'packet is held (reset_packet)' : 'packet no longer exists'} (#1257).`,
        );
        return;
      }
      const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
      // Fresh durable read after every await: the lifecycle admission enforces
      // the same precondition under its owning lock, but avoiding the call
      // entirely when a Stop (or unreadable state) already landed is cheaper
      // and keeps the diagnostic explicit.
      const stop = await readDurableStopState(lane.packetId);
      if (stop !== 'clear') {
        appendEvent(command.laneId, 'typecheck_escalation', 'system', {
          kind: failure.kind,
          reason: stop === 'stopped' ? 'operator_stopped' : 'operator_stop_state_unavailable',
          priorAutoRetries,
          branch: lane.branch,
          baseBranch: lane.baseBranch,
          packetId: lane.packetId,
          output: truncatedOutput,
        });
        return;
      }
      await rerunWithFeedback({ packetId: lane.packetId!, feedback, preserveOperatorStop: true });
      console.log(
        `[lane-merge] Auto-rerun dispatched for packet ${lane.packetId} after ${label.toLowerCase()} failure on lane ${command.laneId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[lane-merge] Auto-rerun failed for packet ${lane.packetId} on lane ${command.laneId}: ${message}`,
      );
      // A Stop that landed while the rerun was in flight still owns the lane:
      // record the rejection as diagnostic only and never reopen the lane. A
      // failed state read must not become an unhandled detached rejection.
      try {
        const { withControlPlaneLock: lockDispatchFailure } = await import('@/lib/orchestrator/control-plane');
        await lockDispatchFailure(async () => {
          const stop = await readDurableStopState(lane.packetId);
          appendEvent(command.laneId, 'typecheck_escalation', 'system', {
            kind: failure.kind,
            reason: stop === 'stopped'
              ? 'rerun_dispatch_failed_after_stop'
              : stop === 'unavailable'
                ? 'rerun_dispatch_failed_stop_state_unavailable'
                : 'rerun_dispatch_failed',
            priorAutoRetries: priorAutoRetries + 1,
            branch: lane.branch,
            baseBranch: lane.baseBranch,
            packetId: lane.packetId,
            output: truncatedOutput,
            dispatchError: message,
          });
          if (stop === 'clear') {
            setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', 'typecheck_rerun_failed');
          }
        });
      } catch (nestedError) {
        console.error(
          `[lane-merge] Could not record rerun dispatch failure for packet ${lane.packetId}: ${nestedError instanceof Error ? nestedError.message : String(nestedError)}`,
        );
      }
    }
  })();

  return {
    ok: false,
    laneId: command.laneId,
    note: `${label} failed after rebase onto ${lane.baseBranch}. Auto-rerun dispatched with the ${label.toLowerCase()} output as feedback; the packet will retry in a fresh worktree.\n\n${truncatedOutput}`,
    reason: 'typecheck_auto_retry',
    checks,
    blockers,
  };
}

/** Record the decision principal separately from the unchanged execution actor. */
export function recordMergePublication(command: MergeCommand, actor: LaneEventActor, approvedSha: string,
  mergedSha: string, baseBranch: string, checks: MergePreviewResult['checks']) {
  appendEvent(command.laneId, 'merge', actor, { laneHeadSha: mergedSha, baseBranch, approvedSha, mergedSha,
    authorizingPrincipal: command.authorizingPrincipal ?? 'unknown', authorizingApprovalId: command.authorizingApprovalId ?? null, checks });
}
