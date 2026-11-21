import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureWorktreeMaintenanceDiscoverySchema } from '@/lib/db/v83-runtime-tables-migration';
import type { WorktreeMetaEntry } from './types';
import { canonicalRepoRoot, resolveWorktreeRootLayout } from './root-layout';

export type MaintenancePhase = 'active' | 'terminal' | 'roots' | 'metadata' | 'claims' | 'legacy' | 'completion';
export const MAINTENANCE_PHASES: MaintenancePhase[] = ['active', 'terminal', 'roots', 'metadata', 'claims', 'legacy', 'completion'];

export interface MaintenanceCandidate {
  key: string;
  id?: string;
  repositoryPath?: string;
  metadataRoot?: string;
  worktreeId?: string;
  worktreePath?: string;
  laneId?: string | null;
  packetId?: string | null;
  revision?: string;
}

interface Cursor { after: string; upper: string }
const initialized = new WeakSet<Database.Database>();
export { WORKTREE_LANE_BASENAME_SQL } from '@/lib/db/v83-runtime-tables-migration';

/** Discovery is advisory. Metadata, holds and the exact retirement journal remain authority. */
export function ensureMaintenanceDiscoverySchema(sqlite: Database.Database = getSqlite()): void {
  if (initialized.has(sqlite)) return;
  ensureWorktreeMaintenanceDiscoverySchema(sqlite);
  initialized.add(sqlite);
}

export function readMaintenanceState<T>(key: string): T | null {
  ensureMaintenanceDiscoverySchema();
  const row = getSqlite().prepare('SELECT value_json FROM worktree_maintenance_state WHERE key = ?')
    .get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as T : null;
}

export function writeMaintenanceState(key: string, value: unknown): void {
  ensureMaintenanceDiscoverySchema();
  getSqlite().prepare(`INSERT INTO worktree_maintenance_state(key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(key, JSON.stringify(value));
}

export function metadataDiscoveryRevision(payload: string): string {
  return createHash('sha256').update(JSON.stringify(JSON.parse(payload))).digest('hex');
}

export function registerMaintenanceRoot(
  repositoryPath: string,
  metadataRoot: string,
  sqlite: Database.Database = getSqlite(),
): void {
  ensureMaintenanceDiscoverySchema(sqlite);
  const repo = canonicalRepoRoot(repositoryPath);
  let root = path.resolve(metadataRoot);
  try { root = realpathSync.native(root); } catch { /* Missing advisory roots remain exact names. */ }
  const existing = sqlite.prepare('SELECT repository_path FROM worktree_maintenance_roots WHERE metadata_root = ?')
    .get(root) as { repository_path: string } | undefined;
  if (existing?.repository_path && existing.repository_path !== repo) {
    throw new Error('Maintenance metadata root has conflicting repository associations.');
  }
  sqlite.prepare(`INSERT OR IGNORE INTO worktree_maintenance_roots(metadata_root, repository_path)
    VALUES (?, ?)`).run(root, repo);
  sqlite.prepare(`UPDATE worktree_maintenance_roots SET repository_path = ?
    WHERE metadata_root = ? AND repository_path = ''`).run(repo, root);
}

export function registerMaintenanceRepository(repositoryPath: string): void {
  const layout = resolveWorktreeRootLayout(repositoryPath);
  registerMaintenanceRoot(repositoryPath, layout.primaryBase);
}

/** Caller holds the metadata lease and SQLite transaction that publishes the authoritative blob. */
export function projectMaintenanceMetadata(
  sqlite: Database.Database,
  repositoryPath: string,
  metadataRoot: string,
  payload: string,
): void {
  registerMaintenanceRoot(repositoryPath, metadataRoot, sqlite);
  repositoryPath = canonicalRepoRoot(repositoryPath);
  metadataRoot = realpathSync.native(metadataRoot);
  const revision = metadataDiscoveryRevision(payload);
  const parsed = JSON.parse(payload) as { worktrees: Record<string, WorktreeMetaEntry> };
  sqlite.prepare('DELETE FROM worktree_maintenance_entries WHERE metadata_root = ?').run(metadataRoot);
  const insert = sqlite.prepare(`INSERT INTO worktree_maintenance_entries (
    discovery_key, metadata_root, repository_path, worktree_id, worktree_path, lane_id, packet_id, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [id, entry] of Object.entries(parsed.worktrees)) {
    if (entry.claudeManaged) continue;
    insert.run(`${metadataRoot}\0${id}`, metadataRoot, repositoryPath, id,
      entry.materializationIdentity?.canonicalPath ?? path.join(metadataRoot, id),
      entry.laneId ?? null, entry.packetId ?? null, revision);
  }
  sqlite.prepare(`UPDATE worktree_maintenance_roots
    SET revision = ?, held_reason = NULL, checked_at = ? WHERE metadata_root = ?`)
    .run(revision, Date.now(), metadataRoot);
}

export function holdMaintenanceRoot(metadataRoot: string, reason: string): void {
  getSqlite().prepare(`UPDATE worktree_maintenance_roots SET held_reason = ?, checked_at = ?
    WHERE metadata_root = ?`).run(reason, Date.now(), metadataRoot);
}

function phaseQuery(phase: MaintenancePhase): { table: string; key: string; columns: string; where: string } {
  if (phase === 'completion') return {
    table: 'worktree_maintenance_pending', key: 'lane_id', columns: 'lane_id AS id', where: '1',
  };
  if (phase === 'active' || phase === 'terminal') return {
    table: 'lanes', key: "created_at || char(0) || id",
    columns: 'id, repo_path AS repositoryPath',
    where: phase === 'active' ? "status NOT IN ('completed', 'archived')" : "status IN ('completed', 'archived')",
  };
  if (phase === 'roots') return {
    table: 'worktree_maintenance_roots', key: 'metadata_root',
    columns: 'metadata_root AS metadataRoot, repository_path AS repositoryPath', where: '1',
  };
  if (phase === 'metadata') return {
    table: 'worktree_maintenance_entries', key: 'discovery_key',
    columns: `metadata_root AS metadataRoot, repository_path AS repositoryPath,
      worktree_id AS worktreeId, worktree_path AS worktreePath, lane_id AS laneId, packet_id AS packetId, revision`,
    where: '1',
  };
  if (phase === 'legacy') return {
    table: 'worktree_metadata_state', key: 'metadata_root',
    columns: 'metadata_root AS metadataRoot', where: '1',
  };
  return {
    table: 'workspace_exact_claims', key: "repository_path || char(0) || worktree_id",
    columns: 'repository_path AS repositoryPath, worktree_id AS worktreeId, source_path AS worktreePath',
    where: "kind = 'managed-retirement'",
  };
}

export function queueTerminalWorktreeMaintenance(laneId: string): void {
  ensureMaintenanceDiscoverySchema();
  getSqlite().prepare('INSERT OR IGNORE INTO worktree_maintenance_pending(lane_id) VALUES (?)').run(laneId);
}

/** Indexed keyset pages, with a finite cycle boundary so new rows cannot starve retries. */
export function nextMaintenanceCandidate(phase: MaintenancePhase): MaintenanceCandidate | null {
  ensureMaintenanceDiscoverySchema();
  const sqlite = getSqlite();
  const q = phaseQuery(phase);
  let cursor = readMaintenanceState<Cursor>(`cursor:${phase}`);
  const lanePhase = phase === 'active' || phase === 'terminal';
  const table = lanePhase ? `${q.table} INDEXED BY idx_maintenance_${phase}_lanes` : q.table;
  const claimPhase = phase === 'claims';
  const order = lanePhase ? 'created_at, id' : claimPhase ? 'repository_path, worktree_id' : q.key;
  if (!cursor) {
    const upper = sqlite.prepare(`SELECT ${q.key} AS key FROM ${table}
      WHERE ${q.where} ORDER BY ${order.split(', ').map((field) => `${field} DESC`).join(', ')} LIMIT 1`)
      .get() as { key: string } | undefined;
    if (!upper) return null;
    cursor = { after: '', upper: upper.key };
    writeMaintenanceState(`cursor:${phase}`, cursor);
  }
  const split = (key: string): [string, string] => {
    const separator = key.indexOf('\0');
    return separator < 0 ? ['', ''] : [key.slice(0, separator), key.slice(separator + 1)];
  };
  const predicate = lanePhase ? '(created_at, id) > (?, ?) AND (created_at, id) <= (?, ?)'
    : claimPhase ? '(repository_path, worktree_id) > (?, ?) AND (repository_path, worktree_id) <= (?, ?)'
      : `${q.key} > ? AND ${q.key} <= ?`;
  const params = lanePhase || claimPhase
    ? [...split(cursor.after), ...split(cursor.upper)] : [cursor.after, cursor.upper];
  const row = sqlite.prepare(`SELECT ${q.key} AS key, ${q.columns} FROM ${table}
    WHERE ${q.where} AND ${predicate} ORDER BY ${order} LIMIT 1`).get(...params) as MaintenanceCandidate | undefined;
  if (row) return row;
  getSqlite().prepare('DELETE FROM worktree_maintenance_state WHERE key = ?').run(`cursor:${phase}`);
  return null;
}

/** Advance only after the admitted action settles; a crash replays its exact journal. */
export function advanceMaintenanceCandidate(phase: MaintenancePhase, key: string): void {
  const cursor = readMaintenanceState<Cursor>(`cursor:${phase}`);
  if (cursor) writeMaintenanceState(`cursor:${phase}`, { ...cursor, after: key });
}

export function readWorktreeMaintenanceStatus(after = '', limit = 50, repositoryPath?: string) {
  ensureMaintenanceDiscoverySchema();
  const pageLimit = Math.min(50, Math.max(1, limit));
  const repo = repositoryPath === undefined ? undefined : canonicalRepoRoot(repositoryPath);
  const holds = getSqlite().prepare(`SELECT metadata_root AS metadataRoot,
    repository_path AS repositoryPath, held_reason AS reason, checked_at AS checkedAt
    FROM worktree_maintenance_roots WHERE held_reason IS NOT NULL AND metadata_root > ?
    ${repo === undefined ? '' : 'AND repository_path = ?'}
    ORDER BY metadata_root LIMIT ?`).all(...(repo === undefined ? [after, pageLimit] : [after, repo, pageLimit]));
  return {
    schema: 'o8/worktree-maintenance/v1',
    ...(repo === undefined ? {} : { repositoryPath: repo }),
    // The persisted pass spans repositories; it cannot establish one repository's outcome.
    lastPass: repo === undefined ? readMaintenanceState('last-pass') : null,
    holds,
  };
}
