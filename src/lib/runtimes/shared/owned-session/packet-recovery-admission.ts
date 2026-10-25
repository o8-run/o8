import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { packetSpendCapBreach } from '@/lib/orchestrator/metered-spend';
import type { OwnedSessionRecord } from './types';

export class PacketRecoveryRefusedError extends Error {
  readonly sideEffect = 'none' as const;
}

/** A run journal can lag a durable Stop; it cannot grant another packet budget. */
export function packetRecoveryRefusal(session: OwnedSessionRecord | null): string | undefined {
  const packetId = session?.packetId ?? session?.workspaceBinding?.packetId;
  if (!packetId) return;
  const active = readOrchestratorControlPlaneState();
  const packet = active.packets.find(candidate => candidate.id === packetId)
    ?? findMissionRegistryEntryByPacketId(packetId, { includeArchived: true, excludeMissionId: active.missionId })
      ?.mission.packets.find(candidate => candidate.id === packetId);
  if (!packet) return `Packet ${packetId} recovery refused: its durable stop and budget state is unavailable.`;
  if (packet.spendTelemetry?.capHit || (packet.spendCap && packet.spendTelemetry
    && packetSpendCapBreach(packet.spendCap, packet.spendTelemetry))) {
    return `Packet ${packetId} budget is exhausted. An explicit authorized budget or runtime change is required before recovery.`;
  }
  if (packet.operatorStopped) {
    return `Packet ${packetId} is stopped (${packet.blockedReason || 'operator_stopped'}). Use an explicit governed packet retry.`;
  }
}

export function assertPacketRecoveryAdmission(session: OwnedSessionRecord | null): void {
  const reason = packetRecoveryRefusal(session);
  if (reason) throw new PacketRecoveryRefusedError(reason);
}
