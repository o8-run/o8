/**
 * GET /api/cortex/diagnostics
 *
 * #749 — Substrate eval gate. Read-only summary of the substrate so we can
 * answer "is SQLite still fine, or is it time to evaluate a swap?" without
 * guessing. The Diagnostics tab in Settings calls this endpoint.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     outcomesCount: number,
 *     directivesCount: number,
 *     timing: RecallTimingSummary,         // last 24h
 *     timing7d: RecallTimingSummary,       // last 7d, used for the threshold
 *     thresholds: { outcomesEval, p95Ms, sustainedDays }
 *   }
 *
 * Local-only by design — `/api/cortex/*` is gated by the global middleware
 * on loopback origin + ws-token. No additional auth needed here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getSqlite } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  flushTimingBuffer,
  summarizeTimings,
  type RecallTimingSummary,
} from '@/lib/cortex/diagnostics';
import {
  readProcessCwdProbeDiagnostics,
  type ProcessCwdProbeDiagnostics,
} from '@/lib/runtime/process-cwd-snapshot';
import { SUBSTRATE_EVAL_THRESHOLDS } from '@/lib/cortex/substrate-eval-thresholds';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DiagnosticsResponse {
  ok: true;
  outcomesCount: number;
  directivesCount: number;
  timing: RecallTimingSummary;
  timing7d: RecallTimingSummary;
  thresholds: typeof SUBSTRATE_EVAL_THRESHOLDS;
  processCwdProbe: ProcessCwdProbeDiagnostics;
  /**
   * Substrate "health" verdict — green/amber/red — derived from the same
   * thresholds the doc records. The UI uses this to colour the row.
   */
  health: 'green' | 'amber' | 'red';
  notes: string[];
}

function countOutcomes(): number {
  try {
    // Drizzle's COUNT helper has historically been finicky against the
    // boolean column on older sqlite builds (#747). Drop down to raw SQL
    // for the headline counter — it's the cheapest possible query.
    //
    // #837 — only count LIVE outcomes. Decayed rows (`valid_to` past now)
    // were inflating the count above the 5,000-row eval threshold
    // prematurely and tripping the substrate-eval gate on data that no
    // longer participates in recall. Mirrors `liveOutcomeFilter()` in
    // `src/lib/cortex/decay.ts` (raw SQL form because this route uses
    // raw sqlite, not Drizzle, for the headline counter).
    //
    // #745 phase 2 — also require `valid_from IS NOT NULL` so this raw
    // SQL matches `liveOutcomeFilter()` exactly. A row inserted with
    // NULL `valid_from` between boots (e.g. another agent's raw INSERT
    // after the o8 process started) would otherwise count as "live"
    // here but be excluded from recall, silently inflating the
    // substrate-eval gate.
    const sqlite = getSqlite();
    if (!sqlite || typeof sqlite.prepare !== 'function') return 0;
    const row = sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM session_outcomes WHERE valid_from IS NOT NULL AND (valid_to IS NULL OR valid_to > datetime('now'))",
      )
      .get() as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
  } catch (error) {
    console.warn('[cortex-diagnostics] outcomes count failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}

function countDirectives(): number {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((name) => name.endsWith('.md')).length;
  } catch (error) {
    console.warn('[cortex-diagnostics] directives count failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}

function classifyHealth(outcomes: number, p95Ms: number): { health: 'green' | 'amber' | 'red'; notes: string[] } {
  const notes: string[] = [];
  let health: 'green' | 'amber' | 'red' = 'green';

  if (outcomes >= SUBSTRATE_EVAL_THRESHOLDS.outcomesEval) {
    health = 'red';
    notes.push(`Outcomes count ${outcomes.toLocaleString()} ≥ eval threshold ${SUBSTRATE_EVAL_THRESHOLDS.outcomesEval.toLocaleString()}.`);
  } else if (outcomes >= SUBSTRATE_EVAL_THRESHOLDS.outcomesEval * 0.5) {
    health = 'amber';
    notes.push(`Outcomes count ${outcomes.toLocaleString()} crossed 50% of the eval threshold.`);
  }

  if (p95Ms >= SUBSTRATE_EVAL_THRESHOLDS.p95Ms) {
    health = 'red';
    notes.push(`Recall p95 ${p95Ms.toFixed(0)}ms ≥ eval threshold ${SUBSTRATE_EVAL_THRESHOLDS.p95Ms}ms (sustained check is in the doc).`);
  } else if (p95Ms >= SUBSTRATE_EVAL_THRESHOLDS.p95Ms * 0.75) {
    if (health === 'green') health = 'amber';
    notes.push(`Recall p95 ${p95Ms.toFixed(0)}ms approaching the ${SUBSTRATE_EVAL_THRESHOLDS.p95Ms}ms eval threshold.`);
  }

  if (notes.length === 0) {
    notes.push('Within thresholds. SQLite is fine; revisit when this card flips to amber.');
  }
  return { health, notes };
}

export async function GET() {
  // Best-effort flush so concurrent recall queries land on disk before we
  // serialize the buffer. The endpoint never errors on flush failure.
  try { flushTimingBuffer(); } catch { /* swallow */ }

  const outcomesCount = countOutcomes();
  const directivesCount = countDirectives();
  const timing = summarizeTimings(DAY_MS);
  const timing7d = summarizeTimings(7 * DAY_MS);
  const { health, notes } = classifyHealth(outcomesCount, timing7d.p95Ms);

  const payload: DiagnosticsResponse = {
    ok: true,
    outcomesCount,
    directivesCount,
    timing,
    timing7d,
    thresholds: SUBSTRATE_EVAL_THRESHOLDS,
    processCwdProbe: readProcessCwdProbeDiagnostics(),
    health,
    notes,
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
