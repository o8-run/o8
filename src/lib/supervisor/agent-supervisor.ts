import { resolveStatus, readOwnedRecoveryState, readOwnedCompletionState } from './recovery-status';
import { sharedWorkerLaunchContext } from '@/lib/orchestrator/shared-worker-recovery';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';
import { settledCompletionStatus, watchedAgentOutcome } from './fleet-outcome';
import { retryWatchedAgent } from './retry-watched-agent';
import type {
  AgentStatusEntry,
  SupervisorCallbacks,
  SupervisorFleetStatusSummary,
  TranscriptEntry,
  WatchedAgent,
} from './agent-supervisor-types';
export type {
  AgentCompletionDecision,
  AgentStatusEntry,
  AgentUpdateEvent,
  SupervisorCallbacks,
  SupervisorFleetStatusSummary,
  TranscriptEntry,
  WatchedAgent,
} from './agent-supervisor-types';

/**
 * Agent Supervisor — zero-cost rules engine that monitors launched Codex agents.
 *
 * Pure Node.js. No LLM tokens. Polls fleet inventory on a configurable interval,
 * detects status changes, and auto-handles common cases (retry, steer, relaunch).
 * Only escalates to the orchestrator (Opus) when a human-level decision is needed.
 *
 * The ws-server injects callbacks so this module has no HTTP/WS/LLM dependencies.
 */

type TranscriptBatchStatus = {
  signature: string | null;
  mtimeMs: number | null;
  totalSize: number;
  pathCount: number;
  exists: boolean;
};

type TranscriptSourceCacheEntry = {
  paths: string[];
  resolvedAt: number;
};
// ── Constants ──

const SUPERVISOR_HEARTBEAT_MS = 5_000;
const DEFAULT_ACTIVE_POLL_INTERVAL_MS = 2_000;
const IDLE_POLL_INTERVAL_MS = 10_000;
const COMPLETED_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STAGGER_WINDOW_MS = 5_000;
const TRANSCRIPT_SOURCE_CACHE_TTL_MS = 15_000;
const MISSING_TRANSCRIPT_SOURCE_CACHE_TTL_MS = 2_000;
const FIRST_STEER_THRESHOLD_MS = 6 * 60 * 1000; // planning-heavy turns need a longer first window
const STUCK_THRESHOLD_MS = 2 * 60 * 1000;       // subsequent steers retain the existing cadence
const MAX_RETRIES = 1;                           // Auto-retry once on failure
const MAX_STEERS = 2;                            // Auto-steer twice before escalate
const COMPLETION_CLEANUP_MS = 60_000;            // Remove from watch 60s after done
const COMPLETION_CONFIRM_MS = 15_000;            // 15s grace before confirming completion
const STALE_WATCH_THRESHOLD_MS = 60 * 60 * 1000; // Purge stale watched rows on startup after 1h
const TRANSCRIPT_ACTIVITY_WINDOW = 120;
const CLAUDE_PROJECTS_DIR = path.join(
  process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'),
  'projects',
);
// ── State ──
const watchedAgents = new Map<string, WatchedAgent>();
const transcriptSourceCache = new Map<string, TranscriptSourceCacheEntry>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let callbacks: SupervisorCallbacks | null = null;
let heartbeatInFlight = false;
const pollIntervalMs = DEFAULT_ACTIVE_POLL_INTERVAL_MS;
let registrationOrdinal = 0;
// ── #458: SQLite persistence for watched agents ──

function persistWatchedAgent(agent: WatchedAgent): void {
  try {
    const db = getSqlite();
    db.prepare(
      `INSERT OR REPLACE INTO watched_agents
       (surface_id, repo_path, name, prompt, registered_at, last_status, retry_count, steer_count, completion_reported, last_event_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.surfaceId, agent.repoPath, agent.name, agent.prompt,
      agent.registeredAt, agent.lastStatus, agent.retryCount, agent.steerCount,
      agent.completionReported ? 1 : 0, agent.lastEventAt, agent.lastActivityAt,
    );
  } catch { /* DB may not be ready */ }
}

function removePersistedAgent(surfaceId: string): void {
  try {
    getSqlite().prepare('DELETE FROM watched_agents WHERE surface_id = ?').run(surfaceId);
  } catch { /* DB may not be ready */ }
}

interface PersistedAgentRow {
  surface_id: string;
  repo_path: string;
  name: string;
  prompt: string;
  registered_at: number;
  last_status: string;
  retry_count: number;
  steer_count: number;
  completion_reported: number;
  last_event_at: number;
  last_activity_at: number;
}

function recordWatchedAgentEvent(watched: WatchedAgent, at: number): void {
  watched.lastEventAt = at;
}

export function rehydrateWatchedAgents(): number {
  try {
    const db = getSqlite();
    const rows = db.prepare('SELECT * FROM watched_agents').all() as PersistedAgentRow[];
    let count = 0;
    let purged = 0;
    const rehydratedSurfaceIds: string[] = [];
    const now = Date.now();

    for (const row of rows) {
      if (watchedAgents.has(row.surface_id)) continue;
      const launchContext = sharedWorkerLaunchContext(row.repo_path, row.surface_id);
      if (row.completion_reported && !launchContext) continue;
      const pollOrdinal = registrationOrdinal++;
      const lastEventAt = row.last_event_at || row.last_activity_at || row.registered_at;
      watchedAgents.set(row.surface_id, {
        surfaceId: row.surface_id,
        repoPath: row.repo_path,
        name: row.name,
        prompt: row.prompt,
        launchContext,
        registeredAt: row.registered_at,
        lastStatus: row.last_status,
        lastRuntimeStatus: null,
        lastTranscriptLength: 0,
        lastTranscriptEntryId: null,
        lastTranscriptSignature: null,
        lastTranscriptMtimeMs: null,
        lastActivityAt: row.last_activity_at,
        lastEventAt,
        retryCount: row.retry_count,
        steerCount: row.steer_count,
        completionReported: launchContext ? false : Boolean(row.completion_reported),
        lastProgressEntryId: null,
        batchReported: false,
        tentativeFinishedSince: null,
        tentativeTranscriptLength: 0,
        tentativeTranscriptEntryId: null,
        tentativeTranscriptSignature: null,
        pollOrdinal,
        nextPollAt: now,
        lastPolledAt: null,
      });
      rehydratedSurfaceIds.push(row.surface_id);
      count++;
    }

    for (const surfaceId of rehydratedSurfaceIds) {
      const agent = watchedAgents.get(surfaceId);
      if (!agent) continue;
      if (agent.completionReported) continue;
      // #1292 ROOT — purge orphans whose lane was reset/archived (no ACTIVE lane
      // maps to the session). Pre-fix, reset didn't unregister these rows, so they
      // rehydrated and relaunched into a fresh sibling lane+session on EVERY launch
      // — the dominant multiply (~154 sessions for ~7 tasks). A missing active lane
      // = the lane is gone/retired → orphan. This drains the existing orphan
      // backlog on the next launch, regardless of staleness; FIX #1 (reset
      // unregister) prevents new ones at reset time. Raw SQL avoids a registry
      // import cycle in this hot startup path.
      const activeLane = db
        .prepare("SELECT 1 FROM lanes WHERE session_key = ? AND status NOT IN ('archived','completed') LIMIT 1")
        .get(surfaceId);
      if (agent.launchContext?.checkoutMode === 'shared' || (activeLane && now - agent.lastEventAt <= STALE_WATCH_THRESHOLD_MS)) continue;
      removePersistedAgent(surfaceId);
      watchedAgents.delete(surfaceId);
      transcriptSourceCache.delete(surfaceId);
      purged += 1;
    }

    if (count > 0) {
      console.log(`[supervisor] Rehydrated ${count} watched agent${count === 1 ? '' : 's'} from SQLite`);
    }
    console.log(`[supervisor] Purged ${purged} stale/orphaned watched agents on startup`);
    return count;
  } catch {
    return 0;
  }
}
// ── Public API ──

export function registerWatchedAgent(
  surfaceId: string,
  repoPath: string,
  name: string,
  prompt: string,
  launchContext?: WorkerLaunchContext,
): void {
  const now = Date.now();
  const pollOrdinal = registrationOrdinal++;

  transcriptSourceCache.delete(surfaceId);

  watchedAgents.set(surfaceId, {
    surfaceId,
    repoPath,
    name,
    prompt,
    launchContext,
    registeredAt: now,
    lastStatus: 'running',
    lastRuntimeStatus: 'running',
    lastTranscriptLength: 0,
    lastTranscriptEntryId: null,
    lastTranscriptSignature: null,
    lastTranscriptMtimeMs: null,
    lastActivityAt: now,
    lastEventAt: now,
    retryCount: 0,
    steerCount: 0,
    completionReported: false,
    lastProgressEntryId: null,
    batchReported: false,
    tentativeFinishedSince: null,
    tentativeTranscriptLength: 0,
    tentativeTranscriptEntryId: null,
    tentativeTranscriptSignature: null,
    pollOrdinal,
    nextPollAt: now + computeInitialPollOffsetMs(pollOrdinal),
    lastPolledAt: null,
  });

  console.log(`[supervisor] Watching agent "${name}" (${surfaceId})`);
  persistWatchedAgent(watchedAgents.get(surfaceId)!);

  callbacks?.broadcastAgentUpdate({
    surfaceId,
    name,
    status: 'launched',
    detail: `Agent "${name}" launched`,
    repoPath,
    launchContext,
  });
}

export function unregisterWatchedAgent(surfaceId: string, expectedWatch?: WatchedAgent): void {
  const agent = watchedAgents.get(surfaceId);
  if (expectedWatch && agent !== expectedWatch) return;
  if (agent) {
    console.log(`[supervisor] Unwatching agent "${agent.name}" (${surfaceId})`);
    watchedAgents.delete(surfaceId);
    removePersistedAgent(surfaceId);
  }
  transcriptSourceCache.delete(surfaceId);
}

export function getWatchedAgents(repoPath?: string): WatchedAgent[] {
  const all = [...watchedAgents.values()];
  return repoPath ? all.filter((agent) => agent.repoPath === repoPath) : all;
}

/**
 * #1523 — push-based completion. Invoked (via the ws-server
 * `/supervisor/completed` endpoint) when an owned worker's child exits clean.
 * Drives the SAME handleStatusChange('finished') chain the poller uses
 * (auto-commit → verification → agent_completed / ralph requeue), without
 * waiting for a fleet snapshot to catch the dead session in a transient
 * 'reviewing' state. The poller and the 45s/90s salvage nets remain as
 * fallbacks; `completionReported` makes the two paths mutually idempotent.
 * Returns false when the surface isn't watched (registration was lost) so the
 * caller can re-register from the lane row and retry.
 */
export async function ingestAgentCompletionSignal(surfaceId: string, runId?: string): Promise<boolean> {
  const watched = watchedAgents.get(surfaceId);
  if (!watched || !callbacks) return false;
  const current = await readOwnedCompletionState(surfaceId);
  if (current.owned && (current.packetHoldReason || current.interrupted || current.outcome !== 'finished' || (runId && runId !== current.runId))) return true;
  await handleStatusChange(watched, 'finished', Date.now());
  return true;
}

export function getSupervisorFleetStatusSummary(repoPath?: string): SupervisorFleetStatusSummary[] {
  return buildFleetStatusSummaries(repoPath);
}

export function startSupervisorLoop(cbs: SupervisorCallbacks): void {
  callbacks = cbs;
  if (pollTimer || heartbeatInFlight) return;

  // #458 — Rehydrate watched agents from SQLite on startup
  rehydrateWatchedAgents();

  queueNextHeartbeat(0);
  console.log(
    `[supervisor] Started (heartbeat ${SUPERVISOR_HEARTBEAT_MS}ms, `
    + `active ${pollIntervalMs}ms / idle ${IDLE_POLL_INTERVAL_MS}ms / `
    + `completed ${COMPLETED_POLL_INTERVAL_MS}ms)`,
  );
}

export function stopSupervisorLoop(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log('[supervisor] Stopped');
}
// ── Scheduler ──

function queueNextHeartbeat(delayMs = SUPERVISOR_HEARTBEAT_MS): void {
  if (!callbacks) return;
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void supervisorHeartbeat();
  }, Math.max(0, delayMs));
}

async function supervisorHeartbeat(): Promise<void> {
  if (!callbacks) return;
  if (heartbeatInFlight) {
    queueNextHeartbeat();
    return;
  }

  heartbeatInFlight = true;
  try {
    await supervisorTick();
  } catch (err) {
    console.error('[supervisor] Poll error:', err);
  } finally {
    heartbeatInFlight = false;
    if (callbacks) {
      queueNextHeartbeat();
    }
  }
}

function computeInitialPollOffsetMs(pollOrdinal: number): number {
  const staggerWindowMs = Math.max(DEFAULT_STAGGER_WINDOW_MS, pollIntervalMs);
  const slotCount = Math.max(1, Math.floor(staggerWindowMs / SUPERVISOR_HEARTBEAT_MS));
  return (pollOrdinal % slotCount) * SUPERVISOR_HEARTBEAT_MS;
}

function scheduleNextAgentPoll(
  watched: WatchedAgent,
  currentStatus: string,
  runtimeStatus: string | null,
  now: number,
): void {
  const intervalMs = pollIntervalForAgent(watched, currentStatus, runtimeStatus);
  const base = watched.nextPollAt > now ? watched.nextPollAt : now;
  watched.nextPollAt = base + intervalMs;
}

function pollIntervalForAgent(
  watched: WatchedAgent,
  currentStatus: string,
  runtimeStatus: string | null,
): number {
  if (watched.completionReported) {
    return COMPLETED_POLL_INTERVAL_MS;
  }
  if (currentStatus === 'finished' || watched.tentativeFinishedSince) {
    return IDLE_POLL_INTERVAL_MS;
  }
  if (currentStatus === 'failed' || currentStatus === 'interrupted') {
    return COMPLETED_POLL_INTERVAL_MS;
  }
  if (runtimeStatus === 'idle' || runtimeStatus === 'reviewing') {
    return IDLE_POLL_INTERVAL_MS;
  }
  return pollIntervalMs;
}
// ── Core Poll Tick ──

async function supervisorTick(): Promise<void> {
  callbacks?.onHeartbeat?.();
  if (!callbacks || watchedAgents.size === 0) return;

  const now = Date.now();
  const dueAgents = [...watchedAgents.values()]
    .filter((watched) => watched.nextPollAt <= now)
    .sort((left, right) => (
      left.nextPollAt - right.nextPollAt
      || left.pollOrdinal - right.pollOrdinal
    ));

  if (dueAgents.length === 0) {
    return;
  }

  let fleet: AgentStatusEntry[];
  try {
    fleet = await callbacks.fetchFleetStatus();
  } catch {
    return; // Fleet fetch failed — skip this heartbeat
  }

  const fleetMap = new Map(fleet.map((agent) => [agent.sessionKey, agent]));
  const transcriptStatusMap = await readTranscriptBatchStatuses(dueAgents);
  if (isJudgmentRefereeEnabled()) {
    const { startLoopChecks } = await import('./loop-detector'); // #2448, advisory
    startLoopChecks(dueAgents, callbacks.fetchTranscript);
  }

  for (const watched of dueAgents) {
    if (!watchedAgents.has(watched.surfaceId)) continue;

    const runtimeAgent = fleetMap.get(watched.surfaceId);
    const transcriptStatus = transcriptStatusMap.get(watched.surfaceId) ?? emptyTranscriptBatchStatus();

    await pollWatchedAgent(watched, runtimeAgent, transcriptStatus, now);
  }

  checkAllDone();
}

/** Test-only: run one supervisor tick with the callbacks from `startSupervisorLoop`. */
export const runSupervisorTickForTesting = () => supervisorTick();

async function pollWatchedAgent(
  watched: WatchedAgent,
  runtimeAgent: AgentStatusEntry | undefined,
  transcriptStatus: TranscriptBatchStatus,
  now: number,
): Promise<void> {
  watched.lastPolledAt = now;
  if (watched.completionReported) {
    scheduleNextAgentPoll(watched, watched.lastStatus, watched.lastRuntimeStatus, now);
    return;
  }
  watched.lastRuntimeStatus = runtimeAgent?.status ?? null;

  const recovery = await (resolveStatus(runtimeAgent, watched, now) === 'finished' ? readOwnedCompletionState : readOwnedRecoveryState)(watched.surfaceId);
  const currentStatus = recovery.owned
    ? recovery.interrupted ? 'interrupted' : !recovery.runId || recovery.packetHoldReason ? 'unavailable' : resolveStatus(runtimeAgent, watched, now)
    : resolveStatus(runtimeAgent, watched, now);

  if (currentStatus === 'finished' && !watched.completionReported) {
    const confirmed = await confirmFinishedAgent(watched, transcriptStatus, now);
    if (!confirmed) {
      scheduleNextAgentPoll(watched, currentStatus, runtimeAgent?.status ?? null, now);
      return;
    }
  } else if (currentStatus !== 'finished' && watched.tentativeFinishedSince) {
    console.log(`[supervisor] "${watched.name}" back to "${currentStatus}" — canceling tentative finish`);
    resetTentativeCompletion(watched);
  }

  if (currentStatus !== watched.lastStatus) {
    const prevStatus = watched.lastStatus;
    watched.lastStatus = currentStatus;
    recordWatchedAgentEvent(watched, now);
    console.log(`[supervisor] "${watched.name}" ${prevStatus} → ${currentStatus}`);

    await handleStatusChange(watched, currentStatus, now);
    if (!watchedAgents.has(watched.surfaceId)) {
      return;
    }
    persistWatchedAgent(watched);
  }

  if ((currentStatus === 'running' || currentStatus === 'waiting') && !watched.completionReported) {
    await checkStuck(watched, transcriptStatus, now, recovery.owned ? recovery.runId : undefined);
    if (!watchedAgents.has(watched.surfaceId)) {
      return;
    }
  }

  scheduleNextAgentPoll(watched, watched.lastStatus, watched.lastRuntimeStatus, now);
}
// ── Status Resolution ──
// ── Completion Grace ──

async function confirmFinishedAgent(
  watched: WatchedAgent,
  transcriptStatus: TranscriptBatchStatus,
  now: number,
): Promise<boolean> {
  if (!callbacks) return false;

  if (!watched.tentativeFinishedSince) {
    watched.tentativeFinishedSince = now;
    watched.tentativeTranscriptSignature = transcriptStatus.signature;

    if (transcriptStatus.signature) {
      watched.tentativeTranscriptLength = watched.lastTranscriptLength;
      watched.tentativeTranscriptEntryId = watched.lastTranscriptEntryId;
    } else {
      try {
        const entries = await callbacks.fetchTranscript(watched.surfaceId, TRANSCRIPT_ACTIVITY_WINDOW);
        watched.tentativeTranscriptLength = measureTranscript(entries);
        watched.tentativeTranscriptEntryId = entries[entries.length - 1]?.id ?? null;
        applyTranscriptStatusSnapshot(watched, transcriptStatus);
      } catch {
        watched.tentativeTranscriptLength = watched.lastTranscriptLength;
        watched.tentativeTranscriptEntryId = watched.lastTranscriptEntryId;
      }
    }

    console.log(
      `[supervisor] "${watched.name}" tentatively finished — `
      + `confirming over ${COMPLETION_CONFIRM_MS / 1000}s`,
    );
    return false;
  }

  const elapsed = now - watched.tentativeFinishedSince;
  if (elapsed < COMPLETION_CONFIRM_MS) {
    return false;
  }

  if (transcriptStatus.signature && watched.tentativeTranscriptSignature) {
    if (transcriptStatus.signature !== watched.tentativeTranscriptSignature) {
      resetTentativeCompletion(watched);
      await refreshTranscriptActivityIfNeeded(watched, transcriptStatus, now);
      console.log(`[supervisor] "${watched.name}" transcript grew during grace — still active`);
      return false;
    }
  } else {
    try {
      const entries = await callbacks.fetchTranscript(watched.surfaceId, TRANSCRIPT_ACTIVITY_WINDOW);
      const currentLength = measureTranscript(entries);
      const currentEntryId = entries[entries.length - 1]?.id ?? null;

      if (
        currentLength !== watched.tentativeTranscriptLength
        || currentEntryId !== watched.tentativeTranscriptEntryId
      ) {
        resetTentativeCompletion(watched);
        recordTranscriptActivity(watched, entries, now);
        applyTranscriptStatusSnapshot(watched, transcriptStatus);
        console.log(`[supervisor] "${watched.name}" transcript grew during grace — still active`);
        return false;
      }
    } catch {
      // Proceed with confirmation if the fetch fails.
    }
  }

  resetTentativeCompletion(watched);
  console.log(`[supervisor] "${watched.name}" completion confirmed after grace period`);
  return true;
}

function resetTentativeCompletion(watched: WatchedAgent): void {
  watched.tentativeFinishedSince = null;
  watched.tentativeTranscriptLength = 0;
  watched.tentativeTranscriptEntryId = null;
  watched.tentativeTranscriptSignature = null;
}

function resumeWatchedAgentAfterCompletionCheck(watched: WatchedAgent, now: number): void {
  watched.lastStatus = 'running';
  watched.lastRuntimeStatus = 'running';
  watched.lastActivityAt = now;
  recordWatchedAgentEvent(watched, now);
  watched.batchReported = false;
  // Release the terminal-state reservation so the next polling pass can
  // re-enter handleStatusChange and react to a fresh transition.
  watched.completionReported = false;
  watched.tentativeFinishedSince = now;
  watched.tentativeTranscriptLength = watched.lastTranscriptLength;
  watched.tentativeTranscriptEntryId = watched.lastTranscriptEntryId;
  watched.tentativeTranscriptSignature = watched.lastTranscriptSignature;
  persistWatchedAgent(watched);
}
// ── Event Handlers ──

async function handleStatusChange(
  watched: WatchedAgent,
  status: string,
  now: number,
): Promise<void> {
  if (!callbacks) return;
  // Reserve completion once; an older callback must never overwrite a successor.
  if (watched.completionReported) return;

  const duration = Math.round((now - watched.registeredAt) / 1000);

  if (status === 'finished') {
    // Claim the terminal transition BEFORE awaiting the completion handler so a
    // concurrent poll during the async window can't re-enter with a stale
    // 'failed' or 'interrupted' status.
    watched.completionReported = true;
    persistWatchedAgent(watched);
    const completionDecision = await callbacks.onAgentCompletion?.(watched.surfaceId, 'completed');
    if (watchedAgents.get(watched.surfaceId) !== watched) return;
    if (completionDecision?.superseded || completionDecision?.resume) {
      resumeWatchedAgentAfterCompletionCheck(watched, now);
      if (completionDecision.superseded) return;
      callbacks.broadcastAgentUpdate({
        surfaceId: watched.surfaceId,
        name: watched.name,
        status: 'running',
        duration,
        detail: completionDecision.detail ?? `Agent "${watched.name}" resumed after post-completion verification failed`,
      });
      return;
    }
    if (completionDecision?.block) {
      // #2141 — the runtime said `finished`, the completion callback said the
      // lane failed. Settle on the callback's verdict BEFORE persisting, or
      // the fleet summary counts a failed lane among the completed ones.
      watched.lastStatus = settledCompletionStatus(true);
      recordWatchedAgentEvent(watched, now);
      persistWatchedAgent(watched);
      callbacks.broadcastAgentUpdate({
        surfaceId: watched.surfaceId,
        name: watched.name,
        status: 'failed',
        duration,
        detail: completionDecision.detail ?? `Agent "${watched.name}" failed post-completion verification and needs operator input`,
      });
      setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS);
      return;
    }

    recordWatchedAgentEvent(watched, now);
    persistWatchedAgent(watched);
    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'completed',
      duration,
      detail: completionDecision?.detail ?? `Agent "${watched.name}" completed (${formatDuration(duration)})`,
    });

    setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS);
    return;
  }

  if (status === 'failed') {
    if (watched.launchContext?.checkoutMode !== 'shared' && watched.retryCount < MAX_RETRIES) {
      await retryWatchedAgent(watched, callbacks, {
        persist: persistWatchedAgent,
        scheduleCleanup: () => setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS),
        replace(newSurfaceId) {
          watchedAgents.delete(watched.surfaceId);
          transcriptSourceCache.delete(watched.surfaceId);
          removePersistedAgent(watched.surfaceId);

          registerWatchedAgent(newSurfaceId, watched.repoPath, watched.name, watched.prompt, watched.launchContext);
          const newWatched = watchedAgents.get(newSurfaceId);
          if (newWatched) {
            newWatched.retryCount = watched.retryCount;
            newWatched.steerCount = watched.steerCount;
            persistWatchedAgent(newWatched);
          }
        },
      });
    } else {
      watched.completionReported = true;
      recordWatchedAgentEvent(watched, now);
      persistWatchedAgent(watched);
      callbacks.broadcastAgentUpdate({
        surfaceId: watched.surfaceId,
        name: watched.name,
        status: 'failed',
        duration,
        detail: watched.launchContext?.checkoutMode === 'shared' ? `Shared worker "${watched.name}" failed; the orchestrator must decide whether to relaunch it.` : `Agent "${watched.name}" failed after ${watched.retryCount + 1} attempts — escalating`,
      });
      callbacks.onAgentCompletion?.(watched.surfaceId, 'failed');

      let transcriptSummary = '';
      try {
        const entries = await callbacks.fetchTranscript(watched.surfaceId, 10);
        transcriptSummary = entries
          .map((entry) => `[${entry.timestampLabel ?? '?'}] ${entry.role}: ${truncate(entry.text, 200)}`)
          .join('\n');
      } catch {
        // Best effort.
      }

      if (watched.launchContext?.checkoutMode !== 'shared') callbacks.queueOrchestratorEscalation(
        watched.repoPath,
        [
          `[SUPERVISOR] Agent "${watched.name}" (${watched.surfaceId}) — FAILED after ${watched.retryCount + 1} attempts (${formatDuration(duration)})`,
          '',
          transcriptSummary ? `Last transcript:\n${transcriptSummary}` : 'No transcript available.',
          '',
          'Auto-retry exhausted. Diagnose the failure and decide: relaunch with a different approach, or report to the user.',
        ].join('\n'),
      );

      setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS);
    }
  }

  if (status === 'interrupted') {
    watched.completionReported = true;
    recordWatchedAgentEvent(watched, now);
    persistWatchedAgent(watched);
    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'interrupted',
      duration,
      detail: `Agent "${watched.name}" was interrupted`,
    });
    setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS);
  }
}
// ── Stuck Detection ──

async function checkStuck(
  watched: WatchedAgent,
  transcriptStatus: TranscriptBatchStatus,
  now: number,
  automaticRecoveryRunId?: string,
): Promise<void> {
  if (!callbacks) return;
  // Terminal state — don't escalate a stuck signal on top of a reported
  // completion. The agent is done from our perspective. Same #531 guard.
  if (watched.completionReported) return;

  if (now - watched.registeredAt < 30_000) return;

  if (await refreshTranscriptActivityIfNeeded(watched, transcriptStatus, now)) {
    return;
  }

  const staleDuration = now - watched.lastActivityAt;
  const stuckThresholdMs = watched.steerCount === 0 ? FIRST_STEER_THRESHOLD_MS : STUCK_THRESHOLD_MS;
  if (staleDuration < stuckThresholdMs) return;
  // Shared workers report to their bound parent. Generic repo-wide escalation
  // must not steer or interrupt them, especially after the parent was stopped.
  if (watched.launchContext?.checkoutMode === 'shared') return;

  if (watched.steerCount < MAX_STEERS) {
    watched.steerCount += 1;
    watched.lastActivityAt = now;
    recordWatchedAgentEvent(watched, now);
    persistWatchedAgent(watched);
    console.log(`[supervisor] Auto-steering stuck agent "${watched.name}" (steer ${watched.steerCount})`);

    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'stuck',
      detail: `Agent "${watched.name}" appears stuck — auto-steering (attempt ${watched.steerCount})`,
    });

    const steerMessage = watched.steerCount === 1
      ? 'You appear to be stuck. Summarize what you have done so far and what is blocking you. Then try a different approach.'
      : 'You are still stuck. Stop your current approach. Try the simplest possible solution to complete the task.';

    try {
      await callbacks.steerAgent(watched.surfaceId, steerMessage, automaticRecoveryRunId);
    } catch (err) {
      console.error(`[supervisor] Steer failed for "${watched.name}":`, err);
    }
  } else {
    watched.completionReported = true;
    // Prevent the 'failed' handler from auto-retrying after stuck escalation
    watched.retryCount = MAX_RETRIES;
    recordWatchedAgentEvent(watched, now);
    persistWatchedAgent(watched);
    console.log(`[supervisor] Agent "${watched.name}" stuck after ${watched.steerCount} steers — escalating`);

    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'stuck',
      detail: `Agent "${watched.name}" stuck after ${watched.steerCount} steers — escalating`,
    });

    try {
      await callbacks.interruptAgent(watched.surfaceId);
    } catch {
      // Best effort.
    }

    // #8 — Transition the lane so it doesn't stay 'running' forever.
    // Without this, the lane was never updated — the escalation message went
    // to the orchestrator chat but the dashboard still showed 'running'.
    callbacks.onAgentCompletion?.(watched.surfaceId, 'failed');

    const duration = Math.round((now - watched.registeredAt) / 1000);
    callbacks.queueOrchestratorEscalation(
      watched.repoPath,
      [
        `[SUPERVISOR] Agent "${watched.name}" (${watched.surfaceId}) — STUCK for ${formatDuration(duration)}`,
        `Auto-steered ${watched.steerCount} times without progress. Agent has been interrupted.`,
        '',
        'Decide: relaunch with a simpler/different prompt, or report to the user.',
      ].join('\n'),
    );

    setTimeout(() => unregisterWatchedAgent(watched.surfaceId, watched), COMPLETION_CLEANUP_MS);
  }
}

async function refreshTranscriptActivityIfNeeded(
  watched: WatchedAgent,
  transcriptStatus: TranscriptBatchStatus,
  now: number,
): Promise<boolean> {
  if (!callbacks) return false;

  if (
    transcriptStatus.signature
    && transcriptStatus.signature === watched.lastTranscriptSignature
  ) {
    watched.lastTranscriptMtimeMs = transcriptStatus.mtimeMs;
    return false;
  }

  try {
    const entries = await callbacks.fetchTranscript(watched.surfaceId, TRANSCRIPT_ACTIVITY_WINDOW);
    const changed = recordTranscriptActivity(watched, entries, now);
    applyTranscriptStatusSnapshot(watched, transcriptStatus);
    return changed;
  } catch {
    return false;
  }
}
// ── All-Done Check ──

function checkAllDone(): void {
  if (!callbacks) return;

  const byRepo = new Map<string, WatchedAgent[]>();
  for (const agent of watchedAgents.values()) {
    if (agent.launchContext?.checkoutMode === 'shared') continue;
    const list = byRepo.get(agent.repoPath) ?? [];
    list.push(agent);
    byRepo.set(agent.repoPath, list);
  }

  for (const [repoPath, agents] of byRepo) {
    const allDone = agents.every((agent) => agent.completionReported);
    const anyUnreported = agents.some((agent) => !agent.batchReported);
    if (!allDone || !anyUnreported || agents.length === 0) continue;

    for (const agent of agents) {
      agent.batchReported = true;
    }

    const lines = agents.map((agent) => {
      const duration = Math.round((Date.now() - agent.registeredAt) / 1000);
      const label = agent.lastStatus === 'failed' || agent.lastStatus === 'interrupted'
        ? 'FAILED'
        : 'COMPLETED';
      return `- "${agent.name}" (${agent.surfaceId}): ${label} (${formatDuration(duration)})`;
    });

    const summary = buildFleetStatusSummaries(repoPath)[0];
    const suffix = agents.every((agent) => agent.lastStatus === 'finished')
      ? 'All agents completed successfully. Summarize the results and report to the user.'
      : 'Some agents failed. Review the results and report to the user.';

    callbacks.queueOrchestratorEscalation(
      repoPath,
      [
        `[SUPERVISOR] All ${agents.length} agents finished.`,
        summary
          ? `Fleet summary: ${summary.completedAgents} completed, ${summary.failedAgents} failed, ${summary.pendingAgents} pending.`
          : '',
        ...lines,
        '',
        suffix,
      ].filter(Boolean).join('\n'),
    );
  }
}
// ── Fleet Summary ──

function buildFleetStatusSummaries(repoPath?: string): SupervisorFleetStatusSummary[] {
  const byRepo = new Map<string, WatchedAgent[]>();

  for (const agent of watchedAgents.values()) {
    if (repoPath && agent.repoPath !== repoPath) continue;
    const list = byRepo.get(agent.repoPath) ?? [];
    list.push(agent);
    byRepo.set(agent.repoPath, list);
  }

  return [...byRepo.entries()].map(([currentRepoPath, agents]) => {
    const activeAgents = agents.filter((agent) => (
      agent.lastStatus === 'running'
      || agent.lastStatus === 'waiting'
      || agent.lastStatus === 'launching'
    )).length;
    const idleAgents = agents.filter((agent) => isIdleAgent(agent)).length;
    const outcomes = agents.map(watchedAgentOutcome);
    const completedAgents = outcomes.filter((outcome) => outcome === 'completed').length;
    const failedAgents = outcomes.filter((outcome) => outcome === 'failed').length;
    const pendingAgents = outcomes.filter((outcome) => outcome === 'pending').length;
    const nextPollAt = agents.reduce<number | null>((next, agent) => {
      if (next === null) return agent.nextPollAt;
      return Math.min(next, agent.nextPollAt);
    }, null);
    const lastUpdatedAt = agents.reduce((latest, agent) => (
      Math.max(latest, agent.lastPolledAt ?? agent.registeredAt)
    ), 0);

    return {
      repoPath: currentRepoPath,
      totalAgents: agents.length,
      activeAgents,
      idleAgents,
      completedAgents,
      failedAgents,
      pendingAgents,
      allDone: agents.every((agent) => agent.completionReported),
      allSucceeded: agents.every((agent) => agent.lastStatus === 'finished'),
      nextPollAt,
      lastUpdatedAt,
    };
  });
}

function isIdleAgent(agent: WatchedAgent): boolean {
  if (agent.completionReported) return false;
  if (agent.tentativeFinishedSince) return true;
  return agent.lastRuntimeStatus === 'idle' || agent.lastRuntimeStatus === 'reviewing';
}
// ── Transcript Status Batching ──

async function readTranscriptBatchStatuses(
  agents: WatchedAgent[],
): Promise<Map<string, TranscriptBatchStatus>> {
  const resolved = await Promise.all(
    agents.map(async (agent) => [
      agent.surfaceId,
      await resolveTranscriptSourcePaths(agent.surfaceId),
    ] as const),
  );

  const statuses = await Promise.all(
    resolved.map(async ([surfaceId, paths]) => [
      surfaceId,
      await readTranscriptBatchStatus(paths),
    ] as const),
  );

  return new Map(statuses);
}

async function resolveTranscriptSourcePaths(surfaceId: string): Promise<string[]> {
  const cached = transcriptSourceCache.get(surfaceId);
  const now = Date.now();
  if (cached) {
    const ttl = cached.paths.length > 0
      ? TRANSCRIPT_SOURCE_CACHE_TTL_MS
      : MISSING_TRANSCRIPT_SOURCE_CACHE_TTL_MS;
    if (now - cached.resolvedAt < ttl) {
      return cached.paths;
    }
  }

  const paths = await resolveTranscriptSourcePathsFresh(surfaceId);
  transcriptSourceCache.set(surfaceId, { paths, resolvedAt: now });
  return paths;
}

async function resolveTranscriptSourcePathsFresh(surfaceId: string): Promise<string[]> {
  if (surfaceId.startsWith('claude-code:')) {
    const transcriptPath = await findClaudeTranscriptPath(
      surfaceId.replace(/^claude-code:/, ''),
    );
    return transcriptPath ? [transcriptPath] : [];
  }

  // #1502 — owned worker sessions write their JSONL run logs to stdoutPath;
  // returning [] here made every codex/opencode-owned worker invisible to the
  // supervisor's transcript batch status, which is half of why completed
  // headless work read as a silent exit.
  if (surfaceId.startsWith('codex-owned:')) {
    const { getOwnedCodexTelemetrySources } = await import('@/lib/codex/owned');
    const sources = await getOwnedCodexTelemetrySources(surfaceId).catch(() => null);
    return sources?.stdoutPaths ?? [];
  }
  if (surfaceId.startsWith('claude-code-owned:')) {
    const { getOwnedClaudeCodeTelemetrySources } = await import('@/lib/claude-code/owned');
    const sources = await getOwnedClaudeCodeTelemetrySources(surfaceId).catch(() => null);
    return sources?.stdoutPaths ?? [];
  }

  return [];
}

async function findClaudeTranscriptPath(sessionId: string): Promise<string | null> {
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const projectDirName of projectDirs) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, projectDirName, `${sessionId}.jsonl`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function readTranscriptBatchStatus(paths: string[]): Promise<TranscriptBatchStatus> {
  if (paths.length === 0) {
    return emptyTranscriptBatchStatus();
  }

  const fileStats = await Promise.all(
    paths.map(async (filePath) => ({
      filePath,
      fileStat: await stat(filePath).catch(() => null),
    })),
  );

  const existing: Array<{ filePath: string; fileStat: NonNullable<(typeof fileStats)[number]['fileStat']> }> = [];
  for (const entry of fileStats) {
    if (entry.fileStat) {
      existing.push({
        filePath: entry.filePath,
        fileStat: entry.fileStat,
      });
    }
  }

  if (existing.length === 0) {
    return {
      signature: null,
      mtimeMs: null,
      totalSize: 0,
      pathCount: paths.length,
      exists: false,
    };
  }

  const newest = existing.reduce((latest, entry) => {
    if (!latest) return entry;
    if (entry.fileStat.mtimeMs > latest.fileStat.mtimeMs) return entry;
    if (entry.fileStat.mtimeMs === latest.fileStat.mtimeMs && entry.fileStat.size > latest.fileStat.size) {
      return entry;
    }
    return latest;
  }, existing[0]);
  const totalSize = existing.reduce((sum, entry) => sum + entry.fileStat.size, 0);
  const roundedMtimeMs = Math.trunc(newest.fileStat.mtimeMs);

  return {
    signature: `${existing.length}:${roundedMtimeMs}:${totalSize}:${newest.filePath}`,
    mtimeMs: newest.fileStat.mtimeMs,
    totalSize,
    pathCount: existing.length,
    exists: true,
  };
}

function emptyTranscriptBatchStatus(): TranscriptBatchStatus {
  return {
    signature: null,
    mtimeMs: null,
    totalSize: 0,
    pathCount: 0,
    exists: false,
  };
}

function applyTranscriptStatusSnapshot(
  watched: WatchedAgent,
  transcriptStatus: TranscriptBatchStatus,
): void {
  watched.lastTranscriptSignature = transcriptStatus.signature;
  watched.lastTranscriptMtimeMs = transcriptStatus.mtimeMs;
}

// ── Helpers ──

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function measureTranscript(entries: TranscriptEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.text?.length ?? 0) + (entry.id?.length ?? 0),
    0,
  );
}

function findLastProgressEntry(entries: TranscriptEntry[]): TranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const text = entry.text?.trim();
    if (!text) continue;
    if (entry.role === 'assistant' || entry.toolName) {
      return entry;
    }
  }
  return null;
}

function normalizeProgressMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function recordTranscriptActivity(
  watched: WatchedAgent,
  entries: TranscriptEntry[],
  now: number,
): boolean {
  const nextLength = measureTranscript(entries);
  const nextEntryId = entries[entries.length - 1]?.id ?? null;
  const changed = (
    nextLength !== watched.lastTranscriptLength
    || nextEntryId !== watched.lastTranscriptEntryId
  );

  if (!changed) {
    return false;
  }

  watched.lastTranscriptLength = nextLength;
  watched.lastTranscriptEntryId = nextEntryId;
  watched.lastActivityAt = now;
  recordWatchedAgentEvent(watched, now);
  persistWatchedAgent(watched);

  const progressEntry = findLastProgressEntry(entries);
  const progressMessage = progressEntry ? normalizeProgressMessage(progressEntry.text) : '';
  if (progressEntry?.id && progressMessage && progressEntry.id !== watched.lastProgressEntryId) {
    watched.lastProgressEntryId = progressEntry.id;
    callbacks?.onAgentProgress?.(watched.surfaceId, progressMessage);
  }

  return true;
}
