import 'server-only';
import type { WorkspaceParkingMode } from '@/lib/operator/workspace-parking-defaults';

import path from 'node:path';

import { findLatestLaneByPacket, listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { listReposFresh } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type {
  OrchestratorPacket,
  OrchestratorStoragePressureCandidateReceipt,
  OrchestratorStoragePressureReceipt,
} from '@/lib/orchestrator/types';
import { measureDirectoryStorage } from '@/lib/worktree/storage-telemetry';
import {
  getWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
} from '@/lib/worktree/snapshot-state';
import { parkWorkspace, type ParkWorkspaceInput, type ParkWorkspaceResult } from '@/lib/workspace/hibernator';
import {
  observeStorageVolume,
  type StorageVolumeObservation,
} from '@/lib/workspace/storage-admission';
import {
  getPacketStorageAdmissionCoordinator,
  PacketStorageAdmissionError,
  type PacketStorageAdmissionCoordinator,
  type PacketStorageAdmissionLease,
  type PacketStorageAdmissionReceipt,
} from './storage-admission';
import { storagePressureCandidateSummary } from './storage-admission-held-message';
import { assertSettledCompletedWorkspace } from '@/lib/workspace/completed-packet';
import { withStoragePressurePolicyLock } from './storage-pressure-policy-lock';

export interface StoragePressureProjection {
  mode: WorkspaceParkingMode;
  automaticParkingEnabled: boolean;
  eligibleRepositories: number;
  optedOutRepositories: number;
}

export interface StoragePressureDependencies {
  now?: () => number;
  mode?: () => 'manual' | 'pressure';
  listLanes?: () => Lane[];
  listRepos?: () => Promise<RepoRegistryEntry[]>;
  measureAllocatedBytes?: (workspacePath: string) => Promise<number | null>;
  observeVolume?: (targetPath: string) => Promise<StorageVolumeObservation>;
  getSnapshot?: typeof getWorkspaceSnapshot;
  parkWorkspace?: (input: ParkWorkspaceInput) => Promise<ParkWorkspaceResult>;
  readParkedReclaimedBytes?: (
    repositoryUuid: string,
    packetId: string,
    operationId: string,
  ) => number | null;
}

export interface PressureCandidate {
  lane: Lane;
  repo: RepoRegistryEntry | null;
  operationId: string;
  ordinal: number;
  measuredAllocatedBytes: number | null;
  refusal: string | null;
  exactParkReplay: boolean;
  volumePath: string | null;
}

function pressureReceipt(
  mode: 'manual' | 'pressure',
  status: OrchestratorStoragePressureReceipt['status'],
  packet: OrchestratorPacket,
  launchGeneration: number,
  candidates: OrchestratorStoragePressureCandidateReceipt[],
  now: number,
): OrchestratorStoragePressureReceipt {
  return {
    schema: 'o8/storage-pressure-decision/v1',
    mode,
    status,
    trigger: 'reserve_breached',
    launchGeneration,
    candidates,
    recordedAt: now,
  };
}

function withPressure(
  receipt: PacketStorageAdmissionReceipt,
  pressure: OrchestratorStoragePressureReceipt,
): PacketStorageAdmissionReceipt {
  return { ...receipt, pressure };
}

function exactRepoForLane(lane: Lane, repos: RepoRegistryEntry[]): RepoRegistryEntry | null {
  const laneRepo = path.resolve(lane.repoPath);
  return repos.find((repo) => path.resolve(repo.localPath) === laneRepo) ?? null;
}

function defaultReadParkedReclaimedBytes(
  repositoryUuid: string,
  packetId: string,
  operationId: string,
): number | null {
  const transition = listWorkspaceSnapshotTransitions(repositoryUuid, packetId)
    .find((item) => item.transitionId === `${operationId}:parked` && item.toState === 'parked');
  const value = transition?.receipt?.reclaimedAvailableBytes;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

async function defaultMeasureAllocatedBytes(workspacePath: string): Promise<number | null> {
  const measured = await measureDirectoryStorage(workspacePath);
  return measured.allocatedBytesAccounting === 'observed' ? measured.allocatedBytes : null;
}

function candidateReceipt(
  candidate: PressureCandidate,
  outcome: OrchestratorStoragePressureCandidateReceipt['outcome'],
  reason: string,
  verifiedReclaimedAvailableBytes: number | null = null,
): OrchestratorStoragePressureCandidateReceipt {
  return {
    packetId: candidate.lane.packetId!,
    repositoryUuid: candidate.repo?.id ?? null,
    laneId: candidate.lane.id,
    operationId: candidate.operationId,
    workspacePath: candidate.volumePath,
    measuredAllocatedBytes: candidate.measuredAllocatedBytes,
    verifiedReclaimedAvailableBytes,
    outcome,
    reason,
  };
}

export async function parkWithFreshPolicy(
  candidate: PressureCandidate,
  heldVolumeId: string | null,
  mode: () => WorkspaceParkingMode,
  readRepos: () => Promise<RepoRegistryEntry[]>,
  observeVolume: NonNullable<StoragePressureDependencies['observeVolume']>,
  park: (input: ParkWorkspaceInput) => Promise<ParkWorkspaceResult>,
  readLane: (packetId: string) => Lane | null = findLatestLaneByPacket,
): Promise<{ refusal: string | null; result: ParkWorkspaceResult | null }> {
  return withStoragePressurePolicyLock(async () => {
    const readPolicy = async (): Promise<string | null> => {
      let repos: RepoRegistryEntry[];
      try {
        repos = await readRepos();
      } catch {
        return 'repository_policy_unknown';
      }
      try {
        if (mode() === 'manual') return 'pressure_mode_disabled';
      } catch {
        return 'pressure_mode_unknown';
      }
      const freshRepo = repos.find((repo) => (
        repo.id === candidate.repo!.id
        && path.resolve(repo.localPath) === path.resolve(candidate.lane.repoPath)
      ));
      if (!freshRepo) return 'repository_not_registered';
      return freshRepo.storagePressureParkingDisabled ? 'repository_opted_out' : null;
    };

    const initialPolicyRefusal = await readPolicy();
    if (initialPolicyRefusal) return { refusal: initialPolicyRefusal, result: null };
    const volumeRefusal = await candidateVolumeRefusal(
      candidate.volumePath,
      heldVolumeId,
      observeVolume,
    );
    if (volumeRefusal) return { refusal: volumeRefusal, result: null };
    const finalPolicyRefusal = await readPolicy();
    if (finalPolicyRefusal) return { refusal: finalPolicyRefusal, result: null };
    try {
      const completed = readLane(candidate.lane.packetId!);
      if (!completed || completed.status !== 'completed') throw new Error('Automatic parking requires a completed lane.');
      const proof = assertSettledCompletedWorkspace(completed);
      const assertPolicyCurrent = async () => {
        const policy = await readPolicy();
        if (policy) throw new Error(policy);
        const volume = await candidateVolumeRefusal(candidate.volumePath, heldVolumeId, observeVolume);
        if (volume) throw new Error(volume);
        const current = readLane(candidate.lane.packetId!);
        if (!current || current.id !== completed.id) throw new Error('Automatic parking owner changed.');
        assertSettledCompletedWorkspace(current, proof);
      };
      return {
        refusal: null,
        result: await park({
          repositoryUuid: candidate.repo!.id,
          packetId: candidate.lane.packetId!,
          operationId: candidate.operationId,
          assertPolicyCurrent,
        }),
      };
    } catch (error) {
      return {
        refusal: `park_call_failed: ${error instanceof Error ? error.message : String(error)}`,
        result: null,
      };
    }
  });
}

async function candidateVolumeRefusal(
  candidatePath: string | null,
  heldVolumeId: string | null,
  observeVolume: NonNullable<StoragePressureDependencies['observeVolume']>,
): Promise<string | null> {
  if (!heldVolumeId) return 'reservation_volume_unknown';
  if (!candidatePath) return 'workspace_volume_unknown';
  try {
    const observed = await observeVolume(candidatePath);
    if (observed.status !== 'observed' || !observed.volumeId) return 'workspace_volume_unknown';
    if (observed.volumeId !== heldVolumeId) return 'workspace_volume_mismatch';
  } catch {
    return 'workspace_volume_unknown';
  }
  return null;
}

async function buildCandidates(
  packet: OrchestratorPacket,
  generation: number,
  heldVolumeId: string | null,
  dependencies: Required<Pick<StoragePressureDependencies, 'listLanes' | 'listRepos' | 'measureAllocatedBytes' | 'observeVolume'>>,
  getSnapshot: typeof getWorkspaceSnapshot,
  selectedMode: 'manual' | 'pressure',
): Promise<PressureCandidate[]> {
  const repos = await dependencies.listRepos();
  const lanes = dependencies.listLanes()
    .filter((lane) => lane.packetId && (lane.status === 'completed' || (selectedMode === 'manual' && lane.status === 'reviewing')))
    .sort((left, right) => (
      new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()
      || left.packetId!.localeCompare(right.packetId!)
      || left.id.localeCompare(right.id)
    ));

  return Promise.all(lanes.map(async (lane, index): Promise<PressureCandidate> => {
    const ordinal = index + 1;
    const operationId = `packet-storage-pressure:${packet.id}:${generation}:${ordinal}:${lane.packetId}`;
    const repo = exactRepoForLane(lane, repos);
    let refusal: string | null = null;
    if (lane.packetId === packet.id) refusal = 'currently_admitted_packet';
    else if (lane.ownership !== 'managed') refusal = 'lane_not_managed';
    else if (!lane.worktreePath || !lane.sessionKey) refusal = 'workspace_identity_incomplete';
    else if (!repo) refusal = 'repository_not_registered';
    else if (repo.storagePressureParkingDisabled) refusal = 'repository_opted_out';
    if (!refusal && selectedMode === 'pressure') {
      try { assertSettledCompletedWorkspace(lane); }
      catch { refusal = 'completed_settled_owner_required'; }
    }

    let snapshot = null;
    if (repo && lane.packetId && !refusal) {
      try {
        snapshot = getSnapshot(repo.id, lane.packetId);
      } catch {
        refusal = 'snapshot_accounting_unknown';
      }
    }
    const exactParkReplay = snapshot?.state === 'parked'
      && snapshot.lastTransitionId === `${operationId}:parked`;
    const volumePath = exactParkReplay ? snapshot?.originalPath ?? null : lane.worktreePath;
    if (!refusal) {
      refusal = await candidateVolumeRefusal(volumePath, heldVolumeId, dependencies.observeVolume);
    }
    let measuredAllocatedBytes: number | null = null;
    if (!refusal && !exactParkReplay) {
      try {
        const measured = await dependencies.measureAllocatedBytes(lane.worktreePath!);
        measuredAllocatedBytes = Number.isSafeInteger(measured) && measured! >= 0 ? measured : null;
      } catch {
        measuredAllocatedBytes = null;
      }
      if (measuredAllocatedBytes === null) refusal = 'workspace_accounting_unknown';
    }
    return {
      lane,
      repo,
      operationId,
      ordinal,
      measuredAllocatedBytes,
      refusal,
      exactParkReplay,
      volumePath,
    };
  }));
}

function pressureOnly(error: unknown): error is PacketStorageAdmissionError {
  return error instanceof PacketStorageAdmissionError && error.receipt.reason === 'reserve_breached';
}

export function projectStoragePressurePolicy(
  repos: Array<Pick<RepoRegistryEntry, 'storagePressureParkingDisabled'>>,
  mode = getOperatorDefaultsSync().values.workspaceParkingMode,
): StoragePressureProjection {
  const optedOutRepositories = repos.filter((repo) => repo.storagePressureParkingDisabled).length;
  return {
    mode,
    automaticParkingEnabled: mode !== 'manual',
    eligibleRepositories: repos.length - optedOutRepositories,
    optedOutRepositories,
  };
}

export function createStoragePressureAdmissionCoordinator(
  base: PacketStorageAdmissionCoordinator,
  overrides: StoragePressureDependencies = {},
): PacketStorageAdmissionCoordinator {
  const now = overrides.now ?? Date.now;
  // On-settle parking also answers dispatch pressure; receipts stay manual or pressure.
  const mode = overrides.mode ?? (() => (
    getOperatorDefaultsSync().values.workspaceParkingMode === 'manual' ? 'manual' : 'pressure'
  ));
  const dependencies = {
    listLanes: overrides.listLanes ?? listLanes,
    listRepos: overrides.listRepos ?? listReposFresh,
    measureAllocatedBytes: overrides.measureAllocatedBytes ?? defaultMeasureAllocatedBytes,
    observeVolume: overrides.observeVolume ?? ((targetPath) => observeStorageVolume(targetPath)),
  };
  const park = overrides.parkWorkspace ?? ((input) => parkWorkspace(input));
  const readSnapshot = overrides.getSnapshot ?? getWorkspaceSnapshot;
  const readReclaimed = overrides.readParkedReclaimedBytes ?? defaultReadParkedReclaimedBytes;
  const readLane = (packetId: string) => dependencies.listLanes().filter(lane => lane.packetId === packetId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

  return {
    ...(base.prepareCreationBase ? {
      prepareCreationBase: base.prepareCreationBase.bind(base),
    } : {}),
    async reserveForLaunch(packet, _pressureRetryOrdinal, context) {
      let held: PacketStorageAdmissionError;
      try {
        return await base.reserveForLaunch(packet, 0, context);
      } catch (error) {
        if (!pressureOnly(error)) throw error;
        held = error;
      }

      const selectedMode = mode();
      let candidates: PressureCandidate[];
      try {
        candidates = await buildCandidates(
          packet,
          held.receipt.ownerGeneration,
          held.receipt.volumeId,
          dependencies,
          readSnapshot,
          selectedMode,
        );
      } catch {
        throw new PacketStorageAdmissionError(
          'Dispatch held because storage-pressure candidate accounting is unknown.',
          withPressure(held.receipt, pressureReceipt(
            selectedMode, selectedMode === 'manual' ? 'manual_review' : 'exhausted',
            packet, held.receipt.ownerGeneration, [], now(),
          )),
        );
      }
      if (selectedMode === 'manual') {
        const receipts = candidates.map((candidate) => (
          candidate.refusal
            ? candidateReceipt(candidate, 'refused', candidate.refusal)
            : candidateReceipt(candidate, 'candidate', 'manual_action_required')
        ));
        const pressure = pressureReceipt(
          'manual', 'manual_review', packet, held.receipt.ownerGeneration, receipts, now(),
        );
        const candidateSummary = storagePressureCandidateSummary(pressure);
        throw new PacketStorageAdmissionError(
          candidateSummary ? `${held.message} ${candidateSummary}` : held.message,
          withPressure(held.receipt, pressure),
        );
      }
      const receipts: OrchestratorStoragePressureCandidateReceipt[] = [];
      for (const candidate of candidates) {
        if (candidate.refusal) {
          receipts.push(candidateReceipt(candidate, 'refused', candidate.refusal));
          continue;
        }
        let outcome: 'parked' | 'already_parked';
        if (candidate.exactParkReplay) {
          const replayPolicy = await parkWithFreshPolicy(
            candidate,
            held.receipt.volumeId,
            mode,
            dependencies.listRepos,
            dependencies.observeVolume,
            async () => ({ status: 'already_parked', snapshot: readSnapshot(
              candidate.repo!.id,
              candidate.lane.packetId!,
            )! }),
            readLane,
          );
          if (replayPolicy.refusal) {
            receipts.push(candidateReceipt(candidate, 'refused', replayPolicy.refusal));
            continue;
          }
          outcome = 'already_parked';
        } else {
          const guardedPark = await parkWithFreshPolicy(
            candidate,
            held.receipt.volumeId,
            mode,
            dependencies.listRepos,
            dependencies.observeVolume,
            park,
            readLane,
          );
          if (guardedPark.refusal || !guardedPark.result) {
            receipts.push(candidateReceipt(candidate, 'refused', guardedPark.refusal ?? 'park_call_failed'));
            continue;
          }
          const result = guardedPark.result;
          if (result.status === 'refused') {
            receipts.push(candidateReceipt(candidate, 'refused', result.note));
            continue;
          }
          outcome = result.status;
        }
        let reclaimed: number | null = null;
        try {
          reclaimed = readReclaimed(
            candidate.repo!.id,
            candidate.lane.packetId!,
            candidate.operationId,
          );
        } catch { /* no physical-byte claim without a readable receipt */ }
        receipts.push(candidateReceipt(candidate, outcome, 'verified_park_receipt', reclaimed));

        try {
          const lease = await base.reserveForLaunch(packet, candidate.ordinal, context);
          lease.receipt = withPressure(
            lease.receipt,
            pressureReceipt(
              'pressure', 'admitted_after_parking', packet,
              lease.receipt.ownerGeneration, receipts, now(),
            ),
          );
          return lease;
        } catch (error) {
          if (!pressureOnly(error)) {
            if (error instanceof PacketStorageAdmissionError) held = error;
            break;
          }
          held = error;
        }
      }

      throw new PacketStorageAdmissionError(
        'Dispatch held after storage pressure parking could not create enough verified headroom.',
        withPressure(held.receipt, pressureReceipt(
          'pressure', 'exhausted', packet, held.receipt.ownerGeneration, receipts, now(),
        )),
      );
    },
    commitAfterLaunch: (lease: PacketStorageAdmissionLease) => base.commitAfterLaunch(lease),
    settleFailedLaunch: (packet, lease) => base.settleFailedLaunch(packet, lease),
  };
}

let defaultCoordinator: PacketStorageAdmissionCoordinator | null = null;

export function getStoragePressureAdmissionCoordinator(): PacketStorageAdmissionCoordinator {
  defaultCoordinator ??= createStoragePressureAdmissionCoordinator(
    getPacketStorageAdmissionCoordinator(),
  );
  return defaultCoordinator;
}
