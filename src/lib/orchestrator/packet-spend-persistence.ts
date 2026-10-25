import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { readMeteredGatewayTelemetrySync } from '@/lib/claude-code/metered-gateway-telemetry';
import { listLanes } from '@/lib/lane/registry';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';
import { readOrchestratorControlPlaneState, withControlPlaneLock, writeOrchestratorControlPlaneState } from './control-plane';
import { listMissionRegistryEntries, updateMissionRegistryPacketSpend } from './mission-registry';
import { packetSpendCapBreach, type PacketSpendTelemetry } from './metered-spend';
import type { OrchestratorPacket } from './types';

const count = (value: number | undefined) => Math.max(0, Math.round(value && Number.isFinite(value) ? value : 0));

/** Read again at the owning mutation, including a session moved to the archive. */
function gatewayEvidence(sessionKey: string): PacketSpendTelemetry | null {
  const root = ownedRoots().find(entry => sessionKey.startsWith(entry.marker));
  if (!root) return null;
  const directory = sessionKey.slice(root.marker.length);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(directory)) return null;
  const observations = [root.root, archiveRootForOwnedSessionRoot(root.root)]
    .map(base => readMeteredGatewayTelemetrySync(path.join(base, directory)))
    .filter((entry): entry is PacketSpendTelemetry => entry !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!observations.length) return null;
  return { ...observations[0], capHit: observations.some(entry => entry.capHit) };
}

/** Unknown totals never become known zero; only known gateway totals replace estimates. */
function mergeObservation(previous: PacketSpendTelemetry | undefined, next: PacketSpendTelemetry, durableGateway: boolean): PacketSpendTelemetry {
  if (!previous) return next;
  const older = next.updatedAt < previous.updatedAt;
  const keepPrevious = older || (next.costSource === 'estimate'
    && (previous.costSource === 'gateway' || previous.costSource === 'unknown'))
    || (previous.costSource === 'unknown' && !durableGateway);
  const selected = keepPrevious ? previous : next;
  return { ...selected,
    costUsd: next.costUsd === null ? null
      : previous.costUsd !== null && previous.costSource === 'gateway' && next.costSource === 'gateway'
        ? Math.max(previous.costUsd, next.costUsd) : selected.costUsd,
    costSource: next.costUsd === null ? 'unknown' : selected.costSource,
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
    capHit: previous.capHit || next.capHit,
  };
}

export async function persistPacketSessionSpend(input: {
  sessionKey: string; packetId?: string | null; laneId?: string | null; telemetry: RuntimeTelemetry;
}): Promise<{ persisted: boolean; telemetry: PacketSpendTelemetry }> {
  const lane = listLanes().find(candidate => candidate.sessionKey === input.sessionKey && candidate.packetId);
  const packetId = input.packetId ?? lane?.packetId;
  const usd = input.telemetry.costSource !== 'unknown' && typeof input.telemetry.estimatedCostUsd === 'number'
    && Number.isFinite(input.telemetry.estimatedCostUsd) ? input.telemetry.estimatedCostUsd : null;
  const snapshot: PacketSpendTelemetry = {
    costUsd: usd, costSource: usd === null ? 'unknown' : input.telemetry.costSource ?? 'estimate',
    inputTokens: count(input.telemetry.inputTokens), outputTokens: count(input.telemetry.outputTokens),
    capHit: false, updatedAt: new Date().toISOString(),
  };
  const readObservation = () => {
    const disk = gatewayEvidence(input.sessionKey);
    return { durable: disk !== null, telemetry: disk ? {
      ...disk, inputTokens: Math.max(disk.inputTokens, snapshot.inputTokens),
      outputTokens: Math.max(disk.outputTokens, snapshot.outputTokens),
    } : snapshot };
  };
  let observed = readObservation().telemetry;
  if (!packetId) return { persisted: false, telemetry: observed };
  return withControlPlaneLock(async () => {
    const owners = listMissionRegistryEntries({ includeArchived: true })
      .filter(entry => entry.mission.packets.some(packet => packet.id === packetId));
    const foreground = readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId);
    const laneId = lane?.id ?? input.laneId;
    // Query the event itself, not a bounded page of unrelated later output.
    const eventHit = Boolean(laneId && getSqlite().prepare(
      "SELECT 1 FROM lane_events WHERE lane_id = ? AND verb = 'spend_cap_hit' LIMIT 1",
    ).get(laneId));
    const packets = [foreground, ...owners.map(owner => owner.mission.packets.find(packet => packet.id === packetId))];
    const breached = (packet: OrchestratorPacket) => Boolean(packet.spendTelemetry?.capHit
      || (packet.spendCap && packet.spendTelemetry && packetSpendCapBreach(packet.spendCap, packet.spendTelemetry)));
    observed.capHit ||= eventHit || packets.some(packet => packet && breached(packet));
    const update = (packet: OrchestratorPacket) => {
      // A Stop or gateway write can land while getTelemetry or a registry lock
      // is awaited. Read and merge within each owner's actual mutation.
      observed.capHit ||= breached(packet);
      const latest = readObservation();
      observed = mergeObservation(observed, latest.telemetry, latest.durable);
      observed = mergeObservation(packet.spendTelemetry, observed, latest.durable);
      observed.capHit ||= Boolean(packet.spendCap && packetSpendCapBreach(packet.spendCap, observed));
      return { ...observed };
    };
    let persisted = false;
    for (const owner of owners) persisted = await updateMissionRegistryPacketSpend(owner.id, packetId, update) || persisted;
    const state = readOrchestratorControlPlaneState();
    const packet = state.packets.find(candidate => candidate.id === packetId);
    if (packet) {
      packet.spendTelemetry = update(packet);
      // A telemetry mirror must not reconcile away a queue or lifecycle hold.
      writeOrchestratorControlPlaneState(state);
      persisted = true;
    }
    // Packet totals span attempts/sessions. Billing receipts belong only to
    // this session, so never copy the packet's larger totals into its receipt.
    const sessionTelemetry = readObservation().telemetry;
    const usageTelemetry: PacketSpendTelemetry = observed.costUsd === null
      ? { ...sessionTelemetry, costUsd: null, costSource: 'unknown' } : sessionTelemetry;
    return { persisted, telemetry: usageTelemetry };
  });
}
