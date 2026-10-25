import type Database from 'better-sqlite3';

/** Called inside the forget transaction. Store identity only, never forgotten content. */
export function excludeOutcomeFromMemory(db: Database.Database, id: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS forgotten_session_outcomes (
    id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL
  )`);
  // Durable database guards also cover already-running capture processes and
  // reindex writers. Checking in one JS reader would leave a check/insert race.
  for (const operation of ['INSERT', 'UPDATE'] as const) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS forgotten_outcome_${operation.toLowerCase()}
      BEFORE ${operation} ON session_outcomes
      WHEN EXISTS (SELECT 1 FROM forgotten_session_outcomes WHERE id = NEW.id)
      BEGIN SELECT RAISE(IGNORE); END`);
    for (const table of ['facts', 'facts_queue'] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS forgotten_outcome_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN NEW.source_kind = 'outcome' AND EXISTS (
          SELECT 1 FROM forgotten_session_outcomes WHERE 'outcome:' || id = NEW.source_id
        ) BEGIN SELECT RAISE(IGNORE); END`);
    }
  }
  db.prepare('INSERT INTO forgotten_session_outcomes (id, forgotten_at) VALUES (?, ?)').run(id, new Date().toISOString());
}
