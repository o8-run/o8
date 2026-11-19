/**
 * Mobile inline diff comments (Slice 2).
 *
 * The operator taps a diff line on the phone and leaves a note anchored to a
 * file + line; the agent (and the desktop review surface) read it so the agent
 * acts on "fix this HERE" instead of a whole-handoff note. The phone anchors via
 * the unified-diff hunk headers (mobile-side parse); the desktop stores the
 * anchor + text verbatim and exposes them to the review/iterate flow.
 *
 * Anchor contract (matches the mobile side — see docs/internals/mobile-diff-comments.md):
 *   { sessionKey, path, lineNumber, side: 'old' | 'new', text }
 */

import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { apiFrontDoorEnabled } from '@/lib/ws-server/api-front-door-config';

export type DiffCommentSide = 'old' | 'new';

export interface DiffComment {
  id: string;
  sessionKey: string;
  path: string;
  lineNumber: number;
  side: DiffCommentSide;
  text: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface DiffCommentRow {
  id: string;
  session_key: string;
  path: string;
  line_number: number;
  side: string;
  text: string;
  created_at: string;
  resolved_at: string | null;
}

const MAX_TEXT_CHARS = 2000;

function toComment(row: DiffCommentRow): DiffComment {
  return {
    id: row.id,
    sessionKey: row.session_key,
    path: row.path,
    lineNumber: row.line_number,
    side: row.side === 'old' ? 'old' : 'new',
    text: row.text,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export interface CreateDiffCommentInput {
  sessionKey: string;
  path: string;
  lineNumber: number;
  side: DiffCommentSide;
  text: string;
}

/** Validate + create a diff comment. Returns null when the input is malformed. */
export function createDiffComment(input: CreateDiffCommentInput): DiffComment | null {
  const sessionKey = input.sessionKey?.trim();
  const path = input.path?.trim();
  const text = input.text?.trim();
  const side: DiffCommentSide = input.side === 'old' ? 'old' : 'new';
  const lineNumber = Number(input.lineNumber);
  if (!sessionKey || !path || !text) return null;
  if (!Number.isInteger(lineNumber) || lineNumber < 0) return null;

  if (apiFrontDoorEnabled()) throw new Error('Diff-comment writes require the native mobile transport.');

  const id = randomUUID();
  const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `INSERT INTO mobile_diff_comments (id, session_key, path, line_number, side, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, sessionKey, path, lineNumber, side, clipped);
  return toComment(
    sqlite.prepare(`SELECT * FROM mobile_diff_comments WHERE id = ?`).get(id) as DiffCommentRow,
  );
}

/** List comments for a session (newest first). Includes resolved unless openOnly. */
export function listDiffComments(sessionKey: string, opts: { openOnly?: boolean } = {}): DiffComment[] {
  const key = sessionKey?.trim();
  if (!key) return [];
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      // rowid tiebreaks within the same second (created_at is second-granular).
      `SELECT * FROM mobile_diff_comments
       WHERE session_key = ?${opts.openOnly ? ' AND resolved_at IS NULL' : ''}
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(key) as DiffCommentRow[];
  return rows.map(toComment);
}

/** Count open (unresolved) comments for a session — for review-surface badges. */
export function countOpenDiffComments(sessionKey: string): number {
  const key = sessionKey?.trim();
  if (!key) return 0;
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM mobile_diff_comments WHERE session_key = ? AND resolved_at IS NULL`)
    .get(key) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Mark a comment resolved (the agent addressed it / the operator dismissed it). */
export function resolveDiffComment(id: string): boolean {
  if (apiFrontDoorEnabled()) throw new Error('Diff-comment writes require the native mobile transport.');
  const trimmed = id?.trim();
  if (!trimmed) return false;
  const sqlite = getSqlite();
  const result = sqlite
    .prepare(`UPDATE mobile_diff_comments SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL`)
    .run(trimmed);
  return result.changes > 0;
}

/**
 * Render a session's open comments as a compact block for an agent prompt — so a
 * rerun/steer can act on the operator's line notes ("src/x.ts:42 (new): add a
 * guard"). Empty string when there are none. Consumed by the iterate flow.
 */
export function formatOpenDiffCommentsForPrompt(sessionKey: string): string {
  const open = listDiffComments(sessionKey, { openOnly: true });
  if (open.length === 0) return '';
  const lines = open
    .slice()
    .reverse() // oldest first reads naturally as a list
    .map((c) => `- ${c.path}:${c.lineNumber} (${c.side}): ${c.text}`);
  return `Operator line comments on the diff:\n${lines.join('\n')}`;
}
