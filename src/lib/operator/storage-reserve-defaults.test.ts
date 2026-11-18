import { afterEach, describe, expect, it } from 'vitest';

import {
  applyStorageReserveUpdate,
  resolveStorageReserveSettings,
  resolveStoredStorageReserve,
} from './storage-reserve-defaults';

const originalRatio = process.env.O8_STORAGE_RESERVE_RATIO;
const originalFloor = process.env.O8_STORAGE_RESERVE_FLOOR_GB;

afterEach(() => {
  if (originalRatio === undefined) delete process.env.O8_STORAGE_RESERVE_RATIO;
  else process.env.O8_STORAGE_RESERVE_RATIO = originalRatio;
  if (originalFloor === undefined) delete process.env.O8_STORAGE_RESERVE_FLOOR_GB;
  else process.env.O8_STORAGE_RESERVE_FLOOR_GB = originalFloor;
});

describe('storage reserve operator defaults', () => {
  it('resolves default, file, and environment values with truthful sources', () => {
    delete process.env.O8_STORAGE_RESERVE_RATIO;
    delete process.env.O8_STORAGE_RESERVE_FLOOR_GB;
    expect(resolveStorageReserveSettings({})).toEqual({
      values: { storageReserveRatio: 0, storageReserveFloorGb: 5 },
      sources: { storageReserveRatio: 'default', storageReserveFloorGb: 'default' },
    });
    expect(resolveStorageReserveSettings({ storageReserveRatio: 0.2, storageReserveFloorGb: 24 })).toEqual({
      values: { storageReserveRatio: 0.2, storageReserveFloorGb: 24 },
      sources: { storageReserveRatio: 'file', storageReserveFloorGb: 'file' },
    });

    process.env.O8_STORAGE_RESERVE_RATIO = '0.3';
    process.env.O8_STORAGE_RESERVE_FLOOR_GB = '32';
    expect(resolveStorageReserveSettings({ storageReserveRatio: 0.2, storageReserveFloorGb: 24 })).toEqual({
      values: { storageReserveRatio: 0.3, storageReserveFloorGb: 32 },
      sources: { storageReserveRatio: 'env', storageReserveFloorGb: 'env' },
    });
  });

  it('rejects invalid stored, environment, and update values at the same bounds', () => {
    expect(resolveStoredStorageReserve({ storageReserveRatio: 2, storageReserveFloorGb: 10001 })).toEqual({});
    process.env.O8_STORAGE_RESERVE_RATIO = '2';
    process.env.O8_STORAGE_RESERVE_FLOOR_GB = '10001';
    expect(resolveStorageReserveSettings({})).toEqual({
      values: { storageReserveRatio: 0, storageReserveFloorGb: 5 },
      sources: { storageReserveRatio: 'default', storageReserveFloorGb: 'default' },
    });
    expect(() => applyStorageReserveUpdate({}, { storageReserveRatio: -0.1 })).toThrow(/between 0 and 1/);
    expect(() => applyStorageReserveUpdate({}, { storageReserveFloorGb: 10001 })).toThrow(/no more than 10000/);
  });

  it('persists an explicitly disabled percentage reserve through every source', () => {
    delete process.env.O8_STORAGE_RESERVE_RATIO;
    delete process.env.O8_STORAGE_RESERVE_FLOOR_GB;
    const stored = { storageReserveRatio: 0.1, storageReserveFloorGb: 4 };
    applyStorageReserveUpdate(stored, { storageReserveRatio: 0 });
    expect(resolveStoredStorageReserve(stored)).toEqual({ storageReserveRatio: 0, storageReserveFloorGb: 4 });
    expect(resolveStorageReserveSettings(stored)).toMatchObject({
      values: { storageReserveRatio: 0, storageReserveFloorGb: 4 },
      sources: { storageReserveRatio: 'file', storageReserveFloorGb: 'file' },
    });
    process.env.O8_STORAGE_RESERVE_RATIO = '0';
    expect(resolveStorageReserveSettings({ storageReserveRatio: 0.5 })).toMatchObject({
      values: { storageReserveRatio: 0 }, sources: { storageReserveRatio: 'env' },
    });
  });
});
