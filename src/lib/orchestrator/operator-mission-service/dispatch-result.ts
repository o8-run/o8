import { missionDispatchQueue } from './dispatch-queue';
import { getDispatchBlocker } from '@/lib/orchestrator/dispatch';
import { packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export type DispatchMissionSkipReason =
  | 'archived'
  | 'released'
  | 'already-running'
  | 'awaiting-review'
  | 'blocked-by'
  | 'operator-stopped'
  | 'held'
  | 'failed'
  | 'launch-limit'
  | 'missing-workspace'
  | 'invalid-workspace'
  | 'already-dispatched'
  | 'not-launchable'
  | 'scheduler-deferred';

export interface DispatchMissionSkippedPacket {
  packetId: string;
  referenceLabel: string;
  reason: DispatchMissionSkipReason;
  detail: string;
  blockedByPacketId?: string;
  suggestedAction?: 'retry_packet' | 'reset_packet' | 'submit_review' | 'wait';
}

function hasLaneBinding(packet: OrchestratorPacket): boolean {
  return Boolean(
    packet.lane?.laneId
    || packet.lane?.sessionKey
    || (packet.lane?.tileId && packet.lane?.tabId),
  );
}

/**
 * An explicit dispatch is the second half of reset_packet's reset+held contract.
 * Reconciliation renders a held reset as `blocked`, so re-arming must restore
 * both halves of the launch invariant instead of changing queueState alone.
 */
export function rearmHeldPacketsForExplicitDispatch(state: OrchestratorMissionState): void {
  for (const packet of state.packets) {
    if (packet.queueState !== 'held') continue;
    if (packet.holdIntent !== 'explicit-dispatch') continue;
    if (packet.archivedAt || packet.status === 'archived') continue;
    if (packet.releaseState === 'released') continue;
    if (packet.status === 'failed' || packet.operatorStopped || hasLaneBinding(packet)) continue;

    packet.queueState = 'queued';
    packet.status = 'queued';
    packet.blockedReason = null;
    packet.holdIntent = undefined;
  }
}

function classifyKnownBlocker(
  packet: OrchestratorPacket,
  blocker: string,
): DispatchMissionSkippedPacket {
  const base = { packetId: packet.id, referenceLabel: packet.referenceLabel, detail: blocker };
  if (blocker.startsWith('Machine busy:')) return { ...base, reason: 'scheduler-deferred', suggestedAction: 'wait' };
  if (blocker === 'Operator stopped') {
    return { ...base, reason: 'operator-stopped', suggestedAction: 'reset_packet' };
  }
  if (blocker.startsWith('Launch attempts exceeded') || blocker.startsWith('Recovery limit exceeded')) {
    return { ...base, reason: 'launch-limit', suggestedAction: 'reset_packet' };
  }
  if (blocker === 'No workspace target') {
    return { ...base, reason: 'missing-workspace', suggestedAction: 'reset_packet' };
  }
  if (blocker.includes("isn't a Git repository")) {
    return { ...base, reason: 'invalid-workspace', suggestedAction: 'reset_packet' };
  }
  if (blocker === 'Already dispatched' || blocker.includes('salvaged work awaits review')) {
    return { ...base, reason: 'already-dispatched', suggestedAction: 'wait' };
  }
  if (blocker === 'Not queued') {
    return { ...base, reason: 'held', suggestedAction: 'retry_packet' };
  }
  if (blocker.startsWith('Failed')) {
    return { ...base, reason: 'failed', suggestedAction: 'reset_packet' };
  }
  return { ...base, reason: 'not-launchable' };
}

function classifySkippedPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): DispatchMissionSkippedPacket {
  const base = { packetId: packet.id, referenceLabel: packet.referenceLabel };
  if (packet.releaseState === 'released') {
    return { ...base, reason: 'released', detail: 'Packet is already released.' };
  }
  if (packet.archivedAt || packet.status === 'archived') {
    return {
      ...base,
      reason: 'archived',
      detail: 'Packet is archived; retry_packet or reset_packet must re-arm it before dispatch.',
      suggestedAction: 'retry_packet',
    };
  }
  if (packet.status === 'launching' || packet.status === 'running') {
    return { ...base, reason: 'already-running', detail: `Packet is already ${packet.status}.`, suggestedAction: 'wait' };
  }
  if (packet.status === 'awaiting_review') {
    return { ...base, reason: 'awaiting-review', detail: 'Packet is awaiting review.', suggestedAction: 'submit_review' };
  }

  const dependency = packetReleaseBlockedBy(packet, allPackets);
  if (dependency) {
    return {
      ...base,
      reason: 'blocked-by',
      detail: `Packet is blocked by ${dependency.id}.`,
      blockedByPacketId: dependency.id,
      suggestedAction: 'wait',
    };
  }
  if (packet.operatorStopped) {
    return { ...base, reason: 'operator-stopped', detail: 'Packet was stopped by the operator.', suggestedAction: 'reset_packet' };
  }
  if (packet.queueState === 'held') {
    return { ...base, reason: 'held', detail: 'Packet is held and was not re-armed.', suggestedAction: 'retry_packet' };
  }
  if (packet.status === 'failed') {
    return { ...base, reason: 'failed', detail: packet.blockedReason ?? 'Packet failed.', suggestedAction: 'reset_packet' };
  }
  if (hasLaneBinding(packet)) {
    return { ...base, reason: 'already-dispatched', detail: 'Packet still has a lane binding.', suggestedAction: 'wait' };
  }
  if (packet.status === 'blocked' && packet.blockedReason) {
    return { ...base, reason: 'not-launchable', detail: packet.blockedReason };
  }

  const blocker = getDispatchBlocker(packet, allPackets);
  if (blocker) return classifyKnownBlocker(packet, blocker);
  return {
    ...base,
    reason: 'scheduler-deferred',
    detail: 'Packet remains launchable but this dispatch tick had no available scheduler slot.',
  };
}

export function summarizeDispatchMission(
  beforeDispatch: OrchestratorMissionState,
  afterDispatch: OrchestratorMissionState,
) {
  const beforeByPacketId = new Map(beforeDispatch.packets.map((packet) => [packet.id, hasLaneBinding(packet)] as const));
  let dispatched = 0;
  const skipped: DispatchMissionSkippedPacket[] = [];
  const queued = missionDispatchQueue(afterDispatch);
  const queuedById = new Map(queued.map((entry) => [entry.packetId, entry]));

  for (const packet of afterDispatch.packets) {
    const launched = !beforeByPacketId.get(packet.id) && hasLaneBinding(packet);
    if (launched) {
      dispatched += 1;
      continue;
    }
    const queue = queuedById.get(packet.id);
    const skip = classifySkippedPacket(packet, afterDispatch.packets);
    skipped.push(queue && skip.reason === 'scheduler-deferred'
      ? { ...skip, detail: queue.detail, suggestedAction: 'wait' }
      : skip);
  }

  return {
    dispatched, skipped, queued,
    status: dispatched > 0 ? 'dispatched' : queued.length > 0 || skipped.some(skip => skip.reason === 'scheduler-deferred') ? 'queued' : 'not-dispatched',
    ...(queued.length > 0 ? { note: `Dispatch returned with ${queued.length} packet(s) still queued. ${queued[0].detail}` } : {}),
  };
}
