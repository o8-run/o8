/**
 * #745 — Temporal validity windows on `session_outcomes`.
 *
 * Outcomes age out after 30 days unless re-confirmed by a fresher outcome on
 * the same `(repo_path, file_path, symbol)` tuple. Recall callers filter to
 * live rows only via `liveOutcomeFilter()` so stale entries never leak into
 * the `<context>` block, the recall card, or the dispatch trailer lookups.
 *
 * Two helpers ship here:
 *   - `decayOutcomes()` — sweep + age check. Stamps `valid_to = NOW` on every
 *     outcome older than 30d that has no recent confirmation. Idempotent —
 *     rows already stamped are skipped. Safe to run on every boot.
 *   - `confirmOutcome()` — when a writer lands a new outcome, extend any
 *     prior live outcome on the same tuple so the older row's `valid_to`
 *     pushes out to NOW + 30d. Append-only — never deletes.
 *
 * Cadence:
 *   - Boot pass: wired into `/api/panel/status` with the other boot hooks.
 *   - Tick pass: same trigger fires every 6h via `setInterval` on the first
 *     boot of a Next process.
 *
 * No-throw policy: every helper swallows DB errors and logs with the
 * `[cortex-decay]` prefix. Recall paths must never block on this module.
 */

import 'server-only';

import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { getDb, runSessionOutcomeValidFromBackfill, sessionOutcomes } from '@/lib/db';
import { recurring } from '@/lib/background-work/ledger';

const DEFAULT_TTL_DAYS = 30;
const DECAY_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function logInfo(msg: string, ...rest: unknown[]) {
  console.log(`[cortex-decay] ${msg}`, ...rest);
}
function logWarn(msg: string, ...rest: unknown[]) {
  console.warn(`[cortex-decay] ${msg}`, ...rest);
}

/**
 * SQL fragment that selects only outcomes that are still live — either never
 * decayed (`valid_to IS NULL`) or whose decay timestamp is in the future
 * (e.g. just confirmed by `confirmOutcome()`). Pull this into Drizzle
 * `.where()` clauses to keep the recall surface consistent.
 *
 * #835 — also requires a non-NULL `valid_from`. A NULL window-start is a
 * writer-side bug (legacy/test seed inserts that bypassed the schema default)
 * and would otherwise leak through forever because SQL NULL comparisons in
 * the decay sweep never match. The DB-layer backfill in
 * `backfillSessionOutcomeValidFrom()` repairs these on every boot, but we
 * harden the read path here too so a stray NULL can't surface as live.
 */
export function liveOutcomeFilter() {
  return and(
    isNotNull(sessionOutcomes.validFrom),
    or(
      isNull(sessionOutcomes.validTo),
      sql`${sessionOutcomes.validTo} > datetime('now')`,
    ),
  );
}

export interface DecayOutcomesResult {
  decayed: number;
  scanned: number;
  skipped: boolean;
}

/**
 * Mark outcomes older than `ttlDays` (default 30) as decayed by stamping
 * `valid_to = datetime('now')`. Skips rows that already carry a `valid_to`
 * stamp so re-runs are no-ops.
 *
 * Returns the count of rows that were just decayed plus the total live rows
 * scanned so callers can log whether the sweep had any effect.
 */
export async function decayOutcomes(
  opts: { ttlDays?: number } = {},
): Promise<DecayOutcomesResult> {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const db = getDb();
  if (!db) {
    return { decayed: 0, scanned: 0, skipped: true };
  }

  // #745 phase 2 — step 0: backfill any rows whose `valid_from` got inserted
  // as NULL by raw SQL between boots (legacy seeds, parallel-agent inserts).
  // The boot-time backfill in `ensureIdempotentColumnAdds()` only fires on
  // the first `getDb()` call per process, so a long-running Next server
  // would otherwise carry stray NULLs until the next restart. Doing this
  // before the age-out sweep guarantees the sweep sees a complete window.
  runSessionOutcomeValidFromBackfill();

  try {
    // Count live rows for telemetry. Cheap because of `idx_so_valid_to`.
    const liveRows = await db
      .select({ id: sessionOutcomes.id })
      .from(sessionOutcomes)
      .where(isNull(sessionOutcomes.validTo));
    const scanned = liveRows.length;

    // SQLite stores timestamps as ISO strings, so `datetime(...)` math works
    // directly. We compare against `valid_from` since the validity window
    // starts there — `completed_at` is the work timestamp, but the outcome
    // becomes "valid" the moment it's recorded.
    //
    // #834 — strict less-than (`<`) so a row at exactly the TTL boundary
    // stays live for its last day. The previous `<=` cut the boundary day
    // short.
    //
    // #835 — `COALESCE(valid_from, completed_at, created_at)` so legacy/test
    // rows with NULL `valid_from` still decay using their work or insert
    // timestamps as fallback. Without COALESCE these rows leaked forever
    // because SQL NULL comparisons are always false.
    const result = await db
      .update(sessionOutcomes)
      .set({ validTo: sql`datetime('now')` })
      .where(
        and(
          isNull(sessionOutcomes.validTo),
          sql`COALESCE(${sessionOutcomes.validFrom}, ${sessionOutcomes.completedAt}, ${sessionOutcomes.createdAt}) < datetime('now', ${`-${ttlDays} days`})`,
        ),
      )
      .run();

    const decayed = (result as unknown as { changes?: number }).changes ?? 0;
    if (decayed > 0) {
      logInfo(
        `decayed ${decayed} outcome${decayed === 1 ? '' : 's'} older than ${ttlDays}d (${scanned} live before sweep)`,
      );
    }
    return { decayed, scanned, skipped: false };
  } catch (error) {
    logWarn(
      'decay sweep failed:',
      error instanceof Error ? error.message : error,
    );
    return { decayed: 0, scanned: 0, skipped: true };
  }
}

export interface ConfirmOutcomeInput {
  repoPath: string;
  /** Optional file path — narrows the confirmation tuple. */
  filePath?: string | null;
  /** Optional symbol name — narrows the confirmation tuple further. */
  symbol?: string | null;
  /**
   * Optional override for how far ahead to push `valid_to`. Defaults to
   * `ttlDays` from now (i.e. the row stays live for another window).
   */
  ttlDays?: number;
}

export interface ConfirmOutcomeResult {
  /** Number of prior outcome rows whose validity was extended. */
  extended: number;
  /** True when the DB was unavailable — the caller should still write the new row. */
  skipped: boolean;
}

/**
 * Extend the `valid_to` of every live outcome that matches the supplied
 * `(repo_path, file_path, symbol)` tuple so the older entries don't decay
 * the moment a fresher outcome confirms the same code-graph node.
 *
 * - When `filePath` and `symbol` are both omitted, every live outcome on the
 *   repo gets extended (broadest match — used when the writer doesn't know
 *   the precise tuple).
 * - When provided, we look for matches inside `changed_files_json` /
 *   `patterns_json` blobs. Lightweight LIKE queries — the tuple is a hint,
 *   not a hard schema, until #738 wires a structured node store.
 *
 * Append-only — never deletes. The intent is to keep history trustworthy
 * while letting fresher signals override stale ones.
 */
export async function confirmOutcome(
  input: ConfirmOutcomeInput,
): Promise<ConfirmOutcomeResult> {
  const repoPath = input.repoPath?.trim();
  if (!repoPath) {
    return { extended: 0, skipped: true };
  }
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  const db = getDb();
  if (!db) {
    return { extended: 0, skipped: true };
  }

  try {
    const filePath = input.filePath?.trim() || null;
    const symbol = input.symbol?.trim() || null;

    // The extension target — push valid_to to NOW + ttlDays so the row stays
    // live for another window. We always overwrite an existing future
    // `valid_to` because a fresh confirmation is the most recent signal.
    const nextValidTo = sql`datetime('now', ${`+${ttlDays} days`})`;

    // When neither filePath nor symbol narrows the tuple, extend the whole
    // repo. When provided, AND the LIKE clauses on top.
    const conditions = [eq(sessionOutcomes.repoPath, repoPath)];
    if (filePath) {
      conditions.push(sql`${sessionOutcomes.changedFilesJson} LIKE ${`%${filePath}%`}`);
    }
    if (symbol) {
      conditions.push(sql`${sessionOutcomes.patternsJson} LIKE ${`%${symbol}%`}`);
    }

    const result = await db
      .update(sessionOutcomes)
      .set({ validTo: nextValidTo })
      .where(and(...conditions))
      .run();

    const extended = (result as unknown as { changes?: number }).changes ?? 0;
    if (extended > 0) {
      logInfo(
        `extended ${extended} outcome${extended === 1 ? '' : 's'} for ${repoPath}${
          filePath ? ` file=${filePath}` : ''
        }${symbol ? ` symbol=${symbol}` : ''}`,
      );
    }
    return { extended, skipped: false };
  } catch (error) {
    logWarn(
      'confirm extension failed:',
      error instanceof Error ? error.message : error,
    );
    return { extended: 0, skipped: true };
  }
}

let bootHookFired = false;
let tickHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Idempotent boot trigger. First call schedules a recurring 6h tick and
 * fires an immediate sweep on the next microtask so the route handler that
 * called us doesn't pay for the DB walk inline. Subsequent calls are
 * no-ops.
 */
export function ensureDecayBootHook(): void {
  if (bootHookFired) return;
  bootHookFired = true;

  setImmediate(() => {
    void decayOutcomes().catch((err: unknown) => {
      logWarn('boot sweep threw:', err);
    });
  });

  // Recurring tick — guard against double-scheduling if Next reloads modules.
  if (tickHandle) return;
  tickHandle = recurring('cortex-decay', () => {
    void decayOutcomes().catch((err: unknown) => {
      logWarn('tick sweep threw:', err);
    });
  }, DECAY_TICK_INTERVAL_MS);
  // Don't keep the event loop alive purely for the decay tick.
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}
