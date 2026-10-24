import { AsyncLocalStorage } from 'node:async_hooks';
import { getSqlite } from '@/lib/db';
import { appendEvent, getLane, listLanes, setLaneStatus } from './registry';
import type { Lane } from './types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import { releasePacketStorageAfterWorktreeProvisionFailure } from './lane-storage-release';

export type PreRunState = 'queued' | 'launching' | 'provisioning';
const admission = new AsyncLocalStorage<() => void>();

export function preRunState(lane: Lane): PreRunState {
  // Watchdog and other status labels cannot erase this attempt's effect-start
  // fence. Absence is final only while the creator is still outside provisioning.
  const progress = getSqlite().prepare(`SELECT verb FROM lane_events WHERE lane_id = ?
    AND verb IN ('worktree_provision_started', 'worktree_provision_queued')
    AND rowid > (SELECT COALESCE(MAX(rowid), 0) FROM lane_events WHERE lane_id = ?
      AND verb = 'status_change' AND json_extract(payload_json, '$.status') = 'launching')
    ORDER BY rowid DESC LIMIT 1`).pluck().get(lane.id, lane.id);
  if (progress === 'worktree_provision_started') return 'provisioning';
  if (progress === 'worktree_provision_queued') return 'queued';
  if (lane.lastEventLabel === 'worktree_provision_started') return 'provisioning';
  return 'launching';
}

/** Cancel before taking the mission lock: provisioning may itself own that lock. */
export function cancelPreRunPacketLaunches(packetIds: readonly string[], kind: 'stop' | 'reset') {
  return getSqlite().transaction(() => {
    const stoppedFrom = new Map<string, PreRunState>();
    const laneIds: string[] = [];
    const eventIds: Record<string, string> = {};
    const packetEvents = new Map<string, Record<string, string>>();
    for (const lane of listLanes()) {
      if (!lane.packetId || !packetIds.includes(lane.packetId) || lane.sessionKey
        || !(lane.status === 'launching'
          || (lane.status === 'awaiting_orchestrator' && lane.lastEventLabel === 'launch_stalled'))) continue;
      const from = preRunState(lane);
      setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
      // Paused admission fences a queued creator before materialization. A
      // started creator may still have an in-flight effect, so its exact rollback
      // must settle before checkout absence can authorize releasing the charge.
      const storageRelease = from === 'provisioning' ? undefined
        : releasePacketStorageAfterWorktreeProvisionFailure(lane, lane.packetId);
      eventIds[lane.id] = appendEvent(lane.id, 'pre_run_cancelled', 'user', {
        packetId: lane.packetId, kind, stoppedFrom: from, ...(storageRelease ? { storageRelease } : {}),
      }).id;
      packetEvents.set(lane.packetId, { ...packetEvents.get(lane.packetId), [lane.id]: eventIds[lane.id] });
      stoppedFrom.set(lane.packetId, from);
      laneIds.push(lane.id);
    }
    return { stoppedFrom, laneIds, eventIds, packetEvents };
  })();
}

function lastCancellation(laneId: string): string | undefined {
  return getSqlite().prepare("SELECT id FROM lane_events WHERE lane_id = ? AND verb = 'pre_run_cancelled' ORDER BY rowid DESC LIMIT 1")
    .pluck().get(laneId) as string | undefined;
}

/** Contention from the launch being cancelled is not a newer reset intent. */
export function preRunCancellationMatches(packetId: string, eventIds: Record<string, string>): boolean {
  return Object.keys(eventIds).length > 0 && Object.entries(eventIds).every(([laneId, eventId]) => {
    const lane = getLane(laneId);
    return lane?.packetId === packetId && lane.sessionKey === null && lane.status === 'paused'
      && lastCancellation(laneId) === eventId;
  });
}

export function assertPreRunAdmission(): void {
  admission.getStore()?.();
}

/** Pool-owned work and exact retirement have lifetimes independent of a packet. */
export function withoutPreRunAdmission<T>(cleanup: () => Promise<T>): Promise<T> {
  return admission.run(() => {}, cleanup);
}

/** No await on admission: bind immediately, or retire only the returned workspace. */
export function retireCancelledPreRunWorktree(repoPath: string, worktree?: WorktreeInfo): Promise<never> | undefined {
  try { assertPreRunAdmission(); }
  catch (error) {
    return (async () => {
      if (worktree) {
        const { getWorktreeManager } = await import('@/lib/worktree/launch');
        const removed = await withoutPreRunAdmission(() => getWorktreeManager(repoPath).cleanup(worktree.id, {
          force: true, deleteBranch: true, expectedCreation: worktree,
        }));
        if (!removed) throw new Error('Cancelled provisioning could not retire its prepared workspace.');
      }
      throw error;
    })();
  }
}

/** The durable event also fences late completions after a reset or a new launch. */
export async function withPreRunLaunchCancellation<T>(laneId: string, launch: () => Promise<T>): Promise<T> {
  const lane = getLane(laneId);
  if (!lane?.packetId || lane.sessionKey) return launch();
  const previous = lastCancellation(laneId);
  const parent = admission.getStore();
  const check = () => {
    parent?.();
    const current = getLane(laneId);
    if (!current || current.packetId !== lane.packetId || current.status === 'paused'
      || current.status === 'archived' || lastCancellation(laneId) !== previous) {
      throw new Error('Packet launch was cancelled before its worker started.');
    }
  };
  check();
  return admission.run(check, async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        timer = setInterval(() => { try { check(); } catch (error) { reject(error); } }, 25);
      });
      // Keep the losing promise observed. Its existing beforeReady validation
      // rolls back its exact workspace if a provisioner finishes after Stop.
      return await Promise.race([launch(), cancelled]);
    } finally {
      clearInterval(timer);
    }
  });
}
