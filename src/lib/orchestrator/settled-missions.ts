/**
 * Missions the headless tick can skip because its last full pass found
 * nothing to do and nothing has changed since.
 *
 * A mission is settled after a full pass that launched nothing and wrote
 * nothing new, when nothing in it is launching, running or recovering, and
 * every queued packet has a dispatch blocker that only a change to the mission
 * or a lane can clear ("runtime is not pinned", "Operator stopped", "Status is
 * blocked", ...). Blockers that clear on their own (machine load, review
 * backlog, a retry backoff, a manual launch claim) never settle a mission, and
 * neither does a pass that moved a packet (a preflight probe, a requeue).
 *
 * A settled mission stays skipped until its record or any lane or lane event
 * is written. A full pass still runs every SETTLED_REFRESH_MS for inputs
 * outside the database, such as a folder that became a Git repository.
 */
import { getSqlite } from '@/lib/db';
import { getBootRecoveryLaunchBlocker, getDispatchBlocker } from '@/lib/orchestrator/scheduling';
import { BACKPRESSURE_PREFIX } from '@/lib/orchestrator/review-backpressure';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export const SETTLED_REFRESH_MS = 10 * 60_000;

/** The current mission lives in its own file; its version is that file's stamp. */
export const CURRENT_MISSION_KEY = 'current-mission';

const LIVE_STATUSES = new Set(['launching', 'running', 'recovering', 'idle']);
const SELF_CLEARING = ['Manual lane opening', 'Storage admission retry backoff', 'Machine busy', BACKPRESSURE_PREFIX];

const settled = new Map<string, string>();
let refreshedAt = Date.now();

/** Lanes and lane events, as one string that changes whenever either is written. */
export function laneEpoch(): string {
  const row = getSqlite().prepare(`
    SELECT COUNT(*) AS lanes, MAX(updated_at) AS updated,
           (SELECT MAX(rowid) FROM lane_events) AS events
      FROM lanes
  `).get() as { lanes: number; updated: string | null; events: number | null };
  return `${row.lanes}:${row.updated ?? ''}:${row.events ?? 0}`;
}

/** A registry mission's row version, which every write advances. */
export function missionVersion(missionId: string): number | null {
  const row = getSqlite().prepare('SELECT updated_at FROM missions WHERE id = ?').get(missionId) as { updated_at: number } | undefined;
  return row?.updated_at ?? null;
}

function stableBlocker(packet: OrchestratorPacket, packets: OrchestratorPacket[]): boolean {
  let blocker: string | null;
  try {
    blocker = getBootRecoveryLaunchBlocker({
      missionArchived: false,
      missionLive: true,
      packet,
      pinnedRuntime: packet.dispatchRuntimePin ?? null,
    }) ?? getDispatchBlocker(packet, packets, { force: true });
  } catch {
    return false;
  }
  return blocker !== null && !SELF_CLEARING.some((prefix) => blocker.startsWith(prefix));
}

/** Whether every packet in a mission waits on something only a record change can clear. */
export function missionIsSettled(state: OrchestratorMissionState): boolean {
  return state.packets.every((packet) => {
    if (packet.archivedAt || packet.releaseState === 'released') return true;
    if (LIVE_STATUSES.has(packet.status)) return false;
    if (packet.queueState !== 'queued' && packet.status !== 'queued') return true;
    // A queued packet waiting only on free disk space has no fixed blocker.
    return stableBlocker(packet, state.packets);
  });
}

/** Drop every mark once per refresh period. Call once per tick. */
export function refreshSettledMissions(now = Date.now()): void {
  if (now - refreshedAt < SETTLED_REFRESH_MS) return;
  settled.clear();
  refreshedAt = now;
}

export function isMissionSettled(missionId: string, version: number | string | null, epoch: string): boolean {
  return version !== null && settled.get(missionId) === `${version}|${epoch}`;
}

/**
 * Record a full pass. `version` is the mission's version after the pass and
 * `changed` whether the pass wrote anything new; only a pass that launched
 * nothing and changed nothing can settle a mission.
 */
export function recordMissionPass(missionId: string, pass: {
  state: OrchestratorMissionState;
  launched: number;
  changed: boolean;
  version: number | string | null;
  epoch: string;
}): void {
  if (pass.version !== null && pass.launched === 0 && !pass.changed && missionIsSettled(pass.state)) {
    settled.set(missionId, `${pass.version}|${pass.epoch}`);
  } else {
    settled.delete(missionId);
  }
}

/** Tests only. */
export function resetSettledMissions(): void {
  settled.clear();
  refreshedAt = Date.now();
}
