import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { packetSpendCapBreach, type PacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import type { OwnedSessionRecord } from './types';
import { readMeteredGatewayTelemetrySync } from '@/lib/claude-code/metered-gateway-telemetry';
import { getSqlite } from '@/lib/db';

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
  // The foreground mirror is not authority to revive a stopped registry owner,
  // including an archived row for the very same foreground mission.
  const registered = listMissionRegistryEntries({ includeArchived: true });
  const rows = getSqlite().prepare(`SELECT id, archived_at FROM missions
    WHERE id = ? OR CASE WHEN json_valid(packet_meta_json) THEN EXISTS (
      SELECT 1 FROM json_each(packet_meta_json) WHERE json_extract(value, '$.id') = ?
    ) ELSE 0 END`).all(active.packets.some(packet => packet.id === packetId) ? active.missionId : null, packetId) as {
      id: string; archived_at: number | null;
    }[];
  for (const row of rows) {
    if (row.archived_at) return `Packet ${packetId} recovery refused: its owning mission is archived.`;
    if (!registered.some(owner => owner.id === row.id)) {
      return `Packet ${packetId} recovery refused: its durable owning mission state is unavailable.`;
    }
  }
  const owners = [{ mission: active, archivedAt: null }, ...registered]
    .filter(owner => owner.mission.packets.some(candidate => candidate.id === packetId));
  if (!owners.length) return `Packet ${packetId} recovery refused: its durable stop and budget state is unavailable.`;
  for (const owner of owners) {
    const packet = owner.mission.packets.find(candidate => candidate.id === packetId)!;
    if (packet.spendTelemetry?.capHit || (packet.spendCap && packet.spendTelemetry
      && packetSpendCapBreach(packet.spendCap, packet.spendTelemetry))
      || (packet.spendCap && telemetry && packetSpendCapBreach(packet.spendCap, telemetry))) return exhausted;
    if (owner.archivedAt || packet.archivedAt || packet.status === 'archived') {
      return `Packet ${packetId} recovery refused: its packet or owning mission is archived.`;
    }
    if (owner.mission.lifecycleHold || packet.operatorStopped || packet.holdIntent === 'operator') {
      return `Packet ${packetId} is held (${packet.blockedReason || 'operator_stop'}). Use an explicit governed packet retry.`;
    }
  }
}

export function assertPacketRecoveryAdmission(session: OwnedSessionRecord | null): void {
  const reason = packetRecoveryRefusal(session);
  if (reason) throw new PacketRecoveryRefusedError(reason);
}
