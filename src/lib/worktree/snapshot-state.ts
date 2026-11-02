import 'server-only';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { assertSnapshotRetentionReleased } from '@/lib/workspace/retention-holds';
import { assertNoActiveWorkspaceArtifactRestore } from '@/lib/workspace/artifact-restore-state';
import {
  WORKSPACE_SNAPSHOT_STATES,
  type CreateWorkspaceSnapshotInput,
  type CreateWorkspaceSnapshotResult,
  type TransitionWorkspaceSnapshotInput,
  type TransitionWorkspaceSnapshotResult,
  type WorkspaceReservationReceipt,
  type WorkspaceSessionIdentityReceipt,
  type WorkspaceSnapshotErrorReceipt,
  type WorkspaceSnapshotJson,
  type WorkspaceSnapshotReconciliationScan,
  type WorkspaceSnapshotRecord,
  type WorkspaceSnapshotState,
  type WorkspaceSnapshotTransitionReceipt,
} from './snapshot-state-types';
import { verifyWorkspaceSnapshotReceiptChain, type WorkspaceSnapshotChainReceipt, type WorkspaceSnapshotChainRow } from './snapshot-receipt-chain';
export * from './snapshot-state-types';
interface WorkspaceSnapshotRow extends WorkspaceSnapshotChainRow {
  mission_id: string | null;
  lane_id: string | null;
  original_path: string;
  branch: string;
  base_commit: string;
  head_commit: string;
  tree_sha: string;
  recovery_ref: string;
  diff_fingerprint: string;
  dependency_recipe_key: string | null;
  session_identity_json: string;
  reservation_json: string | null;
}

type WorkspaceSnapshotTransitionRow = WorkspaceSnapshotChainReceipt
  & Pick<WorkspaceSnapshotChainRow, 'repository_uuid' | 'packet_id'>;

export class WorkspaceSnapshotCorruptError extends Error {}
export class WorkspaceSnapshotInputError extends Error {}
export class WorkspaceSnapshotTransitionReuseError extends Error {}

const ALLOWED_TRANSITIONS: Record<WorkspaceSnapshotState, ReadonlySet<WorkspaceSnapshotState>> = {
  materialized: new Set(['parkable', 'retiring']),
  parkable: new Set(['materialized', 'hibernating']),
  hibernating: new Set(['materialized', 'parked']),
  parked: new Set(['restoring']),
  restoring: new Set(['materialized', 'parked']),
  retiring: new Set(['materialized', 'retired']),
  retired: new Set(),
};

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new WorkspaceSnapshotInputError(`${field} is required.`);
  return normalized;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function integerAt(value: number | undefined, field: string): number {
  const resolved = value ?? Date.now();
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new WorkspaceSnapshotInputError(`${field} must be a non-negative safe integer.`);
  }
  return resolved;
}

function assertChronology(
  transitionStartedAt: number,
  recordedAt: number,
  errorRecordedAt?: number,
): void {
  if (recordedAt < transitionStartedAt) {
    throw new WorkspaceSnapshotInputError('recordedAt cannot precede transitionStartedAt.');
  }
  if (errorRecordedAt !== undefined && recordedAt < errorRecordedAt) {
    throw new WorkspaceSnapshotInputError('recordedAt cannot precede error.recordedAt.');
  }
}

function isState(value: string): value is WorkspaceSnapshotState {
  return (WORKSPACE_SNAPSHOT_STATES as readonly string[]).includes(value);
}

function canonicalizeJson(value: unknown): WorkspaceSnapshotJson {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(objectValue)
        .sort()
        .map((key) => [key, canonicalizeJson(objectValue[key])]),
    ) as Record<string, WorkspaceSnapshotJson>;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new WorkspaceSnapshotInputError('Snapshot JSON cannot contain a non-finite number.');
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  throw new WorkspaceSnapshotInputError(`Snapshot JSON cannot contain ${typeof value}.`);
}

function serializeJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new WorkspaceSnapshotCorruptError(`${field} contains invalid JSON.`);
  }
}

function normalizeSessionIdentities(
  values: WorkspaceSessionIdentityReceipt[],
): WorkspaceSessionIdentityReceipt[] {
  if (!Array.isArray(values)) {
    throw new WorkspaceSnapshotInputError('sessionIdentities must be an array.');
  }
  return values.map((value, index) => ({
    kind: requiredText(value.kind, `sessionIdentities[${index}].kind`),
    identity: requiredText(value.identity, `sessionIdentities[${index}].identity`),
    runtime: nullableText(value.runtime),
    bindingId: nullableText(value.bindingId),
  }));
}

function parseSessionIdentities(raw: string): WorkspaceSessionIdentityReceipt[] {
  const parsed = parseJson(raw, 'session_identity_json');
  if (!Array.isArray(parsed)) {
    throw new WorkspaceSnapshotCorruptError('session_identity_json must contain an array.');
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new WorkspaceSnapshotCorruptError(`session_identity_json[${index}] must be an object.`);
    }
    const row = value as Record<string, unknown>;
    if (typeof row.kind !== 'string' || typeof row.identity !== 'string') {
      throw new WorkspaceSnapshotCorruptError(
        `session_identity_json[${index}] is missing its identity fields.`,
      );
    }
    return {
      kind: row.kind,
      identity: row.identity,
      runtime: typeof row.runtime === 'string' ? row.runtime : null,
      bindingId: typeof row.bindingId === 'string' ? row.bindingId : null,
    };
  });
}

function normalizeReservation(
  value: WorkspaceReservationReceipt | null | undefined,
): WorkspaceReservationReceipt | null {
  if (!value) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new WorkspaceSnapshotInputError('reservation.bytes must be a non-negative safe integer.');
  }
  return {
    id: requiredText(value.id, 'reservation.id'),
    bytes: value.bytes,
    volumeId: nullableText(value.volumeId),
    reservedAt: integerAt(value.reservedAt, 'reservation.reservedAt'),
  };
}

function parseReservation(raw: string | null): WorkspaceReservationReceipt | null {
  if (!raw) return null;
  const parsed = parseJson(raw, 'reservation_json');
  if (!parsed || typeof parsed !== 'object') {
    throw new WorkspaceSnapshotCorruptError('reservation_json must contain an object.');
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.id !== 'string'
    || typeof row.bytes !== 'number'
    || !Number.isSafeInteger(row.bytes)
    || typeof row.reservedAt !== 'number'
    || !Number.isSafeInteger(row.reservedAt)
  ) {
    throw new WorkspaceSnapshotCorruptError('reservation_json is missing required receipt fields.');
  }
  return {
    id: row.id,
    bytes: row.bytes,
    volumeId: typeof row.volumeId === 'string' ? row.volumeId : null,
    reservedAt: row.reservedAt,
  };
}

function parseError(raw: string | null): WorkspaceSnapshotErrorReceipt | null {
  if (!raw) return null;
  const parsed = parseJson(raw, 'error_json');
  if (!parsed || typeof parsed !== 'object') {
    throw new WorkspaceSnapshotCorruptError('error_json must contain an object.');
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.code !== 'string'
    || typeof row.message !== 'string'
    || typeof row.phase !== 'string'
    || typeof row.recordedAt !== 'number'
    || !Number.isSafeInteger(row.recordedAt)
  ) {
    throw new WorkspaceSnapshotCorruptError('error_json is missing required failure fields.');
  }
  return {
    code: row.code,
    message: row.message,
    phase: row.phase,
    recordedAt: row.recordedAt,
    ...(row.details !== undefined ? { details: row.details as WorkspaceSnapshotJson } : {}),
  };
}

function normalizeError(
  value: WorkspaceSnapshotErrorReceipt | null | undefined,
): WorkspaceSnapshotErrorReceipt | null {
  if (!value) return null;
  return {
    code: requiredText(value.code, 'error.code'),
    message: requiredText(value.message, 'error.message'),
    phase: requiredText(value.phase, 'error.phase'),
    recordedAt: integerAt(value.recordedAt, 'error.recordedAt'),
    ...(value.details !== undefined ? { details: canonicalizeJson(value.details) } : {}),
  };
}

function parseReceipt(raw: string | null): Record<string, WorkspaceSnapshotJson> | null {
  if (!raw) return null;
  const parsed = parseJson(raw, 'receipt_json');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new WorkspaceSnapshotCorruptError('receipt_json must contain an object.');
  }
  return parsed as Record<string, WorkspaceSnapshotJson>;
}

function computeSnapshotFingerprint(value: unknown): string {
  return createHash('sha256').update(serializeJson(value)).digest('hex');
}

function selectSnapshotReceiptChain(
  repositoryUuid: string,
  packetId: string,
): WorkspaceSnapshotTransitionRow[] {
  return getSqlite().prepare(`
    SELECT * FROM workspace_snapshot_transitions
    WHERE repository_uuid = ? AND packet_id = ?
    ORDER BY resulting_version ASC, transition_id ASC
  `).all(repositoryUuid, packetId) as WorkspaceSnapshotTransitionRow[];
}

function readConsistentSnapshot<T>(read: () => T): T {
  const sqlite = getSqlite();
  return sqlite.inTransaction ? read() : sqlite.transaction(read).deferred();
}

function mapSnapshotRow(row: WorkspaceSnapshotRow, receipts?: WorkspaceSnapshotChainReceipt[]): WorkspaceSnapshotRecord {
  if (!isState(row.state)) {
    throw new WorkspaceSnapshotCorruptError(`Unknown workspace snapshot state: ${row.state}`);
  }
  const sessionIdentities = parseSessionIdentities(row.session_identity_json);
  const reservation = parseReservation(row.reservation_json);
  const persistedTruth = {
    repositoryUuid: row.repository_uuid,
    packetId: row.packet_id,
    missionId: row.mission_id,
    laneId: row.lane_id,
    originalPath: row.original_path,
    branch: row.branch,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    treeSha: row.tree_sha,
    recoveryRef: row.recovery_ref,
    diffFingerprint: row.diff_fingerprint,
    dependencyRecipeKey: row.dependency_recipe_key,
    sessionIdentities,
    reservation,
  };
  const recomputedFingerprint = computeSnapshotFingerprint(persistedTruth);
  if (row.snapshot_fingerprint !== recomputedFingerprint) {
    throw new WorkspaceSnapshotCorruptError(
      `Workspace snapshot ${row.repository_uuid}/${row.packet_id} does not match its persisted fingerprint.`,
    );
  }
  try {
    verifyWorkspaceSnapshotReceiptChain(
      row,
      recomputedFingerprint,
      receipts ?? selectSnapshotReceiptChain(row.repository_uuid, row.packet_id),
    );
  } catch (error) {
    throw new WorkspaceSnapshotCorruptError(error instanceof Error ? error.message : String(error));
  }
  return {
    repositoryUuid: row.repository_uuid,
    packetId: row.packet_id,
    missionId: row.mission_id,
    laneId: row.lane_id,
    originalPath: row.original_path,
    branch: row.branch,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    treeSha: row.tree_sha,
    recoveryRef: row.recovery_ref,
    diffFingerprint: row.diff_fingerprint,
    dependencyRecipeKey: row.dependency_recipe_key,
    sessionIdentities,
    reservation,
    snapshotFingerprint: row.snapshot_fingerprint,
    snapshotGeneration: row.snapshot_generation,
    state: row.state,
    version: row.record_version,
    lastTransitionId: row.last_transition_id,
    transitionStartedAt: row.transition_started_at,
    stateEnteredAt: row.state_entered_at,
    lastError: parseError(row.last_error_json),
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransitionRow(row: WorkspaceSnapshotTransitionRow): WorkspaceSnapshotTransitionReceipt {
  if ((row.from_state !== null && !isState(row.from_state)) || !isState(row.to_state)) {
    throw new WorkspaceSnapshotCorruptError('A workspace transition contains an unknown state.');
  }
  if (row.transition_kind !== 'created' && row.transition_kind !== 'transition') {
    throw new WorkspaceSnapshotCorruptError('A workspace transition contains an unknown kind.');
  }
  return {
    repositoryUuid: row.repository_uuid,
    packetId: row.packet_id,
    transitionId: row.transition_id,
    kind: row.transition_kind,
    fromState: row.from_state,
    toState: row.to_state,
    priorVersion: row.prior_version,
    resultingVersion: row.resulting_version,
    transitionStartedAt: row.transition_started_at,
    recordedAt: row.recorded_at,
    receipt: parseReceipt(row.receipt_json),
    error: parseError(row.error_json),
    snapshotFingerprint: row.snapshot_fingerprint,
    snapshotGeneration: row.snapshot_generation,
  };
}

export function prepareWorkspaceSnapshotTruth(input: CreateWorkspaceSnapshotInput) {
  const originalPath = input.originalPath.trim();
  if (!path.isAbsolute(originalPath) && !path.win32.isAbsolute(originalPath)) {
    throw new WorkspaceSnapshotInputError('originalPath must be absolute.');
  }
  const sessionIdentities = normalizeSessionIdentities(input.sessionIdentities);
  const reservation = normalizeReservation(input.reservation);
  const truth = {
    repositoryUuid: requiredText(input.repositoryUuid, 'repositoryUuid'),
    packetId: requiredText(input.packetId, 'packetId'),
    missionId: nullableText(input.missionId),
    laneId: nullableText(input.laneId),
    originalPath,
    branch: requiredText(input.branch, 'branch'),
    baseCommit: requiredText(input.baseCommit, 'baseCommit'),
    headCommit: requiredText(input.headCommit, 'headCommit'),
    treeSha: requiredText(input.treeSha, 'treeSha'),
    recoveryRef: requiredText(input.recoveryRef, 'recoveryRef'),
    diffFingerprint: requiredText(input.diffFingerprint, 'diffFingerprint'),
    dependencyRecipeKey: nullableText(input.dependencyRecipeKey),
    sessionIdentities,
    reservation,
  };
  const snapshotFingerprint = computeSnapshotFingerprint(truth);
  const transitionStartedAt = integerAt(input.transitionStartedAt, 'transitionStartedAt');
  const recordedAt = integerAt(input.recordedAt, 'recordedAt');
  assertChronology(transitionStartedAt, recordedAt);
  return {
    ...truth,
    creationId: requiredText(input.creationId, 'creationId'),
    transitionStartedAt,
    recordedAt,
    receiptJson: input.receipt ? serializeJson(input.receipt) : null,
    sessionIdentityJson: serializeJson(sessionIdentities),
    reservationJson: reservation ? serializeJson(reservation) : null,
    snapshotFingerprint,
  };
}

function selectSnapshot(repositoryUuid: string, packetId: string): WorkspaceSnapshotRow | undefined {
  return getSqlite().prepare(
    'SELECT * FROM workspace_snapshots WHERE repository_uuid = ? AND packet_id = ?',
  ).get(repositoryUuid, packetId) as WorkspaceSnapshotRow | undefined;
}

function selectTransition(
  repositoryUuid: string,
  packetId: string,
  transitionId: string,
): WorkspaceSnapshotTransitionRow | undefined {
  return getSqlite().prepare(
    `SELECT * FROM workspace_snapshot_transitions
     WHERE repository_uuid = ? AND packet_id = ? AND transition_id = ?`,
  ).get(repositoryUuid, packetId, transitionId) as WorkspaceSnapshotTransitionRow | undefined;
}

export function createWorkspaceSnapshot(
  input: CreateWorkspaceSnapshotInput,
): CreateWorkspaceSnapshotResult {
  const normalized = prepareWorkspaceSnapshotTruth(input);
  const sqlite = getSqlite();
  const execute = sqlite.transaction((): CreateWorkspaceSnapshotResult => {
    assertNoActiveWorkspaceArtifactRestore(normalized.packetId, normalized.originalPath);
    const existing = selectSnapshot(normalized.repositoryUuid, normalized.packetId);
    if (existing) {
      const creation = selectTransition(
        normalized.repositoryUuid,
        normalized.packetId,
        normalized.creationId,
      );
      if (creation) {
        if (
          creation.transition_kind !== 'created'
          || creation.snapshot_fingerprint !== normalized.snapshotFingerprint
          || creation.from_state !== null
          || creation.to_state !== 'materialized'
          || creation.prior_version !== 0
          || creation.resulting_version !== 1
          || creation.receipt_json !== normalized.receiptJson
        ) {
          throw new WorkspaceSnapshotTransitionReuseError(
            `Creation id ${normalized.creationId} was reused with different snapshot truth.`,
          );
        }
        return { status: 'idempotent', record: mapSnapshotRow(existing) };
      }
      return { status: 'conflict', record: mapSnapshotRow(existing) };
    }

    sqlite.prepare(`
      INSERT INTO workspace_snapshots (
        repository_uuid, packet_id, mission_id, lane_id, original_path, branch,
        base_commit, head_commit, tree_sha, recovery_ref, diff_fingerprint,
        dependency_recipe_key, session_identity_json, reservation_json,
        snapshot_fingerprint, snapshot_generation, state, record_version, last_transition_id,
        transition_started_at, state_entered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'materialized', 1, ?, ?, ?, ?, ?)
    `).run(
      normalized.repositoryUuid,
      normalized.packetId,
      normalized.missionId,
      normalized.laneId,
      normalized.originalPath,
      normalized.branch,
      normalized.baseCommit,
      normalized.headCommit,
      normalized.treeSha,
      normalized.recoveryRef,
      normalized.diffFingerprint,
      normalized.dependencyRecipeKey,
      normalized.sessionIdentityJson,
      normalized.reservationJson,
      normalized.snapshotFingerprint,
      normalized.creationId,
      normalized.transitionStartedAt,
      normalized.recordedAt,
      normalized.recordedAt,
      normalized.recordedAt,
    );
    sqlite.prepare(`
      INSERT INTO workspace_snapshot_transitions (
        repository_uuid, packet_id, transition_id, transition_kind, from_state,
        to_state, prior_version, resulting_version, transition_started_at,
        recorded_at, receipt_json, error_json, snapshot_fingerprint, snapshot_generation
      ) VALUES (?, ?, ?, 'created', NULL, 'materialized', 0, 1, ?, ?, ?, NULL, ?, 1)
    `).run(
      normalized.repositoryUuid,
      normalized.packetId,
      normalized.creationId,
      normalized.transitionStartedAt,
      normalized.recordedAt,
      normalized.receiptJson,
      normalized.snapshotFingerprint,
    );

    return {
      status: 'created',
      record: mapSnapshotRow(selectSnapshot(normalized.repositoryUuid, normalized.packetId)!),
    };
  });
  return execute.immediate();
}

function assertTransitionAllowed(input: TransitionWorkspaceSnapshotInput): void {
  if (!isState(input.expectedState) || !isState(input.toState)) {
    throw new WorkspaceSnapshotInputError(
      `Transition states are invalid: ${String(input.expectedState)} -> ${String(input.toState)}.`,
    );
  }
  if (input.expectedState === input.toState) {
    if (!input.error) {
      throw new WorkspaceSnapshotInputError('A same-state transition requires an error receipt.');
    }
    return;
  }
  if (!ALLOWED_TRANSITIONS[input.expectedState].has(input.toState)) {
    throw new WorkspaceSnapshotInputError(
      `Transition ${input.expectedState} -> ${input.toState} is not allowed.`,
    );
  }
}

function transitionMatchesReplay(
  existing: WorkspaceSnapshotTransitionRow,
  input: TransitionWorkspaceSnapshotInput,
  receiptJson: string | null,
  errorJson: string | null,
): boolean {
  return existing.transition_kind === 'transition'
    && existing.from_state === input.expectedState
    && existing.to_state === input.toState
    && existing.prior_version === input.expectedVersion
    && existing.receipt_json === receiptJson
    && existing.error_json === errorJson;
}

export function transitionWorkspaceSnapshot(
  input: TransitionWorkspaceSnapshotInput,
): TransitionWorkspaceSnapshotResult {
  assertTransitionAllowed(input);
  const repositoryUuid = requiredText(input.repositoryUuid, 'repositoryUuid');
  const packetId = requiredText(input.packetId, 'packetId');
  const transitionId = requiredText(input.transitionId, 'transitionId');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new WorkspaceSnapshotInputError('expectedVersion must be a positive safe integer.');
  }
  const transitionStartedAt = integerAt(input.transitionStartedAt, 'transitionStartedAt');
  const recordedAt = integerAt(input.recordedAt, 'recordedAt');
  const receiptJson = input.receipt ? serializeJson(input.receipt) : null;
  const error = normalizeError(input.error);
  const errorJson = error ? serializeJson(error) : null;
  assertChronology(transitionStartedAt, recordedAt, error?.recordedAt);
  const sqlite = getSqlite();
  const execute = sqlite.transaction((): TransitionWorkspaceSnapshotResult => {
    const priorReceipt = selectTransition(repositoryUuid, packetId, transitionId);
    if (priorReceipt) {
      if (!transitionMatchesReplay(priorReceipt, input, receiptJson, errorJson)) {
        throw new WorkspaceSnapshotTransitionReuseError(
          `Transition id ${transitionId} was reused with different transition truth.`,
        );
      }
      const current = selectSnapshot(repositoryUuid, packetId);
      if (!current) {
        throw new WorkspaceSnapshotCorruptError('A transition receipt exists without its snapshot.');
      }
      const record = mapSnapshotRow(current);
      return priorReceipt.snapshot_generation === record.snapshotGeneration
        ? { status: 'idempotent', record }
        : { status: 'conflict', record };
    }

    const currentBefore = selectSnapshot(repositoryUuid, packetId);
    if (!currentBefore) return { status: 'missing', record: null };
    const currentRecord = mapSnapshotRow(currentBefore);
    if (currentRecord.state !== input.expectedState || currentRecord.version !== input.expectedVersion) {
      return { status: 'conflict', record: currentRecord };
    }
    if (input.expectedGeneration !== undefined
      && currentRecord.snapshotGeneration !== input.expectedGeneration) {
      return { status: 'conflict', record: currentRecord };
    }
    if (recordedAt < currentRecord.updatedAt) {
      throw new WorkspaceSnapshotInputError(
        `recordedAt ${recordedAt} cannot precede current updatedAt ${currentRecord.updatedAt}.`,
      );
    }

    const errorAt = error?.recordedAt ?? null;
    assertNoActiveWorkspaceArtifactRestore(packetId, currentRecord.originalPath);
    if (input.toState === 'retiring') assertSnapshotRetentionReleased(currentRecord);
    const updated = sqlite.prepare(`
      UPDATE workspace_snapshots
      SET state = ?,
          record_version = record_version + 1,
          last_transition_id = ?,
          transition_started_at = ?,
          state_entered_at = CASE WHEN state = ? THEN state_entered_at ELSE ? END,
          last_error_json = ?,
          last_error_at = ?,
          updated_at = ?
      WHERE repository_uuid = ?
        AND packet_id = ?
        AND state = ?
        AND record_version = ?
    `).run(
      input.toState,
      transitionId,
      transitionStartedAt,
      input.toState,
      recordedAt,
      errorJson,
      errorAt,
      recordedAt,
      repositoryUuid,
      packetId,
      input.expectedState,
      input.expectedVersion,
    );
    if (updated.changes !== 1) {
      const current = selectSnapshot(repositoryUuid, packetId);
      return current
        ? { status: 'conflict', record: mapSnapshotRow(current) }
        : { status: 'missing', record: null };
    }

    const current = selectSnapshot(repositoryUuid, packetId)!;
    sqlite.prepare(`
      INSERT INTO workspace_snapshot_transitions (
        repository_uuid, packet_id, transition_id, transition_kind, from_state,
        to_state, prior_version, resulting_version, transition_started_at,
        recorded_at, receipt_json, error_json, snapshot_fingerprint, snapshot_generation
      ) VALUES (?, ?, ?, 'transition', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repositoryUuid,
      packetId,
      transitionId,
      input.expectedState,
      input.toState,
      input.expectedVersion,
      input.expectedVersion + 1,
      transitionStartedAt,
      recordedAt,
      receiptJson,
      errorJson,
      current.snapshot_fingerprint,
      current.snapshot_generation,
    );
    return { status: 'applied', record: mapSnapshotRow(current) };
  });
  return execute.immediate();
}

export function getWorkspaceSnapshot(
  repositoryUuid: string,
  packetId: string,
): WorkspaceSnapshotRecord | null {
  return readConsistentSnapshot(() => {
    const row = selectSnapshot(
      requiredText(repositoryUuid, 'repositoryUuid'),
      requiredText(packetId, 'packetId'),
    );
    return row ? mapSnapshotRow(row) : null;
  });
}

/** One statement keeps the snapshot and receipt chain consistent without a poll transaction. */
export function listParkedWorkspaceReceipts(): Array<{
  snapshot: WorkspaceSnapshotRecord; reclaimedAvailableBytes: number | null;
}> {
  const rows = getSqlite().prepare(`SELECT s.*, t.* FROM workspace_snapshots s
    LEFT JOIN workspace_snapshot_transitions t ON s.repository_uuid = t.repository_uuid AND s.packet_id = t.packet_id
    WHERE s.state = 'parked' ORDER BY s.repository_uuid, s.packet_id, t.resulting_version, t.transition_id`)
    .expand(true).all() as Array<{ workspace_snapshots: WorkspaceSnapshotRow;
      workspace_snapshot_transitions: WorkspaceSnapshotTransitionRow }>;
  const grouped = new Map<string, { row: WorkspaceSnapshotRow; chain: WorkspaceSnapshotTransitionRow[] }>();
  for (const { workspace_snapshots: row, workspace_snapshot_transitions: receipt } of rows) {
    const key = JSON.stringify([row.repository_uuid, row.packet_id]);
    const entry = grouped.get(key) ?? { row, chain: [] };
    if (receipt.transition_id) entry.chain.push(receipt);
    grouped.set(key, entry);
  }
  return [...grouped.values()].flatMap(({ row, chain }) => {
    try {
      const snapshot = mapSnapshotRow(row, chain);
      const parked = chain.findLast(receipt => receipt.to_state === 'parked'
        && receipt.from_state === 'hibernating' && receipt.snapshot_generation === snapshot.snapshotGeneration);
      const value = parked ? parseReceipt(parked.receipt_json)?.reclaimedAvailableBytes : undefined;
      return [{ snapshot, reclaimedAvailableBytes: typeof value === 'number' && Number.isSafeInteger(value) ? value : null }];
    } catch { return []; } // Corrupt or ambiguous recovery truth is never projected as parked proof.
  });
}

/** Packet-wide lookup for the pre-spawn materialization guard. Multiple rows are ambiguous. */
export function listWorkspaceSnapshotsByPacketId(packetId: string): WorkspaceSnapshotRecord[] {
  return readConsistentSnapshot(() => {
    const rows = getSqlite().prepare(`
      SELECT * FROM workspace_snapshots
      WHERE packet_id = ?
      ORDER BY repository_uuid ASC
    `).all(requiredText(packetId, 'packetId')) as WorkspaceSnapshotRow[];
    return rows.map(row => mapSnapshotRow(row));
  });
}

/** Exact materialization lookup for cleanup retirement; multiple rows are ambiguous. */
export function listWorkspaceSnapshotsByOriginalPath(originalPath: string): WorkspaceSnapshotRecord[] {
  return readConsistentSnapshot(() => {
    const rows = getSqlite().prepare(`
      SELECT * FROM workspace_snapshots
      WHERE original_path = ?
      ORDER BY repository_uuid ASC, packet_id ASC
    `).all(originalPath.trim()) as WorkspaceSnapshotRow[];
    return rows.map(row => mapSnapshotRow(row));
  });
}

export function listWorkspaceSnapshotsByRepositoryUuid(
  repositoryUuid: string,
): WorkspaceSnapshotRecord[] {
  return readConsistentSnapshot(() => getSqlite().prepare(`
      SELECT * FROM workspace_snapshots WHERE repository_uuid = ? ORDER BY updated_at DESC
    `).all(requiredText(repositoryUuid, 'repositoryUuid')).map((row) => mapSnapshotRow(
      row as WorkspaceSnapshotRow,
    )));
}

function selectWorkspaceSnapshotsForReconciliation(): WorkspaceSnapshotRow[] {
  return getSqlite().prepare(`
    SELECT * FROM workspace_snapshots
    WHERE state IN ('parkable', 'hibernating', 'restoring', 'retiring')
    ORDER BY updated_at ASC, repository_uuid ASC, packet_id ASC
  `).all() as WorkspaceSnapshotRow[];
}

export function listWorkspaceSnapshotsForReconciliation(): WorkspaceSnapshotRecord[] {
  return readConsistentSnapshot(() => selectWorkspaceSnapshotsForReconciliation().map(row => mapSnapshotRow(row)));
}

function selectRetiredSnapshotsPendingLaneSettlement(): WorkspaceSnapshotRow[] {
  return getSqlite().prepare(`
    SELECT * FROM workspace_snapshots s WHERE s.state = 'retired' AND EXISTS (
      SELECT 1 FROM lanes WHERE lanes.id = s.lane_id AND lanes.packet_id = s.packet_id
        AND lanes.status NOT IN ('archived', 'completed', 'failed')
    ) ORDER BY s.updated_at ASC
  `).all() as WorkspaceSnapshotRow[];
}

export function scanRetiredSnapshotsPendingLaneSettlement(): WorkspaceSnapshotReconciliationScan {
  return readConsistentSnapshot(() => {
    const scan: WorkspaceSnapshotReconciliationScan = { snapshots: [], corruptions: [] };
    for (const row of selectRetiredSnapshotsPendingLaneSettlement()) {
      try { scan.snapshots.push(mapSnapshotRow(row)); }
      catch (error) {
        scan.corruptions.push({
          repositoryUuid: row.repository_uuid, packetId: row.packet_id,
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return scan;
  });
}

/** Isolate corrupt fleet rows during startup; point reads remain strict. */
export function scanWorkspaceSnapshotsForReconciliation(): WorkspaceSnapshotReconciliationScan {
  return readConsistentSnapshot(() => {
    const snapshots: WorkspaceSnapshotRecord[] = [];
    const corruptions: WorkspaceSnapshotReconciliationScan['corruptions'] = [];
    for (const row of selectWorkspaceSnapshotsForReconciliation()) {
      try {
        snapshots.push(mapSnapshotRow(row));
      } catch (error) {
        corruptions.push({
          repositoryUuid: row.repository_uuid,
          packetId: row.packet_id,
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { snapshots, corruptions };
  });
}

export function countWorkspaceSnapshotsByState(state: WorkspaceSnapshotState): number {
  const row = getSqlite().prepare(`
    SELECT COUNT(*) AS count FROM workspace_snapshots WHERE state = ?
  `).get(state) as { count: number };
  return row.count;
}

export function listWorkspaceSnapshotTransitions(
  repositoryUuid: string,
  packetId: string,
): WorkspaceSnapshotTransitionReceipt[] {
  const normalizedRepositoryUuid = requiredText(repositoryUuid, 'repositoryUuid');
  const normalizedPacketId = requiredText(packetId, 'packetId');
  return readConsistentSnapshot(() => {
    if (!getWorkspaceSnapshot(normalizedRepositoryUuid, normalizedPacketId)) return [];
    return selectSnapshotReceiptChain(normalizedRepositoryUuid, normalizedPacketId)
      .map(mapTransitionRow);
  });
}
