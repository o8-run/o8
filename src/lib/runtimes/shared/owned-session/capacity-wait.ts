import { CAPACITY_WAIT_LABEL, capacityWaitMessage } from '@/lib/lane/capacity-wait-label';
import { correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { recordLaneEvent } from '@/lib/lane/events';
import { getLane, updateLane } from '@/lib/lane/registry';
import { packetAutomaticRecoveryHoldReason } from '@/lib/lane/packet-stop-hold';
import type { Lane } from '@/lib/lane/types';
import type { RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { withOwnedActionGuard } from './action-admission';
import { currentRecoveryRun, recoveryInterrupted } from './automatic-recovery';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

const MAX_CAPACITY_RESUMES = 3;
const OBSERVATION_TIMEOUT_MS = 8_000;

function nativeSession(adapter: OwnedRuntimeAdapter, session: OwnedSessionRecord): boolean {
  return ['codex', 'claude-code'].includes(adapter.runtimeId)
    && session.executionPolicy === undefined && !session.controlledTask
    && !session.detachedAt && !session.orphanedAt && !recoveryInterrupted(session)
    && (!session.runtimeConfig?.modelSource || session.runtimeConfig.modelSource === 'native')
    && !session.runtimeConfig?.executionCarrier;
}

/** Only fresh, exact observations for the session's pinned account can schedule work. */
async function observe(adapter: OwnedRuntimeAdapter, session: OwnedSessionRecord): Promise<RuntimeCapacitySnapshot | null> {
  if (!adapter.observeCapacity) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const capacity = await Promise.race([adapter.observeCapacity(session), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), OBSERVATION_TIMEOUT_MS); timer.unref?.();
    })]);
    const age = Date.now() - Date.parse(capacity?.observedAt ?? '');
    return capacity?.runtime === adapter.runtimeId && capacity.status === 'available'
      && capacity.confidence === 'exact' && age >= -5_000 && age <= 30_000
      && capacity.identityId === (session.identity?.id ?? null) ? capacity : null;
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

function applicableCapacity(capacity: RuntimeCapacitySnapshot, session: OwnedSessionRecord): RuntimeCapacitySnapshot {
  if (capacity.runtime !== 'claude-code') return capacity;
  const family = session.model?.toLowerCase().match(/opus|sonnet|haiku/)?.[0];
  return { ...capacity, buckets: capacity.buckets.filter(bucket => {
    const bucketFamily = bucket.id.toLowerCase().match(/opus|sonnet|haiku/)?.[0];
    return !family || !bucketFamily || bucketFamily === family;
  }) };
}

function exhaustedReset(capacity: RuntimeCapacitySnapshot): string | null {
  const exhausted = capacity.buckets.filter(bucket => bucket.usedRatio !== null && bucket.usedRatio >= 1);
  if (!exhausted.length) return null;
  const resets = exhausted.map(bucket => Date.parse(bucket.resetsAt ?? ''));
  return resets.every(reset => Number.isFinite(reset) && reset > Date.now())
    ? new Date(Math.max(...resets)).toISOString() : null;
}

function ownsLane(session: OwnedSessionRecord, lane: Lane | null): lane is Lane {
  return !!lane && lane.ownership === 'managed' && lane.sessionKey === session.surfaceId
    && lane.packetId === (session.packetId ?? null) && (lane.worktreePath ?? lane.repoPath) === session.cwd;
}

/** Callers hold the owned surface lock, including across observation and spawn. */
export function createCapacityRecovery(options: {
  adapter: OwnedRuntimeAdapter;
  io: OwnedSessionIo;
  spawnOwnedRun: OwnedRunController['spawnOwnedRun'];
}) {
  const { adapter, io } = options;
  async function park(surfaceId: string, expectedStopVersion?: number): Promise<string | null> {
    const stopVersion = expectedStopVersion ?? correctionStopVersion(`worker:${surfaceId}`);
    const session = await io.findSession(surfaceId);
    const run = session && currentRecoveryRun(session);
    if (!session || !nativeSession(adapter, session) || session.activeRun || !session.threadId
      || !run || run.outcome !== 'failed' || (session.capacityResumeCount ?? 0) >= MAX_CAPACITY_RESUMES) return null;
    if (session.capacityWait?.runId === run.id) return session.capacityWait.resetsAt;
    const lane = session.laneId ? getLane(session.laneId) : null;
    if (!ownsLane(session, lane) || lane.runtime !== adapter.runtimeId || lane.status !== 'running') return null;
    if (correctionStopVersion(`worker:${surfaceId}`) !== stopVersion) return null;
    const observed = await observe(adapter, session);
    const capacity = observed && applicableCapacity(observed, session);
    const resetsAt = capacity && exhaustedReset(capacity);
    const current = getLane(lane.id);
    if (!resetsAt || !ownsLane(session, current) || current.status !== lane.status
      || correctionStopVersion(`worker:${surfaceId}`) !== stopVersion
      || (session.packetId && packetAutomaticRecoveryHoldReason(session.packetId))) return null;
    session.capacityWait = { runId: run.id, resetsAt, stopVersion,
      laneCheckpoint: { updatedAt: current.updatedAt, status: current.status, lastEventLabel: current.lastEventLabel } };
    session.latestSummary = capacityWaitMessage(resetsAt);
    await io.saveSession(session);
    updateLane(lane.id, { status: 'paused', lastEventLabel: `${CAPACITY_WAIT_LABEL}${resetsAt}`,
      outcomeNote: session.latestSummary, lastEventAt: new Date().toISOString() }, 'system');
    recordLaneEvent(lane.id, 'worker_capacity_wait', 'system', { status: 'scheduled', surfaceId, runId: run.id, resetsAt });
    return resetsAt;
  }

  async function refresh(session: OwnedSessionRecord): Promise<void> {
    const lane = session.laneId ? getLane(session.laneId) : null;
    if (session.capacityResumeClaim) {
      // The schedule was consumed before spawn. Never replay an uncertain start.
      // Complete the lane checkpoint only if the owned run actually advanced.
      const claim = session.capacityResumeClaim;
      const run = currentRecoveryRun(session);
      if (ownsLane(session, lane) && lane.status === 'paused'
        && lane.lastEventLabel === `${CAPACITY_WAIT_LABEL}${claim.resetsAt}`) {
        const resumed = run && run.id !== claim.runId && run.mode === 'resume'
          && run.spawnState === 'started' && nativeSession(adapter, session) && run.outcome !== 'failed'
          && correctionStopVersion(`worker:${session.surfaceId}`) === claim.stopVersion
          && !(session.packetId && packetAutomaticRecoveryHoldReason(session.packetId));
        updateLane(lane.id, { status: resumed ? 'running' : 'awaiting_input',
          lastEventLabel: resumed ? 'limit_reset_resumed' : 'limit_reset_resume_held',
          outcomeNote: resumed ? null : 'Capacity resume was interrupted before its start could be confirmed. Inspect the worker before resuming.' }, 'system');
      }
      delete session.capacityResumeClaim;
      await io.saveSession(session);
    }
    const wait = session.capacityWait;
    if (!wait) return;
    const checkpoint = wait.laneCheckpoint;
    if (nativeSession(adapter, session) && ownsLane(session, lane) && checkpoint
      && lane.updatedAt === checkpoint.updatedAt && lane.status === checkpoint.status
      && lane.lastEventLabel === checkpoint.lastEventLabel && currentRecoveryRun(session)?.id === wait.runId
      && correctionStopVersion(`worker:${session.surfaceId}`) === wait.stopVersion
      && !(session.packetId && packetAutomaticRecoveryHoldReason(session.packetId))) {
      // Recover a crash between the durable wait write and its lane checkpoint.
      updateLane(lane.id, { status: 'paused', lastEventLabel: `${CAPACITY_WAIT_LABEL}${wait.resetsAt}`,
        outcomeNote: capacityWaitMessage(wait.resetsAt) }, 'system');
    }
    const check = (currentSession: OwnedSessionRecord | null, preparedRunId?: string) => {
      const current = session.laneId ? getLane(session.laneId) : null;
      const run = currentSession && currentRecoveryRun(currentSession);
      if (!nativeSession(adapter, currentSession ?? session) || !ownsLane(session, current)
        || current.runtime !== adapter.runtimeId || current.status !== 'paused'
        || current.lastEventLabel !== `${CAPACITY_WAIT_LABEL}${wait.resetsAt}`
        || correctionStopVersion(`worker:${session.surfaceId}`) !== wait.stopVersion
        || (currentSession && run?.id !== (preparedRunId ?? wait.runId))
        || (!preparedRunId && currentSession && (currentSession.activeRun || run?.outcome !== 'failed'))
        || (session.packetId && packetAutomaticRecoveryHoldReason(session.packetId))) {
        throw new Error('Capacity resume cancelled because the worker or lane changed.');
      }
    };
    const cancel = async (status: 'cancelled' | 'failed') => {
      delete session.capacityWait;
      await io.saveSession(session);
      if (lane) recordLaneEvent(lane.id, 'worker_capacity_wait', 'system', { status, surfaceId: session.surfaceId, runId: wait.runId });
    };
    try { check(session); } catch { await cancel('cancelled'); return; }
    if (Date.now() < Math.max(Date.parse(wait.resetsAt), wait.nextProbeAt ?? 0)) return;
    wait.nextProbeAt = Date.now() + 30_000;
    await io.saveSession(session);
    const observed = await observe(adapter, session);
    const capacity = observed && applicableCapacity(observed, session);
    try {
      check(await io.findSession(session.surfaceId));
      // A reset prediction is not proof of available capacity. Failed observations
      // remain parked, with at most one probe per existing 15-second fleet tick.
      if (!capacity || !capacity.buckets.length || capacity.buckets.some(bucket => bucket.usedRatio === null)) return;
      const nextReset = exhaustedReset(capacity);
      if (nextReset) {
        const checkpointLane = getLane(lane!.id)!;
        session.capacityWait = { ...wait, resetsAt: nextReset, laneCheckpoint: {
          updatedAt: checkpointLane.updatedAt, status: checkpointLane.status, lastEventLabel: checkpointLane.lastEventLabel,
        } };
        session.latestSummary = capacityWaitMessage(nextReset);
        await io.saveSession(session);
        updateLane(lane!.id, { lastEventLabel: `${CAPACITY_WAIT_LABEL}${nextReset}`, outcomeNote: session.latestSummary }, 'system');
        return;
      }
      if (capacity.buckets.some(bucket => bucket.usedRatio! >= 1)) return;
      // Consume the durable schedule before spawn. A crash cannot replay it.
      delete session.capacityWait;
      session.capacityResumeClaim = { runId: wait.runId, resetsAt: wait.resetsAt, stopVersion: wait.stopVersion };
      session.capacityResumeCount = (session.capacityResumeCount ?? 0) + 1;
      await io.saveSession(session);
      const run = await withOwnedActionGuard(check, () => options.spawnOwnedRun(session,
        'Continue the previous task from this saved thread after its usage window reset. Inspect existing work before changing it.', 'resume'));
      if (run.outcome === 'failed') throw new Error('Capacity resume did not start.');
      updateLane(lane!.id, { status: 'running', lastEventLabel: 'limit_reset_resumed', outcomeNote: null }, 'system');
      delete session.capacityResumeClaim;
      await io.saveSession(session);
      recordLaneEvent(lane!.id, 'worker_capacity_wait', 'system', { status: 'resumed', surfaceId: session.surfaceId, runId: run.id, previousRunId: wait.runId });
    } catch {
      delete session.capacityResumeClaim;
      await cancel('failed');
      const current = lane && getLane(lane.id);
      if (ownsLane(session, current) && current.lastEventLabel === `${CAPACITY_WAIT_LABEL}${wait.resetsAt}`) {
        updateLane(current.id, { status: 'awaiting_input', lastEventLabel: 'limit_reset_resume_failed',
          outcomeNote: 'Automatic capacity resume could not start. Inspect the worker before resuming.' }, 'system');
      }
    }
  }
  return { park, refresh };
}
