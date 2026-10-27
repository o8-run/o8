import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ensureOutcomeExclusionStorage } from '@/lib/db/outcome-exclusion-migration';
import { outcomeMemoryFingerprint } from './outcome-identity';
import { getSqlite } from '@/lib/db';
import type { PacketContext } from '@/lib/orchestrator/types';

interface OutcomeIdentityRow {
  id: string; project_id: string | null; repo_path: string;
  packet_id: string | null; session_key: string | null; summary: string;
}
function fingerprint(row: OutcomeIdentityRow) {
  return outcomeMemoryFingerprint({ projectId: row.project_id, repoPath: row.repo_path,
    packetId: row.packet_id, sessionKey: row.session_key, summary: row.summary });
}
/** Called within the forget transaction; retain identity digests, never forgotten text. */
export function excludeOutcomeFromMemory(db: Database.Database, id: string): string[] {
  ensureOutcomeExclusionStorage(db, true);
  const selected = db.prepare('SELECT * FROM session_outcomes WHERE id = ?').get(id) as OutcomeIdentityRow;
  const digest = fingerprint(selected);
  const aliases = (db.prepare(`SELECT * FROM session_outcomes WHERE project_id IS ? AND repo_path = ?
    AND packet_id IS ? AND session_key IS ?`).all(selected.project_id, selected.repo_path,
    selected.packet_id, selected.session_key) as OutcomeIdentityRow[]).filter(row => fingerprint(row) === digest);
  const remember = db.prepare(`INSERT OR IGNORE INTO forgotten_session_outcomes
    (id, forgotten_at, packet_id, project_id, repo_path, session_key, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const row of aliases) remember.run(row.id, new Date().toISOString(), row.packet_id,
    row.project_id, row.repo_path, row.session_key, digest);
  return aliases.map(row => row.id);
}

/** One identity for ledger writes and all completion-memory readers, including receipts. */
export function completionOutcomeId(context: Pick<PacketContext, 'packetId' | 'sessionKey' | 'completedAt'>): string {
  // Hash the complete tuple so delimiter, truncation and normalization cannot
  // conflate siblings, and the qualified ID stays within the forget API's bound.
  return `outcome-${createHash('sha256').update(JSON.stringify([
    context.packetId, context.sessionKey, context.completedAt,
  ])).digest('hex')}`;
}

export function isOutcomeForgotten(id: string, fingerprint?: string): boolean {
  const db = getSqlite();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_session_outcomes'").get()) return false;
  const current = (db.prepare('PRAGMA table_info(forgotten_session_outcomes)').all() as Array<{ name: string }>).some(column => column.name === 'fingerprint');
  return current
    ? Boolean(db.prepare('SELECT 1 FROM forgotten_session_outcomes WHERE id = ? OR (fingerprint IS NOT NULL AND fingerprint = ?)').get(id, fingerprint ?? null))
    : Boolean(db.prepare('SELECT 1 FROM forgotten_session_outcomes WHERE id = ?').get(id));
}

/** Old packet summaries/review fragments have no exact completion provenance. Fail closed for that packet. */
export function hasForgottenPacketOutcome(packetId: string, legacyOnly = false): boolean {
  const db = getSqlite();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_session_outcomes'").get()) return false;
  const current = (db.prepare('PRAGMA table_info(forgotten_session_outcomes)').all() as Array<{ name: string }>).some(column => column.name === 'fingerprint');
  return Boolean(db.prepare(`SELECT 1 FROM forgotten_session_outcomes WHERE packet_id = ?
    ${legacyOnly && current ? 'AND fingerprint IS NULL AND repo_path IS NULL' : ''} LIMIT 1`).get(packetId));
}
