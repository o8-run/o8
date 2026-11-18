import 'server-only';
import { normalizeStorageDependencyCloneContract, type StorageDependencyCloneContract } from './storage-dependency-contract';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { measureHostVolume, resolveStorageVolumeId } from '@/lib/worktree/storage-telemetry';

// Keep a bounded critical margin; requested growth is reserved separately.
export const DEFAULT_STORAGE_RESERVE_RATIO = 0;
export const DEFAULT_STORAGE_RESERVE_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS = 30_000;

export type StorageReservationState = 'reserved' | 'committed' | 'released' | 'reconciled';
export type StorageAdmissionOperation = 'reserve' | 'commit' | 'release' | 'reconcile';
export type StorageAdmissionReason =
  | 'admitted'
  | 'accounting_unknown'
  | 'volume_identity_unknown'
  | 'observation_stale'
  | 'reserve_breached'
  | 'reservation_conflict'
  | 'reservation_missing'
  | 'state_conflict'
  | 'owner_conflict'
  | 'generation_conflict'
  | 'volume_conflict'
  | 'lease_expired'
  | 'lease_active'
  | 'owner_not_proven_dead'
  | 'committed'
  | 'released'
  | 'dead_owner_reconciled';

export interface StorageVolumeObservation {
  status: 'observed' | 'unknown';
  targetPath: string;
  probePath: string | null;
  volumeId: string | null;
  availableBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  observedAt: number;
  error: { code: string | null; message: string } | null;
}

export interface StorageAdmissionPolicy {
  reserveRatio?: number;
  absoluteFloorBytes?: number;
  observationMaxAgeMs?: number;
}

export interface StorageRootIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

export interface StorageReservationRecord {
  reservationId: string;
  volumeId: string;
  targetPath: string;
  rootIdentity?: StorageRootIdentity | null;
  exactBytes: number;
  ownerId: string;
  ownerGeneration: number;
  generation: number;
  state: StorageReservationState;
  leaseExpiresAt: number;
  preMeasurement: StorageVolumeObservation;
  postMeasurement: StorageVolumeObservation | null;
  lastMutationId: string;
  lastReason: string;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

export interface StorageAdmissionResult {
  dependencyCloneContract?: StorageDependencyCloneContract;
  operation: StorageAdmissionOperation;
  decision: 'reserved' | 'held' | 'committed' | 'released' | 'reconciled';
  reason: StorageAdmissionReason;
  mutationId: string;
  reservation: StorageReservationRecord | null;
  observation: StorageVolumeObservation | null;
  requiredReserveBytes: number | null;
  activeReservedBytes: number | null;
  headroomBytes: number | null;
  observedAvailableDeltaBytes: number | null;
  recordedAt: number;
  idempotent: boolean;
}

export interface ReserveStorageInput {
  dependencyCloneContract?: StorageDependencyCloneContract;
  mutationId: string;
  reservationId: string;
  targetPath: string;
  rootIdentity?: StorageRootIdentity | null;
  exactBytes: number;
  ownerId: string;
  ownerGeneration: number;
  leaseExpiresAt: number;
  policy?: StorageAdmissionPolicy;
}

interface ReservationMutationInput {
  mutationId: string;
  reservationId: string;
  volumeId: string;
  ownerId: string;
  ownerGeneration: number;
  expectedGeneration: number;
}

export type CommitStorageReservationInput = ReservationMutationInput;
export type ReleaseStorageReservationInput = ReservationMutationInput;

export interface OwnerDeathReceipt {
  source: string;
  evidence: string;
  observedAt: number;
  reservationId: string;
  volumeId: string;
  ownerId: string;
  ownerGeneration: number;
}

export interface ReconcileStorageReservationInput extends ReservationMutationInput {
  ownerLiveness: 'dead' | 'alive' | 'unknown';
  ownerDeathReceipt?: OwnerDeathReceipt | null;
}

export interface StorageAdmissionDependencies {
  now?: () => number;
  observeVolume?: (targetPath: string) => Promise<StorageVolumeObservation>;
}

interface ReservationRow {
  reservation_id: string;
  volume_id: string;
  target_path: string;
  root_identity_json: string | null;
  exact_bytes: number;
  owner_id: string;
  owner_generation: number;
  generation: number;
  state: StorageReservationState;
  lease_expires_at: number;
  pre_measurement_json: string;
  post_measurement_json: string | null;
  last_mutation_id: string;
  last_reason: string;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface MutationRow {
  request_hash: string;
  result_json: string;
}

type StoredStorageAdmissionResult = Omit<StorageAdmissionResult, 'idempotent'>;

export class StorageAdmissionInputError extends Error {}
export class StorageAdmissionMutationReuseError extends Error {}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new StorageAdmissionInputError(`${field} is required.`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StorageAdmissionInputError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function requestHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapReservation(row: ReservationRow): StorageReservationRecord {
  return {
    reservationId: row.reservation_id,
    volumeId: row.volume_id,
    targetPath: row.target_path,
    rootIdentity: row.root_identity_json ? parseJson<StorageRootIdentity>(row.root_identity_json) : null,
    exactBytes: row.exact_bytes,
    ownerId: row.owner_id,
    ownerGeneration: row.owner_generation,
    generation: row.generation,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    preMeasurement: parseJson(row.pre_measurement_json),
    postMeasurement: row.post_measurement_json ? parseJson(row.post_measurement_json) : null,
    lastMutationId: row.last_mutation_id,
    lastReason: row.last_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function unknownObservation(
  targetPath: string,
  observedAt: number,
  code: string | null,
  message: string,
): StorageVolumeObservation {
  return {
    status: 'unknown',
    targetPath,
    probePath: null,
    volumeId: null,
    availableBytes: null,
    freeBytes: null,
    totalBytes: null,
    observedAt,
    error: { code, message },
  };
}

export async function observeStorageVolume(
  targetPath: string,
  clock: () => number = Date.now,
): Promise<StorageVolumeObservation> {
  const resolvedPath = path.resolve(targetPath);
  const host = await measureHostVolume(resolvedPath);
  if (
    host.accountingStatus !== 'observed'
    || host.probePath === null
    || host.availableBytes === null
    || host.freeBytes === null
    || host.totalBytes === null
  ) {
    return unknownObservation(
      resolvedPath,
      clock(),
      host.error?.code ?? null,
      host.error?.message ?? 'Host volume accounting is unknown.',
    );
  }
  try {
    const volumeId = host.volumeId ?? await resolveStorageVolumeId(host.probePath);
    const observedAt = clock();
    return {
      status: 'observed',
      targetPath: resolvedPath,
      probePath: host.probePath,
      volumeId,
      availableBytes: host.availableBytes,
      freeBytes: host.freeBytes,
      totalBytes: host.totalBytes,
      observedAt,
      error: null,
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : null;
    return unknownObservation(
      resolvedPath,
      clock(),
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizePolicy(input: StorageAdmissionPolicy | undefined) {
  const reserveRatio = input?.reserveRatio ?? DEFAULT_STORAGE_RESERVE_RATIO;
  const absoluteFloorBytes = input?.absoluteFloorBytes ?? DEFAULT_STORAGE_RESERVE_FLOOR_BYTES;
  const observationMaxAgeMs = input?.observationMaxAgeMs
    ?? DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS;
  if (!Number.isFinite(reserveRatio) || reserveRatio < 0 || reserveRatio > 1) {
    throw new StorageAdmissionInputError('reserveRatio must be between 0 and 1.');
  }
  if (!Number.isSafeInteger(absoluteFloorBytes) || absoluteFloorBytes < 0) {
    throw new StorageAdmissionInputError('absoluteFloorBytes must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(observationMaxAgeMs) || observationMaxAgeMs <= 0) {
    throw new StorageAdmissionInputError('observationMaxAgeMs must be a positive safe integer.');
  }
  return { reserveRatio, absoluteFloorBytes, observationMaxAgeMs };
}

export function storageObservationFailureReason(
  observation: StorageVolumeObservation,
  probeStartedAt: number,
  decisionAt: number,
  maxAgeMs: number,
): StorageAdmissionReason | null {
  if (
    !Number.isSafeInteger(probeStartedAt)
    || !Number.isSafeInteger(decisionAt)
    || decisionAt < probeStartedAt
    || !Number.isSafeInteger(observation.observedAt)
  ) return 'observation_stale';
  if (observation.status !== 'observed') return 'accounting_unknown';
  if (!observation.volumeId) return 'volume_identity_unknown';
  if (
    observation.availableBytes === null
    || observation.freeBytes === null
    || observation.totalBytes === null
    || !Number.isSafeInteger(observation.availableBytes)
    || !Number.isSafeInteger(observation.freeBytes)
    || !Number.isSafeInteger(observation.totalBytes)
    || observation.availableBytes < 0
    || observation.freeBytes < observation.availableBytes
    || observation.totalBytes < observation.freeBytes
  ) return 'accounting_unknown';
  const age = decisionAt - observation.observedAt;
  if (observation.observedAt < probeStartedAt || age < 0 || age > maxAgeMs) {
    return 'observation_stale';
  }
  return null;
}

function requireMonotonicDecisionTime(probeStartedAt: number, decisionAt: number): void {
  if (
    !Number.isSafeInteger(probeStartedAt)
    || !Number.isSafeInteger(decisionAt)
    || decisionAt < probeStartedAt
  ) {
    throw new StorageAdmissionInputError(
      'Storage admission clock must remain monotonic while a volume probe is running.',
    );
  }
}

function withReplay(result: StoredStorageAdmissionResult): StorageAdmissionResult {
  return { ...result, idempotent: true };
}

function freshResult(result: StoredStorageAdmissionResult): StorageAdmissionResult {
  return { ...result, idempotent: false };
}

export class StorageAdmissionStore {
  private readonly now: () => number;
  private readonly observeVolume: NonNullable<StorageAdmissionDependencies['observeVolume']>;

  constructor(
    private readonly sqlite: Database.Database,
    dependencies: StorageAdmissionDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.observeVolume = dependencies.observeVolume ?? observeStorageVolume;
  }

  private replayMutation(mutationId: string, hash: string): StorageAdmissionResult | null {
    const row = this.sqlite.prepare(
      'SELECT request_hash, result_json FROM storage_admission_mutations WHERE mutation_id = ?',
    ).get(mutationId) as MutationRow | undefined;
    if (!row) return null;
    if (row.request_hash !== hash) {
      throw new StorageAdmissionMutationReuseError(
        `Mutation id ${mutationId} was reused with a different request body.`,
      );
    }
    return withReplay(parseJson<StoredStorageAdmissionResult>(row.result_json));
  }

  private insertMutation(
    operation: StorageAdmissionOperation,
    mutationId: string,
    hash: string,
    result: StoredStorageAdmissionResult,
    reservationId: string | null,
    volumeId: string | null,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO storage_admission_mutations (
        mutation_id, operation, request_hash, reservation_id, volume_id,
        result_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      mutationId,
      operation,
      hash,
      reservationId,
      volumeId,
      JSON.stringify(result),
      result.recordedAt,
    );
  }

  private selectReservation(reservationId: string): ReservationRow | undefined {
    return this.sqlite.prepare(
      'SELECT * FROM storage_admission_reservations WHERE reservation_id = ?',
    ).get(reservationId) as ReservationRow | undefined;
  }

  getReservation(reservationId: string): StorageReservationRecord | null {
    const row = this.selectReservation(requiredText(reservationId, 'reservationId'));
    return row ? mapReservation(row) : null;
  }

  getLatestReservationForOwner(ownerId: string): StorageReservationRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM storage_admission_reservations
      WHERE owner_id = ?
      ORDER BY owner_generation DESC, created_at DESC, reservation_id DESC
      LIMIT 1
    `).get(requiredText(ownerId, 'ownerId')) as ReservationRow | undefined;
    return row ? mapReservation(row) : null;
  }

  async reserve(input: ReserveStorageInput): Promise<StorageAdmissionResult> {
    const policy = normalizePolicy(input.policy);
    const normalized = {
      operation: 'reserve' as const,
      ...(input.dependencyCloneContract ? { dependencyCloneContract: normalizeStorageDependencyCloneContract(input.dependencyCloneContract) } : {}),
      mutationId: requiredText(input.mutationId, 'mutationId'),
      reservationId: requiredText(input.reservationId, 'reservationId'),
      targetPath: path.resolve(requiredText(input.targetPath, 'targetPath')),
      rootIdentity: input.rootIdentity ?? null,
      exactBytes: positiveInteger(input.exactBytes, 'exactBytes'),
      ownerId: requiredText(input.ownerId, 'ownerId'),
      ownerGeneration: positiveInteger(input.ownerGeneration, 'ownerGeneration'),
      leaseExpiresAt: positiveInteger(input.leaseExpiresAt, 'leaseExpiresAt'),
      policy,
    };
    const hash = requestHash(normalized);
    const replay = this.replayMutation(normalized.mutationId, hash);
    if (replay) return replay;
    const probeStartedAt = this.now();
    if (!Number.isSafeInteger(probeStartedAt)) {
      throw new StorageAdmissionInputError('Storage admission clock is unavailable.');
    }
    if (normalized.leaseExpiresAt <= probeStartedAt) {
      throw new StorageAdmissionInputError('leaseExpiresAt must be in the future.');
    }
    const observation = await this.observeVolume(normalized.targetPath);
    const decisionAt = this.now();
    requireMonotonicDecisionTime(probeStartedAt, decisionAt);

    const execute = this.sqlite.transaction((): StorageAdmissionResult => {
      const concurrentReplay = this.replayMutation(normalized.mutationId, hash);
      if (concurrentReplay) return concurrentReplay;
      const observationFailure = storageObservationFailureReason(
        observation,
        probeStartedAt,
        decisionAt,
        policy.observationMaxAgeMs,
      );
      const existing = this.selectReservation(normalized.reservationId);
      let reason = observationFailure;
      if (!reason && normalized.leaseExpiresAt <= decisionAt) reason = 'lease_expired';
      if (!reason && existing) reason = 'reservation_conflict';

      const volumeId = observation.volumeId;
      let requiredReserveBytes: number | null = null;
      let activeReservedBytes: number | null = null;
      let headroomBytes: number | null = null;
      if (!reason && volumeId && observation.totalBytes !== null && observation.availableBytes !== null) {
        requiredReserveBytes = Math.max(
          policy.absoluteFloorBytes,
          Math.ceil(observation.totalBytes * policy.reserveRatio),
        );
        const active = this.sqlite.prepare(`
          SELECT COALESCE(SUM(exact_bytes), 0) AS bytes
          FROM storage_admission_reservations
          WHERE volume_id = ? AND state = 'reserved'
        `).get(volumeId) as { bytes: number };
        activeReservedBytes = active.bytes;
        headroomBytes = observation.availableBytes - requiredReserveBytes - activeReservedBytes;
        if (!Number.isSafeInteger(activeReservedBytes) || !Number.isSafeInteger(headroomBytes)) {
          reason = 'accounting_unknown';
        } else if (normalized.exactBytes > headroomBytes) {
          reason = 'reserve_breached';
        }
      }

      if (reason) {
        const result: StoredStorageAdmissionResult = {
          operation: 'reserve',
          decision: 'held',
          reason,
          mutationId: normalized.mutationId,
          reservation: null,
          observation,
          requiredReserveBytes,
          activeReservedBytes,
          headroomBytes,
          observedAvailableDeltaBytes: null,
          recordedAt: decisionAt,
        };
        this.insertMutation(
          'reserve',
          normalized.mutationId,
          hash,
          result,
          normalized.reservationId,
          volumeId,
        );
        return freshResult(result);
      }

      this.sqlite.prepare(`
        INSERT INTO storage_admission_reservations (
          reservation_id, volume_id, target_path, root_identity_json, exact_bytes, owner_id,
          owner_generation, generation, state, lease_expires_at,
          pre_measurement_json, last_mutation_id, last_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'reserved', ?, ?, ?, 'admitted', ?, ?)
      `).run(
        normalized.reservationId,
        volumeId,
        normalized.targetPath,
        normalized.rootIdentity ? JSON.stringify(normalized.rootIdentity) : null,
        normalized.exactBytes,
        normalized.ownerId,
        normalized.ownerGeneration,
        normalized.leaseExpiresAt,
        JSON.stringify(observation),
        normalized.mutationId,
        decisionAt,
        decisionAt,
      );
      const reservation = mapReservation(this.selectReservation(normalized.reservationId)!);
      const result: StoredStorageAdmissionResult = {
        operation: 'reserve',
        decision: 'reserved',
        ...(normalized.dependencyCloneContract ? { dependencyCloneContract: normalized.dependencyCloneContract } : {}),
        reason: 'admitted',
        mutationId: normalized.mutationId,
        reservation,
        observation,
        requiredReserveBytes,
        activeReservedBytes,
        headroomBytes,
        observedAvailableDeltaBytes: null,
        recordedAt: decisionAt,
      };
      this.insertMutation(
        'reserve',
        normalized.mutationId,
        hash,
        result,
        normalized.reservationId,
        volumeId,
      );
      return freshResult(result);
    });
    return execute.immediate();
  }

  async commit(input: CommitStorageReservationInput): Promise<StorageAdmissionResult> {
    return this.finishReservation('commit', input);
  }

  async release(input: ReleaseStorageReservationInput): Promise<StorageAdmissionResult> {
    return this.finishReservation('release', input);
  }

  async reconcile(input: ReconcileStorageReservationInput): Promise<StorageAdmissionResult> {
    return this.finishReservation('reconcile', input);
  }

  private async finishReservation(
    operation: 'commit' | 'release' | 'reconcile',
    input: CommitStorageReservationInput | ReleaseStorageReservationInput | ReconcileStorageReservationInput,
  ): Promise<StorageAdmissionResult> {
    const normalized = {
      operation,
      mutationId: requiredText(input.mutationId, 'mutationId'),
      reservationId: requiredText(input.reservationId, 'reservationId'),
      volumeId: requiredText(input.volumeId, 'volumeId'),
      ownerId: requiredText(input.ownerId, 'ownerId'),
      ownerGeneration: positiveInteger(input.ownerGeneration, 'ownerGeneration'),
      expectedGeneration: positiveInteger(input.expectedGeneration, 'expectedGeneration'),
      ownerLiveness: operation === 'reconcile'
        ? (input as ReconcileStorageReservationInput).ownerLiveness
        : null,
      ownerDeathReceipt: operation === 'reconcile'
        ? this.normalizeDeathReceipt(
          (input as ReconcileStorageReservationInput).ownerDeathReceipt ?? null,
        )
        : null,
    };
    const hash = requestHash(normalized);
    const replay = this.replayMutation(normalized.mutationId, hash);
    if (replay) return replay;
    const initial = this.selectReservation(normalized.reservationId);
    const probeStartedAt = this.now();
    if (!Number.isSafeInteger(probeStartedAt)) {
      throw new StorageAdmissionInputError('Storage admission clock is unavailable.');
    }
    const requiresObservation = operation !== 'reconcile';
    const observation = initial && requiresObservation
      ? await this.observeVolume(initial.target_path)
      : null;
    const decisionAt = this.now();
    requireMonotonicDecisionTime(probeStartedAt, decisionAt);

    const execute = this.sqlite.transaction((): StorageAdmissionResult => {
      const concurrentReplay = this.replayMutation(normalized.mutationId, hash);
      if (concurrentReplay) return concurrentReplay;
      const current = this.selectReservation(normalized.reservationId);
      let reason: StorageAdmissionReason | null = null;
      if (!current) reason = 'reservation_missing';
      else if (current.volume_id !== normalized.volumeId) reason = 'volume_conflict';
      else if (
        current.owner_id !== normalized.ownerId
        || current.owner_generation !== normalized.ownerGeneration
      ) reason = 'owner_conflict';
      else if (current.generation !== normalized.expectedGeneration) reason = 'generation_conflict';
      else if (current.state !== 'reserved') reason = 'state_conflict';
      else if (operation === 'commit' && current.lease_expires_at <= decisionAt) reason = 'lease_expired';
      else if (operation === 'reconcile' && current.lease_expires_at > decisionAt) reason = 'lease_active';
      else if (operation === 'reconcile' && !this.validDeathReceipt(normalized, decisionAt)) {
        reason = 'owner_not_proven_dead';
      }
      if (!reason && observation) {
        reason = storageObservationFailureReason(
          observation,
          probeStartedAt,
          decisionAt,
          DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS,
        );
        if (!reason && observation.volumeId !== normalized.volumeId) reason = 'volume_conflict';
      } else if (!reason && requiresObservation) {
        reason = 'accounting_unknown';
      }

      if (reason || !current || (requiresObservation && !observation)) {
        const result: StoredStorageAdmissionResult = {
          operation,
          decision: 'held',
          reason: reason ?? 'accounting_unknown',
          mutationId: normalized.mutationId,
          reservation: current ? mapReservation(current) : null,
          observation,
          requiredReserveBytes: null,
          activeReservedBytes: null,
          headroomBytes: null,
          observedAvailableDeltaBytes: null,
          recordedAt: decisionAt,
        };
        this.insertMutation(
          operation,
          normalized.mutationId,
          hash,
          result,
          normalized.reservationId,
          normalized.volumeId,
        );
        return freshResult(result);
      }

      const nextState: StorageReservationState = operation === 'commit'
        ? 'committed'
        : operation === 'release'
          ? 'released'
          : 'reconciled';
      const terminalReason: StorageAdmissionReason = operation === 'commit'
        ? 'committed'
        : operation === 'release'
          ? 'released'
          : 'dead_owner_reconciled';
      const updated = this.sqlite.prepare(`
        UPDATE storage_admission_reservations
        SET state = ?, generation = generation + 1, post_measurement_json = ?,
            last_mutation_id = ?, last_reason = ?, updated_at = ?, terminal_at = ?
        WHERE reservation_id = ? AND volume_id = ? AND state = 'reserved'
          AND generation = ? AND owner_id = ? AND owner_generation = ?
      `).run(
        nextState,
        observation ? JSON.stringify(observation) : null,
        normalized.mutationId,
        terminalReason,
        decisionAt,
        decisionAt,
        normalized.reservationId,
        normalized.volumeId,
        normalized.expectedGeneration,
        normalized.ownerId,
        normalized.ownerGeneration,
      );
      if (updated.changes !== 1) {
        throw new Error('Storage reservation changed during its immediate transaction.');
      }
      const reservation = mapReservation(this.selectReservation(normalized.reservationId)!);
      const result: StoredStorageAdmissionResult = {
        operation,
        decision: nextState,
        reason: terminalReason,
        mutationId: normalized.mutationId,
        reservation,
        observation,
        requiredReserveBytes: null,
        activeReservedBytes: null,
        headroomBytes: null,
        observedAvailableDeltaBytes:
          observation && current.pre_measurement_json && reservation.preMeasurement.availableBytes !== null
            && observation.availableBytes !== null
            ? reservation.preMeasurement.availableBytes - observation.availableBytes
            : null,
        recordedAt: decisionAt,
      };
      this.insertMutation(
        operation,
        normalized.mutationId,
        hash,
        result,
        normalized.reservationId,
        normalized.volumeId,
      );
      return freshResult(result);
    });
    return execute.immediate();
  }

  private validDeathReceipt(
    input: {
      reservationId: string;
      volumeId: string;
      ownerId: string;
      ownerGeneration: number;
      ownerLiveness: 'dead' | 'alive' | 'unknown' | null;
      ownerDeathReceipt: OwnerDeathReceipt | null;
    },
    now: number,
  ): boolean {
    if (input.ownerLiveness !== 'dead' || !input.ownerDeathReceipt) return false;
    if (!input.ownerDeathReceipt.source.trim() || !input.ownerDeathReceipt.evidence.trim()) return false;
    if (
      input.ownerDeathReceipt.reservationId !== input.reservationId
      || input.ownerDeathReceipt.volumeId !== input.volumeId
      || input.ownerDeathReceipt.ownerId !== input.ownerId
      || input.ownerDeathReceipt.ownerGeneration !== input.ownerGeneration
    ) return false;
    const age = now - input.ownerDeathReceipt.observedAt;
    return Number.isSafeInteger(input.ownerDeathReceipt.observedAt)
      && age >= 0
      && age <= DEFAULT_STORAGE_OBSERVATION_MAX_AGE_MS;
  }

  private normalizeDeathReceipt(receipt: OwnerDeathReceipt | null): OwnerDeathReceipt | null {
    if (!receipt) return null;
    return {
      source: typeof receipt.source === 'string' ? receipt.source.trim() : '',
      evidence: typeof receipt.evidence === 'string' ? receipt.evidence.trim() : '',
      observedAt: receipt.observedAt,
      reservationId: typeof receipt.reservationId === 'string' ? receipt.reservationId.trim() : '',
      volumeId: typeof receipt.volumeId === 'string' ? receipt.volumeId.trim() : '',
      ownerId: typeof receipt.ownerId === 'string' ? receipt.ownerId.trim() : '',
      ownerGeneration: receipt.ownerGeneration,
    };
  }

  listExpiredForReconciliation(at = this.now()): StorageReservationRecord[] {
    positiveInteger(at, 'at');
    const rows = this.sqlite.prepare(`
      SELECT * FROM storage_admission_reservations
      WHERE state = 'reserved' AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC, reservation_id ASC
    `).all(at) as ReservationRow[];
    return rows.map(mapReservation);
  }
}

function defaultStore(): StorageAdmissionStore {
  return new StorageAdmissionStore(getSqlite());
}

export function reserveStorage(input: ReserveStorageInput): Promise<StorageAdmissionResult> {
  return defaultStore().reserve(input);
}

export function commitStorageReservation(
  input: CommitStorageReservationInput,
): Promise<StorageAdmissionResult> {
  return defaultStore().commit(input);
}

export function releaseStorageReservation(
  input: ReleaseStorageReservationInput,
): Promise<StorageAdmissionResult> {
  return defaultStore().release(input);
}

export function reconcileStorageReservation(
  input: ReconcileStorageReservationInput,
): Promise<StorageAdmissionResult> {
  return defaultStore().reconcile(input);
}

export function listExpiredStorageReservations(at = Date.now()): StorageReservationRecord[] {
  return defaultStore().listExpiredForReconciliation(at);
}
