import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

let heldDirectory: string | null = null;

// One connection per data directory, reused across spawns: opening and closing
// a SQLite handle for every child cost more than the lock itself. The lock is
// taken and released per operation exactly as before; between operations the
// idle connection holds no lock. If the lock file is replaced, the connection
// is reopened so it never locks a stale file.
const connections = new Map<string, { db: Database.Database; identity: string }>();

function fileIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function lockConnection(directory: string): Database.Database {
  const path = join(directory, '.provider-keys.lock');
  const existing = connections.get(directory);
  if (existing) {
    let current: string | null = null;
    try { current = fileIdentity(path); } catch { /* removed: reopen below */ }
    if (current === existing.identity && existing.db.open) return existing.db;
    connections.delete(directory);
    try { existing.db.close(); } catch { /* already closed */ }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Concurrent launchers may finish their short validation-and-spawn transaction.
  const db = new Database(path, { timeout: 1000 });
  connections.set(directory, { db, identity: fileIdentity(path) });
  return db;
}

/** Synchronous only: preparation, mutation and the actual spawn share this OS lock. */
export function withProviderStoreLock<T>(operation: () => T): T {
  const directory = getDataDir();
  if (heldDirectory === directory) return operation();
  const lock = lockConnection(directory);
  lock.exec('BEGIN EXCLUSIVE');
  heldDirectory = directory;
  try { return operation(); }
  finally {
    heldDirectory = null;
    try { lock.exec('COMMIT'); }
    catch {
      // A lock that cannot be released cleanly is not reused.
      connections.delete(directory);
      try { lock.close(); } catch { /* already closed */ }
    }
  }
}
