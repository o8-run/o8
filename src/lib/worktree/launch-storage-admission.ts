import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { getSqlite } from '@/lib/db';
import {
  getPacketStorageAdmissionCoordinator,
  PacketStorageAdmissionError,
} from '@/lib/orchestrator/storage-admission';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { findLatestLaneByPacket, updateLane } from '@/lib/lane/registry';
import { recordLaneEvent } from '@/lib/lane/events';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import type { StorageRootIdentity } from '@/lib/workspace/storage-admission';
import { probeMetadataLockProcessIdentity } from './metadata-lock-process-identity';
import { withWorktreeProvisionQueue } from './provision-queue';
import {
  assertManagedWorktreeMaterializationBoundary,
  resolveManagedWorktreeStorageTarget,
} from './root-layout';

interface ManagedWorktreeAdmissionInput {
  repoRoot: string;
  packetId?: string;
  reservationId?: string;
  /** Dependency-only idle preparation does not mutate the Git registry. */
  backgroundSetup?: boolean;
}

/** Serialize only shared Git administration, never idle dependency installation. */
export async function withManagedWorktreeRegistryQueue<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const canonicalRepo = await realpath(repoRoot);
  const rootKey = createHash('sha256').update(canonicalRepo).digest('hex');
  return withWorktreeProvisionQueue(`managed-worktree-root:${rootKey}`, () => {}, operation);
}

export async function withManagedWorktreeStorageAdmission<T>(
  input: ManagedWorktreeAdmissionInput,
  materialize: (volumeId: string, rootIdentity: StorageRootIdentity) => Promise<T>,
): Promise<T> {
  if (input.backgroundSetup) return withManagedWorktreeStorageAdmissionUnlocked(input, materialize);
  const canonicalRepo = await realpath(input.repoRoot);
  const rootKey = createHash('sha256').update(canonicalRepo).digest('hex');
  return withWorktreeProvisionQueue(`managed-worktree-root:${rootKey}`, (position) => {
    const lane = input.packetId ? findLatestLaneByPacket(input.packetId) : null;
    if (!lane || lane.sessionKey || !(lane.status === 'launching'
      || (lane.status === 'awaiting_orchestrator' && lane.lastEventLabel === 'launch_stalled'))) return;
    const eventLabel = position > 0 ? 'worktree_provision_queued' : 'worktree_provision_started';
    recordLaneEvent(lane.id, eventLabel, 'system', { packetId: input.packetId, position });
    // A watchdog stall preserves launch authority. Record the effect-start
    // fence even then, while leaving its escalation label and status intact.
    if (lane.status !== 'launching') return;
    updateLane(lane.id, {
      lastEventLabel: position > 0 ? `${eventLabel}:${position}` : eventLabel,
      lastEventAt: new Date().toISOString(),
    }, 'system', { eventLabel, position });
  }, () => (
    withManagedWorktreeStorageAdmissionUnlocked(input, materialize)
  ));
}

/** A refusal materialized nothing. A later dispatch may take a fresh reading,
 * while an admitted or uncertain reservation keeps its replay generation. */
function managedStorageAdmissionEpoch(ownerId: string): number {
  const sqlite = getSqlite();
  const reservation = new StorageAdmissionStore(sqlite).getLatestReservationForOwner(ownerId);
  if (reservation && ['reserved', 'committed'].includes(reservation.state)) return reservation.ownerGeneration;
  const prefix = `packet-storage-reserve:${ownerId}:`;
  const previous = sqlite.prepare(`SELECT mutation_id, result_json FROM storage_admission_mutations
    WHERE operation = 'reserve' AND mutation_id >= ? AND mutation_id < ?
    ORDER BY rowid DESC LIMIT 1`).get(prefix, `${prefix}\uffff`) as { mutation_id: string; result_json: string } | undefined;
  if (!previous) return 1;
  const generation = Number(previous.mutation_id.slice(prefix.length));
  if (!Number.isSafeInteger(generation) || generation < 1 || previous.mutation_id !== `${prefix}${generation}`) {
    throw new Error('Managed worktree storage admission generation is invalid.');
  }
  const result = JSON.parse(previous.result_json) as { mutationId: string; decision: string; reservation: unknown };
  if (result.mutationId !== previous.mutation_id) throw new Error('Managed worktree storage admission receipt identity changed.');
  if (result.decision !== 'held' || result.reservation !== null) return generation;
  if (!Number.isSafeInteger(generation + 1)) throw new Error('Managed worktree storage admission generation is exhausted.');
  return generation + 1;
}

async function withManagedWorktreeStorageAdmissionUnlocked<T>(
  input: ManagedWorktreeAdmissionInput,
  materialize: (volumeId: string, rootIdentity: StorageRootIdentity) => Promise<T>,
): Promise<T> {
  if (input.reservationId) {
    const reservation = new StorageAdmissionStore(getSqlite()).getReservation(input.reservationId);
    if (!reservation
      || reservation.state !== 'reserved'
      || !reservation.rootIdentity
      || reservation.ownerId !== input.packetId
      || reservation.targetPath !== resolveManagedWorktreeStorageTarget(input.repoRoot)
      || reservation.leaseExpiresAt <= Date.now()) {
      throw new Error('Managed worktree storage admission proof is missing, stale, or belongs to another packet.');
    }
    await assertManagedWorktreeMaterializationBoundary(
      input.repoRoot, reservation.volumeId, reservation.rootIdentity,
    );
    return materialize(reservation.volumeId, reservation.rootIdentity);
  }

  const ownerProbe = await probeMetadataLockProcessIdentity(process.pid);
  if (ownerProbe.state !== 'live') {
    throw new Error(`Managed worktree admission could not prove its process owner${ownerProbe.state === 'unknown' ? `: ${ownerProbe.detail.replace(/\.$/, '')}` : ''}.`);
  }
  const encodedOwner = Buffer.from(JSON.stringify(ownerProbe.identity)).toString('base64url');
  const ownerId = `managed-worktree-process:${process.pid}:${encodedOwner}:${input.packetId ?? randomUUID()}`;
  const packet = {
    id: ownerId,
    workspaceTargetPath: input.repoRoot,
    storageAdmissionEpoch: managedStorageAdmissionEpoch(ownerId),
    launchAttempts: 0,
  } as OrchestratorPacket;
  const admission = getPacketStorageAdmissionCoordinator();
  const lease = await admission.reserveForLaunch(packet);
  if (lease.receipt.state !== 'reserved') {
    throw new PacketStorageAdmissionError('Managed worktree creation was not reserved.', lease.receipt);
  }
  let result: T;
  try {
    const rootIdentity = lease.reservation.rootIdentity;
    if (!rootIdentity) throw new Error('Managed worktree reservation has no exact root identity.');
    await assertManagedWorktreeMaterializationBoundary(
      input.repoRoot, lease.reservation.volumeId, rootIdentity,
    );
    result = await materialize(lease.reservation.volumeId, rootIdentity);
  } catch (error) {
    await admission.settleFailedLaunch(packet, lease);
    throw error;
  }
  await admission.commitAfterLaunch(lease);
  return result;
}
