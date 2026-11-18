import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readStorageDependencyCloneContract } from './storage-dependency-contract';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import {
  StorageAdmissionMutationReuseError,
  StorageAdmissionStore,
  observeStorageVolume,
  type StorageVolumeObservation,
} from './storage-admission';

function openDatabase(file: string): Database.Database {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  ensureV38StorageAdmissionSchema(sqlite);
  return sqlite;
}

function observed(
  observedAt: number,
  availableBytes = 900,
  volumeId = 'device:test',
): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath: '/tmp/o8-storage-admission',
    probePath: '/tmp',
    volumeId,
    availableBytes,
    freeBytes: availableBytes,
    totalBytes: 1_000,
    observedAt,
    error: null,
  };
}

function reserveInput(
  sequence: number,
  overrides: Partial<Parameters<StorageAdmissionStore['reserve']>[0]> = {},
) {
  return {
    mutationId: `reserve-mutation-${sequence}`,
    reservationId: `reservation-${sequence}`,
    targetPath: '/tmp/o8-storage-admission',
    exactBytes: 400,
    ownerId: `owner-${sequence}`,
    ownerGeneration: 1,
    leaseExpiresAt: 2_000,
    policy: { reserveRatio: 0.1, absoluteFloorBytes: 100 },
    ...overrides,
  };
}

describe('storage admission', () => {
  it.each([20, 466, 2048])('admits a small reservation with 15 GiB free on a %i GiB volume', async (totalGiB) => {
    const gib = 1024 ** 3;
    const sqlite = openDatabase(':memory:');
    try {
      const store = new StorageAdmissionStore(sqlite, {
        now: () => 1_000,
        observeVolume: async () => ({ ...observed(1_000, 15 * gib), totalBytes: totalGiB * gib }),
      });
      const receipt = await store.reserve(reserveInput(1, { exactBytes: 64 * 1024 ** 2, policy: undefined }));
      expect(receipt).toMatchObject({ decision: 'reserved', requiredReserveBytes: 5 * gib, headroomBytes: 10 * gib });
    } finally { sqlite.close(); }
  });

  it('persists an idempotent body-bound reservation through a real SQLite reopen', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-admission-reopen-'));
    const file = join(dir, 'admission.db');
    let sqlite = openDatabase(file);
    let store = new StorageAdmissionStore(sqlite, {
      now: () => 1_000,
      observeVolume: async () => observed(1_000),
    });
    const input = reserveInput(1);
    const first = await store.reserve(input);

    expect(first).toMatchObject({
      decision: 'reserved',
      reason: 'admitted',
      activeReservedBytes: 0,
      requiredReserveBytes: 100,
      headroomBytes: 800,
      idempotent: false,
    });
    sqlite.close();

    sqlite = openDatabase(file);
    store = new StorageAdmissionStore(sqlite, {
      now: () => 3_000,
      observeVolume: async () => observed(3_000, 500),
    });
    const replay = await store.reserve(input);
    expect(replay).toEqual({ ...first, idempotent: true });
    await expect(store.reserve({ ...input, exactBytes: 401 }))
      .rejects.toBeInstanceOf(StorageAdmissionMutationReuseError);
    expect(() => sqlite.prepare(
      "UPDATE storage_admission_mutations SET operation = 'release'",
    ).run()).toThrow(/immutable/);
    expect(() => sqlite.prepare('DELETE FROM storage_admission_mutations').run())
      .toThrow(/append-only/);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializes concurrent reservations so the volume reserve cannot be overcommitted', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-admission-concurrency-'));
    const file = join(dir, 'admission.db');
    const firstDb = openDatabase(file);
    const secondDb = openDatabase(file);
    const dependencies = {
      now: () => 1_000,
      observeVolume: async () => observed(1_000),
    };
    const firstStore = new StorageAdmissionStore(firstDb, dependencies);
    const secondStore = new StorageAdmissionStore(secondDb, dependencies);

    const decisions = await Promise.all([
      firstStore.reserve(reserveInput(1, { exactBytes: 500 })),
      secondStore.reserve(reserveInput(2, { exactBytes: 500 })),
    ]);

    expect(decisions.map((item) => item.decision).sort()).toEqual(['held', 'reserved']);
    expect(decisions.find((item) => item.decision === 'held')).toMatchObject({
      reason: 'reserve_breached',
      activeReservedBytes: 500,
      headroomBytes: 300,
    });
    expect(firstDb.prepare(`
      SELECT SUM(exact_bytes) AS bytes FROM storage_admission_reservations
      WHERE volume_id = 'device:test' AND state = 'reserved'
    `).get()).toEqual({ bytes: 500 });
    firstDb.close();
    secondDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses post-probe time so a slow reserve cannot create an expired lease', async () => {
    const sqlite = openDatabase(':memory:');
    let now = 1_000;
    const store = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => {
        now = 2_100;
        return observed(now);
      },
    });

    await expect(store.reserve(reserveInput(1))).resolves.toMatchObject({
      decision: 'held',
      reason: 'lease_expired',
      recordedAt: 2_100,
    });
    expect(sqlite.prepare('SELECT COUNT(*) FROM storage_admission_reservations').pluck().get())
      .toBe(0);
    sqlite.close();
  });

  it('rejects pre-probe timestamps and non-monotonic decision clocks without reserving', async () => {
    const sqlite = openDatabase(':memory:');
    let now = 1_000;
    const staleStore = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => {
        now = 1_100;
        return observed(999);
      },
    });
    await expect(staleStore.reserve(reserveInput(1, { leaseExpiresAt: 2_500 })))
      .resolves.toMatchObject({ decision: 'held', reason: 'observation_stale' });

    const backwardsStore = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => {
        now = 1_050;
        return observed(now);
      },
    });
    await expect(backwardsStore.reserve(reserveInput(2, { leaseExpiresAt: 2_500 })))
      .rejects.toThrow(/clock must remain monotonic/);
    expect(sqlite.prepare('SELECT COUNT(*) FROM storage_admission_reservations').pluck().get())
      .toBe(0);
    sqlite.close();
  });

  it('fails closed when accounting, identity, freshness, or capacity is unknown', async () => {
    const sqlite = openDatabase(':memory:');
    const observations: StorageVolumeObservation[] = [
      {
        ...observed(1_000),
        status: 'unknown',
        volumeId: null,
        availableBytes: null,
        freeBytes: null,
        totalBytes: null,
        error: { code: 'EIO', message: 'statfs failed' },
      },
      { ...observed(1_000), volumeId: null },
      observed(900),
      observed(1_000, 450),
    ];
    const store = new StorageAdmissionStore(sqlite, {
      now: () => 1_000,
      observeVolume: async () => observations.shift()!,
    });

    await expect(store.reserve(reserveInput(1))).resolves.toMatchObject({
      decision: 'held', reason: 'accounting_unknown',
    });
    await expect(store.reserve(reserveInput(2))).resolves.toMatchObject({
      decision: 'held', reason: 'volume_identity_unknown',
    });
    await expect(store.reserve(reserveInput(3, {
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 100, observationMaxAgeMs: 50 },
    }))).resolves.toMatchObject({ decision: 'held', reason: 'observation_stale' });
    await expect(store.reserve(reserveInput(4))).resolves.toMatchObject({
      decision: 'held', reason: 'reserve_breached',
    });
    expect(sqlite.prepare('SELECT COUNT(*) FROM storage_admission_reservations').pluck().get())
      .toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) FROM storage_admission_mutations').pluck().get())
      .toBe(4);
    sqlite.close();
  });

  it('requires a same-volume post-statfs receipt before commit or release', async () => {
    const sqlite = openDatabase(':memory:');
    let now = 1_000;
    let nextObservation = observed(now);
    const store = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => nextObservation,
    });
    await store.reserve(reserveInput(1));
    now = 1_100;
    nextObservation = {
      ...observed(now),
      status: 'unknown',
      volumeId: null,
      availableBytes: null,
      freeBytes: null,
      totalBytes: null,
      error: { code: 'EIO', message: 'post-statfs failed' },
    };
    const held = await store.commit({
      mutationId: 'commit-unknown',
      reservationId: 'reservation-1',
      volumeId: 'device:test',
      ownerId: 'owner-1',
      ownerGeneration: 1,
      expectedGeneration: 1,
    });
    expect(held).toMatchObject({ decision: 'held', reason: 'accounting_unknown' });
    expect(held.reservation?.state).toBe('reserved');

    nextObservation = observed(now, 650, 'device:other');
    await expect(store.release({
      mutationId: 'release-other-volume',
      reservationId: 'reservation-1',
      volumeId: 'device:test',
      ownerId: 'owner-1',
      ownerGeneration: 1,
      expectedGeneration: 1,
    })).resolves.toMatchObject({ decision: 'held', reason: 'volume_conflict' });

    nextObservation = observed(now, 650);
    const committed = await store.commit({
      mutationId: 'commit-observed',
      reservationId: 'reservation-1',
      volumeId: 'device:test',
      ownerId: 'owner-1',
      ownerGeneration: 1,
      expectedGeneration: 1,
    });
    expect(committed).toMatchObject({
      decision: 'committed',
      reason: 'committed',
      observedAvailableDeltaBytes: 250,
      reservation: { state: 'committed', generation: 2 },
    });

    now = 1_200;
    nextObservation = observed(now, 650);
    const second = await store.reserve(reserveInput(2));
    expect(second).toMatchObject({ decision: 'reserved', activeReservedBytes: 0 });
    nextObservation = observed(now, 640);
    const released = await store.release({
      mutationId: 'release-observed',
      reservationId: 'reservation-2',
      volumeId: 'device:test',
      ownerId: 'owner-2',
      ownerGeneration: 1,
      expectedGeneration: 1,
    });
    expect(released).toMatchObject({
      decision: 'released',
      reason: 'released',
      observedAvailableDeltaBytes: 10,
      reservation: { state: 'released', generation: 2 },
    });
    sqlite.close();
  });

  it('holds commit when its lease expires while the post-launch probe is running', async () => {
    const sqlite = openDatabase(':memory:');
    let now = 1_000;
    let expireDuringProbe = false;
    const store = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => {
        if (expireDuringProbe) now = 2_100;
        return observed(now);
      },
    });
    const reserved = await store.reserve(reserveInput(1));
    expireDuringProbe = true;
    await expect(store.commit({
      mutationId: 'commit-after-slow-probe',
      reservationId: reserved.reservation!.reservationId,
      volumeId: reserved.reservation!.volumeId,
      ownerId: reserved.reservation!.ownerId,
      ownerGeneration: reserved.reservation!.ownerGeneration,
      expectedGeneration: reserved.reservation!.generation,
    })).resolves.toMatchObject({
      decision: 'held',
      reason: 'lease_expired',
      recordedAt: 2_100,
      reservation: { state: 'reserved' },
    });
    sqlite.close();
  });

  it('keeps expired reservations held until dead ownership and current accounting are proven', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-admission-reconcile-'));
    const file = join(dir, 'admission.db');
    let now = 100_000;
    let sqlite = openDatabase(file);
    let store = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => observed(now),
    });
    await store.reserve(reserveInput(1, { leaseExpiresAt: 100_100 }));
    now = 150_000;
    sqlite.close();

    sqlite = openDatabase(file);
    store = new StorageAdmissionStore(sqlite, {
      now: () => now,
      observeVolume: async () => observed(now, 700),
    });
    expect(store.listExpiredForReconciliation()).toHaveLength(1);
    const base = {
      reservationId: 'reservation-1',
      volumeId: 'device:test',
      ownerId: 'owner-1',
      ownerGeneration: 1,
      expectedGeneration: 1,
    };
    const deathReceipt = {
      source: 'process-group',
      evidence: 'no live members',
      observedAt: now,
      reservationId: base.reservationId,
      volumeId: base.volumeId,
      ownerId: base.ownerId,
      ownerGeneration: base.ownerGeneration,
    };
    await expect(store.reconcile({
      ...base,
      mutationId: 'reconcile-unknown-owner',
      ownerLiveness: 'unknown',
    })).resolves.toMatchObject({ decision: 'held', reason: 'owner_not_proven_dead' });
    await expect(store.reconcile({
      ...base,
      mutationId: 'reconcile-stale-proof',
      ownerLiveness: 'dead',
      ownerDeathReceipt: { ...deathReceipt, evidence: 'gone', observedAt: 100_000 },
    })).resolves.toMatchObject({ decision: 'held', reason: 'owner_not_proven_dead' });

    for (const [label, receipt] of [
      ['reservation', { ...deathReceipt, reservationId: 'reservation-other' }],
      ['owner', { ...deathReceipt, ownerId: 'owner-other' }],
      ['generation', { ...deathReceipt, ownerGeneration: 2 }],
      ['volume', { ...deathReceipt, volumeId: 'device:other' }],
    ] as const) {
      await expect(store.reconcile({
        ...base,
        mutationId: `reconcile-wrong-${label}`,
        ownerLiveness: 'dead',
        ownerDeathReceipt: receipt,
      })).resolves.toMatchObject({ decision: 'held', reason: 'owner_not_proven_dead' });
    }

    const reconciled = await store.reconcile({
      ...base,
      mutationId: 'reconcile-proven-dead',
      ownerLiveness: 'dead',
      ownerDeathReceipt: deathReceipt,
    });
    expect(reconciled).toMatchObject({
      decision: 'reconciled',
      reason: 'dead_owner_reconciled',
      reservation: { state: 'reconciled', generation: 2 },
    });
    expect(store.listExpiredForReconciliation()).toEqual([]);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads real statfs and filesystem volume identity for an existing path', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-admission-volume-'));
    const before = Date.now();
    const receipt = await observeStorageVolume(dir);
    const after = Date.now();
    expect(receipt).toMatchObject({
      status: 'observed',
      targetPath: dir,
      probePath: dir,
      error: null,
    });
    expect(receipt.volumeId).toMatch(/^(?:volume-(?:uuid|mount|unique):.+|device:\d+)$/);
    expect(receipt.availableBytes).toBeGreaterThan(0);
    expect(receipt.totalBytes).toBeGreaterThan(receipt.availableBytes!);
    expect(receipt.observedAt).toBeGreaterThanOrEqual(before);
    expect(receipt.observedAt).toBeLessThanOrEqual(after);
    rmSync(dir, { recursive: true, force: true });
  });
});


it('retains body-bound clone authority through SQLite reopen and rejects mismatched reservation identity', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'o8-clone-contract-reopen-'));
  const file = join(root, 'admission.db');
  const dependencyCloneContract = { creationBaseCommit: 'a'.repeat(40), recipeKey: 'b'.repeat(64),
    installCommand: 'npm ci --ignore-scripts', dependencyBytes: 4096 };
  const input = reserveInput(71, { dependencyCloneContract });
  let db = openDatabase(file);
  try {
    const original = await new StorageAdmissionStore(db, { now: () => 1000, observeVolume: async () => observed(1000) }).reserve(input);
    expect(original.dependencyCloneContract).toEqual(dependencyCloneContract);
    db.close();
    db = openDatabase(file);
    const store = new StorageAdmissionStore(db, { now: () => 1000, observeVolume: async () => observed(1000) });
    const reservation = store.getReservation(input.reservationId)!;
    expect(readStorageDependencyCloneContract(db, reservation)).toEqual(dependencyCloneContract);
    await expect(store.reserve({ ...input, dependencyCloneContract: { ...dependencyCloneContract, recipeKey: 'c'.repeat(64) } }))
      .rejects.toThrow(StorageAdmissionMutationReuseError);
    expect(readStorageDependencyCloneContract(db, reservation)).toEqual(dependencyCloneContract);
    expect(() => readStorageDependencyCloneContract(db, { ...reservation, exactBytes: reservation.exactBytes + 1 }))
      .toThrow(/original receipt/);
    expect(() => readStorageDependencyCloneContract(db, { ...reservation, ownerId: 'other-owner' }))
      .toThrow(/original receipt/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
