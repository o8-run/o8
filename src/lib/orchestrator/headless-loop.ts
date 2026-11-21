import { archiveCompletedLanes, listLanes } from '@/lib/lane/registry';
import { pruneRepoWorktrees } from '@/lib/lane/worktree-cleanup';
import {
  controlPlaneStamp,
  readOrchestratorControlPlaneState,
  reconcileOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import { buildDagMetadata, hasLaneBinding } from '@/lib/orchestrator/dag';
import { buildRemainingLaunchBudget, runDispatchTick } from '@/lib/orchestrator/dispatch';
import { applyHeadlessTickDeadline } from '@/lib/orchestrator/headless-tick-deadline';
import { listActiveMissionRegistryEntries, missionHasPendingHeadlessWork, persistMissionRegistryState, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionStateForPersistence } from '@/lib/orchestrator/persisted-mission';
import { CURRENT_MISSION_KEY, isMissionSettled, laneEpoch, missionVersion, recordMissionPass, refreshSettledMissions } from '@/lib/orchestrator/settled-missions';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const IDLE_HEARTBEAT_TICKS = 6;
interface HeadlessSprintTickResult {
  /** False when the tick found nothing that could launch or move; the idle gate may pause the loop. */
  pending: boolean;
  launched: number;
  active: number;
  currentWave: number;
  totalWaves: number;
  mission: OrchestratorMissionState;
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let tickPromise: Promise<HeadlessSprintTickResult> | null = null;
let rerunRequested = false;
let lastPruneAt = 0;
let prunePromise: Promise<void> | null = null;
let lastCompletedMissionId = '';
let silentIdleTickCount = 0;

function countLaunchedPackets(
  beforeDispatch: OrchestratorMissionState,
  afterDispatch: OrchestratorMissionState,
) {
  const beforeById = new Map(beforeDispatch.packets.map((packet) => [packet.id, packet] as const));

  return afterDispatch.packets.reduce((count, packet) => {
    const previous = beforeById.get(packet.id);
    if (!previous) {
      return count;
    }

    const wasBound = hasLaneBinding(previous);
    const isBound = hasLaneBinding(packet);
    const wasQueued = previous.status === 'queued' && previous.queueState === 'queued';
    const isLaunching = packet.status === 'launching';

    return wasQueued && !wasBound && isBound && isLaunching ? count + 1 : count;
  }, 0);
}

function countActivePackets(state: OrchestratorMissionState) {
  return state.packets.filter((packet) => packet.status === 'launching' || packet.status === 'running').length;
}

function hasWorktreeMaintenanceDemand(state: OrchestratorMissionState) {
  return state.packets.some((packet) => !packet.archivedAt && packet.releaseState !== 'released' && (
    packet.status === 'launching'
    || packet.status === 'running'
    || (!packet.operatorStopped && packet.queueState === 'queued' && packet.storageAdmission?.state === 'held')
  ));
}

function hasPendingHeadlessWork(state: OrchestratorMissionState) {
  return state.packets.some((packet) => {
    if (packet.archivedAt || packet.releaseState === 'released') {
      return false;
    }

    return packet.queueState === 'queued'
      || packet.status === 'queued'
      || packet.status === 'launching'
      || packet.status === 'running'
      || packet.status === 'recovering';
  });
}

function buildIdleTickResult(mission: OrchestratorMissionState): HeadlessSprintTickResult {
  const dag = buildDagMetadata(mission.packets);
  return {
    pending: false,
    launched: 0,
    active: countActivePackets(mission),
    currentWave: dag.currentWave,
    totalWaves: dag.totalWaves,
    mission,
  };
}

function maybeShortCircuitIdleTick(): HeadlessSprintTickResult | null {
  // A mission whose queued packets all wait on a fixed blocker is not work.
  refreshSettledMissions();
  const epoch = laneEpoch();
  const mission = readOrchestratorControlPlaneState();
  if (hasPendingHeadlessWork(mission) && !isMissionSettled(CURRENT_MISSION_KEY, controlPlaneStamp(), epoch)) {
    silentIdleTickCount = 0;
    return null;
  }
  const registryWork = listActiveMissionRegistryEntries(mission.missionId).some((entry) => (
    missionHasPendingHeadlessWork(entry.mission) && !isMissionSettled(entry.id, entry.updatedAt, epoch)
  ));
  if (registryWork) {
    silentIdleTickCount = 0;
    return null;
  }

  silentIdleTickCount += 1;
  if (silentIdleTickCount >= IDLE_HEARTBEAT_TICKS) {
    console.log(`[headless] idle (${silentIdleTickCount} silent ticks)`);
    silentIdleTickCount = 0;
  }

  return buildIdleTickResult(mission);
}

function collectPrunableRepoPaths(state: OrchestratorMissionState) {
  return [...new Set([
    state.repoPath?.trim() || '',
    ...listLanes().map((lane) => lane.repoPath.trim()),
  ].filter(Boolean))];
}

function isMissionComplete(state: OrchestratorMissionState) {
  return state.packets.length > 0
    && state.packets.every((packet) => packet.archivedAt || packet.releaseState === 'released');
}

async function pruneWorktreesIfDue(state: OrchestratorMissionState) {
  if (prunePromise || Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }

  const repoPaths = collectPrunableRepoPaths(state);
  if (repoPaths.length === 0) {
    lastPruneAt = Date.now();
    return;
  }

  prunePromise = (async () => {
    for (const repoPath of repoPaths) {
      try {
        const pruned = await pruneRepoWorktrees(repoPath);
        if (pruned.length > 0) {
          console.log(`[headless] Pruned ${pruned.length} stale worktree${pruned.length === 1 ? '' : 's'} for ${repoPath}`);
        }
      } catch (error) {
        console.error(`[headless] Worktree prune failed for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })().finally(() => {
    lastPruneAt = Date.now();
    prunePromise = null;
  });

  await prunePromise;
}


async function runRegistryMissionTicks(
  currentMissionId: string | null | undefined,
) {
  let launched = 0;
  let maintenanceNeeded = false;
  refreshSettledMissions();
  const epoch = laneEpoch();
  for (const entry of listActiveMissionRegistryEntries(currentMissionId)) {
    // Skip a mission whose last pass found nothing to do until it or a lane changes.
    if (isMissionSettled(entry.id, entry.updatedAt, epoch)) continue;
    const { result: activity, state } = await withMissionRegistryState(entry.id, async (fresh) => {
      const reconciled = reconcileOrchestratorControlPlaneState(fresh);
      const fanned = fanOutComparisonPackets(reconciled);
      // Most registry missions are idle. Check for work first: the budget reads
      // settings and every active lane, which an idle mission never needs.
      const idle = { state: fanned, result: { launched: 0, maintenanceNeeded: hasWorktreeMaintenanceDemand(fanned) } };
      if (!missionHasPendingHeadlessWork(fanned)) return idle;
      const budget = buildRemainingLaunchBudget();
      if (budget.maxLaunches <= 0) return idle;
      const dispatched = await runDispatchTick(fanned, {
        launchBudget: budget,
        enforceBootRecoveryGuard: true,
        missionArchived: entry.archivedAt !== null,
      });
      return {
        state: dispatched,
        result: { launched: countLaunchedPackets(fanned, dispatched), maintenanceNeeded: hasWorktreeMaintenanceDemand(dispatched) },
      };
    });
    const version = missionVersion(entry.id);
    recordMissionPass(entry.id, { state, launched: activity.launched, changed: version !== entry.updatedAt, version, epoch });
    launched += activity.launched;
    maintenanceNeeded ||= activity.maintenanceNeeded;
  }
  return { launched, maintenanceNeeded };
}

async function executeHeadlessSprintTick(): Promise<HeadlessSprintTickResult> {
  const epoch = laneEpoch();
  // #460 — Acquire the control-plane lock so concurrent API operations
  // (reset_packet, etc.) don't race our read-modify-write cycle.
  const { result: { changed, ...result } } = await withLockedState(async (current) => {
    const before = JSON.stringify(normalizeOrchestratorMissionStateForPersistence(current));
    const reconciled = reconcileOrchestratorControlPlaneState(current);
    // #1293 — best-of-N fan-out: a seed packet (comparisonModels set, no
    // comparisonGroupId) is consumed by fanOutComparisonPackets — replaced by
    // its N sibling candidates. Persist that consumption BEFORE dispatch so a
    // mid-dispatch throw can't leave the seed on disk to re-fan next tick.
    const fanned = fanOutComparisonPackets(reconciled);
    if (fanned !== reconciled) {
      writeOrchestratorControlPlaneState(fanned);
    }
    const dispatched = await runDispatchTick(fanned, {
      launchBudget: buildRemainingLaunchBudget(),
      enforceBootRecoveryGuard: true,
      missionArchived: false,
    });
    // #1293 ROOT FIX — make withLockedState persist the post-dispatch state.
    // withLockedState does a FINAL reconcile+write at end-of-lock, and its basis
    // falls back to the (unmutated) pre-callback `current` when the callback
    // returns a non-mission-state result (this one returns tick metadata). For a
    // NORMAL packet that's harmless — reconcile(current) re-attaches the lane
    // from the DB by matching packet id. But a best-of-N SEED has no lane and its
    // candidate lanes are keyed by candidate ids, so reconcile(seed) keeps the
    // bare seed — clobbering the fanned/dispatched writes and re-fanning the seed
    // every single tick (observed: one seed fanned 16×). Mutating `current` with
    // the dispatched state makes the final reconcile+write use it, so the seed is
    // consumed for good.
    Object.assign(current, dispatched);
    const mission = writeOrchestratorControlPlaneState(dispatched);
    await persistMissionRegistryState(mission);
    const dag = buildDagMetadata(mission.packets);
    const launched = countLaunchedPackets(reconciled, mission);
    const active = countActivePackets(mission);

    console.log(`[headless] Tick: ${launched} launched, ${active} active, wave ${dag.currentWave}/${dag.totalWaves}`);

    return {
      pending: true,
      launched,
      active,
      currentWave: dag.currentWave,
      totalWaves: dag.totalWaves,
      mission,
      changed: JSON.stringify(mission) !== before,
    };
  });
  // Stamp after this pass's own write, so only a later write unsettles it.
  recordMissionPass(CURRENT_MISSION_KEY, {
    state: result.mission, launched: result.launched, changed, version: controlPlaneStamp(), epoch,
  });
  const registryActivity = await runRegistryMissionTicks(result.mission.missionId);
  const tickResult = {
    ...result,
    launched: result.launched + registryActivity.launched,
  };

  const archivedCompleted = archiveCompletedLanes();
  let maintenanceNeeded = tickResult.launched > 0
    || hasWorktreeMaintenanceDemand(tickResult.mission)
    || registryActivity.maintenanceNeeded
    || archivedCompleted > 0;
  if (archivedCompleted > 0) {
    console.log(`[headless] Archived ${archivedCompleted} completed lane${archivedCompleted === 1 ? '' : 's'}`);
  }
  const missionId = tickResult.mission.missionId || 'current';
  if (isMissionComplete(tickResult.mission)) {
    if (lastCompletedMissionId !== missionId) {
      lastCompletedMissionId = missionId;
      lastPruneAt = 0;
      maintenanceNeeded = true;
      console.log(`[headless] Mission ${missionId} reached terminal state`);
    }
  } else if (lastCompletedMissionId === missionId) {
    lastCompletedMissionId = '';
  }
  // Dormant queued records still get reconciliation and recovery checks, but
  // must not cause repeated filesystem sweeps. Keep maintenance for active
  // work, terminal transitions and storage holds that cleanup can unblock.
  if (maintenanceNeeded) await pruneWorktreesIfDue(tickResult.mission);

  return tickResult;
}

export async function runHeadlessSprintTick() {
  if (tickPromise) {
    rerunRequested = true;
    return tickPromise;
  }

  const idleResult = maybeShortCircuitIdleTick();
  if (idleResult) {
    return idleResult;
  }

  // A cold dispatch creates its lane before provisioning the worktree and
  // running the required base typecheck. Remember the lanes that were already
  // launching so only work started by this tick can extend its deadline.
  const launchingLaneIdsAtStart = new Set(
    listLanes()
      .filter((lane) => lane.status === 'launching')
      .map((lane) => lane.id),
  );

  const innerPromise: Promise<HeadlessSprintTickResult> = (async () => {
    let result: HeadlessSprintTickResult;

    do {
      rerunRequested = false;
      silentIdleTickCount = 0;
      result = await executeHeadlessSprintTick();
    } while (rerunRequested);

    return result;
  })();

  // #1111 — Keep the short wedge deadline for ordinary ticks, but a cold
  // launch has a real three-minute typecheck bound. Give only a lane that this
  // tick moved into `launching` one bounded extension, preventing the old 30s
  // timeout from clearing the singleton and dispatching the packet twice.
  tickPromise = applyHeadlessTickDeadline(innerPromise, {
    canExtendForLaunch: () => listLanes().some(
      (lane) => lane.status === 'launching' && !launchingLaneIdsAtStart.has(lane.id),
    ),
    onExtended: (deadlineMs) => {
      console.log(`[headless] Cold launch still provisioning; extended tick deadline to ${deadlineMs}ms`);
    },
  })
    .catch((error) => {
      console.error(`[headless] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    })
    .finally(() => {
      // Always clear the singleton — whether the inner work finished or the
      // deadline fired — so the next caller can try again.
      tickPromise = null;
    });

  return tickPromise;
}

export function startHeadlessSprintLoop(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const nextInterval = Number.isFinite(intervalMs)
    ? Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs))
    : DEFAULT_INTERVAL_MS;

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  const timer = setInterval(() => {
    void runHeadlessSprintTick().catch(() => {
      // Logging is handled in runHeadlessSprintTick.
    });
  }, nextInterval);

  loopTimer = timer;
  console.log(`[headless] Started sprint loop (${nextInterval}ms interval)`);

  void runHeadlessSprintTick().catch(() => {
    // Logging is handled in runHeadlessSprintTick.
  });

  return () => {
    clearInterval(timer);
    if (loopTimer === timer) {
      loopTimer = null;
    }
    console.log('[headless] Stopped sprint loop');
  };
}
