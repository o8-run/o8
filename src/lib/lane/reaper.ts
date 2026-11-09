import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';

import { getDb, lanes } from '@/lib/db';
import { getResourceLeaseStore } from '@/lib/leases/resource-lease-service';
import { invalidateProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import type { Lane } from './types';
import {
  appendEvent,
  getLane,
  getLaneEvents,
  listActiveLanes,
  updateLane,
} from './registry';
import { preserveLaneWorktreeHead, type LaneWorktreePreservation } from './worktree-preservation';
import {
  isOwnedSessionKey,
  isPidAlive,
  probeClaudeCwdAlive,
  probeOwnedSessionLiveness,
} from './owned-session-liveness';
import { decideRunningLaneSalvage } from './salvage';
import { runDeadLaneSweep } from './dead-lane-archiver';
import { assessStaleLaneLiveness } from './reaper-liveness';

export const LANE_ZOMBIE_REAPER_INTERVAL_MS = 5 * 60_000;
export const LANE_HEARTBEAT_STALE_MS = 90_000;
const execFileAsync = promisify(execFile);

let zombieReaperTimer: ReturnType<typeof setInterval> | null = null;
let zombieReaperInFlight = false;

export interface LaneOwnerProbe {
  alive: boolean | undefined;
  source: string;
  pid?: number;
  sessionName?: string;
  note?: string;
}

export interface ZombieLaneCandidate {
  lane: Lane;
  staleMs: number;
  lastHeartbeatAt: number | null;
  probe: LaneOwnerProbe;
  reason: 'missing_heartbeat' | 'stale_heartbeat' | 'stale_merging' | 'abandoned_merging';
}

function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-reaper] SQLite database is unavailable');
  }
  return db;
}

function parseLivePidSessionKey(sessionKey: string): number | null {
  const match = sessionKey.match(/^(?:codex-live:|claude-code:live-)(\d+)$/);
  if (!match?.[1]) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function findOwnerPidViaWorktreeManager(lane: Lane): Promise<number | null | undefined> {
  if (!lane.worktreePath) return undefined;
  try {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const manager = new WorktreeManager(lane.repoPath);
    const maybeFindOwnerPid = (manager as unknown as {
      findOwnerPid?: (worktreePath: string) => Promise<number | null> | number | null;
    }).findOwnerPid;
    if (!maybeFindOwnerPid) return undefined;
    const pid = await maybeFindOwnerPid.call(manager, lane.worktreePath);
    return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return undefined;
  }
}

async function probeLaneOwner(lane: Lane): Promise<LaneOwnerProbe> {
  const ownerPid = await findOwnerPidViaWorktreeManager(lane);
  if (ownerPid !== undefined) {
    return {
      alive: ownerPid === null ? false : isPidAlive(ownerPid),
      source: 'worktreeManager.findOwnerPid',
      pid: ownerPid ?? undefined,
    };
  }

  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey) {
    return { alive: false, source: 'lane-session', note: 'running lane has no session key' };
  }

  const livePid = parseLivePidSessionKey(sessionKey);
  if (livePid) {
    return { alive: isPidAlive(livePid), source: 'session-key-pid', pid: livePid };
  }

  // Owned worker sessions (codex/claude-code/gemini/opencode) → shared probe.
  if (isOwnedSessionKey(sessionKey)) {
    return probeOwnedSessionLiveness(sessionKey, lane.worktreePath);
  }

  const terminalSession = getRuntimeTerminalSession(sessionKey);
  if (terminalSession?.sessionName) {
    return {
      alive: await isBridgeSessionAlive(terminalSession.sessionName),
      source: 'terminal-session-registry',
      sessionName: terminalSession.sessionName,
    };
  }

  if (lane.runtime === 'claude-code') {
    return probeClaudeCwdAlive(lane);
  }

  return { alive: undefined, source: 'process-registry', note: 'no owner pid mapping found' };
}

function heartbeatStaleMs(lane: Lane, now: number): number {
  if (typeof lane.lastHeartbeatAt === 'number' && Number.isFinite(lane.lastHeartbeatAt)) {
    return now - lane.lastHeartbeatAt;
  }
  const updatedAtMs = Date.parse(lane.updatedAt);
  return Number.isFinite(updatedAtMs) ? now - updatedAtMs : Number.POSITIVE_INFINITY;
}

async function localBranchExists(lane: Lane): Promise<boolean | null> {
  try {
    await execFileAsync(resolveGitBinary(), ['show-ref', '--verify', '--quiet', `refs/heads/${lane.branch}`], {
      windowsHide: true,
      cwd: lane.repoPath,
      timeout: 5_000,
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    return code === 1 || code === '1' ? false : null;
  }
}

async function repoActionLeaseHeld(repoPath: string): Promise<boolean | null> {
  try {
    const snapshot = await getResourceLeaseStore().status(`repo-tree:${repoPath}`);
    return snapshot.holder !== null;
  } catch {
    return null;
  }
}

function actorStatusTransitionGraceMs(lane: Lane, now: number): number | null {
  const events = getLaneEvents(lane.id, 80);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.verb !== 'status_change') continue;
    if (event.actor !== 'orchestrator' && event.actor !== 'user') continue;
    const eventMs = Date.parse(event.timestamp);
    if (!Number.isFinite(eventMs)) continue;
    const ageMs = now - eventMs;
    return ageMs >= 0 ? ageMs : 0;
  }
  return null;
}

export function recordLaneHeartbeat(laneId: string, heartbeatAt: number = Date.now()): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;

  getLaneDb()
    .update(lanes)
    .set({ lastHeartbeatAt: heartbeatAt })
    .where(eq(lanes.id, laneId))
    .run();

  return getLane(laneId);
}

export async function listZombieLaneCandidates(now: number = Date.now()): Promise<ZombieLaneCandidate[]> {
  const candidates: ZombieLaneCandidate[] = [];
  const runningLanes = listActiveLanes().filter((lane) => lane.status === 'running');
  let processSnapshotStarted = false;

  for (const lane of runningLanes) {
    const staleMs = heartbeatStaleMs(lane, now);
    if (staleMs <= LANE_HEARTBEAT_STALE_MS) continue;
    const actorGraceMs = actorStatusTransitionGraceMs(lane, now);
    if (actorGraceMs !== null && actorGraceMs <= LANE_HEARTBEAT_STALE_MS) continue;

    const probe = await probeLaneOwner(lane);
    if (probe.alive !== false) continue;

    // This is one reaper poll. Refresh the shared snapshot once before its
    // first process check, then let every remaining lane reuse that snapshot.
    if (!processSnapshotStarted) {
      invalidateProcessCwdSnapshot();
      processSnapshotStarted = true;
    }

    // #1585: the lane heartbeat is a fragile, worker-volitional signal — it only
    // advances when the worker itself runs `o8 packet heartbeat`, so a Codex
    // worker deep in a long turn freezes it well inside the 90s window while
    // streaming. Before reaping a stale-heartbeat lane the owner-probe called
    // dead, require it to clear the secondary liveness gates: fresh transcript
    // activity (streaming IS a heartbeat) + a live-process guard on the worktree
    // (fail closed). This is what stopped the fleet-wide wipeout.
    const liveness = await assessStaleLaneLiveness(lane, {
      staleThresholdMs: LANE_HEARTBEAT_STALE_MS,
      now,
    });
    if (liveness.keep) {
      console.log(
        `[lane-reaper] ${lane.id} stale ${Math.round(staleMs / 1000)}s but KEPT via ${liveness.source}: ${liveness.note}`,
      );
      continue;
    }

    candidates.push({
      lane,
      staleMs,
      lastHeartbeatAt: lane.lastHeartbeatAt,
      probe,
      reason: lane.lastHeartbeatAt === null ? 'missing_heartbeat' : 'stale_heartbeat',
    });
  }

  // Lanes stuck in `merging`: the merge runs inside the Next server process
  // and doesn't heartbeat, so a hard process death mid-merge leaves the lane
  // in `merging` forever — invisible to both this reaper (running-only) and
  // the silent-exit detector. Real merges, including time queued behind the
  // per-repo merge lock, finish in minutes; long silence means the owning
  // process died.
  const MERGING_STALE_MS = 30 * 60 * 1000;
  const mergingLanes = listActiveLanes().filter((lane) => lane.status === 'merging');
  for (const lane of mergingLanes) {
    const lastTouch = lane.lastEventAt ? Date.parse(lane.lastEventAt) : Number.NaN;
    const staleMs = Number.isFinite(lastTouch) ? now - lastTouch : Number.MAX_SAFE_INTEGER;
    const [branchExists, leaseHeld, ownerProbe] = await Promise.all([
      localBranchExists(lane),
      repoActionLeaseHeld(canonicalRepoRoot(lane.repoPath)),
      probeLaneOwner(lane),
    ]);
    if (branchExists === false && leaseHeld === false && ownerProbe.alive === false) {
      candidates.push({
        lane,
        staleMs,
        lastHeartbeatAt: lane.lastHeartbeatAt,
        probe: {
          alive: false,
          source: 'merging-abandoned',
          note: 'merge branch absent with no repo-action lease or live lane owner',
        },
        reason: 'abandoned_merging',
      });
      continue;
    }
    if (staleMs <= MERGING_STALE_MS) continue;
    candidates.push({
      lane,
      staleMs,
      lastHeartbeatAt: lane.lastHeartbeatAt,
      probe: { alive: false, source: 'merging-stale', note: 'merge owner process presumed dead (no lane events for 30m+)' },
      reason: 'stale_merging',
    });
  }

  return candidates;
}

export async function reapZombieLane(
  candidate: ZombieLaneCandidate,
  options: { source: 'sidecar' | 'manual'; force?: boolean },
): Promise<Lane | null> {
  const before = getLane(candidate.lane.id);
  if (!before || (before.status !== 'running' && before.status !== 'merging')) return before;
  let preservedWork: LaneWorktreePreservation | null = null;

  if (before.status === 'running' && before.worktreePath) {
    try {
      preservedWork = await preserveLaneWorktreeHead(before);
    } catch (error) {
      console.warn('[lane-reaper] worktree preservation failed before zombie reap:', error);
    }
  }

  const payload = {
    source: options.source,
    force: options.force === true,
    staleMs: candidate.staleMs,
    lastHeartbeatAt: candidate.lastHeartbeatAt,
    previousSessionKey: before.sessionKey,
    processProbe: candidate.probe,
    recommendedAction: before.packetId ? 'retry_packet' : 'inspect_lane',
    preservedBranch: preservedWork?.preserved ? preservedWork.branchName : undefined,
    preservedHead: preservedWork?.preserved ? preservedWork.headSha : undefined,
  };

  // Salvage path (#1282 Failure B): a `running` lane whose owner died may have
  // left COMPLETE, correct edits sitting uncommitted in its worktree — the
  // pre-review auto-commit never ran because the session never reported done.
  // Dumping that straight to `recovering` reads as a failure and the work is
  // invisible. Commit it and route to `reviewing` so the operator sees it.
  // Gate STRICTLY to `running`: a `merging` lane is mid-write, and committing
  // its tree can corrupt the in-flight merge.
  if (before.status === 'running' && before.worktreePath) {
    try {
      const baseRef = before.baseBranch?.trim() || 'main';
      const { autoCommitted, reviewable } = await decideRunningLaneSalvage(
        before.worktreePath,
        baseRef,
        before.repoPath,
        { label: before.label, branch: before.branch, preCommitted: preservedWork?.autoCommitted },
      );
      if (reviewable) {
        appendEvent(before.id, 'zombie_reap', 'system', { ...payload, salvaged: true, autoCommitted });
        return updateLane(
          before.id,
          {
            status: 'reviewing',
            sessionKey: null,
            lastEventAt: new Date().toISOString(),
            lastEventLabel: 'zombie_reap_salvaged',
          },
          'system',
        );
      }
    } catch (error) {
      console.warn('[lane-reaper] salvage attempt failed; falling through to recovering:', error);
    }
  }

  appendEvent(before.id, 'zombie_reap', 'system', payload);
  const updated = updateLane(
    before.id,
    {
      status: 'recovering',
      sessionKey: null,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'zombie_reap',
    },
    'system',
  );

  if (before.packetId) {
    try {
      const { enqueueSupervisorInboxItem } = await import('@/lib/supervisor/heal-bot');
      enqueueSupervisorInboxItem({
        repoPath: before.repoPath,
        packetId: before.packetId,
        kind: 'session_lost',
        status: 'human_required',
        payload: {
          laneId: before.id,
          worktreePath: before.worktreePath,
          sessionKey: before.sessionKey,
          baseBranch: before.baseBranch,
          note: before.status === 'merging'
            ? 'Merge wedge detected with no branch, repo-action lease, or live owner. The lane moved to recovering; inspect Git truth before retrying.'
            : 'Zombie reaper moved this stale running lane to recovering. Run retry_packet to resume the existing worktree.',
        },
      });
    } catch (error) {
      console.warn('[lane-reaper] Failed to enqueue session_lost inbox item:', error);
    }
  }

  return updated;
}

export async function reapZombieLanes(options: {
  source: 'sidecar' | 'manual';
  force?: boolean;
  now?: number;
}): Promise<Array<{ candidate: ZombieLaneCandidate; lane: Lane | null }>> {
  const candidates = await listZombieLaneCandidates(options.now ?? Date.now());
  const reaped: Array<{ candidate: ZombieLaneCandidate; lane: Lane | null }> = [];
  for (const candidate of candidates) {
    const lane = await reapZombieLane(candidate, options);
    reaped.push({ candidate, lane });
  }
  return reaped;
}

export async function runLaneZombieReaperTick(): Promise<void> {
  if (zombieReaperInFlight) return;
  zombieReaperInFlight = true;
  try {
    // Git truth wins before wedge recovery: a process may have died after the
    // merge landed but before its terminal lane write. Reconcile that receipt
    // first so the reaper never demotes a successfully merged lane.
    const { reconcileOrphanedWorktrees } = await import('./reconcile');
    await reconcileOrphanedWorktrees();
    const reaped = await reapZombieLanes({ source: 'sidecar' });
    for (const item of reaped) {
      console.log(
        `[lane-reaper] ${item.candidate.lane.id} stale ${Math.round(item.candidate.staleMs / 1000)}s; owner dead via ${item.candidate.probe.source} — recovering`,
      );
    }
    // Wedge escalation THEN archive, in one structural pass (runDeadLaneSweep) —
    // a packet-bound recovering/launching lane escalates to the orchestrator
    // before any archive rule can consider it. Replaces the old hard-coded
    // "enforceWedgeTimeouts() before archiveStaleDeadLanes()" call ordering.
    const { archived } = await runDeadLaneSweep();
    if (archived > 0) {
      console.log(`[lane-reaper] archived ${archived} stale dead lane(s)`);
    }
  } finally {
    zombieReaperInFlight = false;
  }
}

export function startLaneZombieReaper(): void {
  if (zombieReaperTimer) return;

  setTimeout(() => {
    void runLaneZombieReaperTick().catch((error) => {
      console.error('[lane-reaper] initial tick failed:', error);
    });
  }, 60_000);

  zombieReaperTimer = setInterval(() => {
    void runLaneZombieReaperTick().catch((error) => {
      console.error('[lane-reaper] tick failed:', error);
    });
  }, LANE_ZOMBIE_REAPER_INTERVAL_MS);

  if (typeof zombieReaperTimer.unref === 'function') zombieReaperTimer.unref();
  console.log(`[lane-reaper] started (interval ${LANE_ZOMBIE_REAPER_INTERVAL_MS}ms, stale heartbeat ${LANE_HEARTBEAT_STALE_MS}ms)`);
}

export function stopLaneZombieReaper(): void {
  if (!zombieReaperTimer) return;
  clearInterval(zombieReaperTimer);
  zombieReaperTimer = null;
  console.log('[lane-reaper] stopped');
}
