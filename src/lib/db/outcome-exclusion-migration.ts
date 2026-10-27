import { advanceMemoryRevision } from '@/lib/cortex/memory-revision';
import type Database from 'better-sqlite3';

const provenanceMatch = (alias: string, value: string) => `${alias}.project_id IS ${value}.project_id
  AND ${alias}.repo_path = ${value}.repo_path AND ${alias}.packet_id IS ${value}.packet_id
  AND ${alias}.session_key IS ${value}.session_key`;

/** Upgrade existing exclusions on normal DB open, before any new capture can write. */
export function ensureOutcomeExclusionStorage(db: Database.Database, create = false): void {
  if (!create && !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_session_outcomes'").get()) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS forgotten_session_outcomes (
      id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL, packet_id TEXT,
      project_id TEXT, repo_path TEXT, session_key TEXT, fingerprint TEXT
    )`);
    const columns = db.prepare('PRAGMA table_info(forgotten_session_outcomes)').all() as Array<{ name: string }>;
    for (const name of ['project_id', 'repo_path', 'session_key', 'fingerprint']) {
      if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE forgotten_session_outcomes ADD COLUMN ${name} TEXT`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_forgotten_outcome_fingerprint ON forgotten_session_outcomes(fingerprint)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_forgotten_outcome_source ON forgotten_session_outcomes(project_id, repo_path, packet_id, session_key)');
    for (const operation of ['INSERT', 'UPDATE'] as const) {
      const changed = operation === 'UPDATE' ? `OR (NEW.memory_fingerprint IS OLD.memory_fingerprint AND (
        NEW.summary IS NOT OLD.summary OR NEW.project_id IS NOT OLD.project_id OR NEW.repo_path IS NOT OLD.repo_path
        OR NEW.packet_id IS NOT OLD.packet_id OR NEW.session_key IS NOT OLD.session_key))` : '';
      const oldSource = operation === 'UPDATE' ? `OR EXISTS (SELECT 1 FROM forgotten_session_outcomes f
        WHERE ${provenanceMatch('f', 'OLD')} AND (NEW.memory_fingerprint IS NULL ${changed}))` : '';
      db.exec(`DROP TRIGGER IF EXISTS forgotten_outcome_${operation.toLowerCase()}`);
      db.exec(`CREATE TRIGGER forgotten_outcome_${operation.toLowerCase()}
        BEFORE ${operation} ON session_outcomes
        WHEN EXISTS (SELECT 1 FROM forgotten_session_outcomes f WHERE f.id = NEW.id
          OR (f.fingerprint IS NOT NULL AND f.fingerprint = NEW.memory_fingerprint))
          OR EXISTS (SELECT 1 FROM forgotten_session_outcomes f WHERE f.repo_path IS NULL
            AND f.packet_id IS NOT NULL AND f.packet_id = NEW.packet_id)
          OR EXISTS (SELECT 1 FROM forgotten_session_outcomes f WHERE ${provenanceMatch('f', 'NEW')}
            AND (NEW.memory_fingerprint IS NULL ${changed})) ${oldSource}
        BEGIN
          ${operation === 'INSERT' ? `INSERT OR IGNORE INTO forgotten_session_outcomes
            (id, forgotten_at, packet_id, project_id, repo_path, session_key, fingerprint)
            SELECT NEW.id, datetime('now'), NEW.packet_id, NEW.project_id, NEW.repo_path, NEW.session_key, NEW.memory_fingerprint
            WHERE NOT EXISTS (SELECT 1 FROM session_outcomes WHERE id = NEW.id);` : ''}
          SELECT RAISE(IGNORE);
        END`);
      for (const table of ['facts', 'facts_queue'] as const) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS forgotten_outcome_${table}_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table}
          WHEN NEW.source_kind = 'outcome' AND EXISTS (
            SELECT 1 FROM forgotten_session_outcomes WHERE 'outcome:' || id = NEW.source_id OR id = NEW.source_id
          ) BEGIN SELECT RAISE(IGNORE); END`);
      }
    }
    // An earlier ID format may already have restored a forgotten legacy packet.
    // Adopt those aliases before removing their derived recall rows in the same transaction.
    db.exec('CREATE INDEX IF NOT EXISTS idx_so_memory_fingerprint ON session_outcomes(memory_fingerprint)');
    const restored = db.prepare(`SELECT id, project_id, repo_path, packet_id, session_key, memory_fingerprint
      FROM session_outcomes WHERE id IN (SELECT id FROM forgotten_session_outcomes)
      OR memory_fingerprint IN (SELECT fingerprint FROM forgotten_session_outcomes WHERE fingerprint IS NOT NULL)
      OR packet_id IN (SELECT packet_id FROM forgotten_session_outcomes WHERE repo_path IS NULL AND packet_id IS NOT NULL)`)
      .all() as Array<{ id: string; project_id: string | null; repo_path: string; packet_id: string | null; session_key: string | null; memory_fingerprint: string | null }>;
    const remember = db.prepare(`INSERT OR IGNORE INTO forgotten_session_outcomes
      (id, forgotten_at, project_id, repo_path, packet_id, session_key, fingerprint) VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`);
    for (const row of restored) {
      remember.run(row.id, row.project_id, row.repo_path, row.packet_id, row.session_key, row.memory_fingerprint);
      for (const table of ['facts', 'facts_queue']) {
        db.prepare(`DELETE FROM ${table} WHERE source_kind = 'outcome' AND source_id IN (?, ?)`)
          .run(row.id, `outcome:${row.id}`);
      }
      db.prepare('DELETE FROM session_outcomes WHERE id = ?').run(row.id);
    }
    if (restored.length) advanceMemoryRevision(db);
  })();

}
