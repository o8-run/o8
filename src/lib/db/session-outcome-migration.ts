import type Database from 'better-sqlite3';
import { ensureSessionOutcomeRoutingColumns } from '@/lib/db/session-outcome-routing-migration';

function columnExists(sqlite: Database.Database, column: string): boolean {
  const rows = sqlite.prepare('PRAGMA table_info(session_outcomes)').all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnTolerant(sqlite: Database.Database, sql: string): void {
  try {
    sqlite.exec(sql);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

/** Add columns needed by current indexes before the base schema runs. */
export function ensureSessionOutcomeColumns(sqlite: Database.Database): void {
  if (sqlite.prepare('PRAGMA table_info(session_outcomes)').all().length === 0) return;
  if (!columnExists(sqlite, 'lane_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN lane_id TEXT');
  }
  if (!columnExists(sqlite, 'packet_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN packet_id TEXT');
  }
  if (!columnExists(sqlite, 'plan_text')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN plan_text TEXT');
  }
  if (!columnExists(sqlite, 'memory_fingerprint')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN memory_fingerprint TEXT');
  }
  // SQLite ALTER TABLE ADD COLUMN rejects non-literal defaults, so add this
  // nullable and backfill historical rows. Fresh tables receive the stronger
  // NOT NULL default from the base schema.
  if (!columnExists(sqlite, 'valid_from')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN valid_from TEXT');
    sqlite.exec(
      "UPDATE session_outcomes SET valid_from = COALESCE(completed_at, created_at, datetime('now')) WHERE valid_from IS NULL OR valid_from = ''",
    );
  }
  if (!columnExists(sqlite, 'valid_to')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN valid_to TEXT');
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_so_valid_to ON session_outcomes(valid_to)');
  ensureSessionOutcomeRoutingColumns(sqlite);
}
