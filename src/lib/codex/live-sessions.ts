/**
 * Sync liveness checks for persisted IDE tab sessions.
 *
 * #545 root fix: the IDE persists every chat tab it ever spawned to
 * `~/.o8/terminal-states/*.json`. On every fleet snapshot that list is
 * re-hydrated unfiltered, surfacing hundreds of ghost "Reconnecting…" rows
 * in the Agents panel for sessions whose underlying codex thread / owned
 * process exited days or weeks ago.
 *
 * This module resolves two session-key families:
 *
 *   - `codex:<threadId>` / `codex-discovered:<threadId>` — natively codex
 *     threads. Live iff codex's own `state_5.sqlite` has a non-archived
 *     thread row with `updated_at >= now - staleHours * 3600`.
 *
 *   - `codex-owned:<id>` — IDE-spawned sessions tracked under
 *     `~/.o8/owned-codex/<id>/`. Live iff that directory's mtime is within
 *     the stale window.
 *
 * Results are cached in-memory for 5s so a single snapshot tick that
 * touches dozens of session keys pays the sqlite open + dir scan once.
 *
 * Configurable via `O8_STALE_SESSION_HOURS` (default 24).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const OWNED_CODEX_ROOT = process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(getDataDir(), 'owned-codex');

const DEFAULT_STALE_HOURS = (() => {
  const raw = process.env.O8_STALE_SESSION_HOURS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
})();

const CACHE_TTL_MS = 5_000;

interface LiveSessionCache {
  at: number;
  threadIds: Set<string>;
  ownedIds: Set<string>;
  staleHoursSnapshot: number;
}

let cached: LiveSessionCache | null = null;

function loadLiveCodexThreadIds(staleHours: number): Set<string> {
  if (!existsSync(CODEX_STATE_DB)) return new Set();
  try {
    const db = new Database(CODEX_STATE_DB, { readonly: true, fileMustExist: true });
    try {
      const cutoffEpochSeconds = Math.floor((Date.now() - staleHours * 3600 * 1000) / 1000);
      const rows = db
        // `+archived` keeps the planner off the archived index: nearly every
        // thread is unarchived, so that index made SQLite read most of the
        // (large) threads table on every load. The updated_at range is tiny.
        .prepare('SELECT id FROM threads WHERE +archived = 0 AND updated_at >= ?')
        .all(cutoffEpochSeconds) as Array<{ id: string }>;
      return new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

function loadLiveOwnedCodexIds(staleHours: number): Set<string> {
  if (!existsSync(OWNED_CODEX_ROOT)) return new Set();
  const cutoffMs = Date.now() - staleHours * 3600 * 1000;
  const live = new Set<string>();
  try {
    const entries = readdirSync(OWNED_CODEX_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('codex-owned-')) continue;
      try {
        const stat = statSync(path.join(OWNED_CODEX_ROOT, entry.name));
        if (stat.mtimeMs >= cutoffMs) live.add(entry.name);
      } catch {
        // unreadable entry — treat as dead, fall through
      }
    }
  } catch {
    return live;
  }
  return live;
}

function ensureCache(staleHours: number): LiveSessionCache {
  const now = Date.now();
  if (cached && cached.staleHoursSnapshot === staleHours && now - cached.at < CACHE_TTL_MS) {
    return cached;
  }
  cached = {
    at: now,
    threadIds: loadLiveCodexThreadIds(staleHours),
    ownedIds: loadLiveOwnedCodexIds(staleHours),
    staleHoursSnapshot: staleHours,
  };
  return cached;
}

/**
 * Strip the runtime prefix from a canonical session key. Returns the bare
 * identifier (thread id for `codex:*`/`codex-discovered:*`, owned-session
 * id for `codex-owned:*`, or null when the key can't be classified).
 */
function extractCodexSessionIdentifier(sessionKey: string): { kind: 'thread' | 'owned'; id: string } | null {
  if (sessionKey.startsWith('codex-owned:')) {
    const tail = sessionKey.slice('codex-owned:'.length).trim();
    return tail ? { kind: 'owned', id: tail } : null;
  }
  if (sessionKey.startsWith('codex-discovered:')) {
    const tail = sessionKey.slice('codex-discovered:'.length).trim();
    return tail ? { kind: 'thread', id: tail } : null;
  }
  if (sessionKey.startsWith('codex-live:')) {
    const tail = sessionKey.slice('codex-live:'.length).trim();
    return tail ? { kind: 'thread', id: tail } : null;
  }
  if (sessionKey.startsWith('codex:')) {
    const tail = sessionKey.slice('codex:'.length).trim();
    return tail ? { kind: 'thread', id: tail } : null;
  }
  return null;
}

/**
 * Determine whether a canonicalized codex session key points at a session
 * that is still considered live (updated within the stale window).
 *
 * Returns true for any non-codex runtime — this helper intentionally does
 * not judge claude-code sessions since there's no equivalent central
 * registry to consult.
 */
export function isCodexSessionLive(sessionKey: string, staleHours: number = DEFAULT_STALE_HOURS): boolean {
  if (!sessionKey) return false;
  const identifier = extractCodexSessionIdentifier(sessionKey);
  if (!identifier) return true;
  const cache = ensureCache(staleHours);
  if (identifier.kind === 'owned') return cache.ownedIds.has(identifier.id);
  return cache.threadIds.has(identifier.id);
}

export function __resetLiveCodexSessionsCache(): void {
  cached = null;
}
