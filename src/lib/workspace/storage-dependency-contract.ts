import type Database from 'better-sqlite3';
import type { StorageReservationRecord } from './storage-admission';

/** Immutable reservation authority. Metadata bytes are an estimate, not APFS allocation proof. */
export interface StorageDependencyCloneContract {
  creationBaseCommit: string;
  recipeKey: string;
  installCommand: string;
  dependencyBytes: number;
}

export function normalizeStorageDependencyCloneContract(value: StorageDependencyCloneContract): StorageDependencyCloneContract {
  if (!value || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.creationBaseCommit)
    || !/^[0-9a-f]{64}$/.test(value.recipeKey) || typeof value.installCommand !== 'string'
    || !value.installCommand.trim() || value.installCommand !== value.installCommand.trim()
    || !Number.isSafeInteger(value.dependencyBytes) || value.dependencyBytes <= 0) {
    throw new Error('Dependency clone admission contract is invalid.');
  }
  return { creationBaseCommit: value.creationBaseCommit, recipeKey: value.recipeKey,
    installCommand: value.installCommand, dependencyBytes: value.dependencyBytes };
}

/** Read original authority from the append-only reserve receipt, including after restart. */
export function readStorageDependencyCloneContract(
  sqlite: Database.Database,
  reservation: StorageReservationRecord,
): StorageDependencyCloneContract | null {
  const rows = sqlite.prepare(`SELECT result_json FROM storage_admission_mutations
    WHERE reservation_id = ? AND operation = 'reserve' ORDER BY rowid`).all(reservation.reservationId) as Array<{ result_json: string }>;
  for (const row of rows) {
    const result = JSON.parse(row.result_json) as { decision: string; reservation: StorageReservationRecord | null;
      dependencyCloneContract?: StorageDependencyCloneContract };
    if (result.decision !== 'reserved' || !result.reservation) continue;
    const original = result.reservation;
    if (original.reservationId !== reservation.reservationId || original.ownerId !== reservation.ownerId
      || original.ownerGeneration !== reservation.ownerGeneration || original.targetPath !== reservation.targetPath
      || original.volumeId !== reservation.volumeId || original.exactBytes !== reservation.exactBytes
      || JSON.stringify(original.rootIdentity ?? null) !== JSON.stringify(reservation.rootIdentity ?? null)) {
      throw new Error('Dependency clone admission reservation no longer matches its original receipt.');
    }
    return result.dependencyCloneContract ? normalizeStorageDependencyCloneContract(result.dependencyCloneContract) : null;
  }
  throw new Error('Storage admission reservation has no original reserve receipt.');
}
