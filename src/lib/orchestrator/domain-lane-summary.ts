import { capacityWaitLabel } from '@/lib/lane/capacity-wait-label';
import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketContextObservation } from '@/lib/orchestrator/packet-context-telemetry';

export function preferRuntimeRecoveryMessage(reason: string | null | undefined, recovery: string | null | undefined) {
  return (!reason || reason === 'runtime_process_exit' || reason === 'Awaiting operator input')
    ? recovery ?? reason : reason;
}

export function applyLanePendingStatus(packet: OrchestratorPacket, lane: DomainLaneSummary): boolean {
  const waiting = capacityWaitLabel(lane.status, lane.lastEventLabel);
  if (waiting) {
    packet.status = 'blocked';
    packet.lastEventLabel = lane.lastEventLabel;
    packet.blockedReason = waiting;
    return true;
  }
  if (lane.status === 'merging') {
    packet.status = 'awaiting_review';
    packet.blockedReason = 'Merge in progress';
    return true;
  }
  if (lane.status === 'launching' && lane.provisioningQueuePosition) {
    packet.status = 'launching';
    packet.lastEventLabel = 'worktree_provision_queued';
    packet.blockedReason = `Queued for provisioning (position ${lane.provisioningQueuePosition}).`;
    return true;
  }
  return false;
}

/** Retain a completed workspace association after its live tab or checkout disappears. */
export function hasCompletedManagedBinding(packet: OrchestratorPacket, lane: DomainLaneSummary | null): boolean {
  const binding = packet.lane;
  return Boolean(lane?.status === 'completed' && lane.ownership === 'managed'
    && lane.packetId === packet.id && binding?.laneId && binding.sessionKey
    && binding.repoPath && binding.worktreePath && lane.laneId === binding.laneId
    && lane.sessionKey === binding.sessionKey && lane.repoPath === binding.repoPath
    && (lane.worktreePath === null || lane.worktreePath === binding.worktreePath));
}

export interface DomainLaneSummary {
  laneId: string;
  packetId: string;
  status: string;
  sessionKey: string | null;
  lastEventLabel: string | null;
  failureMessage?: string | null;
  provisioningQueuePosition?: number | null;
  authRecoveryRequired?: boolean;
  recovery?: OrchestratorPacket['recovery'];
  contextObservation?: PacketContextObservation;
  branch?: string;
  repoPath?: string;
  worktreePath?: string | null;
  ownership?: 'managed' | 'attached';
  label?: string;
  mergeMode?: LaneMergeMode;
  mergeModeNote?: string | null;
}
