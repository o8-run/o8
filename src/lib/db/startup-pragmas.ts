import type Database from 'better-sqlite3';

/** Page cache while the server is working, in KiB. */
export const ACTIVE_CACHE_KIB = 8000;
/** Page cache while the server is at rest; the OS file cache still holds the database. */
export const RESTING_CACHE_KIB = 1000;

/** Connection configuration must run before the startup transaction. */
export function configureSqlite(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');      // Concurrent reads
  sqlite.pragma('synchronous = NORMAL');    // Crash-safe with WAL
  sqlite.pragma('busy_timeout = 5000');     // Wait for another writer
  sqlite.pragma(`cache_size = -${ACTIVE_CACHE_KIB}`); // Bound the connection's page cache
  sqlite.pragma('foreign_keys = ON');       // Enforce FK constraints
}

/**
 * At rest the connection keeps a small page cache and returns the rest to the
 * allocator; on wake it gets its working size back and refills from the file.
 */
export function setSqliteResting(sqlite: Database.Database, resting: boolean): void {
  sqlite.pragma(`cache_size = -${resting ? RESTING_CACHE_KIB : ACTIVE_CACHE_KIB}`);
  if (resting) sqlite.pragma('shrink_memory');
}
