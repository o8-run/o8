/**
 * #746 — Auto-directive proposer.
 *
 * When the same fix-pattern appears in `session_outcomes` ≥ 3 times within
 * the last 14 days, this module surfaces a candidate directive to the
 * Orchestrator's Mission panel. The orchestrator never writes a directive
 * autonomously — the row is human-gated with Accept / Dismiss.
 *
 * Storage:
 *   ~/.o8/proposal-snooze.json — append-only ledger of dismissed proposals,
 *   each entry valid for 30 days. Stable proposal id is derived from the
 *   matched (filePattern, fixPattern) pair so re-running the proposer keeps
 *   suppressing the same row until the snooze expires.
 *
 * Algorithm (intentionally simple — tune during dogfooding):
 *   1. Pull recent outcomes (14 d window, success+partial only — interrupted
 *      and failed are noisy).
 *   2. Extract `(filePattern, fixPattern)` pairs from each outcome:
 *        - filePattern   — most-common file extension across `changedFilesJson`
 *        - fixPattern    — top-frequency 2-gram from `summary` (after stop-word
 *                           strip, lowercase, alpha+digit only)
 *   3. Bucket pairs across outcomes; emit candidates with hits ≥ 3.
 *   4. Filter against snooze ledger.
 *   5. Rank by hit count descending, then most-recent occurrence.
 */

import { recurring } from '@/lib/background-work/ledger';
import 'server-only';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { getDataDir } from '@/lib/data-dir-migration';
import { withTimingSync } from '@/lib/cortex/diagnostics';

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_THRESHOLD = 3;
const SNOOZE_DAYS = 30;
const MAX_CANDIDATES = 5;
const SNOOZE_FILE = 'proposal-snooze.json';

// English-ish stop words — minimal list, just enough to drop the most common
// connector-noise from summary text. Bigger lists get the proposer too
// aggressive on borderline phrases.
//
// #839 — added common dev-prefix tokens (`test`, `wip`, `todo`, `hotfix`,
// `chore`, `refactor`, `done`) so a stray bracket marker like `[test]` (the
// recommended dogfood prefix) doesn't cluster across unrelated outcomes and
// surface a spurious `test always` bigram. Outcomes whose summary starts
// with a `[bracket-prefix]` are also skipped entirely below.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'will', 'with', 'when', 'while', 'over', 'under', 'now', 'then',
  'so', 'do', 'did', 'does', 'add', 'added', 'fix', 'fixed', 'update', 'updated',
  'change', 'changed', 'remove', 'removed', 'use', 'used', 'make', 'made',
  // Dev-prefix noise (#839)
  'test', 'wip', 'todo', 'hotfix', 'chore', 'refactor', 'done',
]);

/**
 * #839 — Outcomes whose summary starts with a `[bracket-prefix]` (e.g.
 * `[test] always validate`, `[WIP] hook up cache`) are dogfood/staging
 * markers, not real fix patterns. Skip them when counting cluster hits so
 * the same prefix can't aggregate spurious bigrams across the corpus.
 */
const BRACKET_PREFIX = /^\s*\[[^\]]+\]/;
function hasBracketPrefix(summary: string | null | undefined): boolean {
  if (!summary) return false;
  return BRACKET_PREFIX.test(summary);
}

export interface DirectiveProposalCandidate {
  /**
   * #748 — Discriminator so the same `DirectiveProposalRow` UI can render
   * both auto-proposer rows (this module) and cross-repo rows
   * (`cross-repo-proposer.ts`). Always `'auto'` for outputs of this module.
   */
  source: 'auto';
  /** Stable hash id derived from `(filePattern, fixPattern)` — used as the snooze key. */
  id: string;
  filePattern: string;
  fixPattern: string;
  hits: number;
  /** Most recent matching outcome timestamp (ISO-8601). */
  lastSeenAt: string;
  /** Outcome ids that contributed — caller can render a list when needed. */
  outcomeIds: string[];
  /** Single-line draft text for the directive editor. */
  draftDirective: string;
}

interface SnoozeEntry {
  id: string;
  snoozedUntil: string; // ISO-8601
  filePattern: string;
  fixPattern: string;
}

interface SnoozeLedger {
  version: 1;
  entries: SnoozeEntry[];
}

interface OutcomeRow {
  id: string;
  summary: string;
  completedAt: string;
  changedFilesJson: string;
}

// ── snooze helpers ────────────────────────────────────────────────────────

function snoozeFilePath(): string {
  return join(getDataDir(), SNOOZE_FILE);
}

function readSnoozeLedger(): SnoozeLedger {
  const path = snoozeFilePath();
  if (!existsSync(path)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SnoozeLedger>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    // Defensive — strip malformed entries but keep the rest.
    const entries = parsed.entries.filter(
      (e): e is SnoozeEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.snoozedUntil === 'string' &&
        typeof e.filePattern === 'string' &&
        typeof e.fixPattern === 'string',
    );
    return { version: 1, entries };
  } catch (err) {
    console.warn('[proposer] Failed to parse snooze ledger:', err instanceof Error ? err.message : err);
    return { version: 1, entries: [] };
  }
}

function writeSnoozeLedger(ledger: SnoozeLedger): void {
  try {
    writeFileSync(snoozeFilePath(), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[proposer] Failed to write snooze ledger:', err instanceof Error ? err.message : err);
  }
}

function activeSnoozedIds(now: Date): Set<string> {
  const ledger = readSnoozeLedger();
  const out = new Set<string>();
  for (const entry of ledger.entries) {
    const until = Date.parse(entry.snoozedUntil);
    if (Number.isFinite(until) && until > now.getTime()) {
      out.add(entry.id);
    }
  }
  return out;
}

/**
 * Snooze a proposal for the SNOOZE_DAYS window.
 *
 * #838 — write-side dedup. If an entry with this `id` already exists in the
 * ledger, update its `snoozedUntil` in place rather than appending a new row.
 * Without this, a rapid double-click on Dismiss (UI race before optimistic
 * hide takes effect) used to write two entries with different timestamps.
 * `activeSnoozedIds()` already deduped at read time so behavior was
 * unaffected, but the file accumulated garbage.
 */
export function snoozeProposal(candidate: { id: string; filePattern: string; fixPattern: string }): SnoozeEntry {
  const snoozedUntil = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const entry: SnoozeEntry = {
    id: candidate.id,
    filePattern: candidate.filePattern,
    fixPattern: candidate.fixPattern,
    snoozedUntil,
  };
  const ledger = readSnoozeLedger();
  const existingIdx = ledger.entries.findIndex((e) => e.id === candidate.id);
  if (existingIdx >= 0) {
    ledger.entries[existingIdx] = entry;
  } else {
    ledger.entries.push(entry);
  }
  writeSnoozeLedger(ledger);
  return entry;
}

// ── pattern extraction ────────────────────────────────────────────────────

function makeProposalId(filePattern: string, fixPattern: string): string {
  return createHash('sha1')
    .update(`${filePattern}::${fixPattern}`, 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function safeParseChangedFiles(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path;
          return null;
        })
        .filter((s): s is string => !!s && s.length > 0);
    }
  } catch {
    // ignore — empty list is the right answer for malformed rows
  }
  return [];
}

function extractFilePattern(changedFiles: string[]): string | null {
  if (changedFiles.length === 0) return null;
  const counts = new Map<string, number>();
  for (const path of changedFiles) {
    const match = path.match(/\.([a-zA-Z0-9]+)$/);
    const ext = match ? `*.${match[1].toLowerCase()}` : null;
    if (!ext) continue;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [ext, count] of counts) {
    if (count > bestCount) {
      best = ext;
      bestCount = count;
    }
  }
  return best;
}

function tokenize(summary: string): string[] {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/**
 * Return every distinct bigram in the summary. We aggregate across outcomes
 * later — picking only the most-frequent per outcome made the matcher far
 * too brittle when summaries vary in length or word order.
 */
function extractBigrams(summary: string): string[] {
  const tokens = tokenize(summary);
  if (tokens.length < 2) return [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    seen.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return Array.from(seen);
}

interface CandidateAccumulator {
  filePattern: string;
  fixPattern: string;
  outcomeIds: Set<string>;
  lastSeenAt: string;
}

function pairKey(filePattern: string, fixPattern: string): string {
  return `${filePattern} ${fixPattern}`;
}

function buildDraftDirective(filePattern: string, fixPattern: string, hits: number): string {
  const pretty = fixPattern
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return [
    `# ${pretty}`,
    '',
    `Observed ${hits}× in the last ${DEFAULT_WINDOW_DAYS} days on \`${filePattern}\` files.`,
    '',
    'Proposed rule (edit before saving):',
    '',
    `- When working on \`${filePattern}\`, ${fixPattern}.`,
  ].join('\n');
}

// ── outcome read with defensive `valid_to` coalescing ─────────────────────

/**
 * Pull recent successful + partial outcomes inside the window. Defensively
 * coalesces around `valid_to` (#745 may not have merged when this code runs)
 * by reading `pragma table_info` first and only adding the clause if the
 * column is present.
 */
function readRecentOutcomes(windowDays: number): OutcomeRow[] {
  // Lazy require so this module stays tree-shake-friendly for client builds.

  const dbModule = require('@/lib/db') as typeof import('@/lib/db');
  const db = dbModule.getDb();
  if (!db) return [];
  const sqlite = dbModule.getSqlite();
  if (!sqlite || typeof sqlite.prepare !== 'function') return [];

  let hasValidTo = false;
  try {
    const cols = sqlite.pragma('table_info(session_outcomes)') as Array<{ name: string }>;
    hasValidTo = Array.isArray(cols) && cols.some((col) => col?.name === 'valid_to');
  } catch {
    hasValidTo = false;
  }

  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // outcome filter: 'succeeded' and 'partial' only — failed/interrupted runs
  // amplify noise patterns that probably shouldn't become directives.
  const validToClause = hasValidTo ? "AND (valid_to IS NULL OR valid_to > datetime('now'))" : '';
  const sql = `
    SELECT id, summary, completed_at AS completedAt, changed_files_json AS changedFilesJson
    FROM session_outcomes
    WHERE outcome IN ('succeeded', 'partial')
      AND completed_at >= ?
      ${validToClause}
    ORDER BY completed_at DESC
    LIMIT 500
  `;

  try {
    const rows = withTimingSync('recall.proposer-outcomes', () =>
      sqlite.prepare(sql).all(sinceIso) as Array<{
        id: string;
        summary: string;
        completedAt: string;
        changedFilesJson: string;
      }>,
    );
    return rows.filter((r) => r && typeof r.id === 'string');
  } catch (err) {
    console.warn('[proposer] outcome read failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ── public surface ────────────────────────────────────────────────────────

export interface ProposeOptions {
  /** Window in days. Default 14. */
  windowDays?: number;
  /** Trigger threshold. Default 3. */
  threshold?: number;
  /** Cap on returned candidates. Default 5. */
  limit?: number;
  /** Inject a fixed `now` for tests — defaults to `new Date()`. */
  now?: Date;
}

/**
 * Run the proposer pass. Synchronous (we only touch SQLite + a small JSON
 * file) and side-effect-free aside from reading the snooze ledger.
 */
export function proposeDirectives(options: ProposeOptions = {}): DirectiveProposalCandidate[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? MAX_CANDIDATES;
  const now = options.now ?? new Date();

  const outcomes = readRecentOutcomes(windowDays);
  if (outcomes.length === 0) return [];

  // Aggregate every (filePattern × bigram) pair across all outcomes. Each
  // outcome contributes its full bigram set; the threshold filter at the
  // end requires the SAME pair to appear in ≥ 3 distinct outcomes.
  const accumulators = new Map<string, CandidateAccumulator>();
  for (const row of outcomes) {
    // #839 — bracket-prefixed summaries (`[test] …`, `[WIP] …`) are dogfood
    // markers; skip them so prefix tokens can't cluster as bigrams.
    if (hasBracketPrefix(row.summary)) continue;
    const filePattern = extractFilePattern(safeParseChangedFiles(row.changedFilesJson));
    if (!filePattern) continue;
    const bigrams = extractBigrams(row.summary ?? '');
    if (bigrams.length === 0) continue;
    for (const bigram of bigrams) {
      const key = pairKey(filePattern, bigram);
      const existing = accumulators.get(key);
      if (existing) {
        existing.outcomeIds.add(row.id);
        if (row.completedAt > existing.lastSeenAt) existing.lastSeenAt = row.completedAt;
      } else {
        accumulators.set(key, {
          filePattern,
          fixPattern: bigram,
          outcomeIds: new Set([row.id]),
          lastSeenAt: row.completedAt,
        });
      }
    }
  }

  const snoozed = activeSnoozedIds(now);
  const candidates: DirectiveProposalCandidate[] = [];
  for (const acc of accumulators.values()) {
    const hits = acc.outcomeIds.size;
    if (hits < threshold) continue;
    const id = makeProposalId(acc.filePattern, acc.fixPattern);
    if (snoozed.has(id)) continue;
    candidates.push({
      source: 'auto',
      id,
      filePattern: acc.filePattern,
      fixPattern: acc.fixPattern,
      hits,
      lastSeenAt: acc.lastSeenAt,
      outcomeIds: Array.from(acc.outcomeIds),
      draftDirective: buildDraftDirective(acc.filePattern, acc.fixPattern, hits),
    });
  }

  candidates.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

  return candidates.slice(0, limit);
}

// ── boot tick wiring ──────────────────────────────────────────────────────

let bootTickFired = false;
let lastTickAt = 0;
// #836 — shortened from 30 min to 5 min so the Mission panel's poll cadence
// (also 5 min) and the cache TTL line up. Combined with the `?force=1`
// query param on the route, fresh data lands immediately when the operator
// asks for it.
const TICK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Cache for the current tick — read by the API route. Keeps the proposer
 * cheap when the Mission panel polls in.
 */
let cachedCandidates: DirectiveProposalCandidate[] = [];
let cachedAt = 0;

function runTick(): void {
  try {
    cachedCandidates = proposeDirectives();
    cachedAt = Date.now();
    lastTickAt = cachedAt;
  } catch (err) {
    console.warn('[proposer] tick threw:', err instanceof Error ? err.message : err);
  }
}

/**
 * Boot-time entrypoint: fires once per server process via `setImmediate`, then schedules itself
 * every 5 min (#836). Idempotent.
 */
export function ensureProposerBootTick(): void {
  if (bootTickFired) return;
  bootTickFired = true;
  setImmediate(() => runTick());
  // Use unref so the interval doesn't keep the process alive in tests/CI.
  const interval = recurring('cortex-proposer', () => {
    if (Date.now() - lastTickAt < TICK_INTERVAL_MS - 5_000) return;
    runTick();
  }, TICK_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
}

/**
 * Read the most recent cached candidate set. If the cache is empty (server
 * just booted), runs the proposer inline. Cheap — bounded by the LIMIT 500
 * query above and the threshold filter.
 *
 * #836 — `force` bypasses the cache and recomputes inline so the Mission
 * panel can show fresh data immediately after a directive change or new
 * outcome row, without waiting on the next tick.
 */
export function readCachedProposals(
  options: { force?: boolean } = {},
): { candidates: DirectiveProposalCandidate[]; computedAt: number } {
  if (options.force || cachedAt === 0) {
    runTick();
  }
  return { candidates: cachedCandidates, computedAt: cachedAt };
}

/**
 * #836 — Drop the cached payload so the next read recomputes from scratch.
 * Call sites: anything that mutates `session_outcomes` or the directives dir
 * such that the proposer's input set has shifted. Cheap — no I/O, just zeroes
 * the in-memory state so the next `readCachedProposals()` call falls through
 * to `runTick()`.
 */
export function invalidateProposerCache(): void {
  cachedCandidates = [];
  cachedAt = 0;
}
