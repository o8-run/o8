import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getDataDir } from '@/lib/data-dir-migration';
import { projectMaintenanceMetadata } from './maintenance-discovery';
import { chargeWorktreeMetadataRead, worktreeMetadataReadLimit, WorktreeMaintenanceHeldError } from './maintenance-budget';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';

const RETRY_MS = 20;
const WAIT_BUDGET_MS = 10_000;

interface MetadataTransactionLeaseRow {
  metadata_root: string;
  reservation_id: string;
  owner_pid: number;
  owner_identity_json: string;
  acquired_at: number;
}

export interface MetadataTransactionLease {
  metadataRoot: string;
  reservationId: string;
}

export interface MetadataTransactionBoundary {
  rootPath: string;
  rootCanonicalPath: string;
  rootDevice: number;
  rootInode: number;
  metadataRootIdentity: { canonicalPath: string; device: number; inode: number };
}

export interface MetadataMirrorIdentity {
  device: number;
  inode: number;
  canonicalPath?: string;
  volumeId?: string;
}

export class MetadataTransactionLeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataTransactionLeaseUnavailableError';
  }
}

let currentProcessIdentityPromise: Promise<MetadataLockProcessIdentity> | null = null;

function ensureSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worktree_metadata_leases (
      metadata_root TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_metadata_state (
      metadata_root TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      mirror_identity_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  const stateColumns = sqlite.prepare('PRAGMA table_info(worktree_metadata_state)')
    .all() as Array<{ name: string }>;
  if (!stateColumns.some((column) => column.name === 'mirror_identity_json')) {
    sqlite.exec('ALTER TABLE worktree_metadata_state ADD COLUMN mirror_identity_json TEXT');
  }
}

function withLeaseDatabase<T>(operation: (sqlite: Database.Database) => T): T {
  const dataDir = getDataDir();
  const databasePath = process.env.CORTEX_IDE_DB_PATH
    || path.join(dataDir, 'cortex-ide.db');
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma('busy_timeout = 5000');
    ensureSchema(sqlite);
    try {
      chmodSync(dataDir, 0o700);
      if (existsSync(databasePath)) chmodSync(databasePath, 0o600);
    } catch {
      // The main database follows the same best-effort local permission rule.
    }
    return operation(sqlite);
  } finally {
    sqlite.close();
  }
}

async function currentProcessIdentity(): Promise<MetadataLockProcessIdentity> {
  currentProcessIdentityPromise ??= probeMetadataLockProcessIdentity(process.pid).then((probe) => {
    if (probe.state !== 'live') {
      throw new MetadataTransactionLeaseUnavailableError(
        `Current process identity is ${probe.state}; worktree metadata mutation is held.`,
      );
    }
    return probe.identity;
  });
  return currentProcessIdentityPromise;
}

async function canonicalMetadataRoot(
  metadataRoot: string,
  boundary?: MetadataTransactionBoundary,
): Promise<string> {
  if (!boundary) await mkdir(metadataRoot, { recursive: true });
  if (boundary) {
    const root = await lstat(boundary.rootPath);
    const canonicalRoot = await realpath(boundary.rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()
      || root.dev !== boundary.rootDevice || root.ino !== boundary.rootInode
      || canonicalRoot !== boundary.rootCanonicalPath) {
      throw new MetadataTransactionLeaseUnavailableError(
        'The admitted worktree root changed before metadata lease acquisition.',
      );
    }
  }
  const identity = await lstat(metadataRoot);
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new MetadataTransactionLeaseUnavailableError(
      'The worktree metadata root is redirected or is not a directory.',
    );
  }
  const canonical = await realpath(metadataRoot);
  if (boundary && (identity.dev !== boundary.metadataRootIdentity.device
    || identity.ino !== boundary.metadataRootIdentity.inode
    || canonical !== boundary.metadataRootIdentity.canonicalPath)) {
    throw new MetadataTransactionLeaseUnavailableError(
      'The admitted worktree metadata root changed before lease acquisition.',
    );
  }
  return canonical;
}

function parseOwnerIdentity(row: MetadataTransactionLeaseRow): MetadataLockProcessIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.owner_identity_json) as unknown;
  } catch {
    throw new MetadataTransactionLeaseUnavailableError(
      `The worktree metadata lease for ${row.metadata_root} has corrupt owner identity.`,
    );
  }
  if (!isMetadataLockProcessIdentity(parsed)) {
    throw new MetadataTransactionLeaseUnavailableError(
      `The worktree metadata lease for ${row.metadata_root} has invalid owner identity.`,
    );
  }
  return parsed;
}

function claimLease(
  metadataRoot: string,
  reservationId: string,
  identity: MetadataLockProcessIdentity,
): { acquired: boolean; owner: MetadataTransactionLeaseRow | null } {
  return withLeaseDatabase((sqlite) => sqlite.transaction(() => {
    const inserted = sqlite.prepare(`
      INSERT OR IGNORE INTO worktree_metadata_leases (
        metadata_root, reservation_id, owner_pid, owner_identity_json, acquired_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(metadataRoot, reservationId, process.pid, JSON.stringify(identity), Date.now());
    if (inserted.changes === 1) return { acquired: true, owner: null };
    const owner = sqlite.prepare(`
      SELECT metadata_root, reservation_id, owner_pid, owner_identity_json, acquired_at
      FROM worktree_metadata_leases
      WHERE metadata_root = ?
    `).get(metadataRoot) as MetadataTransactionLeaseRow | undefined;
    return { acquired: false, owner: owner ?? null };
  }).immediate());
}

function reclaimLease(owner: MetadataTransactionLeaseRow): boolean {
  return withLeaseDatabase((sqlite) => sqlite.prepare(`
    DELETE FROM worktree_metadata_leases
    WHERE metadata_root = ? AND reservation_id = ?
  `).run(owner.metadata_root, owner.reservation_id).changes === 1);
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_MS));
}

export async function acquireMetadataTransactionLease(
  rawMetadataRoot: string,
  boundary?: MetadataTransactionBoundary,
): Promise<MetadataTransactionLease> {
  const metadataRoot = await canonicalMetadataRoot(rawMetadataRoot, boundary);
  const identity = await currentProcessIdentity();
  const reservationId = randomUUID();
  const deadline = Date.now() + WAIT_BUDGET_MS;
  for (;;) {
    const claim = claimLease(metadataRoot, reservationId, identity);
    if (claim.acquired) return { metadataRoot, reservationId };
    if (!claim.owner) {
      if (Date.now() >= deadline) break;
      await waitBriefly();
      continue;
    }
    const ownerIdentity = parseOwnerIdentity(claim.owner);
    const ownerProbe = await probeMetadataLockProcessIdentity(claim.owner.owner_pid);
    if (ownerProbe.state === 'absent'
      || (ownerProbe.state === 'live'
        && !sameMetadataLockProcessIdentity(ownerProbe.identity, ownerIdentity))) {
      reclaimLease(claim.owner);
      continue;
    }
    if (ownerProbe.state === 'unknown') {
      throw new MetadataTransactionLeaseUnavailableError(
        `The worktree metadata lease owner identity is unknown: ${ownerProbe.detail}`,
      );
    }
    if (Date.now() >= deadline) break;
    await waitBriefly();
  }
  throw new MetadataTransactionLeaseUnavailableError(
    `Timed out waiting for the exact worktree metadata owner at ${metadataRoot}.`,
  );
}

export function releaseMetadataTransactionLease(lease: MetadataTransactionLease): void {
  const released = withLeaseDatabase((sqlite) => sqlite.prepare(`
    DELETE FROM worktree_metadata_leases
    WHERE metadata_root = ? AND reservation_id = ?
  `).run(lease.metadataRoot, lease.reservationId));
  if (released.changes !== 1) {
    throw new MetadataTransactionLeaseUnavailableError(
      `Worktree metadata lease ${lease.reservationId} is no longer the owner of ${lease.metadataRoot}.`,
    );
  }
}

function assertLeaseOwner(
  sqlite: Database.Database,
  lease: MetadataTransactionLease,
): void {
  const owner = sqlite.prepare(`
    SELECT reservation_id FROM worktree_metadata_leases WHERE metadata_root = ?
  `).get(lease.metadataRoot) as { reservation_id: string } | undefined;
  if (owner?.reservation_id !== lease.reservationId) {
    throw new MetadataTransactionLeaseUnavailableError(
      `Worktree metadata lease ${lease.reservationId} no longer owns ${lease.metadataRoot}.`,
    );
  }
}

function readBoundedState(sqlite: Database.Database, metadataRoot: string) {
  const limit = worktreeMetadataReadLimit();
  const row = sqlite.prepare(`
    SELECT length(CAST(payload_json AS BLOB)) + length(CAST(COALESCE(mirror_identity_json, '') AS BLOB)) AS bytes,
      CASE WHEN length(CAST(payload_json AS BLOB)) + length(CAST(COALESCE(mirror_identity_json, '') AS BLOB)) <= ?
        THEN payload_json END AS payload_json,
      CASE WHEN length(CAST(payload_json AS BLOB)) + length(CAST(COALESCE(mirror_identity_json, '') AS BLOB)) <= ?
        THEN mirror_identity_json END AS mirror_identity_json
    FROM worktree_metadata_state WHERE metadata_root = ?
  `).get(limit ?? Number.MAX_SAFE_INTEGER, limit ?? Number.MAX_SAFE_INTEGER, metadataRoot) as {
    bytes: number; payload_json: string | null; mirror_identity_json: string | null;
  } | undefined;
  if (!row) return null;
  if (row.payload_json === null) {
    throw new WorktreeMaintenanceHeldError(metadataRoot, `metadata ${row.bytes} bytes exceeds the read allowance ${limit}`);
  }
  chargeWorktreeMetadataRead(metadataRoot, row.bytes);
  return {
    payload: row.payload_json,
    mirrorIdentity: row.mirror_identity_json
      ? JSON.parse(row.mirror_identity_json) as MetadataMirrorIdentity : null,
  };
}

export function readMetadataTransactionState(
  lease: MetadataTransactionLease,
): { payload: string; mirrorIdentity: MetadataMirrorIdentity | null } | null {
  return withLeaseDatabase((sqlite) => {
    assertLeaseOwner(sqlite, lease);
    return readBoundedState(sqlite, lease.metadataRoot);
  });
}

export function readMetadataTransactionStateSnapshot(
  metadataRoot: string,
  sqlite: Database.Database,
): { payload: string; mirrorIdentity: MetadataMirrorIdentity | null } | null {
  const schema = sqlite.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_metadata_state'
  `).get();
  if (!schema) return null;
  return readBoundedState(sqlite, path.resolve(metadataRoot));
}

export function writeMetadataTransactionState(
  lease: MetadataTransactionLease,
  payload: string,
  mirrorIdentity: MetadataMirrorIdentity | null,
  repositoryPath?: string,
  commit?: (sqlite: Database.Database) => void,
): void {
  withLeaseDatabase((sqlite) => sqlite.transaction(() => {
    assertLeaseOwner(sqlite, lease);
    sqlite.prepare(`
      INSERT INTO worktree_metadata_state (
        metadata_root, payload_json, mirror_identity_json, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(metadata_root) DO UPDATE SET
        payload_json = excluded.payload_json,
        mirror_identity_json = excluded.mirror_identity_json,
        updated_at = excluded.updated_at
    `).run(
      lease.metadataRoot,
      payload,
      mirrorIdentity ? JSON.stringify(mirrorIdentity) : null,
      Date.now(),
    );
    if (repositoryPath) projectMaintenanceMetadata(sqlite, repositoryPath, lease.metadataRoot, payload);
    commit?.(sqlite);
  }).immediate());
}
