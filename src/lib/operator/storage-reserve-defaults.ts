import 'server-only';

import { envStorageReserveFloorGb, envStorageReserveRatio } from './defaults-env';

export interface StorageReserveDefaults {
  storageReserveRatio: number;
  storageReserveFloorGb: number;
}

export const STORAGE_RESERVE_FALLBACK: StorageReserveDefaults = {
  storageReserveRatio: 0,
  storageReserveFloorGb: 5,
};

export function resolveStoredStorageReserve(
  stored: Partial<StorageReserveDefaults>,
): Partial<StorageReserveDefaults> {
  const resolved: Partial<StorageReserveDefaults> = {};
  if (
    typeof stored.storageReserveRatio === 'number'
    && Number.isFinite(stored.storageReserveRatio)
    && stored.storageReserveRatio >= 0
    && stored.storageReserveRatio <= 1
  ) resolved.storageReserveRatio = stored.storageReserveRatio;
  if (
    typeof stored.storageReserveFloorGb === 'number'
    && Number.isFinite(stored.storageReserveFloorGb)
    && stored.storageReserveFloorGb > 0
    && stored.storageReserveFloorGb <= 10000
  ) resolved.storageReserveFloorGb = stored.storageReserveFloorGb;
  return resolved;
}

export function resolveStorageReserveSettings(file: Partial<StorageReserveDefaults>) {
  const envRatio = envStorageReserveRatio();
  const envFloor = envStorageReserveFloorGb();
  return {
    values: {
      storageReserveRatio: envRatio ?? file.storageReserveRatio ?? STORAGE_RESERVE_FALLBACK.storageReserveRatio,
      storageReserveFloorGb: envFloor ?? file.storageReserveFloorGb ?? STORAGE_RESERVE_FALLBACK.storageReserveFloorGb,
    },
    sources: {
      storageReserveRatio: envRatio !== null ? 'env' as const : file.storageReserveRatio !== undefined ? 'file' as const : 'default' as const,
      storageReserveFloorGb: envFloor !== null ? 'env' as const : file.storageReserveFloorGb !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyStorageReserveUpdate(
  stored: Partial<StorageReserveDefaults>,
  update: Partial<StorageReserveDefaults>,
): void {
  if (update.storageReserveRatio !== undefined) {
    if (!Number.isFinite(update.storageReserveRatio) || update.storageReserveRatio < 0 || update.storageReserveRatio > 1) {
      throw new Error('storageReserveRatio must be between 0 and 1.');
    }
    stored.storageReserveRatio = update.storageReserveRatio;
  }
  if (update.storageReserveFloorGb !== undefined) {
    if (!Number.isFinite(update.storageReserveFloorGb) || update.storageReserveFloorGb <= 0 || update.storageReserveFloorGb > 10000) {
      throw new Error('storageReserveFloorGb must be greater than 0 and no more than 10000.');
    }
    stored.storageReserveFloorGb = update.storageReserveFloorGb;
  }
}
