import path from 'node:path';
import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { listReposFresh } from '@/lib/repos/registry';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { parkWithFreshPolicy, type PressureCandidate } from '@/lib/orchestrator/storage-pressure-policy';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { assertSettledCompletedWorkspace } from '@/lib/workspace/completed-packet';
import { parkWorkspace } from '@/lib/workspace/hibernator';
import { DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS, observeStorageVolume, storageObservationFailureReason,
  type StorageAdmissionResult } from '@/lib/workspace/storage-admission';
import { inboxPackets, settleScope } from './subjects';
import { readInboxState } from './store';
import type { InboxSubject } from './settlement-state';

const pending = new Map<string, Promise<void>>();

function heldBreach(packet: OrchestratorPacket) {
  const held = packet.storageAdmission;
  if (!held || held.state !== 'held' || held.reason !== 'reserve_breached' || held.ownerId !== packet.id
    || packet.releaseState === 'released' || ['archived', 'running', 'launching', 'draft'].includes(packet.status)
    || packet.operatorStopped || !held.volumeId || !Number.isSafeInteger(held.estimateBytes) || held.estimateBytes <= 0) return null;
  const row = getSqlite().prepare(`SELECT result_json FROM storage_admission_mutations
    WHERE mutation_id = ? AND operation = 'reserve' AND reservation_id = ? AND volume_id = ?`)
    .get(held.mutationId, held.reservationId, held.volumeId) as { result_json: string } | undefined;
  if (!row) return null;
  try {
    const actual = JSON.parse(row.result_json) as StorageAdmissionResult;
    return actual.operation === 'reserve' && actual.decision === 'held' && actual.reason === 'reserve_breached'
      && actual.mutationId === held.mutationId && actual.recordedAt === held.recordedAt
      && actual.observation?.volumeId === held.volumeId ? held : null;
  } catch { return null; }
}

/** Observe the existing held demand; never reserve, retry dispatch or change admission. */
async function assertCurrentPressure(packetId: string, mutationId: string): Promise<string> {
  const packet = inboxPackets().find(candidate => candidate.id === packetId);
  const held = packet ? heldBreach(packet) : null;
  const targetPath = packet?.workspaceTargetPath;
  if (!packet || !held || held.mutationId !== mutationId || !targetPath?.trim()) {
    throw new Error('The authoritative storage hold or target path changed.');
  }
  const started = Date.now();
  const volume = await observeStorageVolume(targetPath);
  if (storageObservationFailureReason(volume, started, Date.now(), DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS)
    || volume.volumeId !== held.volumeId) throw new Error('Current held-volume accounting is unknown or changed.');
  const policy = getOperatorDefaultsSync().values;
  const reserved = (getSqlite().prepare(`SELECT COALESCE(SUM(exact_bytes), 0) AS bytes
    FROM storage_admission_reservations WHERE volume_id = ? AND state = 'reserved'`)
    .get(held.volumeId) as { bytes: number }).bytes;
  const reserve = Math.max(Math.round(policy.storageReserveFloorGb * 1_073_741_824),
    Math.ceil(volume.totalBytes! * policy.storageReserveRatio));
  const headroom = volume.availableBytes! - reserve - reserved;
  if (policy.workspaceParkingMode !== 'pressure' || !Number.isSafeInteger(reserved) || reserved < 0
    || !Number.isSafeInteger(headroom) || held.estimateBytes <= headroom) {
    throw new Error('The current volume does not have an authoritative reserve breach.');
  }
  // Re-read after the observation so a changed durable demand is never reused.
  const current = inboxPackets().find(candidate => candidate.id === packetId);
  if (!current || heldBreach(current)?.mutationId !== mutationId) throw new Error('The storage hold changed during observation.');
  return held.volumeId!;
}

async function parkSettledWorkspaces(subject: InboxSubject, settledAt: string): Promise<void> {
  if (getOperatorDefaultsSync().values.workspaceParkingMode !== 'pressure') return;
  const scope = settleScope(subject);
  const demands = scope.packets.filter(packet => heldBreach(packet));
  if (!demands.length) return;
  const repos = await listReposFresh();
  for (const lane of scope.relevantLanes) {
    if (lane.status !== 'completed' || !lane.packetId || !lane.worktreePath) continue;
    let proof: ReturnType<typeof assertSettledCompletedWorkspace>;
    try {
      proof = assertSettledCompletedWorkspace(lane);
      if (JSON.stringify(proof.subject) !== JSON.stringify(subject) || proof.settledAt !== settledAt) continue;
    }
    catch { continue; }
    const repo = repos.find(entry => path.resolve(entry.localPath) === path.resolve(lane.repoPath));
    if (!repo || repo.storagePressureParkingDisabled) continue;
    const probeStarted = Date.now();
    const workspaceVolume = await observeStorageVolume(lane.worktreePath);
    if (storageObservationFailureReason(workspaceVolume, probeStarted, Date.now(), DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS)) continue;
    const demand = demands.find(packet => heldBreach(packet)?.volumeId === workspaceVolume.volumeId);
    if (!demand?.storageAdmission) continue;
    let volumeId: string;
    try { volumeId = await assertCurrentPressure(demand.id, demand.storageAdmission.mutationId); }
    catch { continue; }
    const operationId = `inbox-settle:${createHash('sha256').update(JSON.stringify([subject, settledAt, lane.packetId])).digest('hex')}`;
    const candidate: PressureCandidate = { lane, repo, operationId, ordinal: 1, measuredAllocatedBytes: null,
      refusal: null, exactParkReplay: false, volumePath: lane.worktreePath };
    const parked = await parkWithFreshPolicy(candidate, volumeId,
      () => getOperatorDefaultsSync().values.workspaceParkingMode, listReposFresh, observeStorageVolume,
      async input => {
        await assertCurrentPressure(demand.id, demand.storageAdmission!.mutationId);
        assertSettledCompletedWorkspace(lane, proof);
        return parkWorkspace({ ...input,
          assertPolicyCurrent: async () => {
            await input.assertPolicyCurrent?.();
            await assertCurrentPressure(demand.id, demand.storageAdmission!.mutationId);
          },
        });
      });
    if (!parked.refusal && parked.result && parked.result.status !== 'refused') {
      await publishRealtimeMutation({ mutation: {
        mutationId: operationId, source: 'server', action: 'workspace.park', status: 'completed',
        packetId: lane.packetId, laneId: lane.id, repoPath: repo.localPath,
        createdAt: settledAt, settledAt: new Date().toISOString(),
      } });
    }
  }
}

/** A bounded post-commit job, not part of the metadata transaction or response. */
export function startSettledWorkspaceParking(subject: InboxSubject): void {
  const state = readInboxState(subject);
  if (state.settledOverride !== 'settled' || !state.settledAt) return;
  const key = JSON.stringify([subject, state.settledAt]);
  if (pending.has(key)) return;
  const job = Promise.resolve().then(() => parkSettledWorkspaces(subject, state.settledAt!))
    .catch(error => console.warn('[inbox] Workspace parking held:', error instanceof Error ? error.message : String(error)))
    .finally(() => { pending.delete(key); });
  pending.set(key, job);
}
