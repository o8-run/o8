import 'server-only';

import path from 'node:path';
import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { findLaneByPacket, findLaneByRepoAndBranch } from '@/lib/lane/registry';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { listDurablePacketsWithId } from '@/lib/orchestrator/mission-registry';
import type {
  OrchestratorPacket,
  OrchestratorPacketStorageAdmission,
} from '@/lib/orchestrator/types';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import {
  observeManagedWorktreeRootIdentity,
  resolveManagedWorktreeStorageTarget,
} from '@/lib/worktree/root-layout';
import {
  DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS,
  observeStorageVolume,
  storageObservationFailureReason,
  StorageAdmissionStore,
  type StorageAdmissionResult,
  type StorageReservationRecord,
} from '@/lib/workspace/storage-admission';
import {
  durableStorageLaunchGeneration,
} from './storage-admission-generation';
import { resolvePacketCheckout } from './storage-admission-owner-liveness';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  observeRepoStorageEstimate,
  observeRepoWorkspacePaths,
  type RepoStorageEstimate,
} from './storage-estimate';
import { storageAdmissionHeldMessage } from './storage-admission-held-message';

export { observeRepoStorageEstimate } from './storage-estimate';
export type { RepoStorageEstimate } from './storage-estimate';

import { withIdempotency } from './idempotency-store';
import { assertPacketCreationBaseAuthority, existingPacketCreationBase, resolvePacketCreationBase, type PacketCreationBaseAuthority, type PacketCreationBaseInput } from '@/lib/lane/packet-creation-base';

const GIB = 1024 * 1024 * 1024;
const LAUNCH_RESERVATION_LEASE_MS = 24 * 60 * 60_000;

export type PacketStorageAdmissionState = OrchestratorPacketStorageAdmission['state'];
export type PacketStorageAdmissionReceipt = OrchestratorPacketStorageAdmission;

export interface PacketStorageAdmissionLease {
  receipt: PacketStorageAdmissionReceipt;
  reservation: StorageReservationRecord;
  baselineWorkspacePaths: string[] | null;
}

export interface PacketStorageCreationContext {
  creationBaseCommit: string;
}

export interface PacketStorageAdmissionCoordinator {
  prepareCreationBase?(packet: OrchestratorPacket, input: PacketCreationBaseInput): Promise<PacketCreationBaseAuthority>;
  reserveForLaunch(packet: OrchestratorPacket, pressureRetryOrdinal?: number, context?: PacketStorageCreationContext): Promise<PacketStorageAdmissionLease>;
  commitAfterLaunch(lease: PacketStorageAdmissionLease): Promise<PacketStorageAdmissionReceipt>;
  settleFailedLaunch(
    packet: OrchestratorPacket,
    lease: PacketStorageAdmissionLease,
  ): Promise<PacketStorageAdmissionReceipt>;
}

export interface PacketStorageAdmissionReconciliationResult {
  inspected: number;
  reconciled: number;
  retainedLive: number;
  retainedUnknown: number;
  held: number;
}

export interface PacketStorageAdmissionOwnerResolution {
  liveness: 'dead' | 'alive' | 'unknown';
  source: string;
  evidence: string;
}

export interface AdmissionCoordinatorDependencies {
  sqlite?: Database.Database;
  store?: StorageAdmissionStore;
  now?: () => number;
  observeEstimate?: (repoPath: string, context?: PacketStorageCreationContext) => Promise<RepoStorageEstimate>;
  observeWorkspacePaths?: (repoPath: string) => Promise<string[]>;
  resolveReservationTarget?: (repoPath: string) => string;
  observeRootIdentity?: typeof observeManagedWorktreeRootIdentity;
  observeReservationVolume?: typeof observeStorageVolume;
  resolvePolicy?: () => { reserveRatio: number; absoluteFloorBytes: number };
}

interface StoredMutationRow {
  result_json: string;
}

export class PacketStorageAdmissionError extends Error {
  constructor(
    message: string,
    public readonly receipt: PacketStorageAdmissionReceipt,
  ) {
    super(message);
    this.name = 'PacketStorageAdmissionError';
  }
}

function receiptFromResult(
  result: StorageAdmissionResult,
  input: {
    state?: PacketStorageAdmissionState;
    ownerId: string;
    ownerGeneration: number;
    estimateBytes: number;
    estimateSource: PacketStorageAdmissionReceipt['estimateSource'];
    historySamples: number;
    reservationId: string;
    pressure?: PacketStorageAdmissionReceipt['pressure'];
  },
): PacketStorageAdmissionReceipt {
  const state = input.state ?? (result.decision === 'reserved' ? 'reserved' : 'held');
  return {
    schema: 'o8/packet-storage-admission/v1',
    state,
    reason: result.reason,
    reservationId: input.reservationId,
    mutationId: result.mutationId,
    ownerId: input.ownerId,
    ownerGeneration: input.ownerGeneration,
    estimateBytes: input.estimateBytes,
    estimateSource: input.estimateSource,
    historySamples: input.historySamples,
    volumeId: result.reservation?.volumeId ?? result.observation?.volumeId ?? null,
    physicalAvailableBytes: result.observation?.availableBytes ?? null,
    reservedBeforeBytes: result.activeReservedBytes,
    requiredReserveBytes: result.requiredReserveBytes,
    dispatchHeadroomBytes: result.headroomBytes,
    pressure: input.pressure ?? null,
    recordedAt: result.recordedAt,
  };
}

function mutationSuffix(pressureRetryOrdinal: number): string {
  return pressureRetryOrdinal > 0 ? `:pressure:${pressureRetryOrdinal}` : '';
}

function unknownEstimateReceipt(
  packet: OrchestratorPacket,
  launchGeneration: number,
  pressureRetryOrdinal: number,
  error: string,
  recordedAt: number,
  reasonPrefix = 'estimate_unknown',
): PacketStorageAdmissionReceipt {
  const suffix = mutationSuffix(pressureRetryOrdinal);
  const reservationId = `packet-storage:${packet.id}:${launchGeneration}${suffix}`;
  return {
    schema: 'o8/packet-storage-admission/v1',
    state: 'held',
    reason: `${reasonPrefix}: ${error}`,
    reservationId,
    mutationId: `packet-storage-reserve:${packet.id}:${launchGeneration}${suffix}`,
    ownerId: packet.id,
    ownerGeneration: launchGeneration,
    estimateBytes: 0,
    estimateSource: 'unknown',
    historySamples: 0,
    volumeId: null,
    physicalAvailableBytes: null,
    reservedBeforeBytes: null,
    requiredReserveBytes: null,
    dispatchHeadroomBytes: null,
    pressure: null,
    recordedAt,
  };
}

function priorMutationResult(sqlite: Database.Database, mutationId: string): StorageAdmissionResult | null {
  const row = sqlite.prepare(
    'SELECT result_json FROM storage_admission_mutations WHERE mutation_id = ?',
  ).get(mutationId) as StoredMutationRow | undefined;
  return row ? { ...(JSON.parse(row.result_json) as Omit<StorageAdmissionResult, 'idempotent'>), idempotent: true } : null;
}

function reserveReplayIdentityFailure(
  result: StorageAdmissionResult,
  input: {
    mutationId: string;
    reservationId: string;
    ownerId: string;
    ownerGeneration: number;
    targetPath: string;
  },
): string | null {
  if (result.operation !== 'reserve' || result.mutationId !== input.mutationId) {
    return 'reservation_mutation_conflict';
  }
  const reservation = result.reservation;
  if (!reservation) return null;
  if (
    reservation.reservationId !== input.reservationId
    || reservation.ownerId !== input.ownerId
    || reservation.ownerGeneration !== input.ownerGeneration
    || path.resolve(reservation.targetPath) !== path.resolve(input.targetPath)
  ) {
    return 'reservation_identity_conflict';
  }
  return null;
}

function authoritativeReplayDisposition(
  historical: StorageReservationRecord,
  current: StorageReservationRecord | null,
  input: {
    reservationId: string;
    ownerId: string;
    ownerGeneration: number;
    targetPath: string;
    replayedAt: number;
    exactPacketReceipt: PacketStorageAdmissionReceipt | null;
  },
): { decision: 'reserved' | 'committed' | 'held'; reason: string } {
  if (!current) return { decision: 'held', reason: 'reservation_missing' };
  if (
    current.reservationId !== input.reservationId
    || current.volumeId !== historical.volumeId
    || current.ownerId !== input.ownerId
    || current.ownerGeneration !== input.ownerGeneration
    || current.exactBytes !== historical.exactBytes
    || path.resolve(current.targetPath) !== path.resolve(input.targetPath)
  ) {
    return { decision: 'held', reason: 'reservation_conflict' };
  }
  if (input.exactPacketReceipt?.state === 'quarantined') {
    return { decision: 'held', reason: 'launch_effect_unknown' };
  }
  if (current.state === 'reserved') {
    if (!Number.isSafeInteger(current.leaseExpiresAt) || current.leaseExpiresAt <= input.replayedAt) {
      return { decision: 'held', reason: 'lease_expired' };
    }
    return current.generation === historical.generation
      ? { decision: 'reserved', reason: 'admitted' }
      : { decision: 'held', reason: 'generation_conflict' };
  }
  const expectedCommitMutation = `packet-storage-commit:${current.ownerId}:${current.ownerGeneration}`;
  if (
    current.state === 'committed'
    && current.generation === historical.generation + 1
    && current.lastMutationId === expectedCommitMutation
    && current.lastReason === 'committed'
    && current.terminalAt !== null
    && current.postMeasurement !== null
  ) {
    return { decision: 'committed', reason: 'committed' };
  }
  return { decision: 'held', reason: `state_conflict:${current.state}` };
}

export function createPacketStorageAdmissionCoordinator(
  dependencies: AdmissionCoordinatorDependencies = {},
): PacketStorageAdmissionCoordinator {
  const sqlite = dependencies.sqlite ?? getSqlite();
  const store = dependencies.store ?? new StorageAdmissionStore(sqlite);
  const now = dependencies.now ?? Date.now;
  const estimate = dependencies.observeEstimate ?? ((repoPath: string, context?: PacketStorageCreationContext) => (
    observeRepoStorageEstimate(repoPath, { creationBaseCommit: context?.creationBaseCommit })
  ));
  const paths = dependencies.observeWorkspacePaths ?? observeRepoWorkspacePaths;
  const resolveReservationTarget = dependencies.resolveReservationTarget
    ?? resolveManagedWorktreeStorageTarget;
  const observeReservationVolume = dependencies.observeReservationVolume ?? observeStorageVolume;
  const observeRootIdentity = dependencies.observeRootIdentity ?? observeManagedWorktreeRootIdentity;
  const resolvePolicy = dependencies.resolvePolicy ?? (() => {
    const values = getOperatorDefaultsSync().values;
    return {
      reserveRatio: values.storageReserveRatio,
      absoluteFloorBytes: Math.round(values.storageReserveFloorGb * GIB),
    };
  });

  return {
    async prepareCreationBase(packet, input) {
      await reconcileExpiredPacketStorageReservations({ store, now });
      const existing = existingPacketCreationBase(input);
      if (existing) return existing;
      const generation = await durableStorageLaunchGeneration(packet, store);
      const key = `packet-storage-creation-base:${packet.id}:${generation}`;
      const prior = getSqlite().prepare('SELECT result_json, expires_at FROM idempotency_keys WHERE key = ?')
        .get(key) as { result_json: string | null; expires_at: number } | undefined;
      if (prior?.result_json && prior.expires_at > now()) {
        const authority = JSON.parse(prior.result_json) as PacketCreationBaseAuthority;
        assertPacketCreationBaseAuthority(authority, input);
        return Object.freeze(authority);
      }
      const reservation = store.getLatestReservationForOwner(packet.id);
      if (reservation?.ownerGeneration === generation) {
        throw new Error('Existing storage reservation has no immutable creation base receipt.');
      }
      const outcome = await withIdempotency({
        key, verb: 'packet_storage_creation_base', scopeId: packet.id,
        ttlMs: LAUNCH_RESERVATION_LEASE_MS, attachToInFlight: true,
        reconcileUnresolved: async () => {
          // A dead preparation owner cannot have launched before persisting this
          // receipt. Prove no later effect exists before repeating the ref read.
          if (store.getLatestReservationForOwner(packet.id)?.ownerGeneration === generation
            || findLaneByRepoAndBranch(input.repoPath, input.branch)) return null;
          return resolvePacketCreationBase(input);
        },
      }, () => resolvePacketCreationBase(input));
      if (outcome.inProgress || outcome.persistenceDegraded) {
        throw new Error('Packet creation base receipt could not be durably resolved.');
      }
      assertPacketCreationBaseAuthority(outcome.result, input);
      return Object.freeze(outcome.result);
    },
    async reserveForLaunch(packet, pressureRetryOrdinal = 0, context) {
      if (!packet.workspaceTargetPath) {
        throw new Error('Packet has no workspace target for storage admission.');
      }
      await reconcileExpiredPacketStorageReservations({ store, now });
      const launchGeneration = await durableStorageLaunchGeneration(packet, store);
      if (!Number.isSafeInteger(pressureRetryOrdinal) || pressureRetryOrdinal < 0) {
        throw new Error('Pressure retry ordinal must be a non-negative safe integer.');
      }
      const suffix = mutationSuffix(pressureRetryOrdinal);
      const reservationId = `packet-storage:${packet.id}:${launchGeneration}${suffix}`;
      const mutationId = `packet-storage-reserve:${packet.id}:${launchGeneration}${suffix}`;
      let reservationTargetPath: string;
      try {
        reservationTargetPath = path.resolve(resolveReservationTarget(packet.workspaceTargetPath));
      } catch (error) {
        const receipt = unknownEstimateReceipt(
          packet, launchGeneration, pressureRetryOrdinal,
          error instanceof Error ? error.message : String(error), now(), 'workspace_target_unknown',
        );
        throw new PacketStorageAdmissionError(
          'Dispatch held because the managed workspace storage target is unknown.', receipt,
        );
      }
      const replay = priorMutationResult(sqlite, mutationId);
      if (replay) {
        const identityFailure = reserveReplayIdentityFailure(replay, {
          mutationId,
          reservationId,
          ownerId: packet.id,
          ownerGeneration: launchGeneration,
          targetPath: reservationTargetPath,
        });
        const exactPacketReceipt = packet.storageAdmission?.mutationId === mutationId
          && packet.storageAdmission.reservationId === reservationId
          && packet.storageAdmission.ownerId === packet.id
          && packet.storageAdmission.ownerGeneration === launchGeneration
          ? packet.storageAdmission
          : null;
        const historicalReservation = replay.reservation;
        const currentReservation = historicalReservation
          ? store.getReservation(reservationId)
          : null;
        const probeStartedAt = now();
        let liveVolume: Awaited<ReturnType<typeof observeReservationVolume>> | null = null;
        let probeFailed = false;
        if (!identityFailure && historicalReservation && currentReservation) {
          try {
            liveVolume = await observeReservationVolume(reservationTargetPath);
          } catch {
            probeFailed = true;
          }
        }
        const decisionAt = now();
        const decisionClockValid = Number.isSafeInteger(probeStartedAt)
          && Number.isSafeInteger(decisionAt)
          && decisionAt >= probeStartedAt;
        let disposition = identityFailure
          ? { decision: 'held' as const, reason: identityFailure }
          : historicalReservation && currentReservation && decisionClockValid
          ? authoritativeReplayDisposition(historicalReservation, currentReservation, {
              reservationId,
              ownerId: packet.id,
              ownerGeneration: launchGeneration,
              targetPath: reservationTargetPath,
              replayedAt: decisionAt,
              exactPacketReceipt,
            })
          : { decision: 'held' as const, reason: replay.reason };
        if (!decisionClockValid) {
          disposition = { decision: 'held', reason: 'observation_stale' };
        } else if (disposition.decision !== 'held' && currentReservation) {
          const observationFailure = liveVolume
            ? storageObservationFailureReason(
                liveVolume,
                probeStartedAt,
                decisionAt,
                DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS,
              )
            : 'accounting_unknown';
          if (probeFailed || observationFailure) {
            disposition = { decision: 'held', reason: observationFailure ?? 'accounting_unknown' };
          } else if (liveVolume!.volumeId !== currentReservation.volumeId) {
            disposition = { decision: 'held', reason: 'volume_conflict' };
          }
        }
        let receipt = receiptFromResult(replay, {
          ownerId: packet.id,
          ownerGeneration: launchGeneration,
          estimateBytes: historicalReservation?.exactBytes ?? exactPacketReceipt?.estimateBytes ?? 0,
          estimateSource: exactPacketReceipt?.estimateSource ?? 'unknown',
          historySamples: exactPacketReceipt?.historySamples ?? 0,
          reservationId,
        });
        if (disposition.decision === 'held' || !currentReservation) {
          receipt = {
            ...receipt,
            state: 'held',
            reason: disposition.reason,
            recordedAt: decisionClockValid ? decisionAt : replay.recordedAt,
          };
          throw new PacketStorageAdmissionError(
            // Same policy the first hold explained with, so a replayed hold
            // reads identically instead of degrading to the vague summary.
            storageAdmissionHeldMessage(
              receipt,
              sqlite,
              resolvePolicy(),
            ),
            receipt,
          );
        }
        if (disposition.decision === 'committed') {
          return {
            receipt: { ...receipt, state: 'committed', reason: 'committed', recordedAt: currentReservation.updatedAt },
            reservation: currentReservation,
            baselineWorkspacePaths: null,
          };
        }
        let baselineWorkspacePaths: string[] | null = null;
        try {
          baselineWorkspacePaths = await paths(packet.workspaceTargetPath);
        } catch {
          baselineWorkspacePaths = null;
        }
        return {
          receipt,
          reservation: currentReservation,
          baselineWorkspacePaths,
        };
      }

      const observed = await estimate(packet.workspaceTargetPath, context);
      if (observed.status !== 'observed' || observed.exactBytes === null) {
        const receipt = unknownEstimateReceipt(
          packet,
          launchGeneration,
          pressureRetryOrdinal,
          observed.error ?? 'No safe workspace estimate is available.',
          now(),
        );
        throw new PacketStorageAdmissionError(
          'Dispatch held because workspace growth accounting is unknown.',
          receipt,
        );
      }
      let rootIdentity;
      try {
        rootIdentity = await observeRootIdentity(packet.workspaceTargetPath);
      } catch (error) {
        throw new PacketStorageAdmissionError(
          'Dispatch held because the managed worktree root identity is unknown.',
          unknownEstimateReceipt(
            packet, launchGeneration, pressureRetryOrdinal,
            error instanceof Error ? error.message : String(error), now(), 'workspace_target_unknown',
          ),
        );
      }
      const policy = resolvePolicy();
      const result = await store.reserve({
        mutationId,
        reservationId,
        targetPath: reservationTargetPath,
        rootIdentity,
        exactBytes: observed.exactBytes,
        ownerId: packet.id,
        ownerGeneration: launchGeneration,
        leaseExpiresAt: now() + LAUNCH_RESERVATION_LEASE_MS,
        policy,
      });
      const receipt = receiptFromResult(result, {
        ownerId: packet.id,
        ownerGeneration: launchGeneration,
        estimateBytes: observed.exactBytes,
        estimateSource: observed.source,
        historySamples: observed.historySamples,
        reservationId,
      });
      if (result.decision !== 'reserved' || !result.reservation) {
        throw new PacketStorageAdmissionError(
          storageAdmissionHeldMessage(
            receipt,
            sqlite,
            policy,
          ),
          receipt,
        );
      }
      return {
        receipt,
        reservation: result.reservation,
        baselineWorkspacePaths: observed.workspacePaths,
      };
    },

    async commitAfterLaunch(lease) {
      const reservation = lease.reservation;
      if (reservation.state === 'committed' && lease.receipt.state === 'committed') {
        return lease.receipt;
      }
      try {
        const result = await store.commit({
          mutationId: `packet-storage-commit:${reservation.ownerId}:${reservation.ownerGeneration}`,
          reservationId: reservation.reservationId,
          volumeId: reservation.volumeId,
          ownerId: reservation.ownerId,
          ownerGeneration: reservation.ownerGeneration,
          expectedGeneration: reservation.generation,
        });
        return receiptFromResult(result, {
          ...lease.receipt,
          state: result.decision === 'committed' ? 'committed' : 'quarantined',
        });
      } catch (error) {
        return {
          ...lease.receipt,
          state: 'quarantined',
          reason: `post_launch_accounting_failed: ${error instanceof Error ? error.message : String(error)}`,
          recordedAt: now(),
        };
      }
    },

    async settleFailedLaunch(packet, lease) {
      const reservation = lease.reservation;
      if (reservation.state === 'committed') {
        return {
          ...lease.receipt,
          state: 'quarantined',
          reason: 'committed_launch_reentry_failed',
          recordedAt: now(),
        };
      }
      let provenPreEffect = false;
      try {
        const [currentPaths, lane] = await Promise.all([
          paths(packet.workspaceTargetPath!),
          Promise.resolve(findLaneByPacket(packet.id)),
        ]);
        provenPreEffect = lease.baselineWorkspacePaths !== null
          && JSON.stringify(currentPaths) === JSON.stringify(lease.baselineWorkspacePaths)
          && !lane?.worktreePath
          && !lane?.sessionKey;
      } catch {
        provenPreEffect = false;
      }
      if (!provenPreEffect) {
        return { ...lease.receipt, state: 'quarantined', reason: 'launch_effect_unknown', recordedAt: now() };
      }
      try {
        const result = await store.release({
          mutationId: `packet-storage-release:${reservation.ownerId}:${reservation.ownerGeneration}`,
          reservationId: reservation.reservationId,
          volumeId: reservation.volumeId,
          ownerId: reservation.ownerId,
          ownerGeneration: reservation.ownerGeneration,
          expectedGeneration: reservation.generation,
        });
        return receiptFromResult(result, {
          ...lease.receipt,
          state: result.decision === 'released' ? 'released' : 'quarantined',
        });
      } catch (error) {
        return {
          ...lease.receipt,
          state: 'quarantined',
          reason: `release_accounting_failed: ${error instanceof Error ? error.message : String(error)}`,
          recordedAt: now(),
        };
      }
    },
  };
}

export async function resolveDurablePacketStorageOwner(
  reservation: StorageReservationRecord,
  durablePackets?: OrchestratorPacket[],
): Promise<PacketStorageAdmissionOwnerResolution> {
  if (reservation.ownerId.startsWith('managed-worktree-process:')) {
    const [, rawPid, rawIdentity] = reservation.ownerId.split(':');
    const pid = Number(rawPid);
    let identity: unknown;
    try {
      identity = JSON.parse(Buffer.from(rawIdentity ?? '', 'base64url').toString('utf8')) as unknown;
    } catch {
      identity = null;
    }
    if (!Number.isInteger(pid) || pid <= 0 || !isMetadataLockProcessIdentity(identity)) {
      return { liveness: 'unknown', source: 'managed-worktree-process', evidence: 'The direct worktree owner identity is invalid.' };
    }
    const probe = await probeMetadataLockProcessIdentity(pid);
    if (probe.state === 'absent' || (probe.state === 'live' && !sameMetadataLockProcessIdentity(probe.identity, identity))) {
      return { liveness: 'dead', source: 'managed-worktree-process', evidence: 'The exact direct worktree owner process ended.' };
    }
    if (probe.state === 'live') {
      return { liveness: 'alive', source: 'managed-worktree-process', evidence: 'The exact direct worktree owner process is still live.' };
    }
    return { liveness: 'unknown', source: 'managed-worktree-process', evidence: probe.detail };
  }
  const matches = durablePackets
    ? durablePackets.filter((packet) => packet.id === reservation.ownerId)
    : listDurablePacketsWithId(reservation.ownerId);
  if (matches.length !== 1) {
    return {
      liveness: 'unknown',
      source: 'packet-generation',
      evidence: matches.length === 0
        ? 'No unique durable packet owner exists.'
        : 'More than one durable packet claims the reservation owner id.',
    };
  }
  const ownerPacket = matches[0]!;
  const current = ownerPacket.storageAdmission;
  if (
    current
    && current.ownerId === reservation.ownerId
    && current.ownerGeneration > reservation.ownerGeneration
    && current.reservationId !== reservation.reservationId
  ) {
    return {
      liveness: 'dead',
      source: 'packet-generation',
      evidence: `Durable admission ${current.reservationId} generation ${current.ownerGeneration} superseded generation ${reservation.ownerGeneration}.`,
    };
  }
  if (
    current
    && current.ownerId === reservation.ownerId
    && current.ownerGeneration === reservation.ownerGeneration
    && current.reservationId === reservation.reservationId
  ) {
    const terminal = packetTerminalState(ownerPacket);
    if (terminal) {
      const checkout = await resolvePacketCheckout(ownerPacket);
      if (checkout.state === 'absent') {
        return {
          liveness: 'dead',
          source: 'terminal-packet-checkout',
          evidence: `The durable packet is ${terminal} and its checkout is confirmed absent. ${checkout.evidence}`,
        };
      }
      if (checkout.state === 'unknown') {
        return {
          liveness: 'unknown',
          source: 'terminal-packet-checkout',
          evidence: `The durable packet is ${terminal}, but checkout absence is unproved. ${checkout.evidence}`,
        };
      }
      return {
        liveness: 'alive',
        source: 'terminal-packet-checkout',
        evidence: `The durable packet is ${terminal}, but its checkout still exists. ${checkout.evidence}`,
      };
    }
    return {
      liveness: 'alive',
      source: 'packet-generation',
      evidence: 'The durable packet still names this exact admission generation.',
    };
  }
  return {
    liveness: 'unknown',
    source: 'packet-generation',
    evidence: 'Durable packet state does not prove that this exact admission owner was retired.',
  };
}

/**
 * Reconcile only expired reservations whose exact logical owner was superseded
 * by durable owner evidence. Lease expiry makes a row eligible for inspection;
 * it is not itself proof that a live or unknown owner stopped using storage.
 */
export async function reconcileExpiredPacketStorageReservations(
  dependencies: {
    store?: StorageAdmissionStore;
    now?: () => number;
    resolveOwner?: (
      reservation: StorageReservationRecord,
    ) => PacketStorageAdmissionOwnerResolution | Promise<PacketStorageAdmissionOwnerResolution>;
  } = {},
): Promise<PacketStorageAdmissionReconciliationResult> {
  const now = dependencies.now ?? Date.now;
  const store = dependencies.store ?? new StorageAdmissionStore(getSqlite(), { now });
  const resolveOwner = dependencies.resolveOwner ?? resolveDurablePacketStorageOwner;
  const expired = store.listExpiredForReconciliation(now());
  const summary: PacketStorageAdmissionReconciliationResult = {
    inspected: expired.length,
    reconciled: 0,
    retainedLive: 0,
    retainedUnknown: 0,
    held: 0,
  };

  for (const reservation of expired) {
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
    const result = await store.reconcile({
      mutationId: `packet-storage-reconcile:${reservation.reservationId}:${reservation.generation}:${observedAt}`,
      reservationId: reservation.reservationId,
      volumeId: reservation.volumeId,
      ownerId: reservation.ownerId,
      ownerGeneration: reservation.ownerGeneration,
      expectedGeneration: reservation.generation,
      ownerLiveness: 'dead',
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
    if (result.decision === 'reconciled') summary.reconciled += 1;
    else summary.held += 1;
  }
  return summary;
}

let defaultCoordinator: PacketStorageAdmissionCoordinator | null = null;

export function getPacketStorageAdmissionCoordinator(): PacketStorageAdmissionCoordinator {
  defaultCoordinator ??= createPacketStorageAdmissionCoordinator();
  return defaultCoordinator;
}

export {
  readPacketStorageAdmissionProjection,
  type PacketStorageAdmissionProjection,
} from './storage-admission-projection';
export { packetStorageLaunchGeneration } from './storage-admission-generation';
