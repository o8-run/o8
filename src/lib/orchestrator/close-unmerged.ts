import { timeClosePhase, withCloseTiming } from './close-timing';
import { orphanCloseRetirement, withOrphanCloseContext, prepareOrphanCloseOwners } from './close-orphaned-owner';
import { OrphanCloseRefusal } from './close-orphaned-process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverArchivedCloseOwner } from '@/lib/orchestrator/close-archived-owner';
import { dispatch } from '@/lib/lane/commands';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket, getLaneEvents, listLanes, updateLane } from '@/lib/lane/registry';
import { cancelAutoReviewForLane } from '@/lib/lane/review-cancellation';
import { stopActiveReviewTurn } from '@/lib/lane/review-turn-state';
import {
  hasRecordedCleanWorkerExit,
  liveWorkerSessionLanes,
} from '@/lib/lane/worker-session-state';
import {
  archiveLaneSessions,
  killLaneSessionsConfirmed,
  LaneSessionArchiveUnconfirmedError,
} from '@/lib/lane/reap-sessions';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { readMissionRegistryEntry, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { withMissionHandoffBarrier, withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  holdPacketLifecycleMutation,
  markPacketLifecycleFailure,
  packetLifecycleGuardMatches,
  restorePacketLifecycleGuard,
  type PacketLifecycleGuard,
} from '@/lib/orchestrator/packet-lifecycle-guard';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import { markOutcomeClosedUnmerged } from '@/lib/orchestrator/context-relay';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { runRuntimeAwareWorktreeCleanup } from '@/lib/orchestrator/runtime-worktree-cleanup';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import {
  archivedSessionPathForSurfaceId,
  readOwnedSessionState,
} from '@/lib/runtimes/shared/owned-session/archive';
import { formatWorktreeHolderPids } from '@/lib/worktree/holder-diagnostics';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
// #1570 build fix: the client-safe vocabulary (dispositions, labels, types)
// lives in a server-import-free module so client components can use it without
// dragging this server pipeline (+ its transitive `server-only`) into the bundle.
import {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
  type BranchPreservationFailure,
  type BranchPreservationReceipt,
  type CloseUnmergedDisposition,
  type CloseUnmergedResult,
} from './close-unmerged-shared';
import { classifyClosePreservation } from './close-unmerged-preservation';
import {
  buildDiscardedPacketDisposition,
  PACKET_DISPOSITION_EVENT_CODE,
} from '@/lib/receipts/disposition';

// Re-export the shared vocabulary so existing server-side importers of this
// module keep working unchanged.
export {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
};
export type { CloseUnmergedDisposition, CloseUnmergedResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CLOSEABLE_LANE_STATUSES = new Set([
  'idle',
  'paused',
  'awaiting_input',
  'awaiting_orchestrator',
  'awaiting_human',
  'recovering',
  'reviewing',
  'failed',
]);

function workerBindingKey(lane: { id: string; sessionKey: string | null }): string | null {
  const sessionKey = lane.sessionKey?.trim();
  return sessionKey ? `${lane.id}\0${sessionKey}` : null;
}

function isNewWorkerRunBoundary(event: ReturnType<typeof getLaneEvents>[number]): boolean {
  if (event.verb === 'attach_session') return true;
  if (event.verb !== 'status_change') return false;
  return event.payload.status === 'launching' || event.payload.status === 'running';
}

async function archivedSessionMatchesInterruptedRun(input: {
  root: string;
  marker: string;
  sessionKey: string;
  runId: string;
}): Promise<boolean> {
  const archivePath = await archivedSessionPathForSurfaceId(
    input.root,
    input.sessionKey,
    input.marker,
  );
  if (!archivePath) return false;
  try {
    const session = JSON.parse(await readFile(join(archivePath, 'session.json'), 'utf8')) as {
      surfaceId?: unknown;
      activeRun?: unknown;
      recentRuns?: Array<{ id?: unknown; outcome?: unknown }>;
    };
    return session.surfaceId === input.sessionKey
      && !session.activeRun
      && Array.isArray(session.recentRuns)
      && session.recentRuns.some((run) => run.id === input.runId && run.outcome === 'interrupted');
  } catch {
    return false;
  }
}

/**
 * A close retry can retain a packet binding after the durable lane, owned
 * session, and checkout already retired. Treat that exact binding as settled
 * only when the lane ledger proves the stopped run end to end. Missing session
 * metadata alone is never exit proof, and a later attach/launch invalidates the
 * earlier receipts even when it reused the same surface id.
 */
async function confirmedRetiredWorkerBindings(
  packetId: string,
  targets: Array<{ id: string; sessionKey: string | null }>,
): Promise<Set<string>> {
  const retired = new Set<string>();
  const latest = findLatestLaneByPacket(packetId);
  if (!latest || (latest.status !== 'paused'
    && latest.status !== 'archived'
    && latest.status !== 'completed')) return retired;
  const matchingTargets = targets.filter((target) => target.id === latest.id && target.sessionKey?.trim());
  if (matchingTargets.length !== 1) return retired;
  const matchingTarget = matchingTargets[0];
  const sessionKey = matchingTarget?.sessionKey?.trim();
  if (!matchingTarget || !sessionKey) return retired;
  const latestSessionKey = latest.sessionKey?.trim();
  if (latestSessionKey && latestSessionKey !== sessionKey) return retired;
  const bindingKey = workerBindingKey(matchingTarget);
  if (!bindingKey) return retired;

  const events = getLaneEvents(latest.id, 500);
  const killIndex = events.findLastIndex((event) => (
    event.verb === 'kill_escalated'
    && event.payload.confirmed === true
    && event.payload.sessionKey === sessionKey
  ));
  if (killIndex < 0) return retired;
  if (latest.status === 'paused' && !events.some((event, index) => (
    index > killIndex
    && event.verb === 'status_change'
    && event.payload.status === 'paused'
    && event.payload.eventLabel === 'operator_stopped'
  ))) return retired;
  const exitIndex = events.findIndex((event, index) => (
    index > killIndex
    && event.verb === 'runtime_process_exit'
    && event.payload.surfaceId === sessionKey
    && typeof event.payload.runId === 'string'
    && event.payload.runId.trim().length > 0
    && event.payload.runtimeOutcome === 'interrupted'
  ));
  if (exitIndex < 0 || events.slice(killIndex + 1).some(isNewWorkerRunBoundary)) return retired;
  const runId = events[exitIndex]?.payload.runId;
  if (typeof runId !== 'string' || !runId.trim()) return retired;

  const root = ownedRoots().find((candidate) => sessionKey.startsWith(candidate.marker));
  if (!root) return retired;
  if (await readOwnedSessionState(root.root, sessionKey, root.marker) !== 'archived') return retired;
  if (!await archivedSessionMatchesInterruptedRun({
    root: root.root,
    marker: root.marker,
    sessionKey,
    runId: runId.trim(),
  })) return retired;
  retired.add(bindingKey);
  return retired;
}

type PacketCloseFinalization = { closed: true } | {
  closed: false;
  store: 'current' | 'registry';
  reason: 'packet_missing' | 'storage_generation_changed' | 'attempt_changed' | 'lane_binding_changed' | 'lifecycle_guard_changed' | 'terminal_state_changed';
};

function terminalCloseState(packet: OrchestratorPacket): boolean {
  return Boolean(packet.archivedAt) || packet.status === 'archived'
    || packet.status === 'released' || packet.releaseState === 'released';
}

function closeGenerationRefusal(
  guard: PacketLifecycleGuard,
  packet: OrchestratorPacket | undefined,
  store: 'current' | 'registry',
): PacketCloseFinalization | null {
  const reason = !packet ? 'packet_missing'
    : packet.storageAdmissionEpoch !== guard.previousPacket.storageAdmissionEpoch ? 'storage_generation_changed'
      : packet.attemptCount !== guard.previousPacket.attemptCount ? 'attempt_changed'
        : packet.lane?.laneId !== guard.previousPacket.lane?.laneId ? 'lane_binding_changed' : null;
  return reason ? { closed: false, store, reason } : null;
}

async function markPacketClosed(
  guard: PacketLifecycleGuard,
  closedAt: string,
  worktreeCleanup: 'missing' | 'removed' | 'preserved',
  /** Recorded on a packet that has no lane to carry its disposition. */
  completionSummary?: string,
): Promise<PacketCloseFinalization> {
  const archive = (packet: OrchestratorPacket) => {
    if (completionSummary) packet.completionSummary = completionSummary;
    packet.status = 'archived';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.releaseState = 'pending';
    packet.releaseStatePayload = null;
    packet.lane = null;
    packet.archivedAt = closedAt;
    packet.blockedReason = null;
    packet.lastEventAt = closedAt;
    packet.lastEventLabel = worktreeCleanup === 'missing'
      ? 'discarded_worktree_missing'
      : 'closed_unmerged';
  };
  return withMissionHandoffBarrier(async () => {
    const { result } = await withLockedState<PacketCloseFinalization | null>(async (state) => {
      if (state.missionId !== guard.missionId) return null;
      const packet = state.packets.find((candidate) => candidate.id === guard.packetId);
      const refused = closeGenerationRefusal(guard, packet, 'current');
      if (refused) return refused;
      if (packet && terminalCloseState(packet)) {
        return { closed: false, store: 'current', reason: 'terminal_state_changed' };
      }
      if (!packet || !packetLifecycleGuardMatches(packet, guard)) {
        return { closed: false, store: 'current', reason: 'lifecycle_guard_changed' };
      }
      if (readMissionRegistryEntry(guard.missionId, { includeArchived: true })) {
        const { result: mirrored } = await withMissionRegistryState<PacketCloseFinalization>(guard.missionId, (registry) => {
          const target = registry.packets.find((candidate) => candidate.id === guard.packetId);
          const previous = guard.previousRegistryPacket === undefined
            ? guard.previousPacket : guard.previousRegistryPacket;
          // The registry may lag the current lifecycle. Compare its own
          // admission snapshot; never overwrite a later owner/generation.
          const captured = target
            && previous
            && target.releaseStatePayload?.source === previous.releaseStatePayload?.source
            && target.status === previous.status
            && target.queueState === previous.queueState
            && target.operatorStopped === previous.operatorStopped;
          const refused = closeGenerationRefusal(guard, target, 'registry');
          if (refused) return { state: registry, result: refused };
          if (target && terminalCloseState(target)) {
            return { state: registry, result: { closed: false, store: 'registry', reason: 'terminal_state_changed' } };
          }
          if (!target || (!packetLifecycleGuardMatches(target, guard) && !captured)) {
            return { state: registry, result: { closed: false, store: 'registry', reason: 'lifecycle_guard_changed' } };
          }
          archive(target);
          return { state: registry, result: { closed: true } };
        });
        if (!mirrored.closed) return mirrored;
      }
      archive(packet);
      return { closed: true };
    });
    if (result !== null) return result;
    const { result: closed } = await withMissionRegistryState<PacketCloseFinalization>(guard.missionId, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === guard.packetId);
      const refused = closeGenerationRefusal(guard, packet, 'registry');
      if (refused) return { state, result: refused };
      if (packet && terminalCloseState(packet)) {
        return { state, result: { closed: false, store: 'registry', reason: 'terminal_state_changed' } };
      }
      if (!packet || !packetLifecycleGuardMatches(packet, guard)) {
        return { state, result: { closed: false, store: 'registry', reason: 'lifecycle_guard_changed' } };
      }
      archive(packet);
      return { state, result: { closed: true } };
    });
    return closed;
  });
}

async function closePacketUnmergedUnlocked(input: {
  packetId: string;
  disposition: unknown;
  note: unknown;
  acknowledgeMissingWorktree: boolean;
}): Promise<CloseUnmergedResult> {
  const rawDisposition = input.disposition ?? 'wontfix';
  if (!isCloseUnmergedDisposition(rawDisposition)) {
    return {
      ok: false,
      code: 'invalid_disposition',
      message: 'disposition must be one of: adopted_elsewhere, superseded, spec_changed, wontfix.',
      status: 400,
    };
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 1_000) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'note must be 1,000 characters or fewer.',
      status: 400,
    };
  }

  const guard = await holdPacketLifecycleMutation({ packetId: input.packetId, kind: 'close' });
  if (!guard) {
    return {
      ok: false,
      code: 'packet_not_found',
      message: `Packet ${input.packetId} was not found in current or durable mission state.`,
      status: 404,
    } satisfies CloseUnmergedResult;
  }
  if (guard.previousRegistryPacket) {
    const refused = closeGenerationRefusal(guard, guard.previousRegistryPacket, 'registry')
      ?? (terminalCloseState(guard.previousRegistryPacket) && guard.previousPacket.status !== 'archived'
        ? { closed: false, store: 'registry', reason: 'terminal_state_changed' } as const : null);
    if (refused && !refused.closed) {
      await restorePacketLifecycleGuard(guard);
      return { ok: false, code: 'packet_state_changed', status: 409,
        message: `Packet ${input.packetId} close admission refused by registry state (${refused.reason}).`,
        error: { store: refused.store, reason: refused.reason } };
    }
  }
  if (guard.previousPacket.status === 'archived') {
    const priorLane = findLatestLaneByPacket(input.packetId);
    if (!await restorePacketLifecycleGuard(guard)) {
      return {
        ok: false,
        code: 'packet_state_changed',
        message: `Packet ${input.packetId} changed while its closed state was being confirmed.`,
        status: 409,
      };
    }
    const hadCheckout = Boolean(priorLane?.worktreePath && existsSync(priorLane.worktreePath));
    const cleanup = hadCheckout && priorLane
      ? await import('@/lib/lane/retire-finished-worktree').then(({ retireFinishedWorktreeWithResult }) => retireFinishedWorktreeWithResult(priorLane))
      : null;
    if (cleanup && !cleanup.removed) return { ok: false, code: 'close_failed', status: 409,
      message: cleanup.detail ?? `Archived packet checkout retirement was not confirmed (${cleanup.reason ?? 'unknown'}). The checkout remains held.` };
    return {
      ok: true,
      result: {
        closed: true,
        alreadyClosed: true,
        packetId: input.packetId,
        laneId: priorLane?.id ?? null,
        note: `Packet ${input.packetId} is already closed.`,
      },
    };
  }
  const persistedLanes = listLanes().filter((candidate) => (
    candidate.packetId === input.packetId
    && candidate.status !== 'archived'
    && candidate.status !== 'completed'
  ));
  let lanesToClose = collectPacketLifecycleLanes(
    guard.previousPacket,
    guard.repoPath,
    persistedLanes,
  );
  const lane = lanesToClose.at(-1) ?? findLatestLaneByPacket(input.packetId) ?? null;
  if (!lane && packetNeverLaunched(guard.previousPacket)) {
    return closeNeverLaunchedPacket(guard, input.packetId, rawDisposition, note);
  }
  if (!lane) {
    await restorePacketLifecycleGuard(guard);
    return {
      ok: false,
      code: 'lane_not_found',
      message: `No lane or authoritative packet binding found for packet ${input.packetId}.`,
      status: 404,
    };
  }
  const uncloseable = lanesToClose.find((candidate) => !CLOSEABLE_LANE_STATUSES.has(candidate.status));
  if (uncloseable) {
    await restorePacketLifecycleGuard(guard);
    return {
      ok: false,
      code: 'invalid_packet_state',
      message: `Packet ${input.packetId} cannot close unmerged while lane ${uncloseable.id} is ${uncloseable.status}. Stop or finish the live worker first.`,
      status: 409,
    };
  }
  const worktreeRefs = new Map<string, string>();
  for (const target of lanesToClose) {
    if (!target.worktreePath?.trim() || !target.branch.trim()) continue;
    const refKey = `${target.repoPath.replace(/\/+$/, '')}\0${target.branch}`;
    const priorWorktree = worktreeRefs.get(refKey);
    if (priorWorktree && priorWorktree !== target.worktreePath) {
      await restorePacketLifecycleGuard(guard);
      return {
        ok: false,
        code: 'ambiguous_lifecycle_targets',
        message: `Packet ${input.packetId} has multiple worktrees claiming branch ${target.branch}; close was refused so neither checkout is discarded.`,
        status: 409,
      };
    }
    worktreeRefs.set(refKey, target.worktreePath);
  }

  const missingWorktreeBindings = new Set<string>();
  const detachedSessionRollbacks: Array<() => Promise<unknown>> = [];
  const restoreDetachedSessions = async () => {
    await Promise.allSettled(detachedSessionRollbacks.map((rollback) => rollback()));
    detachedSessionRollbacks.length = 0;
  };
  try {
    for (const target of lanesToClose) {
      const worktreePath = target.worktreePath?.trim();
      if (worktreePath && !existsSync(worktreePath) && !orphanCloseRetirement(target)) missingWorktreeBindings.add(`${target.id}\0${worktreePath}`);
    }
    const stoppedReviewTurns = [];
    const reviewedLaneIds = new Set<string>();
    for (const target of lanesToClose) {
      if (reviewedLaneIds.has(target.id)) continue;
      reviewedLaneIds.add(target.id);
      cancelAutoReviewForLane(target.id, 'packet_discarded');
      const stopped = stopActiveReviewTurn({ laneId: target.id, reason: 'packet_discarded' });
      if (stopped) stoppedReviewTurns.push(stopped);
    }

    const archivedOwner = rawDisposition === 'adopted_elsewhere'
      ? await timeClosePhase('recover_owner', () => recoverArchivedCloseOwner(input.packetId, lanesToClose)) : null;
    if (archivedOwner) {
      lanesToClose = archivedOwner.targets;
    }
    const orphanLaneIds = await timeClosePhase('admit_owners', () => prepareOrphanCloseOwners(lanesToClose));
    const retiredWorkerBindings = await confirmedRetiredWorkerBindings(input.packetId, lanesToClose);
    if (archivedOwner) retiredWorkerBindings.add(archivedOwner.bindingKey);
    const workerLanesToKill = lanesToClose.filter((target) => {
      if (orphanLaneIds.has(target.id)) return false;
      const bindingKey = workerBindingKey(target);
      return !bindingKey || !retiredWorkerBindings.has(bindingKey);
    });
    const kills = await killLaneSessionsConfirmed(liveWorkerSessionLanes(workerLanesToKill));
    const survivors = [] as typeof kills;
    let goneRunsWithoutProcess = 0;
    for (const outcome of kills.filter(entry => !entry.confirmed && !entry.alreadyDead)) {
      const target = lanesToClose.find(entry => entry.id === outcome.laneId);
      const workspaceGone = target && (target.worktreePath?.trim()
        ? missingWorktreeBindings.has(`${target.id}\0${target.worktreePath}`)
        : input.acknowledgeMissingWorktree);
      const gone = target && workspaceGone
        ? await import('./close-gone-session').then(({ confirmGoneCloseSession }) => confirmGoneCloseSession(target, {
          packetId: input.packetId, sessionKey: outcome.sessionKey, acknowledgeMissingWorktree: input.acknowledgeMissingWorktree,
        }))
        : null;
      if (gone && target) {
        orphanLaneIds.add(target.id);
        goneRunsWithoutProcess += gone.runsWithoutProcess;
      } else survivors.push(outcome);
    }
    const survivorLaneIds = new Set(survivors.map((outcome) => outcome.laneId));
    const unverifiedMissing = lanesToClose.find((target) => {
      const worktreePath = target.worktreePath?.trim();
      if (!worktreePath || !missingWorktreeBindings.has(`${target.id}\0${worktreePath}`)) return false;
      return !input.acknowledgeMissingWorktree && !hasRecordedCleanWorkerExit(target);
    });
    if (unverifiedMissing) {
      await restorePacketLifecycleGuard(guard);
      return {
        ok: false,
        code: 'worktree_missing_unverified',
        message: `Close refused because worktree ${unverifiedMissing.worktreePath} is missing without a recorded clean worker exit. Inspect the packet, then acknowledge the missing worktree to discard it without deleting any path that still exists.`,
        status: 409,
      };
    }

    const preservedBranches: string[] = [];
    const preservationReceipts: BranchPreservationReceipt[] = [];
    let preservationFailure: BranchPreservationFailure | null = null;
    const distinctTargets = [...new Map(lanesToClose
      .filter((target) => target.repoPath.trim() && target.branch.trim())
      .map((target) => [`${target.repoPath}\0${target.branch}`, target] as const)).values()];
    for (const target of distinctTargets) {
      const preservation = await timeClosePhase('preserve_branch', () => classifyClosePreservation(input.packetId, target));
      preservationReceipts.push(preservation.receipt);
      if (preservation.receipt.reason.startsWith('preserved/')
        && !preservedBranches.includes(preservation.receipt.reason)) {
        preservedBranches.push(preservation.receipt.reason);
      }
      if (preservation.failure) {
        preservationFailure = preservation.failure;
        const auditNote = `Preservation FAILED for ${preservation.failure.ref}; the worktree remains intact and close was refused.`;
        recordLaneEvent(target.id, 'branch_preservation_failed', 'system', {
          code: preservation.failure.code,
          reason: preservation.failure.reason,
          packetId: input.packetId,
          branch: preservation.failure.branch,
          ref: preservation.failure.ref,
          receipt: preservation.receipt,
          note: auditNote,
          gcRisk: false,
        });
        break;
      }
    }
    if (preservationFailure) {
      await markPacketLifecycleFailure(guard, preservationFailure.code);
      return {
        ok: false,
        code: preservationFailure.code,
        message: `Close refused because work on ${preservationFailure.branch} could not be preserved. The lane and worktree remain intact.`,
        status: 409,
      };
    }
    const preservedBranch = preservedBranches.length === 1 ? preservedBranches[0] ?? null : null;

    const killUnconfirmedNote = survivors.length > 0
      ? ` Kill unconfirmed for ${survivors.length} worker session class process${survivors.length === 1 ? '' : 'es'}. The packet was closed; any existing worktree and owned-session recovery metadata were preserved.`
      : '';
    const goneSessionNote = goneRunsWithoutProcess > 0
      ? ` ${goneRunsWithoutProcess} earlier worker run${goneRunsWithoutProcess === 1 ? '' : 's'} never recorded a process id, so only packet and run markers were checked for a live worker.`
      : '';
    const outcomeNote = `${closeUnmergedOutcomeNote({
      disposition: rawDisposition,
      note,
      preservedBranch,
      preservedBranches,
      preservationReceipts,
      preservationFailure,
    })}${killUnconfirmedNote}${goneSessionNote}`;
    for (const survivor of survivors) {
      const lifecycle = getOwnedSessionLifecycle(survivor.sessionKey);
      if (!lifecycle?.setDetachedSession) {
        if (!survivor.sessionKey.includes('-owned:')) continue;
        await restoreDetachedSessions();
        await markPacketLifecycleFailure(guard, 'session_archive_unconfirmed');
        return {
          ok: false,
          code: 'session_archive_unconfirmed',
          message: `Close could not detach owned-session recovery metadata for ${survivor.sessionKey}; the packet remains held.`,
          status: 409,
        };
      }
      const detached = await lifecycle.setDetachedSession(
        survivor.sessionKey,
        `Packet ${input.packetId} closed while worker exit remained unconfirmed.`,
      );
      if (!detached.updated) {
        await restoreDetachedSessions();
        await markPacketLifecycleFailure(guard, 'session_archive_unconfirmed');
        return {
          ok: false,
          code: 'session_archive_unconfirmed',
          message: `Close could not preserve detached owned-session recovery metadata for ${survivor.sessionKey}; the packet remains held.`,
          status: 409,
        };
      }
      if (!detached.previouslyDetached) {
        detachedSessionRollbacks.push(() => lifecycle.setDetachedSession!(survivor.sessionKey, null));
      }
    }
    let worktreeRemoved = false;
    for (const candidate of survivors.length === 0 ? lanesToClose : []) {
      const worktreePath = candidate.worktreePath?.trim();
      if (worktreePath && missingWorktreeBindings.has(`${candidate.id}\0${worktreePath}`)) {
        continue;
      }
      try {
        const cleanupAttempt = await runRuntimeAwareWorktreeCleanup({
          runtime: candidate.runtime,
          worktreePath: candidate.worktreePath,
          cleanup: () => timeClosePhase('cleanup', () => removeMergedWorktree(candidate)),
          removed: (result) => result.removed || result.reason === 'worktree-equals-repo',
        });
        const cleanup = cleanupAttempt.result;
        const intentionalMainCheckout = cleanup.reason === 'worktree-equals-repo';
        if (!cleanup.removed && !intentionalMainCheckout) {
          await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
          return {
            ok: false,
            code: 'close_failed',
            message: cleanup.detail ?? `Close refused because worktree cleanup for lane ${candidate.id} was not confirmed (${cleanup.reason ?? 'unknown'}). The packet remains held and the checkout remains visible.${formatWorktreeHolderPids(cleanupAttempt.holderPids)}`,
            status: 409,
          };
        }
        worktreeRemoved = cleanup.removed || worktreeRemoved;
      } catch (cleanupError) {
        await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
        return {
          ok: false,
          code: 'close_failed',
          message: `Close refused because worktree cleanup for lane ${candidate.id} failed. The packet remains held and the checkout remains visible: ${errorMessage(cleanupError)}`,
          status: 409,
        };
      }
    }
    try {
      // A worker whose exit is confirmed and whose session files are absent has
      // nothing left to archive; record that and close.
      const archive = await archiveLaneSessions(lanesToClose.filter((candidate) => !survivorLaneIds.has(candidate.id) && !orphanLaneIds.has(candidate.id)));
      const failures = archive.failures.filter((failure) => !failure.missing);
      if (failures.length > 0) throw new LaneSessionArchiveUnconfirmedError({ ...archive, failures });
      for (const absent of archive.failures.filter((failure) => failure.missing)) {
        if (persistedLanes.some((candidate) => candidate.id === absent.laneId)) {
          recordLaneEvent(absent.laneId, 'update', 'system', {
            code: 'session_files_absent', packetId: input.packetId, sessionKey: absent.sessionKey,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof LaneSessionArchiveUnconfirmedError)) throw error;
      await restoreDetachedSessions();
      await markPacketLifecycleFailure(guard, 'session_archive_unconfirmed');
      return {
        ok: false,
        code: 'session_archive_unconfirmed',
        message: error.message,
        status: 409,
      };
    }
    for (const candidate of lanesToClose.filter((target) => !survivorLaneIds.has(target.id))) {
      if (candidate.sessionKey?.trim()) unregisterWatchedAgent(candidate.sessionKey.trim());
    }
    const primaryWorktreePath = lane.worktreePath?.trim();
    const worktreeCleanup = primaryWorktreePath
      && missingWorktreeBindings.has(`${lane.id}\0${primaryWorktreePath}`)
      ? 'missing' as const
      : worktreeRemoved
        ? 'removed' as const
        : 'preserved' as const;
    const persistedIds = new Set(persistedLanes.map((candidate) => candidate.id));
    for (const candidate of lanesToClose.filter((target) => persistedIds.has(target.id))) {
      const archived = await dispatch({
        verb: 'archive',
        laneId: candidate.id,
        outcome: 'closed_unmerged',
        outcomeNote,
        actor: 'user',
      });
      if (!archived.ok) {
        await restoreDetachedSessions();
        await markPacketLifecycleFailure(guard, 'lane_archive_failed');
        return {
          ok: false,
          code: 'close_failed',
          message: archived.note ?? `Unable to archive lane ${candidate.id}.`,
          status: 422,
        };
      }
      const candidateWorktreePath = candidate.worktreePath?.trim();
      const candidateCleanup = candidateWorktreePath
        && missingWorktreeBindings.has(`${candidate.id}\0${candidateWorktreePath}`)
        ? 'missing'
        : worktreeRemoved ? 'removed' : 'preserved';
      const eventLabel = candidateCleanup === 'missing'
        ? 'discarded_worktree_missing'
        : 'closed_unmerged';
      updateLane(candidate.id, {
        lastEventAt: new Date().toISOString(),
        lastEventLabel: eventLabel,
      }, 'user', {
        eventLabel,
        packetId: input.packetId,
        worktreeCleanup: candidateCleanup,
        reason: candidateCleanup === 'missing' ? 'worktree_missing' : 'close_unmerged',
        acknowledgedMissingWorktree: input.acknowledgeMissingWorktree,
      });
      recordLaneEvent(candidate.id, 'packet_discarded', 'user', {
        packetId: input.packetId,
        disposition: rawDisposition,
        worktreeCleanup: candidateCleanup,
        reason: candidateCleanup === 'missing' ? 'worktree_missing' : 'close_unmerged',
        acknowledgedMissingWorktree: input.acknowledgeMissingWorktree,
        stoppedReviewTurns: stoppedReviewTurns.length,
        killUnconfirmed: survivors.length,
      });
    }

    const closedAt = new Date().toISOString();
    const finalization = await markPacketClosed(guard, closedAt, worktreeCleanup);
    if (!finalization.closed) {
      await restoreDetachedSessions();
      return {
        ok: false,
        code: 'close_failed',
        message: `Packet ${input.packetId} close finalization refused by ${finalization.store} state (${finalization.reason}).`,
        error: { store: finalization.store, reason: finalization.reason },
        status: 409,
      };
    }
    detachedSessionRollbacks.length = 0;
    for (const survivor of survivors.filter((target) => persistedIds.has(target.laneId))) {
      recordLaneEvent(survivor.laneId, 'update', 'system', {
        code: 'kill_unconfirmed',
        packetId: input.packetId,
        sessionKey: survivor.sessionKey,
        resolution: 'closed_unmerged_worker_ownership_preserved',
        note: survivor.note,
      });
    }
    await markOutcomeClosedUnmerged({
      laneId: lane.id,
      packetId: input.packetId,
      disposition: rawDisposition,
      lane,
      summary: outcomeNote,
    });

    const packetDisposition = buildDiscardedPacketDisposition({
      disposition: rawDisposition,
      reason: note,
      preservedBranches,
      closedAt,
    });
    if (persistedIds.has(lane.id)) {
      recordLaneEvent(lane.id, 'update', 'system', {
        code: PACKET_DISPOSITION_EVENT_CODE,
        disposition: packetDisposition,
        preservationReceipts,
      });
    }
    void import('@/lib/receipts/packet-receipt')
      .then(({ createPacketReceiptForClosedPacket }) => createPacketReceiptForClosedPacket({
        packetId: input.packetId,
        laneId: lane.id,
        repoPath: lane.repoPath,
        disposition: packetDisposition,
      }))
      .catch((error) => {
        console.warn(`[receipts] Discard receipt failed for packet ${input.packetId}:`, error);
      });

    void requestRealtimeRefresh({
      targets: ['global', 'mobileInbox'],
      fresh: true,
      reason: 'packet.close_unmerged',
    });

    return {
      ok: true,
      result: {
        closed: true,
        alreadyClosed: false,
        discarded: true,
        disposition: rawDisposition,
        laneId: lane.id,
        packetId: input.packetId,
        worktreeRemoved,
        worktreeCleanup,
        stoppedReviewTurns: stoppedReviewTurns.length,
        preservedBranch,
        preservedBranches,
        preservationReceipts,
        preservationFailure,
        note: `${outcomeNote}${worktreeCleanup === 'missing'
          ? ' Worktree was already missing; close recorded worktree_missing.'
          : worktreeRemoved ? ' Worktree removed.' : ''}${stoppedReviewTurns.length > 0
          ? ` Stopped ${stoppedReviewTurns.length} active review turn${stoppedReviewTurns.length === 1 ? '' : 's'} before close.`
          : ''}`,
      },
    };
  } catch (error) {
    await restoreDetachedSessions();
    await markPacketLifecycleFailure(guard, 'close_failed');
    return {
      ok: false,
      code: 'close_failed',
      message: error instanceof Error ? error.message : 'Unable to close packet unmerged.',
      status: error instanceof OrphanCloseRefusal ? 409 : 500,
      error,
    };
  }
}

/** No lane record and no binding: the packet was never launched. */
function packetNeverLaunched(packet: OrchestratorPacket): boolean {
  return !packet.lane?.laneId && !packet.lane?.sessionKey && !packet.lane?.worktreePath
    && !findLatestLaneByPacket(packet.id);
}

/** A never-launched packet has no worker, checkout or branch to retire: archive it with its disposition. */
async function closeNeverLaunchedPacket(
  guard: PacketLifecycleGuard,
  packetId: string,
  disposition: CloseUnmergedDisposition,
  note: string,
): Promise<CloseUnmergedResult> {
  const outcomeNote = `${closeUnmergedOutcomeNote({ disposition, note })} The packet never launched.`;
  const finalization = await markPacketClosed(guard, new Date().toISOString(), 'preserved', outcomeNote);
  if (!finalization.closed) {
    await restorePacketLifecycleGuard(guard);
    return {
      ok: false,
      code: 'close_failed',
      message: `Packet ${packetId} close finalization refused by ${finalization.store} state (${finalization.reason}).`,
      error: { store: finalization.store, reason: finalization.reason },
      status: 409,
    };
  }
  void requestRealtimeRefresh({ targets: ['global', 'mobileInbox'], fresh: true, reason: 'packet.close_unmerged' });
  return {
    ok: true,
    result: {
      closed: true,
      alreadyClosed: false,
      discarded: true,
      disposition,
      laneId: null,
      packetId,
      worktreeRemoved: false,
      worktreeCleanup: 'preserved',
      stoppedReviewTurns: 0,
      preservedBranch: null,
      preservedBranches: [],
      preservationReceipts: [],
      preservationFailure: null,
      note: outcomeNote,
    },
  };
}

export function closePacketUnmerged(input: {
  packetId: string;
  disposition: unknown;
  note: unknown;
  acknowledgeMissingWorktree?: boolean;
}): Promise<CloseUnmergedResult> {
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended) {
      return {
        ok: false,
        code: 'packet_state_changed',
        message: `Packet ${input.packetId} changed while another lifecycle action was in progress; close was not applied.`,
        status: 409,
      };
    }
    return withCloseTiming(input.packetId, () => withOrphanCloseContext(input.packetId, () => closePacketUnmergedUnlocked({
      ...input,
      acknowledgeMissingWorktree: input.acknowledgeMissingWorktree === true,
    })));
  });
}
