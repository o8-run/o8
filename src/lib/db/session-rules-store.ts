/**
 * Session rules store (#1329) — operator-authored rules scoped to ONE
 * orchestrator thread. Ephemeral by design: a rule belongs to a thread id
 * (e.g. `thoughts-1779296462456`) and never applies to another thread. A new
 * thread starts with a clean session tier; rules die with the thread.
 *
 * This is the missing rule TIER between a chat message (decays as context
 * churns) and a Cortex directive (durable, repo-scoped). Active session rules
 * are re-injected into EVERY orchestrator turn and inherited by dispatched
 * workers, so they survive compaction — that's the difference between a rule
 * and a message.
 *
 * Storage is a dedicated SQLite table (NOT a `scope:'session'` extension of the
 * markdown directive files) because these are ephemeral, thread-keyed,
 * high-churn relational rows with a lifecycle tied to a thread — the
 * missions-store shape, not the directive-file shape. Keeping them separate is
 * what lets directives stay read-only while session rules stay editable.
 */

import 'server-only';
import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';
import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';

export interface SessionRuleRecord {
  id: string;
  threadId: string;
  text: string;
  active: boolean;
  createdAt: string;
  constraint: 'no_merge' | null;
}

interface SessionRuleRow {
  id: string;
  thread_id: string;
  text: string;
  active: number;
  created_at: string;
  constraint_kind: 'no_merge' | null;
}

function rowToRecord(row: SessionRuleRow): SessionRuleRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    text: row.text,
    active: row.active === 1,
    createdAt: row.created_at,
    constraint: row.constraint_kind ?? null,
  };
}

/** Max stored rule length — a session rule is a short directive, not an essay. */
export const SESSION_RULE_MAX_LEN = 2_000;

function normalizeThreadId(threadId: string | null | undefined): string {
  return (threadId ?? '').trim();
}

/**
 * Add a session rule for a thread. Returns the created record, or null when the
 * inputs are empty (no thread id / blank text). Idempotent-ish: callers dedupe
 * on text; this always inserts a fresh row (a thread can hold repeats if the
 * operator really wants them — cheap, ephemeral).
 */
export function addSessionRule(threadId: string, text: string, constraint: 'no_merge' | null = null): SessionRuleRecord | null {
  if (apiFrontDoorEnabled()) throw new Error('Session-rule writes require the native operator transport.');
  const thread = normalizeThreadId(threadId);
  const body = text.trim().slice(0, SESSION_RULE_MAX_LEN);
  if (!thread || !body) return null;

  const id = randomUUID();
  const db = getSqlite();
  db.prepare(`
    INSERT INTO session_rules (id, thread_id, text, active, created_at, constraint_kind)
    VALUES (?, ?, ?, 1, datetime('now'), ?)
  `).run(id, thread, body, constraint);

  return getSessionRule(id);
}

/** Remove a rule by id. Returns true when a row was deleted. */
export function removeSessionRule(id: string): boolean {
  if (apiFrontDoorEnabled()) throw new Error('Session-rule writes require the native operator transport.');
  const db = getSqlite();
  const result = db.prepare(`DELETE FROM session_rules WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getSessionRule(id: string): SessionRuleRecord | null {
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM session_rules WHERE id = ?`).get(id) as SessionRuleRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * List ACTIVE rules for a thread, oldest first (stable rule order — the
 * operator reads them top-to-bottom in the popover and the same order is
 * injected into the prompt). Returns [] for an unknown/blank thread id.
 */
export function listSessionRules(threadId: string): SessionRuleRecord[] {
  const thread = normalizeThreadId(threadId);
  if (!thread) return [];
  const db = getSqlite();
  // rowid tiebreaker: datetime('now') is second-resolution, so rules added in
  // the same second would otherwise sort by random UUID — rowid is insertion
  // order, which is the order the operator wrote them.
  const rows = db.prepare(`
    SELECT * FROM session_rules
     WHERE thread_id = ? AND active = 1
     ORDER BY created_at ASC, rowid ASC
  `).all(thread) as SessionRuleRow[];
  return rows.map(rowToRecord);
}

/** Just the rule strings for a thread (prompt injection convenience). */
export function listSessionRuleTexts(threadId: string): string[] {
  return listSessionRules(threadId).map((rule) => rule.constraint === 'no_merge'
    ? `Do not merge. Merge is blocked until the operator removes this session rule. ${rule.text}` : rule.text);
}
