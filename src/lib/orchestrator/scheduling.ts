import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { observeWsHealthHandler } from '@/lib/ws-server/handler-activity';
import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { computeReadBudget, resolveModelTier } from '@/lib/dispatch/read-budget';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { getLane, findLaneByPacket, listActiveLanes } from '@/lib/lane/registry';
import { salvagedWorkBlockReason } from '@/lib/supervisor/heal-guard';
import { isGitWorkTreeSync } from '@/lib/lane/repo-preflight';
import { resolveOverlapGateSync, resolveParallelCapSync } from '@/lib/operator/defaults';
import { clearStaleLaneBinding, getDispatchableWave } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import { releaseAbandonedMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  MCP_DISPATCH_TILE_SENTINEL,
  type OrchestratorLaneBinding,
  type OrchestratorMissionState,
  type OrchestratorPacket,
  type OrchestratorRuntime,
  type WorkerRouting,
} from '@/lib/orchestrator/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { bindWorkerLaunchParent } from '@/lib/orchestrator/worker-launch-context';
import { launchPacketWithStorageAdmission } from '@/lib/orchestrator/dispatch-packet-launch';
import { manualLaunchClaimAppeared, manualLaunchClaimIsLive } from '@/lib/orchestrator/manual-launch-claim';
import {
  PacketStorageAdmissionError,
  type PacketStorageAdmissionCoordinator,
  type PacketStorageAdmissionReceipt,
} from '@/lib/orchestrator/storage-admission';
import { getStoragePressureAdmissionCoordinator } from '@/lib/orchestrator/storage-pressure-policy';
import { isDispatchHalted } from './dispatch-halt';
import {
  dispatchPreflightRefusalBlocker,
  recordDispatchPreflightRefusal,
  surfaceDispatchPreflightRefusalIncident,
} from './dispatch-preflight-refusal';
import { forgetRecoverySkip, pruneRecoverySkipMemo, shouldLogRecoverySkip } from './recovery-skip-log';
import { computePredictedFiles, filterOverlappingPackets } from './preservation-envelope';
import { applyPacketScopePolicy, packetScopeDispatchBlocker } from './packet-scope-policy';
// Back-compat export — resolves env var, then the persisted operator default,
// then the locked fallback (5). Existing imports keep working.
export const MAX_PARALLEL_DISPATCHES = resolveParallelCapSync();
export const MAX_RECOVERY_DISPATCHES = 2;
// Packet-scoped launch/attach cap. The per-lane LAUNCH_ATTEMPT_CAP (lane/commands.ts)
// resets when a fresh lane is minted on redispatch, so it never accumulated — the
// launching<->idle thrash. This counter lives on the packet so it survives.
export const MAX_LAUNCH_ATTEMPTS = 5;
export const RUNTIME_PARALLEL_CAP: Partial<Record<OrchestratorRuntime, number>> = {
  gemini: 3,
};
export interface DispatchLaunchBudget {
  maxLaunches: number;
  perRuntime?: Partial<Record<OrchestratorRuntime, number>>;
}

export function buildRemainingLaunchBudget(): DispatchLaunchBudget {
  const parallelCap = resolveParallelCapSync();
  const activeLanes = listActiveLanes().filter((lane) => lane.status === 'launching' || lane.status === 'running');
  const perRuntime: Partial<Record<OrchestratorRuntime, number>> = {};
  for (const runtime of Object.keys(RUNTIME_PARALLEL_CAP) as OrchestratorRuntime[]) {
    const cap = RUNTIME_PARALLEL_CAP[runtime];
    if (cap === undefined) continue;
    const active = activeLanes.filter((lane) => lane.runtime === runtime).length;
    perRuntime[runtime] = Math.max(0, cap - active);
  }
  return {
    maxLaunches: Math.max(0, parallelCap - activeLanes.length),
    perRuntime,
  };
}

const RECOVERY_COOLDOWN_MS = 60_000;
const STORAGE_ADMISSION_RETRY_BASE_MS = 10_000;
const STORAGE_ADMISSION_RETRY_MAX_MS = 5 * 60_000;
const SESSION_RECOVERY_COMMIT_MESSAGE = 'auto-commit: session recovery';
const execFileAsync = promisify(execFile);

// #1551 — one canonical work-tree probe, shared with both orchestrator spawn
// preflights (repo-preflight.ts) so the dispatch gate and the spawn gate can
// never drift.
const isGitRepoSync = isGitWorkTreeSync;

function createLaneBinding(
  packet: OrchestratorPacket,
  laneId: string,
  sessionKey?: string | null,
  workerRouting?: WorkerRouting,
  dependencyMaterializationMode?: 'native' | 'image' | null,
): OrchestratorLaneBinding {
  // Read the SQLite lane row so the binding reflects what `updateLane` already
  // persisted (most importantly `worktreePath`, written in commands.ts during
  // `bind_worktree` / `launch_session`). Without this, MCP-dispatched packets
  // saw `worktreePath: null` on the binding even though a real worktree
  // existed, and the no_changes_produced check inspected the wrong tree.
  // tileId/tabId do not live on the lane row, but writing empty strings here
  // made every downstream truthy check (`hasInteractiveLane`, `hasLaneBinding`)
  // hide the Focus button for MCP-dispatched packets (#1113). The sentinel
  // keeps those checks truthy and is filtered out by the workspace tile-handle
  // lookup, so this never collides with a real workspace binding.
  const laneRow = getLane(laneId);
  return {
    tileId: MCP_DISPATCH_TILE_SENTINEL,
    tabId: MCP_DISPATCH_TILE_SENTINEL,
    repoPath: packet.workspaceTargetPath,
    worktreePath: laneRow?.worktreePath ?? null,
    runtime: workerRouting?.selectedRuntime ?? packet.runtime,
    model: laneRow?.model ?? workerRouting?.selectedModel ?? packet.model ?? packet.assignedModel ?? null,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
    dependencyMaterializationMode: dependencyMaterializationMode ?? null,
  };
}

function packetLaunchContext(packet: OrchestratorPacket) {
  return bindWorkerLaunchParent(packet.launchContext, {
    threadId: packet.orchestratorThreadId,
  });
}

interface AwaitingReviewDispatchResult {
  kind: 'awaiting_review';
  laneId: string | null;
  sessionKey: string | null;
  lane?: OrchestratorLaneBinding | null;
}

interface LaunchedDispatchResult {
  kind: 'launched';
  laneId: string;
  sessionKey: string | null;
  workerRouting: WorkerRouting;
  storageAdmission: PacketStorageAdmissionReceipt;
  spendCap?: import('@/lib/orchestrator/metered-spend').PacketSpendCap;
  dependencyMaterializationMode: 'native' | 'image' | null;
}

type DispatchResult = AwaitingReviewDispatchResult | LaunchedDispatchResult;

interface RecoveryDispatchContext {
  lane: OrchestratorLaneBinding | null;
  worktreePath: string | null;
  laneId: string | null;
  repoPath: string | null;
  baseBranch: string;
  runtime: OrchestratorRuntime | null;
}
function isDispatchReadyStatus(packet: OrchestratorPacket) {
  return packet.status === 'queued' || packet.status === 'recovering';
}

export function storageAdmissionRetryDelayMs(packet: OrchestratorPacket): number {
  const receipt = packet.storageAdmission;
  if (receipt?.state !== 'held' || packet.lastEventLabel !== 'storage_admission_held') return 0;
  const exponent = Math.min(8, Math.max(0, receipt.ownerGeneration - 1));
  return Math.min(STORAGE_ADMISSION_RETRY_MAX_MS, STORAGE_ADMISSION_RETRY_BASE_MS * (2 ** exponent));
}

export function getBootRecoveryLaunchBlocker(input: {
  missionArchived?: boolean;
  missionLive?: boolean;
  packet: Pick<OrchestratorPacket, 'id' | 'status' | 'queueState' | 'archivedAt' | 'releaseState' | 'dispatchRuntimePin'>;
  pinnedRuntime?: OrchestratorRuntime | null;
}): string | null {
  const packet = input.packet;
  if (input.missionArchived || input.missionLive === false || packet.archivedAt || packet.releaseState === 'released') {
    return 'mission is not live';
  }
  if (packet.status !== 'queued' && packet.status !== 'recovering') {
    return `lane state does not expect a worker (${packet.status})`;
  }
  if (packet.queueState !== 'queued') {
    return `queue state is ${packet.queueState}`;
  }
  if (!input.pinnedRuntime) {
    return 'runtime is not pinned';
  }
  return null;
}

async function hasUncommittedWorktreeChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    windowsHide: true,
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim().length > 0;
}

async function autoCommitRecoveryWorktree(worktreePath: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], {
    windowsHide: true,
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync('git', ['commit', '-m', SESSION_RECOVERY_COMMIT_MESSAGE], {
    windowsHide: true,
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function dispatchOrRecoverPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
  recoveryContext?: RecoveryDispatchContext | null,
  storageAdmission = getStoragePressureAdmissionCoordinator(),
): Promise<DispatchResult> {
  if (packet.status === 'recovering' && recoveryContext?.worktreePath) {
    const worktreePath = recoveryContext.worktreePath;
    const hasUncommittedChanges = await hasUncommittedWorktreeChanges(worktreePath);
    // #1293 — a silent-exited worker often ALREADY COMMITTED its diff (it does the
    // work, commits, passes checks, then exits without `turn.completed`). Salvage
    // committed work too — not just uncommitted — so the lane finalizes to review
    // FROM ITS OWN WORKTREE instead of falling through to dispatchPacket, which
    // opens a fresh, disconnected `isolate` worktree and orphans the real work
    // (the silent_exit_but_work_present loop). Only a genuinely empty worktree
    // (silent_exit_no_work) redispatches.
    let reviewable = hasUncommittedChanges;
    if (!reviewable) {
      try {
        const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
        if (recoveryContext.repoPath) reviewable = await hasReviewableCompletionDiff(worktreePath, recoveryContext.baseBranch, recoveryContext.repoPath);
      } catch { /* probe failed — fall through to redispatch */ }
    }
    if (reviewable) {
      if (hasUncommittedChanges) {
        await autoCommitRecoveryWorktree(worktreePath);
      }

      const laneId = recoveryContext.laneId ?? recoveryContext.lane?.laneId ?? null;
      if (laneId) {
        const reviewResult = await dispatchLaneCommand({
          verb: 'request_review',
          laneId,
          actor: 'orchestrator',
        });
        if (!reviewResult.ok) {
          throw new Error(reviewResult.note || 'Unable to request review after session recovery.');
        }
      }

      return {
        kind: 'awaiting_review',
        laneId: recoveryContext.laneId ?? recoveryContext.lane?.laneId ?? null,
        sessionKey: null,
        lane: recoveryContext.lane
          ? {
              ...recoveryContext.lane,
              sessionKey: null,
            }
          : null,
      };
    }
  }

  const launchPacket: OrchestratorPacket = recoveryContext?.runtime
    ? {
        ...packet,
        runtime: recoveryContext.runtime,
        workerRouting: packet.workerRouting
          ? {
              ...packet.workerRouting,
              requestedRuntime: recoveryContext.runtime,
              selectedRuntime: recoveryContext.runtime,
            }
          : packet.workerRouting,
      }
    : packet;
  const workerRouting = resolveWorkerRouting({
    workerIntent: launchPacket.workerIntent,
    requestedProvider: launchPacket.workerRouting?.requestedProvider,
    requestedRuntime: launchPacket.workerRouting?.requestedRuntime ?? launchPacket.runtime,
    requestedModel: launchPacket.workerRouting?.requestedModel ?? launchPacket.assignedModel, requestedEffort: launchPacket.workerRouting?.requestedEffort,
    source: 'scheduler-dispatch',
  });
  const launchResult = await launchPacketWithStorageAdmission({
    packet: launchPacket,
    allPackets,
    workerRouting,
    storageAdmission,
  });
  return {
    kind: 'launched',
    laneId: launchResult.laneId,
    sessionKey: launchResult.sessionKey,
    workerRouting: launchResult.workerRouting,
    storageAdmission: launchResult.storageAdmission,
    spendCap: launchResult.spendCap,
    dependencyMaterializationMode: launchResult.dependencyMaterializationMode,
  };
}

/**
 * Check if a packet can be dispatched.
 * Returns null if dispatchable, or a string reason if blocked.
 */
export function getDispatchBlocker(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): string | null {
  if (packet.standingLaneId) return 'Standing lane owns sequential dispatch.';
  const candidate = packet.status === 'recovering' ? clearStaleLaneBinding(packet) : packet;
  // #1391 — salvaged work is not a fault to heal. A packet whose latest lane
  // sits in reviewing/merging (silent-exit salvage, open PR, approved review)
  // must never auto-redispatch, whatever churn its status/queueState went
  // through. Legit relaunch paths archive lanes first, so they pass.
  const salvageBlock = salvagedWorkBlockReason(candidate);
  if (salvageBlock) {
    return salvageBlock;
  }

  // Operator Stop is terminal — this is THE line that makes a Stop the loop
  // can't ignore. Every dispatch path funnels through here, so a stopped packet
  // can never be relaunched by the headless loop, a stall escalation, or a ralph
  // requeue. Cleared by reset_packet / explicit relaunch. (2026-06-22)
  if (candidate.operatorStopped) {
    return 'Operator stopped';
  }
  if (manualLaunchClaimIsLive(candidate.manualLaunchClaim)) return 'Manual lane opening';
  const scopeBlocker = packetScopeDispatchBlocker(candidate);
  if (scopeBlocker) {
    return scopeBlocker;
  }
  if (candidate.queueState !== 'queued') {
    return 'Not queued';
  }
  if (candidate.status === 'failed') {
    return 'Failed — max recovery attempts exceeded';
  }
  if (!isDispatchReadyStatus(candidate)) {
    return `Status is ${candidate.status}`;
  }
  const storageRetryDelay = storageAdmissionRetryDelayMs(candidate);
  const storageRecordedAt = candidate.storageAdmission?.recordedAt;
  if (storageRetryDelay > 0 && typeof storageRecordedAt === 'number') {
    const retryInMs = storageRetryDelay - (Date.now() - storageRecordedAt);
    if (retryInMs > 0) return `Storage admission retry backoff (${Math.ceil(retryInMs / 1000)}s)`;
  }
  // #455 — Block dispatch if recovery limit exceeded
  if (candidate.status === 'recovering' && (candidate.recoveryCount ?? 0) >= MAX_RECOVERY_DISPATCHES) {
    return `Recovery limit exceeded (${candidate.recoveryCount}/${MAX_RECOVERY_DISPATCHES})`;
  }
  // Packet-scoped launch cap — stop the launching<->idle relaunch thrash. The
  // per-lane cap resets when a fresh lane is minted on redispatch (proven
  // lane-scoped-counter runaway); this one lives on the packet.
  if ((candidate.launchAttempts ?? 0) >= MAX_LAUNCH_ATTEMPTS) {
    return `Launch attempts exceeded (${candidate.launchAttempts}/${MAX_LAUNCH_ATTEMPTS})`;
  }
  const preflightBlocker = dispatchPreflightRefusalBlocker(candidate);
  if (preflightBlocker) return preflightBlocker;
  const dependency = packetReleaseBlockedBy(candidate, allPackets);
  if (dependency) {
    return `Blocked by ${dependency.id}`;
  }
  if (!candidate.workspaceTargetPath) {
    return 'No workspace target';
  }
  if (!isGitRepoSync(candidate.workspaceTargetPath)) {
    return 'This folder isn\'t a Git repository — initialize Git to dispatch agents into it.';
  }
  if (candidate.lane?.laneId || candidate.lane?.sessionKey || (candidate.lane?.tileId && candidate.lane?.tabId)) {
    // Allow retry if the lane's last event was a launch failure
    const lastEvent = candidate.lane?.lastEventLabel ?? '';
    if (lastEvent === 'launch_error' || lastEvent === 'launch_failed') {
      // Clear the stale binding so dispatchPacket can re-open/re-launch
    } else {
      return 'Already dispatched';
    }
  }
  return null;
}

/**
 * Run one dispatch tick. For each queued packet with no blockers and no lane binding,
 * dispatch via the lane command bus.
 * Returns the updated mission state.
 */
/**
 * Merge a dispatch tick's outcome onto FRESH locked state, per packet —
 * never a whole-state overwrite. The tick runs outside the control-plane
 * lock (it clones worktrees and spawns sessions, seconds of work), so by the
 * time its result exists, concurrent locked writes (reviews, task creates,
 * resets) may have landed. Only packets the tick actually changed (or added)
 * are copied over; everything else keeps the fresh state. Adversarial F3 —
 * the old `writeOrchestratorControlPlaneState(afterDispatch)` from the
 * pre-tick snapshot clobbered every concurrent write on the merge path.
 */
export function mergeDispatchTickOutcome(
  fresh: OrchestratorMissionState,
  tickBase: OrchestratorMissionState,
  afterDispatch: OrchestratorMissionState,
): void {
  const baseById = new Map(tickBase.packets.map((packet) => [packet.id, JSON.stringify(packet)] as const));
  const freshIndexById = new Map(fresh.packets.map((packet, index) => [packet.id, index] as const));
  for (const packet of afterDispatch.packets) {
    const before = baseById.get(packet.id);
    if (before !== undefined && before === JSON.stringify(packet)) continue;
    const index = freshIndexById.get(packet.id);
    if (index === undefined) {
      fresh.packets.push(packet);
    } else if ((fresh.packets[index]?.holdIntent !== 'operator' || tickBase.packets.find((entry) => entry.id === packet.id)?.holdIntent === 'operator')
      && !manualLaunchClaimAppeared(fresh.packets[index], tickBase.packets.find((entry) => entry.id === packet.id))) {
      fresh.packets[index] = packet;
    }
  }
  fresh.updatedAt = afterDispatch.updatedAt ?? fresh.updatedAt;
}

export const runDispatchTick = observeWsHealthHandler('dispatch', async function runDispatchTick(
  state: OrchestratorMissionState,
  options: {
    launchBudget?: DispatchLaunchBudget;
    enforceBootRecoveryGuard?: boolean;
    missionArchived?: boolean;
    storageAdmission?: PacketStorageAdmissionCoordinator;
  } = {},
): Promise<OrchestratorMissionState> {
  let nextState = releaseAbandonedMissionLifecycleHold(normalizeOrchestratorMissionState(state));
  if (nextState.lifecycleHold) return nextState;
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      const blocker = dispatchPreflightRefusalBlocker(packet);
      if (!blocker || packet.queueState !== 'queued') return packet;
      return surfaceDispatchPreflightRefusalIncident(packet, packet.blockedReason ?? blocker)
        ? { ...packet, status: 'blocked', queueState: 'held' }
        : packet;
    }),
  };
  if (isDispatchHalted()) {
    return nextState;
  }
  nextState = fanOutComparisonPackets(nextState);
  const recoveryContextByPacketId = new Map(
    nextState.packets.flatMap((packet) => {
      if (packet.status !== 'recovering') return [];
      // #1293 — recover into the LANE's OWN worktree (where a silent-exited
      // worker's committed work lives), NOT the main repo. The old code read
      // `packet.lane?.repoPath` (the main checkout, always clean), so recovery
      // never found the work and always redispatched a fresh, disconnected
      // worktree. The reconciler also nulls `packet.lane` on the recovering
      // transition, so resolve the lane row by packetId for the authoritative
      // worktreePath + baseBranch + laneId.
      const row = findLaneByPacket(packet.id);
      const worktreePath = packet.lane?.worktreePath ?? row?.worktreePath ?? null;
      return [[packet.id, {
        lane: packet.lane ?? null,
        worktreePath,
        laneId: packet.lane?.laneId ?? row?.id ?? null,
        repoPath: row?.repoPath ?? null,
        baseBranch: row?.baseBranch ?? 'main',
        runtime: row?.runtime ?? packet.lane?.runtime ?? null,
      } satisfies RecoveryDispatchContext] as const];
    }),
  );
  // Compute predicted files for all packets (used by overlap gate + dashboard)
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      const files = packet.predictedFiles ?? computePredictedFiles(packet);
      return applyPacketScopePolicy(packet, files);
    }),
  };

  // #535 — Populate `readBudget` for any queued packet that doesn't already
  // have one set. Dispatch-site injection only — in-flight packets (running,
  // launching, awaiting_review, etc.) are left untouched so we never mutate
  // a prompt under an agent's feet. The computed budget is opt-out: when
  // `computeReadBudget` returns null (no targets, strong tier w/ no graph),
  // the packet field stays undefined and legacy behaviour is preserved.
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      if (packet.readBudget) return packet;
      if (packet.status !== 'queued' && packet.status !== 'recovering' && packet.status !== 'draft') {
        return packet;
      }
      const repoPath = packet.workspaceTargetPath;
      const targetFiles = packet.predictedFiles ?? [];
      if (!repoPath || targetFiles.length === 0) return packet;
      const routing = resolveWorkerRouting({
        workerIntent: packet.workerIntent,
        requestedProvider: packet.workerRouting?.requestedProvider,
        requestedRuntime: packet.workerRouting?.requestedRuntime ?? packet.runtime,
        requestedModel: packet.workerRouting?.requestedModel ?? packet.assignedModel, requestedEffort: packet.workerRouting?.requestedEffort,
        source: 'scheduler-enrichment',
      });
      const tier = resolveModelTier({ runtime: routing.selectedRuntime, assignedModel: routing.selectedModel });
      const budget = computeReadBudget({ repoPath, targetFiles, tier });
      return budget ? { ...packet, runtime: routing.selectedRuntime, workerIntent: routing.workerIntent, workerRouting: routing, readBudget: budget } : { ...packet, runtime: routing.selectedRuntime, workerIntent: routing.workerIntent, workerRouting: routing };
    }),
  };

  // #536 — Populate `edgeCaseSites` on the same enrichment gate so any
  // packet queued without a surfacer pass picks one up at dispatch time.
  // `surfaceEdgeCases` never throws; on garbage input it returns empty,
  // which collapses to an undefined field (legacy-identical).
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      if (packet.edgeCaseSites && packet.edgeCaseSites.length > 0) return packet;
      if (packet.status !== 'queued' && packet.status !== 'recovering' && packet.status !== 'draft') {
        return packet;
      }
      const repoPath = packet.workspaceTargetPath;
      const targetFiles = packet.predictedFiles ?? [];
      if (!repoPath || targetFiles.length === 0) return packet;
      const { sites } = surfaceEdgeCases({ repoPath, targetFiles, depth: 1 });
      return sites.length > 0 ? { ...packet, edgeCaseSites: sites } : packet;
    }),
  };

  // Strict is the default: hold predicted file overlaps with active tasks or
  // earlier tasks in this wave. Advisory allows parallel work and leaves
  // conflicts to the clean-rebase merge gate. Saved settings and the
  // O8_STRICT_OVERLAP_GATE environment override still take precedence.
  const overlapGate = resolveOverlapGateSync();
  const activePackets = nextState.packets.filter((p) => p.status === 'running' || p.status === 'launching');
  const wavePackets = getDispatchableWave(nextState.packets);
  const overlapFiltered = overlapGate === 'strict'
    ? filterOverlappingPackets(wavePackets, activePackets)
    : wavePackets;
  if (overlapGate !== 'strict' && wavePackets.length > 1) {
    const wouldFilter = filterOverlappingPackets(wavePackets, activePackets);
    if (wouldFilter.length < wavePackets.length) {
      const held = wavePackets.filter((p) => !wouldFilter.find((kept) => kept.id === p.id));
      console.log(`[overlap-gate] Advisory only — would have held ${held.length} packets: ${held.map((p) => p.id).join(', ')}`);
    }
  }

  pruneRecoverySkipMemo(new Set(nextState.packets.map((packet) => packet.id)));

  const dispatchablePackets = overlapFiltered
    .map((packet) => ({
      packet,
      recoveryContext: recoveryContextByPacketId.get(packet.id) ?? null,
    }))
    .filter(({ packet, recoveryContext }) => {
      const pinnedRuntime = recoveryContext?.runtime ?? packet.dispatchRuntimePin ?? null;
      const recoveryBlocker = options.enforceBootRecoveryGuard
        ? getBootRecoveryLaunchBlocker({
            missionArchived: options.missionArchived,
            missionLive: !nextState.packets.every((candidate) => candidate.archivedAt || candidate.releaseState === 'released'),
            packet,
            pinnedRuntime,
          })
        : null;
      if (recoveryBlocker) {
        // #2048 — print once per reason+runtime, not once per tick.
        if (shouldLogRecoverySkip(packet.id, recoveryBlocker, pinnedRuntime)) {
          console.log(`[recovery] Packet ${packet.id} skipped — ${recoveryBlocker}`);
        }
        return false;
      }
      forgetRecoverySkip(packet.id);
      if (getDispatchBlocker(packet, nextState.packets) !== null) {
        return false;
      }
      // #455 — Recovery cooldown: skip packets that were recovered too recently
      if (packet.status === 'recovering' || recoveryContextByPacketId.has(packet.id)) {
        const lastRecovery = packet.lastRecoveryAt ? Date.now() - new Date(packet.lastRecoveryAt).getTime() : Infinity;
        if (lastRecovery < RECOVERY_COOLDOWN_MS) {
          console.log(`[recovery] Packet ${packet.id} skipped — recovery cooldown (${Math.round(lastRecovery / 1000)}s < ${RECOVERY_COOLDOWN_MS / 1000}s)`);
          return false;
        }
      }
      return true;
    });

  if (dispatchablePackets.length === 0) {
    return nextState;
  }

  const parallelCap = resolveParallelCapSync();
  const maxLaunches = options.launchBudget
    ? Math.max(0, Math.floor(options.launchBudget.maxLaunches))
    : Number.POSITIVE_INFINITY;
  if (maxLaunches <= 0) {
    return nextState;
  }
  const queue = [...dispatchablePackets];
  let launchedThisTick = 0;
  const runtimeCountsInTick: Partial<Record<OrchestratorRuntime, number>> = {};
  const effectiveRuntimeByPacket = new Map<string, OrchestratorRuntime>();
  while (queue.length > 0 && launchedThisTick < maxLaunches) {
    const batch: typeof dispatchablePackets = [];
    const deferred: typeof dispatchablePackets = [];
    const runtimeCountsInBatch: Partial<Record<OrchestratorRuntime, number>> = {};
    const batchLimit = Math.min(parallelCap, maxLaunches - launchedThisTick);
    for (const candidate of queue) {
      // Budget against the EFFECTIVE runtime, not the persisted one: a packet
      // stamped with a retired runtime (gemini) reroutes at dispatch (see
      // dispatchPacket's resolveWorkerRouting), and its launch must count
      // against the runtime it will actually run on — otherwise legacy packets
      // bypass the workhorse's parallel budget.
      const runtime = resolveWorkerRouting({
        workerIntent: candidate.packet.workerIntent,
        requestedProvider: candidate.packet.workerRouting?.requestedProvider,
        requestedRuntime: candidate.packet.workerRouting?.requestedRuntime ?? candidate.packet.runtime,
        requestedModel: candidate.packet.workerRouting?.requestedModel ?? candidate.packet.assignedModel,
        source: 'scheduler-budget',
      }).selectedRuntime;
      effectiveRuntimeByPacket.set(candidate.packet.id, runtime);
      const perRuntimeCap = RUNTIME_PARALLEL_CAP[runtime];
      const perRuntimeBudget = options.launchBudget?.perRuntime?.[runtime];
      const hitRuntimeCap =
        perRuntimeCap !== undefined && (runtimeCountsInBatch[runtime] ?? 0) >= perRuntimeCap;
      const hitRuntimeBudget =
        perRuntimeBudget !== undefined
        && (runtimeCountsInTick[runtime] ?? 0) + (runtimeCountsInBatch[runtime] ?? 0) >= perRuntimeBudget;
      if (batch.length < batchLimit && !hitRuntimeCap && !hitRuntimeBudget) {
        batch.push(candidate);
        runtimeCountsInBatch[runtime] = (runtimeCountsInBatch[runtime] ?? 0) + 1;
      } else {
        deferred.push(candidate);
      }
    }
    if (batch.length === 0) break;
    queue.length = 0;
    queue.push(...deferred);
    launchedThisTick += batch.length;
    for (const { packet } of batch) {
      const effective = effectiveRuntimeByPacket.get(packet.id) ?? packet.runtime;
      runtimeCountsInTick[effective] = (runtimeCountsInTick[effective] ?? 0) + 1;
    }
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel (cap ${parallelCap}): ${batch.map(({ packet }) => packet.id).join(', ')}`);

    const results = await Promise.allSettled(
      batch.map(({ packet, recoveryContext }) => dispatchOrRecoverPacket(
        packet,
        nextState.packets,
        recoveryContext,
        options.storageAdmission,
      )),
    );
    nextState = normalizeOrchestratorMissionState({
      ...nextState,
      packets: nextState.packets.map((candidate) => {
        const batchIndex = batch.findIndex(({ packet }) => packet.id === candidate.id);
        if (batchIndex === -1) {
          return candidate;
        }

        const wasRecovering = recoveryContextByPacketId.has(candidate.id);
        const recoveryCount = (candidate.recoveryCount ?? 0) + (wasRecovering ? 1 : 0);
        const recoveryFields = wasRecovering
          ? { recoveryCount, lastRecoveryAt: new Date().toISOString() }
          : {};

        if (wasRecovering) {
          console.log(`[recovery] Packet ${candidate.id} recovery attempt ${recoveryCount}/${MAX_RECOVERY_DISPATCHES}`);
        }

        // #1293 — a per-packet fold error (e.g. createLaneBinding → getLane, or a
        // malformed dispatch result) must NEVER throw out of this .map. If it did,
        // runDispatchTick would abort before the caller persists the dispatched
        // state, leaving an already-dispatched packet stuck 'queued' — so the next
        // tick re-dispatches it, opening a fresh lane + owned session every tick
        // (the second runaway path, distinct from the seed re-fan). Catch
        // per-packet so the tick always completes and persists; a fold failure
        // degrades that single packet to 'blocked' (terminal for getDispatchBlocker).
        try {
          const result = results[batchIndex];
          if (result.status === 'fulfilled') {
            if (result.value.kind === 'awaiting_review') {
              return {
                ...candidate,
                ...recoveryFields,
                status: 'awaiting_review',
                blockedReason: null,
                lastEventAt: new Date().toISOString(),
                lastEventLabel: 'session_recovery_autocommit',
                lane: result.value.lane ?? candidate.lane ?? null,
              };
            }
            const workerRouting = result.value.workerRouting;
            if (!result.value.laneId) {
              throw new Error('Dispatch returned no lane id.');
            }

            void publishRealtimeMutation({
              mutation: {
                mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
                source: 'server',
                action: 'packet-dispatch',
                status: 'completed',
                runtime: workerRouting.selectedRuntime,
                sessionKey: result.value.sessionKey ?? undefined,
                laneId: result.value.laneId ?? undefined,
                laneLabel: candidate.title,
                packetId: candidate.id,
                packetTitle: candidate.title,
                packetReferenceLabel: candidate.referenceLabel,
                repoPath: candidate.workspaceTargetPath ?? undefined,
                branch: candidate.branchTarget,
                launchContext: packetLaunchContext(candidate),
                note: `Dispatched ${candidate.referenceLabel} to ${workerRouting.selectedRuntime}`,
                createdAt: new Date().toISOString(),
                settledAt: new Date().toISOString(),
              },
              refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
              sessionKeys: result.value.sessionKey ? [result.value.sessionKey] : [],
              fresh: true,
            });
            return {
              ...candidate,
              ...recoveryFields,
              // Packet-scoped launch counter (survives the fresh lane minted on
              // each redispatch, unlike the per-lane cap). getDispatchBlocker
              // stops re-admitting this packet once it hits MAX_LAUNCH_ATTEMPTS.
              launchAttempts: (candidate.launchAttempts ?? 0) + 1,
              // A dispatch that cleared preflight proves the earlier refusals
              // were transient, so the refusal budget starts fresh (#2195).
              preflightRefusals: 0,
              runtime: workerRouting.selectedRuntime,
              model: getLane(result.value.laneId)?.model ?? workerRouting.selectedModel,
              assignedModel: workerRouting.selectedModel,
              workerIntent: workerRouting.workerIntent,
              workerRouting,
              launchContext: packetLaunchContext(candidate),
              status: 'launching',
              blockedReason: null,
              storageAdmission: result.value.storageAdmission,
              spendCap: result.value.spendCap,
              lane: createLaneBinding(
                candidate,
                result.value.laneId,
                result.value.sessionKey,
                workerRouting,
                result.value.dependencyMaterializationMode,
              ),
            };
          }

          const reason = result.reason instanceof Error ? result.reason.message : 'Dispatch failed.';
          const storageReceipt = result.reason instanceof PacketStorageAdmissionError
            ? result.reason.receipt
            : candidate.storageAdmission ?? null;
          const retryableStorageHold = storageReceipt?.state === 'held';
          console.error(`[dag-scheduler] Failed to dispatch packet ${candidate.id}: ${reason}`);
          // #2195 — a preflight refusal is an attempt and must be counted like
          // one. It throws before a lane exists, so `launchAttempts` (bumped
          // only on a dispatch that produced a lane) never moved and reconcile
          // re-derived 'blocked' back to 'queued' on the next tick: an
          // unbounded, invisible retry loop spawning an auth probe per pass.
          // Under budget the packet still retries — a runtime that is merely
          // still starting deserves that — and the budget resets on the
          // dispatch that finally succeeds.
          const preflightRefusal = recordDispatchPreflightRefusal(candidate, result.reason);
          if (preflightRefusal) {
            // Log-only was the whole visibility defect: the app looked idle
            // while it spun. Mirrors the dispatch mutation published above so
            // the refusal — and its reason — reaches the operator live.
            void publishRealtimeMutation({
              mutation: {
                mutationId: `packet-dispatch-refused-${candidate.id}-${Date.now()}`,
                source: 'server',
                action: 'packet-dispatch',
                status: 'failed',
                runtime: candidate.runtime,
                laneLabel: candidate.title,
                packetId: candidate.id,
                packetTitle: candidate.title,
                packetReferenceLabel: candidate.referenceLabel,
                repoPath: candidate.workspaceTargetPath ?? undefined,
                branch: candidate.branchTarget,
                launchContext: packetLaunchContext(candidate),
                note: preflightRefusal.exhausted
                  ? `${candidate.referenceLabel} failed dispatch preflight ${preflightRefusal.count}× — no further retries. ${reason}`
                  : `${candidate.referenceLabel} refused by dispatch preflight (${preflightRefusal.count}/${preflightRefusal.maxAttempts}). ${reason}`,
                reason,
                createdAt: new Date().toISOString(),
                settledAt: new Date().toISOString(),
              },
              refreshTargets: ['global', 'mobileInbox'],
              fresh: true,
            });
          }
          return {
            ...candidate,
            ...recoveryFields,
            preflightRefusals: preflightRefusal?.count ?? candidate.preflightRefusals ?? 0,
            status: retryableStorageHold ? 'queued' : 'blocked',
            queueState: preflightRefusal?.incidentPersisted ? 'held' : candidate.queueState,
            blockedReason: preflightRefusal?.blockedReason ?? reason,
            storageAdmission: storageReceipt,
            lastEventAt: retryableStorageHold || preflightRefusal ? new Date().toISOString() : candidate.lastEventAt,
            lastEventLabel: retryableStorageHold
              ? 'storage_admission_held'
              : preflightRefusal ? 'dispatch_preflight_refused' : candidate.lastEventLabel,
          };
        } catch (foldErr) {
          const msg = foldErr instanceof Error ? foldErr.message : 'Dispatch post-processing failed.';
          console.error(`[dag-scheduler] Fold-back error for ${candidate.id} — marking blocked so the tick can't loop:`, msg);
          const storageReceipt = foldErr instanceof PacketStorageAdmissionError
            ? foldErr.receipt
            : candidate.storageAdmission ?? null;
          const retryableStorageHold = storageReceipt?.state === 'held';
          return {
            ...candidate,
            ...recoveryFields,
            status: retryableStorageHold ? 'queued' : 'blocked',
            blockedReason: msg,
            storageAdmission: storageReceipt,
            lastEventAt: retryableStorageHold ? new Date().toISOString() : candidate.lastEventAt,
            lastEventLabel: retryableStorageHold ? 'storage_admission_held' : candidate.lastEventLabel,
          };
        }
      }),
    });
  }

  return nextState;
});
