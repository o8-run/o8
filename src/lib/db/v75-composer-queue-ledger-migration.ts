import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from './schema-columns';

/** Idempotent DDL only. The o8d owner backfills and compacts before serving. */
export function ensureV75ComposerQueueLedgerSchema(sqlite: Database.Database): void {
  for (const [name, type] of [['payload_hash', 'TEXT'], ['payload_bytes', 'INTEGER'], ['payload_compacted_at', 'INTEGER']]) {
    if (!tableColumnExists(sqlite, 'composer_send_queue', name)) {
      addColumnTolerant(sqlite, `ALTER TABLE composer_send_queue ADD COLUMN ${name} ${type}`);
    }
  }
}
