import { holdStandingLane } from '@/lib/lane/standing-store';
/**
 * Stop / kill an agent — the symmetric counterpart to dispatch (#1286).
 *
 * `resetPacket` archives the lane + prunes the worktree but does NOT reap the
 * runtime process, so a plain reset can leave an orphaned `codex exec` churning
 * against a pruned worktree (the zombie case the operator hit via Symon). A true
 * stop must INTERRUPT the live session first (kills the process via the runtime
 * adapter), THEN archive — and must NOT relaunch. "Stop" means stop.
 */
import { archiveLaneSessions, killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';
import { cancelAutoReviewForLane } from '@/lib/lane/review-cancellation';
import { stopActiveReviewTurn } from '@/lib/lane/review-turn-state';
import { liveWorkerSessionLanes } from '@/lib/lane/worker-session-state';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  holdPacketLifecycleMutation,
  markPacketLifecycleFailure,
  mutatePacketLifecycleGuard,
  type PacketLifecycleGuard,
} from '@/lib/orchestrator/packet-lifecycle-guard';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
import { terminatePacketManagedRuns } from '@/lib/runtimes/managed-runs/packet-lifecycle';

export interface StopPacketResult {
  ok: boolean;
  packetId: string;
  interruptedSessions: number;
  archivedLanes: number;
  worktreePruned: boolean;
  /** #1471 S1 — false when a worker survived even SIGKILL (lane parked kill_unconfirmed). */
  killConfirmed: boolean;
  stoppedReviewTurns: number;
  /** Set to 'kill_unconfirmed' when the process could not be confirmed dead. */
  blockedReason?: string;
  note: string;
}

export interface StopAllResult {
  ok: boolean;
  stoppedPackets: number;
  failedPackets: number;
  interruptedSessions: number;
  archivedLanes: number;
  failedLanes: number;
  note: string;
}

/**
 * Stop a single packet: kill its live runtime process(es), archive its lane(s),
 * prune the worktree — no relaunch. The interrupt MUST run before resetPacket
 * nulls sessionKey, or the runtime process is orphaned (#1286).
 */
// #1528 review F10 — one stop per packet at a time. Two concurrent stops
// would double the backgrounded cleanup (duplicate archive/prune races) and
// each would clear the other's operatorStopped provenance via the reset hold.
const stopsInFlight = new Map<string, Promise<StopPacketResult>>();
const stopCleanups = new Map<string, Promise<boolean>>();

export function stopPacket(packetId: string): Promise<StopPacketResult> {
  const existing = stopsInFlight.get(packetId);
  if (existing) return existing;
  // A prior stop's settled cleanup receipt stays readable for stop-all until a
  // genuinely new stop attempt begins.
  stopCleanups.delete(packetId);
  const operation = withPacketLifecycleMutationLock(packetId, async () => {
    const { listLanes } = await import('@/lib/lane/registry');
    const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service');
    return stopPacketInner(packetId, resetPacket, listLanes);
  });
  const tracked = operation.then((result) => {
    const cleanup = stopCleanups.get(packetId);
    if (cleanup) {
      void cleanup.finally(() => {
        if (stopsInFlight.get(packetId) === tracked) stopsInFlight.delete(packetId);
      });
    } else if (stopsInFlight.get(packetId) === tracked) {
      stopsInFlight.delete(packetId);
    }
    return result;
  }, (error) => {
    if (stopsInFlight.get(packetId) === tracked) stopsInFlight.delete(packetId);
    throw error;
  });
  stopsInFlight.set(packetId, tracked);
  return tracked;
}

async function stopPacketInner(
  packetId: string,
  resetPacket: typeof import('@/lib/orchestrator/operator-mission-service').resetPacket,
  listLanes: typeof import('@/lib/lane/registry').listLanes,
): Promise<StopPacketResult> {
  const stopGuard = await holdPacketLifecycleMutation({ packetId, kind: 'stop' });
  const packetKnown = Boolean(stopGuard);

  // Install the dispatch blocker before the kill ladder yields. A stop can
  // spend seconds waiting through SIGINT -> SIGTERM -> SIGKILL; leaving the
  // packet queued during that window lets an explicit or headless dispatch
  // bind a fresh lane that the stop's scoped reset never owned. The generation
  // ties every later transition and cleanup to this exact stop attempt, while
  // the packet's live lane/session/worktree binding remains untouched until
  // death is confirmed.
  // Read lanes after the durable hold. If a dispatch already owned the mission
  // lock when Stop arrived, the hold waits for it and this read captures the
  // lane it finished binding instead of using a stale pre-lock snapshot.
  const persistedLanes = listLanes().filter((lane) => lane.packetId === packetId);
  const lanes = stopGuard
    ? collectPacketLifecycleLanes(stopGuard.previousPacket, stopGuard.repoPath, persistedLanes)
    : persistedLanes;

  for (const lane of lanes) holdStandingLane(lane.id);

  // #1528 — idempotent no-op: nothing bound anywhere means nothing to stop.
  // Stopping an already-gone packet must return success in milliseconds, never
  // fall through to resetPacket's "not found" throw.
  if (lanes.length === 0 && !packetKnown) {
    const managedRuns = await terminatePacketManagedRuns(packetId);
    if (managedRuns.failures.length > 0) {
      return {
        ok: false,
        packetId,
        interruptedSessions: managedRuns.confirmed,
        archivedLanes: 0,
        worktreePruned: false,
        killConfirmed: false,
        stoppedReviewTurns: 0,
        blockedReason: 'kill_unconfirmed',
        note: `Stop could not confirm ${managedRuns.failures.length} packet-managed run${managedRuns.failures.length === 1 ? '' : 's'} exited. No lane or worktree state was changed.`,
      };
    }
    return {
      ok: true,
      packetId,
      interruptedSessions: managedRuns.confirmed,
      archivedLanes: 0,
      worktreePruned: false,
      killConfirmed: true,
      stoppedReviewTurns: 0,
      note: managedRuns.confirmed > 0
        ? `Stopped ${managedRuns.confirmed} packet-managed run${managedRuns.confirmed === 1 ? '' : 's'}; no live lanes or mission packet remained for ${packetId}.`
        : `Nothing to stop — no live lanes and no mission packet for ${packetId}.`,
    };
  }

  // #1471 S1 — confirmed kill FIRST. Escalate SIGINT→SIGTERM→SIGKILL and verify
  // exit before touching lane state, so we never archive + prune a worktree out
  // from under a worker that is still churning (the zombie the stop verb exists
  // to prevent). If ANY session survived even SIGKILL, park the packet
  // `kill_unconfirmed` and DO NOT archive/prune — telling the truth beats lying.
  let stoppedReviewTurns = 0;
  const reviewedLaneIds = new Set<string>();
  for (const lane of lanes) {
    if (reviewedLaneIds.has(lane.id)) continue;
    reviewedLaneIds.add(lane.id);
    cancelAutoReviewForLane(lane.id, 'packet_stopped');
    if (stopActiveReviewTurn({ laneId: lane.id, reason: 'packet_stopped' })) {
      stoppedReviewTurns += 1;
    }
  }

  const kills = await killLaneSessionsConfirmed(liveWorkerSessionLanes(lanes));
  const reaped = kills.filter((kill) => kill.confirmed && !kill.alreadyDead).length;
  const survivors = kills.filter((kill) => !kill.confirmed && !kill.alreadyDead);

  if (survivors.length > 0) {
    if (stopGuard) {
      await markPacketKillUnconfirmed(stopGuard, survivors.map((survivor) => ({
        laneId: survivor.laneId,
        sessionKey: survivor.sessionKey,
        pid: survivor.pid,
      })));
    }
    return {
      ok: false,
      packetId,
      interruptedSessions: reaped,
      archivedLanes: 0,
      worktreePruned: false,
      killConfirmed: false,
      stoppedReviewTurns,
      blockedReason: 'kill_unconfirmed',
      note: `Stop could not confirm ${survivors.length} worker session class process${survivors.length === 1 ? '' : 'es'} exited after SIGKILL. Packet parked kill_unconfirmed; worktree left intact. Reset again or kill the pid manually.`,
    };
  }

  // A worker can launch an o8-managed command in a separate tmux process tree.
  // Once the worker itself is confirmed dead, no new packet-owned runs can be
  // registered. Settle every already-registered run before archive/prune so a
  // stopped packet cannot keep CPU, listeners, or a retired-worktree cwd alive.
  const managedRuns = await terminatePacketManagedRuns(packetId);
  if (managedRuns.failures.length > 0) {
    if (stopGuard) {
      await markPacketLifecycleFailure(stopGuard, 'kill_unconfirmed');
    }
    return {
      ok: false,
      packetId,
      interruptedSessions: reaped + managedRuns.confirmed,
      archivedLanes: 0,
      worktreePruned: false,
      killConfirmed: false,
      stoppedReviewTurns,
      blockedReason: 'kill_unconfirmed',
      note: `Stop confirmed the worker session but could not confirm ${managedRuns.failures.length} packet-managed run${managedRuns.failures.length === 1 ? '' : 's'} exited. Packet parked kill_unconfirmed; worktree left intact.`,
    };
  }

  // #1528 — stop's contract is answered at kill-confirm. Hold the packet under
  // the lock NOW (cheap, blocks every relaunch path), then background the
  // archive + worktree prune: rm -rf of a node_modules-cloned worktree runs for
  // minutes and used to hold this response open until undici's client timeout
  // fired and the CLI misreported connection_refused while the server listened.
  if (stopGuard) {
    await markPacketStoppedHeld(stopGuard);
  }
  const cleanup = resetPacket({
    packetId,
    clearWorktree: true,
    reason: 'stopped by operator (#1286)',
    // Generation scope: only the lanes captured at stop entry. A re-dispatch
    // during the cleanup window binds a NEW lane + worktree this cleanup must
    // never touch, and the hold is skipped if the packet's state moved on.
    scope: {
      laneIds: lanes.map((lane) => lane.id),
      skipHoldIfStateMoved: true,
      preserveOperatorStopped: true,
      expectedReleaseSource: stopGuard?.source,
    },
  }).then((reset) => {
    const pruned = (reset as { worktreePruned?: boolean }).worktreePruned === true;
    console.log(`[stop-packet] background cleanup finished for ${packetId}${pruned ? ' (worktree pruned)' : ''}`);
    return reset.reset !== false || reset.salvaged === true;
  }).catch((error) => {
    console.warn(`[stop-packet] background cleanup failed for ${packetId} — packet stays held:`, error);
    return false;
  });
  stopCleanups.set(packetId, cleanup);
  void cleanup;

  return {
    ok: true,
    packetId,
    interruptedSessions: reaped + managedRuns.confirmed,
    archivedLanes: 0,
    worktreePruned: false,
    killConfirmed: true,
    stoppedReviewTurns,
    note: `Stopped packet ${packetId}: confirmed-killed ${reaped} live worker session${reaped === 1 ? '' : 's'} and ${managedRuns.confirmed} packet-managed run${managedRuns.confirmed === 1 ? '' : 's'}; stopped ${stoppedReviewTurns} review turn${stoppedReviewTurns === 1 ? '' : 's'}; held against relaunch. Archiving ${lanes.length} lane${lanes.length === 1 ? '' : 's'} + pruning the worktree in the background (audit via lane events). Not relaunched.`,
  };
}

async function markPacketStoppedHeld(guard: PacketLifecycleGuard): Promise<void> {
  const held = await mutatePacketLifecycleGuard(guard, (packet) => {
    packet.operatorStopped = true;
    packet.queueState = 'held';
    packet.status = 'blocked';
    packet.blockedReason = 'operator_stopped';
    packet.releaseState = 'pending';
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = 'operator_stopped';
    return true;
  });
  if (!held.matched || held.result !== true) {
    throw new Error(`Packet ${guard.packetId} moved to a newer generation before its confirmed stop could be finalized.`);
  }
}

/**
 * #1471 S1 — park a packet `kill_unconfirmed` when its worker survived SIGKILL.
 * Held under the control-plane lock so a concurrent dispatch tick can't relaunch
 * it. Best-effort — a failed write is logged, never thrown.
 */
async function markPacketKillUnconfirmed(
  guard: PacketLifecycleGuard,
  survivors: Array<{ laneId: string; sessionKey: string; pid?: number }>,
): Promise<void> {
  try {
    await markPacketLifecycleFailure(guard, 'kill_unconfirmed');
  } catch (error) {
    console.warn(`[kill] failed to mark packet ${guard.packetId} kill_unconfirmed:`, error);
  }
  console.warn(
    `[kill] packet ${guard.packetId}: ${survivors.length} worker(s) unconfirmed after SIGKILL — ${survivors
      .map((survivor) => `${survivor.sessionKey}${survivor.pid ? ` pid ${survivor.pid}` : ''}`)
      .join(', ')}`,
  );
}

/**
 * Clean slate: stop every active lane in scope — kill live processes, archive
 * lanes (including orphans with no packetId), prune worktrees. No relaunch.
 */
export async function stopAllLanes(opts: { repoPath?: string } = {}): Promise<StopAllResult> {
  const { listActiveLanes, archiveLane } = await import('@/lib/lane/registry');

  const active = listActiveLanes().filter(
    (lane) => !opts.repoPath || lane.repoPath === opts.repoPath,
  );
  const packetIds = new Set<string>();
  for (const lane of active) {
    if (lane.packetId) packetIds.add(lane.packetId);
  }

  let interrupted = 0;
  let archived = 0;
  let stoppedPackets = 0;
  let failedPackets = 0;
  let failedLanes = 0;

  // Packets with bound lanes go through the full stop (interrupt + archive + prune).
  for (const packetId of packetIds) {
    try {
      const result = await stopPacket(packetId);
      interrupted += result.interruptedSessions;
      if (result.ok && result.killConfirmed) {
        const cleanupReceipt = stopCleanups.get(packetId);
        const cleanupOk = await (cleanupReceipt ?? Promise.resolve(true));
        if (cleanupReceipt && stopCleanups.get(packetId) === cleanupReceipt) {
          stopCleanups.delete(packetId);
        }
        if (cleanupOk) {
          stoppedPackets += 1;
          archived += active.filter((lane) => lane.packetId === packetId).length;
        } else {
          failedPackets += 1;
          failedLanes += Math.max(1, active.filter((lane) => lane.packetId === packetId).length);
        }
      } else {
        failedPackets += 1;
        failedLanes += Math.max(1, active.filter((lane) => lane.packetId === packetId).length);
      }
    } catch (error) {
      console.warn(`[stop-packet] stopAll: failed to stop packet ${packetId}:`, error);
      failedPackets += 1;
      failedLanes += Math.max(1, active.filter((lane) => lane.packetId === packetId).length);
    }
  }

  // Orphan lanes have no packet state to park, so they still require the same
  // confirmed kill truth. A surviving orphan stays visible and bound for
  // manual recovery instead of being archived while it keeps running.
  const orphans = active.filter((lane) => !lane.packetId);
  const orphanKills = await killLaneSessionsConfirmed(orphans);
  const confirmedOrphanIds = new Set(orphanKills
    .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
    .map((outcome) => outcome.laneId));
  for (const lane of orphans) {
    if (!lane.sessionKey?.trim()) confirmedOrphanIds.add(lane.id);
  }
  interrupted += confirmedOrphanIds.size;
  const stoppedOrphans = orphans.filter((candidate) => confirmedOrphanIds.has(candidate.id));
  const sessionArchive = await archiveLaneSessions(stoppedOrphans);
  const unarchivedSessionLaneIds = new Set(sessionArchive.failures.map((failure) => failure.laneId));
  for (const lane of stoppedOrphans.filter((candidate) => !unarchivedSessionLaneIds.has(candidate.id))) {
    try {
      if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());
      const archivedLane = archiveLane(lane.id, 'user');
      if (!archivedLane) throw new Error('lane disappeared during orphan archive');
      archived += 1;
    } catch (error) {
      console.warn(`[stop-packet] stopAll: failed to archive orphan lane ${lane.id}:`, error);
      failedLanes += 1;
    }
  }
  failedLanes += unarchivedSessionLaneIds.size;
  failedLanes += orphans.length - confirmedOrphanIds.size;

  const ok = failedPackets === 0 && failedLanes === 0;

  return {
    ok,
    stoppedPackets,
    failedPackets,
    interruptedSessions: interrupted,
    archivedLanes: archived,
    failedLanes,
    note: ok
      ? `Stopped everything${opts.repoPath ? ' in this repo' : ''}: reaped ${interrupted} live session${interrupted === 1 ? '' : 's'}, archived ${archived} lane${archived === 1 ? '' : 's'} across ${stoppedPackets} packet${stoppedPackets === 1 ? '' : 's'}. Nothing relaunched.`
      : `Stop-all was incomplete: ${failedPackets} packet${failedPackets === 1 ? '' : 's'} and ${failedLanes} worker session class lane${failedLanes === 1 ? '' : 's'} could not be confirmed stopped. Their live bindings were preserved.`,
  };
}
