import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { CODEX_AUTH_RECOVERY_LANE_LABEL, findCurrentAuthExit } from '@/lib/lane/current-auth-exit';
import { recoveryInfoFromLaneEvents } from '@/lib/lane/recovery-info';
import { readLaneTerminalReason } from '@/lib/lane/terminal-reason';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import type { DomainLaneSummary } from '@/lib/orchestrator/domain-lane-summary';
import { normalizeOrchestratorMissionStateForPersistence } from '@/lib/orchestrator/persisted-mission';
import { assertMissionSnapshotAvailable } from './mission-snapshot-availability';
import type { OrchestratorMissionState, OrchestratorRuntimeTruth } from '@/lib/orchestrator/types';
import { packetContextObservationFromEvent } from '@/lib/orchestrator/packet-context-telemetry';
import { CODEX_AUTH_RECOVERY_MESSAGE, codexAuthRecoveryMessage } from '@/lib/runtimes/shared/codex-auth-failure';
import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
  reconcileOrchestratorMissionState,
  updateOrchestratorMissionState,
} from '@/lib/orchestrator/store';

const ORCHESTRATOR_DIR = getDataDir();
const ORCHESTRATOR_PATH = join(ORCHESTRATOR_DIR, 'orchestrator-state.json');
const ORCHESTRATOR_TMP_PATH = `${ORCHESTRATOR_PATH}.tmp`;

// #460/#1488 — In-process mutex to serialize read-modify-write on
// orchestrator-state.json. FIFO chain: each acquirer waits on the previous
// holder's promise and enqueues its own resolver. (The previous single
// module-level resolver was clobbered by concurrent waiters — the second
// waiter's promise got resolved in the first's place and the chain deadlocked.)
let lockTail: Promise<void> = Promise.resolve();
const lockReleases: Array<() => void> = [];

// #1488 — Cross-process lock. The in-process chain above only serializes writers
// inside ONE Node process, but next-server and ws-server both read-modify-write
// this file: a packet created via the API could be erased seconds later when the
// other process persisted a snapshot read before the create (queued tasks
// "evaporating" between o8_task_create and o8_task_dispatch). mkdir is atomic on
// POSIX, so the lock dir is the mutex; a holder writes its pid, timestamp, and a
// unique token inside.
//
// #2399 — The wait is bounded by the holder's liveness, not a flat budget. A
// dead holder's lock is broken at once. A live holder is waited on, past
// LOCK_WAIT_BUDGET_MS (recorded as a slow-holder event), up to
// LOCK_HARD_CEILING_MS; only then is its lock broken. A broken live lock means
// two writers may overlap, so both sides re-read the persisted state before
// writing and merge instead of replacing (see persistMissionUnderLock), and the
// bypass is recorded in the control-plane lock event log.
const LOCK_DIR = `${ORCHESTRATOR_PATH}.lock`;
const LOCK_META = join(LOCK_DIR, 'holder.json');
const LOCK_EVENTS_PATH = join(ORCHESTRATOR_DIR, 'control-plane-lock-events.jsonl');
const LOCK_RETRY_MS = 25;
// mkdir and the holder.json write are two steps; a lock dir younger than this
// with no metadata belongs to a holder between them, not a crashed one.
const LOCK_META_GRACE_MS = 2_000;

function lockTiming() {
  const envMs = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    waitBudgetMs: envMs('O8_CONTROL_PLANE_LOCK_WAIT_BUDGET_MS', 8_000),
    hardCeilingMs: envMs('O8_CONTROL_PLANE_LOCK_HARD_CEILING_MS', 60_000),
  };
}

export class ControlPlaneLockTimeoutError extends Error {
  constructor(public readonly waitTimeoutMs: number) {
    super(`Timed out after ${waitTimeoutMs}ms waiting for the orchestrator control-plane lock.`);
    this.name = 'ControlPlaneLockTimeoutError';
  }
}

interface ControlPlaneLockOptions {
  waitTimeoutMs?: number;
}

interface LockHolderMeta {
  pid?: number;
  at?: number;
  token?: string;
}

export interface ControlPlaneLockEvent {
  at: string;
  pid: number;
  kind: 'slow_holder_waited' | 'dead_holder_broken' | 'hard_ceiling_bypassed' | 'bypass_merged' | 'bypass_unmerged';
  holderPid?: number | null;
  holderAgeMs?: number | null;
  waitedMs?: number;
  preservedPacketIds?: string[];
}

function recordLockEvent(event: Omit<ControlPlaneLockEvent, 'at' | 'pid'>): void {
  const entry: ControlPlaneLockEvent = { at: new Date().toISOString(), pid: process.pid, ...event };
  console.error(`[control-plane] lock ${event.kind}`, JSON.stringify(entry));
  try {
    ensureControlPlaneDir();
    appendFileSync(LOCK_EVENTS_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[control-plane] failed to record lock event:', error);
  }
}

export function readControlPlaneLockEvents(): ControlPlaneLockEvent[] {
  try {
    return readFileSync(LOCK_EVENTS_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ControlPlaneLockEvent);
  } catch {
    return [];
  }
}

function readLockMeta(): LockHolderMeta | null {
  try {
    return JSON.parse(readFileSync(LOCK_META, 'utf8')) as LockHolderMeta;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type LockHolderVerdict =
  | { kind: 'gone' }
  | { kind: 'live'; meta: LockHolderMeta | null; ageMs: number }
  | { kind: 'dead'; meta: LockHolderMeta | null; ageMs: number };

function judgeLockHolder(): LockHolderVerdict {
  const meta = readLockMeta();
  if (meta && typeof meta.pid === 'number' && typeof meta.at === 'number') {
    const ageMs = Date.now() - meta.at;
    return pidIsAlive(meta.pid) ? { kind: 'live', meta, ageMs } : { kind: 'dead', meta, ageMs };
  }
  let dirAgeMs: number;
  try {
    dirAgeMs = Date.now() - statSync(LOCK_DIR).mtimeMs;
  } catch {
    return { kind: 'gone' };
  }
  // No usable metadata: a holder between mkdir and its metadata write, or one
  // that crashed there. Only the second outlives the grace window.
  return dirAgeMs < LOCK_META_GRACE_MS
    ? { kind: 'live', meta, ageMs: dirAgeMs }
    : { kind: 'dead', meta, ageMs: dirAgeMs };
}

function breakLock(judged: LockHolderMeta | null): void {
  // Narrow the break race: skip if another waiter already broke this lock and
  // a new holder took it since we judged it.
  const current = readLockMeta();
  if (judged?.token && current?.token && current.token !== judged.token) return;
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* another process may have broken it first */ }
}

// The token of the FS lock this process holds, and whether it was taken by
// breaking a live holder. Guarded by the in-process chain, so one slot suffices.
let heldLockToken: string | null = null;
let heldLockBypassed = false;

async function acquireFsLock(options: ControlPlaneLockOptions, waitStartedAt: number): Promise<void> {
  const { waitBudgetMs, hardCeilingMs } = lockTiming();
  const startedAt = Date.now();
  let slowHolderRecorded = false;
  for (;;) {
    if (options.waitTimeoutMs !== undefined && Date.now() - waitStartedAt >= options.waitTimeoutMs) {
      throw new ControlPlaneLockTimeoutError(options.waitTimeoutMs);
    }
    const token = randomUUID();
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(LOCK_META, JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8');
      heldLockToken = token;
      return;
    } catch (error) {
      // Only an occupied lock is contention. Missing fixture parents, access
      // errors and failed receipt writes must not become a synchronous spin.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = judgeLockHolder();
      if (holder.kind === 'gone') continue;
      if (holder.kind === 'dead') {
        recordLockEvent({ kind: 'dead_holder_broken', holderPid: holder.meta?.pid ?? null, holderAgeMs: holder.ageMs });
        breakLock(holder.meta);
        continue;
      }
      const waitedMs = Date.now() - startedAt;
      if (holder.ageMs > hardCeilingMs) {
        recordLockEvent({ kind: 'hard_ceiling_bypassed', holderPid: holder.meta?.pid ?? null, holderAgeMs: holder.ageMs, waitedMs });
        breakLock(holder.meta);
        heldLockBypassed = true;
        continue;
      }
      if (!slowHolderRecorded && waitedMs > waitBudgetMs) {
        slowHolderRecorded = true;
        recordLockEvent({ kind: 'slow_holder_waited', holderPid: holder.meta?.pid ?? null, holderAgeMs: holder.ageMs, waitedMs });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** True when this writer may overlap another: it broke a live holder's lock,
 * or its own lock was broken by a waiter that hit the hard ceiling. */
function heldLockCompromised(): boolean {
  return heldLockBypassed || !heldLockToken || readLockMeta()?.token !== heldLockToken;
}

function releaseFsLock(): void {
  const token = heldLockToken;
  heldLockToken = null;
  heldLockBypassed = false;
  // Never remove a lock another writer took after breaking ours.
  if (!token || readLockMeta()?.token !== token) return;
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    console.error('[control-plane] failed to release cross-process lock:', error);
  }
}

async function acquireLock(options: ControlPlaneLockOptions = {}): Promise<void> {
  const waitStartedAt = Date.now();
  const waitForPrevious = lockTail;
  let release!: () => void;
  lockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockReleases.push(release);
  const waitTimeoutMs = options.waitTimeoutMs;
  if (waitTimeoutMs !== undefined) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      waitForPrevious.then(() => 'acquired' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      // Keep the FIFO chain healthy after this waiter leaves. Once its
      // predecessor releases, remove this abandoned queue slot and resolve it
      // so later waiters can continue without acquiring or releasing the FS lock.
      void waitForPrevious.then(() => {
        const index = lockReleases.indexOf(release);
        if (index >= 0) lockReleases.splice(index, 1);
        release();
      });
      throw new ControlPlaneLockTimeoutError(waitTimeoutMs);
    }
  } else {
    await waitForPrevious;
  }
  try { await acquireFsLock(options, waitStartedAt); }
  catch (error) {
    // A failed filesystem acquisition owns this FIFO slot, but no lock.
    // Release the slot so a repaired parent can be acquired on the next call.
    const index = lockReleases.indexOf(release);
    if (index >= 0) lockReleases.splice(index, 1);
    release();
    throw error;
  }
}

function releaseLock(): void {
  releaseFsLock();
  lockReleases.shift()?.();
}

interface OrchestratorControlPlaneFile {
  version: 1;
  mission: OrchestratorMissionState;
}

function ensureControlPlaneDir() {
  mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
}

function readPersistedControlPlaneState(strict = false): OrchestratorMissionState {
  try {
    const raw = readFileSync(ORCHESTRATOR_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OrchestratorControlPlaneFile>;
    if (strict) assertMissionSnapshotAvailable(parsed?.mission);
    return normalizeOrchestratorMissionState(parsed.mission ?? createEmptyOrchestratorMissionState());
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Current packet snapshot is unavailable.');
    return createEmptyOrchestratorMissionState();
  }
}

export function readOrchestratorControlPlaneState(options: { strict?: boolean } = {}): OrchestratorMissionState {
  const mission = readPersistedControlPlaneState(options.strict);
  updateOrchestratorMissionState(mission);
  return mission;
}

export function writeOrchestratorControlPlaneState(state: OrchestratorMissionState) {
  ensureControlPlaneDir();
  const next: OrchestratorControlPlaneFile = {
    version: 1,
    mission: normalizeOrchestratorMissionStateForPersistence(state),
  };
  writeFileSync(ORCHESTRATOR_TMP_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(ORCHESTRATOR_TMP_PATH, ORCHESTRATOR_PATH);
  updateOrchestratorMissionState(next.mission);
  return next.mission;
}

const RUNTIME_EXIT_OVERRIDE_STATUSES = new Set<Lane['status']>([
  'launching',
  'running',
  'recovering',
]);

function hasUnreconciledRuntimeExit(lane: Lane, events: LaneEvent[]): boolean {
  if (!RUNTIME_EXIT_OVERRIDE_STATUSES.has(lane.status)) return false;
  const runtimeExit = events.findLast((event) => event.verb === 'runtime_process_exit');
  if (!runtimeExit) return false;
  const exitSurfaceId = runtimeExit.payload.surfaceId;
  if (typeof exitSurfaceId === 'string' && lane.sessionKey && exitSurfaceId !== lane.sessionKey) return false;
  const exitAt = Date.parse(runtimeExit.timestamp);
  const laneEventAt = lane.lastEventAt ? Date.parse(lane.lastEventAt) : 0;
  if (!Number.isFinite(exitAt) || (Number.isFinite(laneEventAt) && exitAt < laneEventAt)) return false;
  const classification = runtimeExit.payload.classification;
  const exitCode = runtimeExit.payload.exitCode;
  const runtimeOutcome = runtimeExit.payload.runtimeOutcome;
  const signal = runtimeExit.payload.signal;
  if (runtimeOutcome === 'failed') return true;
  if (classification === 'clean-exit' || (exitCode === 0 && (signal === null || signal === undefined))) {
    return false;
  }
  return true;
}

export function buildDomainLaneSummaries(packetIds?: ReadonlySet<string>): DomainLaneSummary[] {
  if (packetIds?.size === 0) return [];
  const mergePolicy = currentLaneMergePolicy();
  return listLanes(packetIds)
    .filter((lane) => lane.packetId)
    .map((lane) => {
      const events = getLaneEvents(lane.id, 100);
      const recovery = recoveryInfoFromLaneEvents(events);
      const currentAuthExit = findCurrentAuthExit(lane, events);
      const runtimeExited = currentAuthExit ? false : hasUnreconciledRuntimeExit(lane, events);
      const contextEvent = events.findLast((event) => event.verb === 'runtime_process_exit');
      const provisionFailure = events.findLast((event) => event.verb === 'worktree_provision_failed');
      const failureMessage = currentAuthExit
        ? CODEX_AUTH_RECOVERY_MESSAGE
        : contextEvent?.payload.runtime === 'codex'
        && contextEvent.payload.surfaceId === lane.sessionKey
        && !events.slice(events.indexOf(contextEvent) + 1).some((event) => event.verb === 'attach_session')
        && contextEvent.payload.runtimeOutcome === 'failed'
        ? (contextEvent.payload.authRecoveryRequired === true ? CODEX_AUTH_RECOVERY_MESSAGE
          : codexAuthRecoveryMessage(typeof contextEvent.payload.stderr === 'string' ? contextEvent.payload.stderr : ''))
        : lane.lastEventLabel === 'packet_worktree_provision_failed'
          ? String(provisionFailure?.payload.note ?? provisionFailure?.payload.cause
            ?? readLaneTerminalReason(lane)?.cause ?? 'Worktree provisioning failed')
          : null;
      return {
        laneId: lane.id,
        packetId: lane.packetId!,
        status: currentAuthExit ? 'awaiting_input' : runtimeExited ? 'failed' : lane.status,
        sessionKey: lane.sessionKey,
        lastEventLabel: currentAuthExit
          ? CODEX_AUTH_RECOVERY_LANE_LABEL
          : runtimeExited ? 'runtime_process_exit' : lane.lastEventLabel,
        provisioningQueuePosition: lane.status === 'launching' && !lane.sessionKey
          && /^worktree_provision_queued:\d+$/.test(lane.lastEventLabel ?? '')
          ? Number(lane.lastEventLabel!.split(':')[1]) : null,
        failureMessage,
        authRecoveryRequired: Boolean(currentAuthExit),
        recovery,
        contextObservation: contextEvent ? packetContextObservationFromEvent(contextEvent) : undefined,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      };
    });
}

function needsRuntimeTruth(domainLanes: DomainLaneSummary[]): boolean {
  return domainLanes.some((lane) =>
    lane.status === 'reviewing' && lane.sessionKey?.startsWith('codex-owned:')
  );
}

async function buildRuntimeTruthSummaries(domainLanes: DomainLaneSummary[]): Promise<OrchestratorRuntimeTruth[]> {
  if (!needsRuntimeTruth(domainLanes)) return [];
  const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents
    .filter((agent) => agent.sessionKey && (agent.runtime === 'codex' || agent.runtime === 'claude-code'))
    .map(runtimeTruthFromInventoryAgent);
}

type InventoryAgent = Awaited<ReturnType<typeof import('@/lib/runtime/inventory').getRuntimeInventorySnapshot>>['agents'][number];

/** One inventory agent as the runtime truth reconciliation reads it. */
export function runtimeTruthFromInventoryAgent(agent: InventoryAgent): OrchestratorRuntimeTruth {
  return {
    sessionKey: agent.sessionKey,
    runtime: agent.runtime === 'claude-code' ? 'claude-code' as const : 'codex' as const,
    status: agent.status ?? 'idle',
    currentTask: agent.currentTask ?? null,
    lastEventAt: agent.lastEventAt ?? null,
    workflowStageLabel: null,
    canSendInput: agent.runtimeSurface?.capabilities.sendInput ?? null,
    canInterrupt: agent.runtimeSurface?.capabilities.interrupt ?? null,
    runtimeAvailability: agent.runtimeSurface?.lifecycle?.availability ?? null,
    ownership: agent.runtimeSurface?.ownership ?? null,
  };
}

export function reconcileOrchestratorControlPlaneState(
  state?: OrchestratorMissionState,
  runtimeTruth: OrchestratorRuntimeTruth[] = [],
  domainLanes?: DomainLaneSummary[],
) {
  const current = normalizeOrchestratorMissionState(state ?? readOrchestratorControlPlaneState());
  return reconcileOrchestratorMissionState(current, {
    laneSnapshots: [],
    runtimeTruth,
    // A mission consumes lane truth only by its own packet IDs. Reading every
    // other mission's event history on each tick multiplies idle work by the
    // saved fleet size without changing this mission's reconciliation.
    domainLanes: domainLanes ?? buildDomainLaneSummaries(new Set(current.packets.map((packet) => packet.id))),
  });
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * #2399 — Three-way merge for a writer whose lock was bypassed. `base` is what
 * this writer read, `ours` is what it wants to persist, `theirs` is what is on
 * disk now. A field or packet this writer did not change takes the persisted
 * value; one it changed keeps its value. A packet the other writer added or
 * changed survives even if this writer's snapshot omits it.
 */
function mergeBypassedMission(
  base: OrchestratorMissionState,
  ours: OrchestratorMissionState,
  theirs: OrchestratorMissionState,
): { mission: OrchestratorMissionState; preservedPacketIds: string[] } {
  // A different mission on disk cannot be merged packet by packet.
  if ((theirs.missionId ?? '') !== (base.missionId ?? '')) return { mission: ours, preservedPacketIds: [] };
  const baseById = new Map(base.packets.map((packet) => [packet.id, packet]));
  const theirsById = new Map(theirs.packets.map((packet) => [packet.id, packet]));
  const oursIds = new Set(ours.packets.map((packet) => packet.id));
  const preservedPacketIds: string[] = [];
  const packets: OrchestratorMissionState['packets'] = [];
  for (const packet of ours.packets) {
    const before = baseById.get(packet.id);
    const persisted = theirsById.get(packet.id);
    if (!before) {
      packets.push(packet);
    } else if (sameValue(packet, before)) {
      // Unchanged here: the persisted copy wins, including its deletion.
      if (persisted) {
        packets.push(persisted);
        if (!sameValue(persisted, before)) preservedPacketIds.push(packet.id);
      }
    } else {
      packets.push(packet);
    }
  }
  for (const packet of theirs.packets) {
    if (oursIds.has(packet.id)) continue;
    const before = baseById.get(packet.id);
    // Added by the other writer, or changed by it after this writer removed it.
    if (!before || !sameValue(packet, before)) {
      packets.push(packet);
      preservedPacketIds.push(packet.id);
    }
  }
  const merged = { ...ours } as unknown as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  const theirsRecord = theirs as unknown as Record<string, unknown>;
  for (const key of Object.keys(merged)) {
    if (key === 'packets') continue;
    if (sameValue(merged[key], baseRecord[key])) merged[key] = theirsRecord[key];
  }
  return {
    mission: normalizeOrchestratorMissionState({ ...merged, packets }),
    preservedPacketIds,
  };
}

/**
 * Reconcile and persist `mission` (derived from `base`, the state read under
 * the lock). If the lock was bypassed, re-read the persisted state and merge
 * rather than replace, so an overlapping writer's changes are not lost.
 */
async function persistMissionUnderLock(
  base: OrchestratorMissionState,
  mission: OrchestratorMissionState,
): Promise<OrchestratorMissionState> {
  const domainLanes = buildDomainLaneSummaries(new Set(mission.packets.map((packet) => packet.id)));
  const runtimeTruth = await buildRuntimeTruthSummaries(domainLanes).catch(() => []);
  if (!heldLockCompromised()) {
    return writeOrchestratorControlPlaneState(reconcileOrchestratorControlPlaneState(mission, runtimeTruth, domainLanes));
  }
  const { mission: merged, preservedPacketIds } = mergeBypassedMission(base, mission, readPersistedControlPlaneState());
  recordLockEvent({ kind: 'bypass_merged', preservedPacketIds });
  return writeOrchestratorControlPlaneState(reconcileOrchestratorControlPlaneState(merged, runtimeTruth));
}

// Sync always derives from the state read under the lock. Caller snapshots can
// predate another writer; apply mutations through withLockedState instead.
export async function syncOrchestratorControlPlaneState() {
  await acquireLock();
  try {
    const base = readOrchestratorControlPlaneState();
    const current = structuredClone(base);
    return await persistMissionUnderLock(base, current);
  } finally {
    releaseLock();
  }
}

/**
 * #460 — Locked read-modify-write: read state, apply a mutation, reconcile, and persist.
 * Use this for any operation that needs exclusive access to orchestrator-state.json.
 *
 * If the callback returns an OrchestratorMissionState, that value is used as the
 * basis for reconcile + write instead of the pre-callback snapshot. This allows
 * callers that run a sub-operation (e.g. runDispatchTick) producing a new state
 * to persist that result without a second write that would clobber it.
 */
/**
 * #1488 — Lock-only variant: exclusive access (in-process + cross-process)
 * WITHOUT the end-of-lock reconcile+write that withLockedState performs. For
 * callers that must persist exact statuses (e.g. mission stop's honest
 * per-packet results) and do their own writeOrchestratorControlPlaneState —
 * a reconcile against not-yet-caught-up lane snapshots would rewrite them.
 */
export async function withControlPlaneLock<T>(
  fn: () => T | Promise<T>,
  options: ControlPlaneLockOptions = {},
): Promise<T> {
  await acquireLock(options);
  try {
    const result = await fn();
    // These callers write for themselves, so there is nothing to merge; the
    // overlap is recorded for diagnosis.
    if (heldLockCompromised()) recordLockEvent({ kind: 'bypass_unmerged' });
    return result;
  } finally {
    releaseLock();
  }
}

export async function withLockedState<T>(
  fn: (state: OrchestratorMissionState) => T | Promise<T>,
  options: ControlPlaneLockOptions = {},
): Promise<{ result: T; state: OrchestratorMissionState }> {
  await acquireLock(options);
  try {
    const current = readOrchestratorControlPlaneState();
    const base = structuredClone(current);
    const result = await fn(current);
    // If the callback returned a mission state, reconcile from that (post-operation
    // snapshot). Otherwise fall back to the mutated `current` object as before.
    const basisForReconcile: OrchestratorMissionState =
      result !== null
      && typeof result === 'object'
      && 'packets' in (result as object)
      && 'lanes' in (result as object)
        ? (result as unknown as OrchestratorMissionState)
        : current;
    const mission = normalizeOrchestratorMissionState(basisForReconcile);
    const state = await persistMissionUnderLock(base, mission);
    return { result, state };
  } finally {
    releaseLock();
  }
}
