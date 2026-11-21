import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { listLanes } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import type { LaneStatus } from '@/lib/lane/types';
import { listDurablePacketsWithId } from '@/lib/orchestrator/mission-registry';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  listCommittedPacketStorageReservations,
  releaseCommittedStorageForDeadOwner,
} from '@/lib/workspace/storage-admission-terminal-release';
import type { StorageReservationRecord } from '@/lib/workspace/storage-admission';
import { resolvePacketCheckoutByOwner } from './storage-admission-owner-liveness';
import type { PacketStorageAdmissionOwnerResolution } from './storage-admission';

interface CommittedOwnerLane {
  id: string;
  packetId: string | null;
  status: LaneStatus;
  worktreePath: string | null;
}

export interface CommittedStorageReconciliationResult {
  inspected: number;
  released: number;
  releasedBytes: number;
  retainedLive: number;
  retainedUnknown: number;
  held: number;
}

/**
 * A committed row describes storage that survived launch, so owner death alone
 * is insufficient. Release requires terminal or absent durable ownership plus
 * affirmative absence of every recorded and packet-named checkout.
 */
export async function resolveCommittedPacketStorageOwner(
  reservation: StorageReservationRecord,
  dependencies: {
    lanes?: CommittedOwnerLane[];
    packets?: OrchestratorPacket[];
  } = {},
): Promise<PacketStorageAdmissionOwnerResolution> {
  const lanes = (dependencies.lanes ?? listLanes()).filter((lane) => (
    lane.packetId?.trim() === reservation.ownerId || lane.id === reservation.ownerId
  ));
  const liveLane = lanes.find((lane) => !isLaneTerminal(lane.status));
  if (liveLane) {
    return {
      liveness: 'alive',
      source: 'committed-storage-lane',
      evidence: 'A nonterminal lane still names the committed storage owner.',
    };
  }

  const packets = dependencies.packets
    ? dependencies.packets.filter((packet) => packet.id === reservation.ownerId)
    : listDurablePacketsWithId(reservation.ownerId);
  if (packets.length > 1) {
    return {
      liveness: 'unknown',
      source: 'committed-storage-packet',
      evidence: 'More than one durable packet claims the committed storage owner.',
    };
  }
  const packet = packets[0] ?? null;
  if (packet && !packetTerminalState(packet)) {
    return {
      liveness: 'alive',
      source: 'committed-storage-packet',
      evidence: 'A nonterminal durable packet still names the committed storage owner.',
    };
  }

  const checkout = await resolvePacketCheckoutByOwner({
    ownerId: reservation.ownerId,
    recordedPaths: [
      ...lanes.map((lane) => lane.worktreePath),
      packet?.lane?.worktreePath,
    ],
    reservationTargetPath: reservation.targetPath,
  });
  if (checkout.state === 'present') {
    return {
      liveness: 'alive',
      source: 'committed-storage-checkout',
      evidence: checkout.evidence,
    };
  }
  if (checkout.state === 'unknown') {
    return {
      liveness: 'unknown',
      source: 'committed-storage-checkout',
      evidence: checkout.evidence,
    };
  }
  return {
    liveness: 'dead',
    source: 'committed-storage-checkout',
    evidence: `${packet ? 'The durable packet is terminal' : 'The durable packet owner is absent'}; ${checkout.evidence}`,
  };
}

export async function reconcileCommittedPacketStorageReservations(
  dependencies: {
    sqlite?: Database.Database;
    now?: () => number;
    resolveOwner?: (
      reservation: StorageReservationRecord,
    ) => PacketStorageAdmissionOwnerResolution | Promise<PacketStorageAdmissionOwnerResolution>;
  } = {},
): Promise<CommittedStorageReconciliationResult> {
  const sqlite = dependencies.sqlite ?? getSqlite();
  const now = dependencies.now ?? Date.now;
  const resolveOwner = dependencies.resolveOwner ?? resolveCommittedPacketStorageOwner;
  const committed = listCommittedPacketStorageReservations(sqlite);
  const summary: CommittedStorageReconciliationResult = {
    inspected: committed.length,
    released: 0,
    releasedBytes: 0,
    retainedLive: 0,
    retainedUnknown: 0,
    held: 0,
  };

  for (const reservation of committed) {
    const owner = await resolveOwner(reservation);
    if (owner.liveness === 'alive') {
      summary.retainedLive += 1;
      continue;
    }
    if (owner.liveness !== 'dead') {
      summary.retainedUnknown += 1;
      continue;
    }
    const observedAt = now();
    const result = releaseCommittedStorageForDeadOwner({
      sqlite,
      reservation,
      releasedAt: observedAt,
      ownerDeathReceipt: {
        source: owner.source,
        evidence: owner.evidence,
        observedAt,
        reservationId: reservation.reservationId,
        volumeId: reservation.volumeId,
        ownerId: reservation.ownerId,
        ownerGeneration: reservation.ownerGeneration,
      },
    });
    if (result.released) {
      summary.released += 1;
      summary.releasedBytes += result.releasedBytes;
    } else {
      summary.held += 1;
    }
  }
  return summary;
}
