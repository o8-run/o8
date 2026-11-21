import type Database from 'better-sqlite3';

// Load an exclusion in the format written by older installations.
export async function seedForgottenCorrection(db: Database.Database, id: string) {
  const { advanceMemoryRevision } = await import('@/lib/cortex/memory-revision');
  db.exec('CREATE TABLE IF NOT EXISTS forgotten_operator_corrections (id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL)');
  db.prepare('INSERT INTO forgotten_operator_corrections (id, forgotten_at) VALUES (?, ?)').run(id, '2026-01-01T00:00:00Z');
  advanceMemoryRevision(db);
}
