import type Database from 'better-sqlite3';

/** Connection configuration must run before the startup transaction. */
export function configureSqlite(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');      // Concurrent reads
  sqlite.pragma('synchronous = NORMAL');    // Crash-safe with WAL
  sqlite.pragma('busy_timeout = 5000');     // Wait for another writer
  sqlite.pragma('cache_size = -20000');     // 20MB page cache
  sqlite.pragma('foreign_keys = ON');       // Enforce FK constraints
}
