import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

/**
 * Managed retirements stuck in `purging`. Their purge helper refused because the
 * retired tree no longer matches its stored inventory, so replay can never finish
 * them, and each retry reloads the whole inventory (up to ~190k entries).
 *
 * Abandoning removes only the claim row, its stored inventory and its replay
 * backoff. The retired directory stays on disk: the inventory mismatch is the
 * signal that the tree may hold bytes the claim never owned, and once the claim
 * is gone nothing proves ownership. Deleting it is left to the owner.
 */
export interface StuckPurge {
  operationId: string;
  repositoryPath: string;
  worktreeId: string;
  sourcePath: string;
  retiredPath: string;
  createdAt: number;
  updatedAt: number;
  ageDays: number;
  inventoryEntries: number | null;
  inventoryBytes: number;
  refused: { refusals: number; retryAfter: number } | null;
  retiredDirectory: 'present' | 'absent' | 'replaced';
  retiredDirectoryKiB: number | null;
  sourcePresent: boolean;
}

interface StuckPurgeRow {
  operation_id: string;
  repository_path: string;
  worktree_id: string;
  source_path: string;
  claim_path: string;
  claim_device: number | null;
  claim_inode: number | null;
  created_at: number;
  updated_at: number;
  inventory_entries: number | null;
  inventory_bytes: number | null;
  refusals: number | null;
  retry_after: number | null;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function directoryState(path: string, device: number | null, inode: number | null): StuckPurge['retiredDirectory'] {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'replaced';
    return stat.dev === device && stat.ino === inode ? 'present' : 'replaced';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Allocated size, counting each hard-linked inode once; links shared with live worktrees free nothing. */
function diskKiB(path: string): number | null {
  try {
    const output = execFileSync('du', ['-sk', '-x', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const value = Number.parseInt(output.split(/\s/)[0] ?? '', 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function listStuckPurges(db: Database.Database, now = Date.now(), measureDisk = true): StuckPurge[] {
  if (!hasTable(db, 'workspace_exact_claims')) return [];
  const refusals = hasTable(db, 'workspace_exact_replay_refusals');
  const rows = db.prepare(`
    SELECT claim.operation_id, claim.repository_path, claim.worktree_id, claim.source_path, claim.claim_path,
      claim.claim_device, claim.claim_inode, claim.created_at, claim.updated_at,
      CASE WHEN json_valid(claim.authority_json)
        THEN json_array_length(claim.authority_json, '$.purgeManifest.entries') END AS inventory_entries,
      octet_length(claim.authority_json) AS inventory_bytes,
      ${refusals ? 'refusal.refusals, refusal.retry_after' : 'NULL AS refusals, NULL AS retry_after'}
    FROM workspace_exact_claims AS claim
    ${refusals ? `LEFT JOIN workspace_exact_replay_refusals AS refusal
      ON refusal.operation_id = claim.operation_id AND refusal.claim_updated_at = claim.updated_at` : ''}
    WHERE claim.kind = 'managed-retirement' AND claim.state = 'purging'
    ORDER BY claim.created_at ASC
  `).all() as StuckPurgeRow[];
  return rows.map((row) => {
    const retiredDirectory = directoryState(row.claim_path, row.claim_device, row.claim_inode);
    return {
      operationId: row.operation_id,
      repositoryPath: row.repository_path,
      worktreeId: row.worktree_id,
      sourcePath: row.source_path,
      retiredPath: row.claim_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ageDays: Math.floor((now - row.created_at) / 86_400_000),
      inventoryEntries: row.inventory_entries,
      inventoryBytes: row.inventory_bytes ?? 0,
      refused: row.refusals === null || row.retry_after === null
        ? null : { refusals: row.refusals, retryAfter: row.retry_after },
      retiredDirectory,
      retiredDirectoryKiB: measureDisk && retiredDirectory !== 'absent' ? diskKiB(row.claim_path) : null,
      sourcePresent: exists(row.source_path),
    };
  });
}

/**
 * Remove the selected claim rows, each only if it is still the exact stuck row
 * that was listed. Directories are never touched.
 */
export function abandonStuckPurges(db: Database.Database, selected: StuckPurge[]): string[] {
  const refusals = hasTable(db, 'workspace_exact_replay_refusals');
  const removeClaim = db.prepare(`DELETE FROM workspace_exact_claims
    WHERE kind = 'managed-retirement' AND state = 'purging' AND operation_id = ? AND updated_at = ?`);
  const removeRefusal = refusals
    ? db.prepare('DELETE FROM workspace_exact_replay_refusals WHERE operation_id = ?') : null;
  return db.transaction(() => {
    const removed: string[] = [];
    for (const purge of selected) {
      if (removeClaim.run(purge.operationId, purge.updatedAt).changes !== 1) continue;
      removeRefusal?.run(purge.operationId);
      removed.push(purge.operationId);
    }
    return removed;
  }).immediate();
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function describe(purge: StuckPurge): string {
  const disk = purge.retiredDirectory === 'absent' ? 'no retired directory on disk'
    : `${purge.retiredDirectory === 'replaced' ? 'a replaced directory' : 'retired directory'} ${purge.retiredPath}`
      + (purge.retiredDirectoryKiB === null ? '' : ` (${megabytes(purge.retiredDirectoryKiB * 1024)} on disk)`);
  return [
    `${purge.operationId}  ${purge.repositoryPath}  ${purge.worktreeId}`,
    `  stuck ${purge.ageDays} days; inventory ${purge.inventoryEntries ?? 'unreadable'} entries, ${megabytes(purge.inventoryBytes)} stored`,
    `  ${purge.refused ? `replay refused ${purge.refused.refusals} time(s), next retry ${new Date(purge.refused.retryAfter).toISOString()}` : 'no replay refusal recorded yet'}`,
    `  ${disk}`,
  ].join('\n');
}

/** `o8 workspace-cleanup stuck-purges [--abandon <operation-id>]... [--abandon-refused] [--apply]` */
export function runStuckPurges(mode: OutputMode, args: string[]): number {
  const chosen = args.flatMap((arg, index) => arg === '--abandon' ? [args[index + 1] ?? ''] : []);
  const allRefused = args.includes('--abandon-refused');
  const apply = args.includes('--apply');
  if (chosen.some((id) => !id) || (apply && !allRefused && !chosen.length)) {
    throw new CliError('invalid_args',
      'Use workspace-cleanup stuck-purges [--abandon <operation-id>]... [--abandon-refused] [--apply].', EXIT.INVALID_ARGS);
  }
  const dbPath = process.env.CORTEX_IDE_DB_PATH || join(resolveCliDataDir(), 'cortex-ide.db');
  if (!exists(dbPath)) throw new CliError('not_found', `No o8 database at ${dbPath}.`, EXIT.NOT_FOUND);
  // Read-write even for a dry run: a read-only open fails on a WAL database whose
  // shared-memory file is absent. A dry run issues no writes.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 10000');
    const stuck = listStuckPurges(db);
    const unknown = chosen.filter((id) => !stuck.some((purge) => purge.operationId === id));
    if (unknown.length) {
      throw new CliError('not_found', `Not a stuck managed retirement: ${unknown.join(', ')}.`, EXIT.NOT_FOUND);
    }
    const selected = stuck.filter((purge) => chosen.includes(purge.operationId) || (allRefused && purge.refused));
    const removed = apply ? abandonStuckPurges(db, selected) : [];
    const skipped = apply ? selected.filter((purge) => !removed.includes(purge.operationId)) : [];
    const leftOnDisk = selected.filter((purge) => purge.retiredDirectory !== 'absent' && (!apply || removed.includes(purge.operationId)))
      .map((purge) => ({ operationId: purge.operationId, path: purge.retiredPath, state: purge.retiredDirectory,
        kib: purge.retiredDirectoryKiB }));
    if (mode.human) {
      const out: string[] = [`${stuck.length} managed retirement(s) stuck in purging`, ...stuck.map(describe)];
      if (selected.length) {
        out.push('', apply ? 'Removed:' : 'Dry run. With --apply this would remove:');
        for (const purge of selected) {
          if (apply && !removed.includes(purge.operationId)) continue;
          out.push(`  claim row ${purge.operationId} and its stored inventory (${megabytes(purge.inventoryBytes)})`);
        }
        for (const purge of skipped) out.push(`Skipped ${purge.operationId}: the claim changed after it was listed.`);
        out.push('Nothing on disk is removed. Left in place for you to check and delete:');
        if (!leftOnDisk.length) out.push('  (none)');
        for (const left of leftOnDisk) {
          out.push(`  ${left.path}${left.kib === null ? '' : ` (${megabytes(left.kib * 1024)})`}${left.state === 'replaced' ? ' — not the retired directory; another directory now has this name' : ''}`);
        }
      }
      process.stdout.write(`${out.join('\n')}\n`);
    } else {
      printJson({ schema: 'o8/cli/workspace-cleanup-stuck-purges/v1', dryRun: !apply, stuck,
        selected: selected.map((purge) => purge.operationId), removed, skipped: skipped.map((purge) => purge.operationId),
        leftOnDisk });
    }
    return skipped.length ? EXIT.CONFLICT : EXIT.OK;
  } finally {
    db.close();
  }
}
