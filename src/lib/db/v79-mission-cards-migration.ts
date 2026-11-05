import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from './schema-columns';

/**
 * Schema v79 (#5468): mission cards are task artifacts with a native card
 * spec instead of HTML. Their decisions use the existing receipt ledger.
 */
export function ensureV79MissionCardsSchema(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'task_artifacts', 'card_json')) {
    addColumnTolerant(sqlite, 'ALTER TABLE task_artifacts ADD COLUMN card_json TEXT');
  }
}
