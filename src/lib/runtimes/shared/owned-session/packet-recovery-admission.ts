import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { packetSpendCapBreach, type PacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import type { OwnedSessionRecord } from './types';
import { readMeteredGatewayTelemetrySync } from '@/lib/claude-code/metered-gateway-telemetry';

export class PacketRecoveryRefusedError extends Error {
  readonly sideEffect = 'none' as const;
}

/** A run journal can lag a durable Stop; it cannot grant another packet budget. */
export function packetRecoveryRefusal(session: OwnedSessionRecord | null): string | undefined {
  const packetId = session?.packetId ?? session?.workspaceBinding?.packetId;
  if (!packetId) return;
  const exhausted = `Packet ${packetId} budget is exhausted. An explicit authorized budget or runtime change is required before recovery.`;
  let telemetry: PacketSpendTelemetry | null;
  try { telemetry = readMeteredGatewayTelemetrySync(session!.sessionDir); }
  catch { return `Packet ${packetId} recovery refused: its durable gateway budget evidence is unavailable.`; }
  if (telemetry?.capHit) return exhausted;
  const active = readOrchestratorControlPlaneState();
  const packet = active.packets.find(candidate => candidate.id === packetId)
    ?? findMissionRegistryEntryByPacketId(packetId, { includeArchived: true, excludeMissionId: active.missionId })
      ?.mission.packets.find(candidate => candidate.id === packetId);
  if (!packet) return `Packet ${packetId} recovery refused: its durable stop and budget state is unavailable.`;
  if (packet.spendTelemetry?.capHit || (packet.spendCap && packet.spendTelemetry
    && packetSpendCapBreach(packet.spendCap, packet.spendTelemetry))
    || (packet.spendCap && telemetry && packetSpendCapBreach(packet.spendCap, telemetry))) {
    return exhausted;
  }
  if (packet.operatorStopped) {
    return `Packet ${packetId} is stopped (${packet.blockedReason || 'operator_stopped'}). Use an explicit governed packet retry.`;
  }
}

export function assertPacketRecoveryAdmission(session: OwnedSessionRecord | null): void {
  const reason = packetRecoveryRefusal(session);
  if (reason) throw new PacketRecoveryRefusedError(reason);
}
