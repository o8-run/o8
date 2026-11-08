import 'server-only';

import { randomUUID } from 'node:crypto';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';
import { findLaneByPacket, getLane, setLaneStatus } from '@/lib/lane/registry';
import { isWorkerTerminal } from '@/lib/lane/terminal-states';
import type { Lane } from '@/lib/lane/types';
import { liveWorkerSessionLanes } from '@/lib/lane/worker-session-state';
import { readOrchestratorControlPlaneState, withControlPlaneLock, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import {
  listActiveMissionRegistryEntries,
  readMissionRegistryEntry,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  holdPacketLifecycleMutation,
  mutatePacketLifecycleGuard,
} from '@/lib/orchestrator/packet-lifecycle-guard';
import {
  withMissionHandoffBarrier,
  withPacketLifecycleMutationLock,
} from '@/lib/orchestrator/lifecycle-mutation-lock';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { createMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';
import { terminatePacketManagedRuns } from '@/lib/runtimes/managed-runs/packet-lifecycle';
import { cancelPreRunPacketLaunches, preRunCancellationMatches } from '@/lib/lane/pre-run-cancellation';

const missionStopChains = new Map<string, Promise<unknown>>();
const missionStopDepth = new Map<string, number>();

export type StopMissionPacketStatus = 'stopped' | 'already-terminal' | 'stop-failed';

export interface StopMissionPacketResult {
  packetId: string;
  stoppedFrom?: string;
  status: StopMissionPacketStatus;
  laneId: string | null;
  note: string;
}

export interface StopMissionResult {
  missionId: string;
  event: {
    type: 'mission_stop';
    recordedAt: string;
  };
  packets: StopMissionPacketResult[];
}

export interface GlobalDispatchHaltResult {
  halted: boolean;
  stoppedMissions: StopMissionResult[];
}

function isPacketTerminal(packet: OrchestratorPacket): boolean {
  return Boolean(packet.archivedAt)
    || packet.releaseState === 'released'
    || packet.status === 'archived';
}

function liveArchivedLane(packet: OrchestratorPacket) {
  const lane = (packet.lane?.laneId ? getLane(packet.lane.laneId) : null) ?? findLaneByPacket(packet.id);
  return lane && !isWorkerTerminal(lane.status) && liveWorkerSessionLanes([lane]).length > 0 ? lane : null;
}

// The lane stop command refuses to hold an archived packet, and none is needed:
// archiving already refuses further runs. Kill the worker and its packet-managed
// runs, then park the lane the way an operator stop does.
async function stopArchivedWorker(packet: OrchestratorPacket, lane: Lane): Promise<StopMissionPacketResult> {
  const [killed] = await killLaneSessionsConfirmed(liveWorkerSessionLanes([lane]));
  if (!killed?.confirmed && !killed?.alreadyDead) {
    return { packetId: packet.id, status: 'stop-failed', laneId: lane.id,
      note: `Packet is archived, but its live worker did not exit: ${killed?.note ?? 'no confirmed process result.'}` };
  }
  const managedRuns = await terminatePacketManagedRuns(packet.id);
  if (managedRuns.failures.length > 0) {
    return { packetId: packet.id, status: 'stop-failed', laneId: lane.id,
      note: `Packet is archived and its worker stopped, but ${managedRuns.failures.length} packet-managed run${managedRuns.failures.length === 1 ? '' : 's'} could not be confirmed dead.` };
  }
  setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
  return { packetId: packet.id, status: 'already-terminal', laneId: lane.id,
    note: 'Packet is archived; stopped its live worker.' };
}

function markStoppedPacket(packet: OrchestratorPacket, stoppedAt: string): OrchestratorPacket {
  return {
    ...packet,
    operatorStopped: true,
    queueState: 'held',
    status: 'blocked',
    blockedReason: 'operator_stopped',
    lastEventAt: stoppedAt,
    lastEventLabel: 'operator_stopped',
  };
}

async function settleTerminalPacketManagedRuns(
  packet: OrchestratorPacket,
  laneId: string | null,
  terminalNote: string,
): Promise<StopMissionPacketResult> {
  const managedRuns = await terminatePacketManagedRuns(packet.id);
  if (managedRuns.failures.length > 0) {
    return {
      packetId: packet.id,
      status: 'stop-failed',
      laneId,
      note: `${terminalNote} ${managedRuns.failures.length} packet-managed run${managedRuns.failures.length === 1 ? '' : 's'} could not be confirmed dead.`,
    };
  }
  return {
    packetId: packet.id,
    status: 'already-terminal',
    laneId,
    note: managedRuns.confirmed > 0
      ? `${terminalNote} Stopped ${managedRuns.confirmed} packet-managed run${managedRuns.confirmed === 1 ? '' : 's'}.`
      : terminalNote,
  };
}

async function stopPacketViaLaneCommand(packet: OrchestratorPacket, cancelledEvents: Record<string, string> = {}): Promise<StopMissionPacketResult> {
  const preRunCancelled = Object.keys(cancelledEvents).length > 0;
  if (isPacketTerminal(packet)) {
    // Archiving refuses further runs but does not end the current turn, so an
    // archived packet can still own a live worker. Stop it; the packet stays archived.
    const live = packet.releaseState !== 'released' ? liveArchivedLane(packet) : null;
    if (live) return withPacketLifecycleMutationLock(packet.id, () => stopArchivedWorker(packet, live));
    return settleTerminalPacketManagedRuns(
      packet,
      packet.lane?.laneId ?? null,
      `Packet is already terminal (${packet.status}).`,
    );
  }

  const persistedBinding = packet.lane?.laneId ? getLane(packet.lane.laneId) : null;
  const lane = persistedBinding ?? findLaneByPacket(packet.id);
  const laneId = packet.lane?.laneId ?? lane?.id ?? null;
  const laneStatus = lane?.status ?? null;
  const sessionKey = packet.lane?.sessionKey?.trim() || lane?.sessionKey?.trim() || '';
  if (laneStatus && isWorkerTerminal(laneStatus) && !sessionKey) {
    return settleTerminalPacketManagedRuns(
      packet,
      laneId,
      `Lane is already terminal (${laneStatus}).`,
    );
  }
  if (packet.lane && !persistedBinding && !laneId) {
    return stopPacketWithoutLaneRow(packet, null);
  }
  if (packet.lane && !persistedBinding) {
    return stopPacketWithoutLaneRow(packet, laneId);
  }

  return withPacketLifecycleMutationLock(packet.id, async ({ contended }) => {
    if (contended && !preRunCancellationMatches(packet.id, cancelledEvents)) {
      return {
        packetId: packet.id,
        status: 'stop-failed',
        laneId,
        note: 'Packet changed while another lifecycle action was in progress; mission stop was not applied.',
      };
    }
    if (!laneId || (preRunCancelled && lane?.status === 'paused' && !sessionKey)) {
      if ((packet.status === 'failed' || packet.status === 'awaiting_review') && !sessionKey) {
        return settleTerminalPacketManagedRuns(
          packet,
          null,
          `Packet is already terminal (${packet.status}).`,
        );
      }
      if (preRunCancelled || (!sessionKey && !packet.lane)) {
        const guard = await holdPacketLifecycleMutation({ packetId: packet.id, kind: 'stop' });
        if (!guard) {
          return {
            packetId: packet.id,
            status: 'stop-failed',
            laneId,
            note: 'Queued packet could not be held before launch.',
          };
        }
        const held = await mutatePacketLifecycleGuard(guard, (target) => {
          Object.assign(target, markStoppedPacket(target, new Date().toISOString()));
          return true;
        });
        if (!held.matched || held.result !== true) {
          return {
            packetId: packet.id,
            status: 'stop-failed',
            laneId,
            note: 'Queued packet changed before its stop hold could be finalized.',
          };
        }
        return {
          packetId: packet.id,
          status: 'stopped',
          laneId,
          note: preRunCancelled ? 'Packet held before its worker launched.' : 'Queued packet held before any lane launched.',
        };
      }
      return {
        packetId: packet.id,
        status: 'stop-failed',
        laneId: null,
        note: 'No lane is bound to this packet.',
      };
    }

    const result = await dispatchLaneCommand({ verb: 'stop', laneId, actor: 'user' });
    return {
      packetId: packet.id,
      status: result.ok ? 'stopped' : 'stop-failed',
      laneId,
      note: result.note,
    };
  });
}

async function stopPacketWithoutLaneRow(
  packet: OrchestratorPacket,
  laneId: string | null,
): Promise<StopMissionPacketResult> {
  const { stopPacket } = await import('@/lib/orchestrator/stop-packet');
  const result = await stopPacket(packet.id);
  return {
    packetId: packet.id,
    status: result.ok && result.killConfirmed ? 'stopped' : 'stop-failed',
    laneId,
    note: result.note,
  };
}

function applyStopResults(
  state: OrchestratorMissionState,
  results: StopMissionPacketResult[],
  stoppedAt: string,
  fallbackPackets: OrchestratorPacket[] = [],
  releaseSource?: string,
): OrchestratorMissionState {
  const stoppedIds = new Set(results.filter((result) => result.status === 'stopped').map((result) => result.packetId));
  const failedIds = new Set(results.filter((result) => result.status === 'stop-failed').map((result) => result.packetId));
  const fallbackById = new Map(fallbackPackets.map((packet) => [packet.id, packet] as const));
  return normalizeOrchestratorMissionState({
    ...state,
    packets: state.packets.map((packet) => {
      if (stoppedIds.has(packet.id)) return markStoppedPacket(packet, stoppedAt);
      if (failedIds.has(packet.id) && !packet.lane && fallbackById.get(packet.id)?.lane) {
        return { ...packet, lane: fallbackById.get(packet.id)!.lane };
      }
      return packet;
    }),
    lifecycleHold: releaseSource && state.lifecycleHold?.source === releaseSource
      ? null
      : state.lifecycleHold,
    updatedAt: stoppedAt,
  });
}

async function stopMissionSnapshot(state: OrchestratorMissionState, cancelled = new Map<string, Record<string, string>>()): Promise<{
  stoppedAt: string;
  result: StopMissionResult;
}> {
  const missionId = state.missionId?.trim();
  if (!missionId) throw new Error('missionId is required.');
  const stoppedAt = new Date().toISOString();
  const packets: StopMissionPacketResult[] = [];
  for (const packet of state.packets) {
    packets.push({ ...await stopPacketViaLaneCommand(packet, cancelled.get(packet.id)), stoppedFrom: packet.status });
  }
  return {
    stoppedAt,
    result: {
      missionId,
      event: {
        type: 'mission_stop',
        recordedAt: stoppedAt,
      },
      packets,
    },
  };
}

async function holdMissionStopAdmission(
  missionId: string,
  hold: NonNullable<OrchestratorMissionState['lifecycleHold']>,
): Promise<OrchestratorMissionState> {
  return withMissionHandoffBarrier(async () => {
    if ((readOrchestratorControlPlaneState().missionId ?? '').trim() === missionId) {
      return withControlPlaneLock(() => {
        const fresh = readOrchestratorControlPlaneState();
        if ((fresh.missionId ?? '').trim() !== missionId) {
          throw new Error(`Mission ${missionId} changed before its stop hold could be installed.`);
        }
        fresh.lifecycleHold = hold;
        return writeOrchestratorControlPlaneState(fresh);
      });
    }
    if (!readMissionRegistryEntry(missionId, { includeArchived: true })) {
      throw new Error(`Mission ${missionId} not found.`);
    }
    const { state } = await withMissionRegistryState(missionId, (fresh) => {
      fresh.lifecycleHold = hold;
      return { state: fresh, result: undefined };
    });
    return state;
  });
}

async function finalizeMissionStop(
  missionId: string,
  held: OrchestratorMissionState,
  stopped: Awaited<ReturnType<typeof stopMissionSnapshot>>,
  admissionSource: string,
): Promise<StopMissionResult> {
  return withMissionHandoffBarrier(async () => {
    const apply = (fresh: OrchestratorMissionState) => applyStopResults(
      fresh,
      stopped.result.packets,
      stopped.stoppedAt,
      held.packets,
      admissionSource,
    );
    if ((readOrchestratorControlPlaneState().missionId ?? '').trim() === missionId) {
      return withControlPlaneLock(async () => {
        const fresh = readOrchestratorControlPlaneState();
        if ((fresh.missionId ?? '').trim() !== missionId) {
          throw new Error(`Mission ${missionId} changed before its stop result could be persisted.`);
        }
        writeOrchestratorControlPlaneState(apply(fresh));
        // A headless tick can mirror a partial stop between packet interrupts.
        // Finalize the registry's own fresh state before acknowledging the stop;
        // no later tick is guaranteed once every packet is held.
        if (readMissionRegistryEntry(missionId, { includeArchived: true })) {
          await withMissionRegistryState(missionId, (registry) => ({
            state: apply(registry),
            result: undefined,
          }));
        }
        return stopped.result;
      });
    }
    const { result } = await withMissionRegistryState(missionId, (fresh) => ({
      state: apply(fresh),
      result: stopped.result,
    }));
    return result;
  });
}

async function releaseMissionStopAdmission(missionId: string, admissionSource: string): Promise<void> {
  await withMissionHandoffBarrier(async () => {
    if ((readOrchestratorControlPlaneState().missionId ?? '').trim() === missionId) {
      await withControlPlaneLock(() => {
        const fresh = readOrchestratorControlPlaneState();
        if (fresh.lifecycleHold?.source !== admissionSource) return;
        fresh.lifecycleHold = null;
        writeOrchestratorControlPlaneState(fresh);
      });
      return;
    }
    if (!readMissionRegistryEntry(missionId, { includeArchived: true })) return;
    await withMissionRegistryState(missionId, (fresh) => {
      if (fresh.lifecycleHold?.source === admissionSource) fresh.lifecycleHold = null;
      return { state: fresh, result: undefined };
    });
  });
}

async function stopMissionUnlocked(normalizedId: string): Promise<StopMissionResult> {
  const before = (readOrchestratorControlPlaneState().missionId ?? '').trim() === normalizedId
    ? readOrchestratorControlPlaneState()
    : readMissionRegistryEntry(normalizedId, { includeArchived: true })?.mission;
  const { stoppedFrom: cancelled, packetEvents } = cancelPreRunPacketLaunches(before?.packets.map(packet => packet.id) ?? [], 'stop');
  const admissionSource = `mission_stop:${randomUUID()}`;
  const held = await holdMissionStopAdmission(
    normalizedId,
    createMissionLifecycleHold(admissionSource),
  );
  try {
    const stopped = await stopMissionSnapshot(held, packetEvents);
    for (const packet of stopped.result.packets) {
      packet.stoppedFrom = cancelled.get(packet.packetId)
        ?? before?.packets.find(candidate => candidate.id === packet.packetId)?.status
        ?? packet.stoppedFrom;
    }
    return await finalizeMissionStop(normalizedId, held, stopped, admissionSource);
  } catch (error) {
    await releaseMissionStopAdmission(normalizedId, admissionSource);
    throw error;
  }
}

export async function stopMission(missionId: string): Promise<StopMissionResult> {
  const normalizedId = missionId.trim();
  if (!normalizedId) throw new Error('missionId is required.');
  const contended = (missionStopDepth.get(normalizedId) ?? 0) > 0;
  missionStopDepth.set(normalizedId, (missionStopDepth.get(normalizedId) ?? 0) + 1);
  try {
    return await chainOnKey(missionStopChains, normalizedId, async () => {
      if (!contended) return stopMissionUnlocked(normalizedId);
      const current = (readOrchestratorControlPlaneState().missionId ?? '').trim() === normalizedId
        ? readOrchestratorControlPlaneState()
        : readMissionRegistryEntry(normalizedId, { includeArchived: true })?.mission;
      if (!current) throw new Error(`Mission ${normalizedId} not found.`);
      return {
        missionId: normalizedId,
        event: { type: 'mission_stop', recordedAt: new Date().toISOString() },
        packets: current.packets.map((packet) => ({
          packetId: packet.id,
          stoppedFrom: packet.status,
          status: 'stop-failed',
          laneId: packet.lane?.laneId ?? null,
          note: 'Mission changed while another lifecycle action was in progress; this stop was not applied.',
        })),
      };
    });
  } finally {
    const remaining = (missionStopDepth.get(normalizedId) ?? 1) - 1;
    if (remaining > 0) missionStopDepth.set(normalizedId, remaining);
    else missionStopDepth.delete(normalizedId);
  }
}

export async function stopAllActiveMissions(): Promise<GlobalDispatchHaltResult> {
  const stoppedMissions: StopMissionResult[] = [];
  const current = readOrchestratorControlPlaneState();
  if ((current.missionId ?? '').trim()) {
    stoppedMissions.push(await stopMission(current.missionId ?? ''));
  }
  for (const entry of listActiveMissionRegistryEntries(current.missionId)) {
    stoppedMissions.push(await stopMission(entry.id));
  }
  return {
    halted: true,
    stoppedMissions,
  };
}
