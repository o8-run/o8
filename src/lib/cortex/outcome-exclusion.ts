import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import type { PacketContext } from '@/lib/orchestrator/types';

/** Called inside the forget transaction. Store identity only, never forgotten content. */
export function excludeOutcomeFromMemory(db: Database.Database, id: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS forgotten_session_outcomes (
    id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL, packet_id TEXT
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
  const outcome = db.prepare('SELECT packet_id FROM session_outcomes WHERE id = ?').get(id) as { packet_id: string | null } | undefined;
  db.prepare('INSERT INTO forgotten_session_outcomes (id, forgotten_at, packet_id) VALUES (?, ?, ?)')
    .run(id, new Date().toISOString(), outcome?.packet_id ?? null);
}

/** One identity for ledger writes and all completion-memory readers, including receipts. */
export function completionOutcomeId(context: Pick<PacketContext, 'packetId' | 'sessionKey' | 'completedAt'>): string {
  // Hash the complete tuple so delimiter, truncation and normalization cannot
  // conflate siblings, and the qualified ID stays within the forget API's bound.
  return `outcome-${createHash('sha256').update(JSON.stringify([
    context.packetId, context.sessionKey, context.completedAt,
  ])).digest('hex')}`;
}

export function isOutcomeForgotten(id: string): boolean {
  const db = getSqlite();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_session_outcomes'").get()) return false;
  return Boolean(db.prepare('SELECT 1 FROM forgotten_session_outcomes WHERE id = ?').get(id));
}

/** Old packet summaries/review fragments have no exact completion provenance. Fail closed for that packet. */
export function hasForgottenPacketOutcome(packetId: string): boolean {
  const db = getSqlite();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_session_outcomes'").get()) return false;
  return Boolean(db.prepare('SELECT 1 FROM forgotten_session_outcomes WHERE packet_id = ? LIMIT 1').get(packetId));
}
