import 'server-only';

import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries, missionsStamp } from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { WorkerLaunchContext, WorkerWorkMode } from '@/lib/orchestrator/types';

export interface ResolvedPacketLaunchContext {
  launchContext: WorkerLaunchContext;
  missionId: string | null;
}

// Every stored mission's packets, indexed once and kept until a stored mission
// changes: resolving a lane's packet otherwise parses every stored mission on
// each /api/lanes poll. The first stored packet with a launch context wins, as
// in a scan of the registry in its order.
let storedLaunchContexts: { stamp: string; byPacket: Map<string, ResolvedPacketLaunchContext> } | null = null;

function storedLaunchContextIndex(): Map<string, ResolvedPacketLaunchContext> {
  const stamp = missionsStamp();
  if (storedLaunchContexts?.stamp === stamp) return storedLaunchContexts.byPacket;
  const byPacket = new Map<string, ResolvedPacketLaunchContext>();
  for (const entry of listMissionRegistryEntries({ includeArchived: true })) {
    for (const packet of entry.mission.packets) {
      if (!packet.launchContext || byPacket.has(packet.id)) continue;
      byPacket.set(packet.id, { launchContext: packet.launchContext, missionId: entry.id });
    }
  }
  storedLaunchContexts = { stamp, byPacket };
  return byPacket;
}

export function resolvePacketLaunchContexts(
  packetIds: Iterable<string>,
): Map<string, ResolvedPacketLaunchContext> {
  const unresolved = new Set(
    Array.from(packetIds, (packetId) => packetId.trim()).filter(Boolean),
  );
  const resolved = new Map<string, ResolvedPacketLaunchContext>();
  if (unresolved.size === 0) return resolved;

  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  for (const packet of current.packets) {
    if (!unresolved.has(packet.id) || !packet.launchContext) continue;
    resolved.set(packet.id, {
      launchContext: packet.launchContext,
      missionId: current.missionId?.trim() || null,
    });
    unresolved.delete(packet.id);
  }

  if (unresolved.size === 0) return resolved;
  const stored = storedLaunchContextIndex();
  for (const packetId of unresolved) {
    const found = stored.get(packetId);
    if (found) resolved.set(packetId, found);
  }
  return resolved;
}

export function resolvePacketLaunchContext(packetId: string): ResolvedPacketLaunchContext | null {
  return resolvePacketLaunchContexts([packetId]).get(packetId.trim()) ?? null;
}

/**
 * The durable work mode for a packet, distinguishing "this packet is not in
 * durable state at all" from "this packet is recorded and carries no launch
 * context".
 *
 * `resolvePacketLaunchContext` conflates those two into `null`, which is fine
 * for presentation but NOT for an authorization decision. `launchContext` is
 * optional metadata, so a perfectly normal write packet routinely has none —
 * refusing those would brick dispatch. An UNKNOWN packet is the dangerous case:
 * durable state could not confirm the packet is a write packet, so the launch
 * must refuse rather than default to write access.
 */
export type ResolvedPacketWorkMode =
  | { found: true; workMode: WorkerWorkMode | undefined }
  | { found: false };

export function resolvePacketWorkMode(packetId: string): ResolvedPacketWorkMode {
  const wanted = packetId.trim();
  if (!wanted) return { found: false };

  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  for (const packet of current.packets) {
    if (packet.id === wanted) return { found: true, workMode: packet.launchContext?.workMode };
  }
  for (const entry of listMissionRegistryEntries({ includeArchived: true })) {
    for (const packet of entry.mission.packets) {
      if (packet.id === wanted) return { found: true, workMode: packet.launchContext?.workMode };
    }
  }
  return { found: false };
}
