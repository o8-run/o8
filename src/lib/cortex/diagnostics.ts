/**
 * #749 — Substrate eval gate (read-only instrumentation).
 *
 * Wraps recall-path queries with `performance.now()` timing and pushes each
 * sample into a bounded persisted buffer. Each recording transaction owns
 * the shared metrics file; readers never initialize or flush it.
 *
 * The recall substrate is unchanged. Instrumentation records timings so we can answer "is SQLite still fine, or is it time to
 * evaluate a swap?" without guessing.
 *
 * Storage: `<dataDir>/recall-metrics.db`; legacy JSON remains readable.
 * FIFO eviction at `MAX_SAMPLES` bounds retained observations.
 *
 * No-throw policy: timing must never affect recall behaviour. Every helper
 * swallows IO errors and logs with the `[recall-metrics]` prefix.
 */

import 'server-only';

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

/** Max number of samples kept in the ring buffer. FIFO eviction beyond this. */
export const MAX_SAMPLES = 1000;

const METRICS_FILE = 'recall-metrics.json';

/** A single timing sample. Shape kept narrow on purpose — easy to extend later. */
export interface RecallTimingSample {
  /** Logical label, e.g. `recall.recent-outcomes`. */
  label: string;
  /** Wall-clock duration in milliseconds, post `performance.now()`. */
  durationMs: number;
  /** Unix epoch ms when the sample was recorded. */
  timestamp: number;
  /** True when the wrapped fn threw — durationMs still represents wall time. */
  errored?: boolean;
}

interface PersistedFile {
  version: 1;
  samples: RecallTimingSample[];
}

function metricsFilePath(): string {
  return join(getDataDir({ ...process.env }), METRICS_FILE);
}

function loadFromDisk(): RecallTimingSample[] {
  const path = metricsFilePath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.samples)) {
      return [];
    }
    // Defensive — strip malformed entries but keep the rest.
    const out: RecallTimingSample[] = [];
    for (const entry of parsed.samples) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<RecallTimingSample>;
      if (
        typeof e.label !== 'string' ||
        typeof e.durationMs !== 'number' ||
        typeof e.timestamp !== 'number'
      ) continue;
      if (!Number.isFinite(e.durationMs) || !Number.isFinite(e.timestamp)) continue;
      out.push({
        label: e.label,
        durationMs: e.durationMs,
        timestamp: e.timestamp,
        errored: e.errored === true ? true : undefined,
      });
    }
    // Hard cap on hydrate too — disk file may be older than the current ceiling.
    return out.slice(-MAX_SAMPLES);
  } catch (err) {
    console.warn('[recall-metrics] Failed to hydrate buffer:', err instanceof Error ? err.message : err);
    return [];
  }
}

function databasePath(): string {
  return join(getDataDir({ ...process.env }), 'recall-metrics.db');
}

function readSamples(database: Database.Database): RecallTimingSample[] {
  return database.prepare('SELECT label, duration_ms AS durationMs, timestamp, errored FROM samples ORDER BY id')
    .all().map(row => {
      const sample = row as RecallTimingSample;
      return { ...sample, errored: sample.errored ? true : undefined };
    });
}

/** Recording owns initialization and the transaction, including legacy import. */
function writeSamples(sample?: RecallTimingSample): void {
  let database: Database.Database | undefined;
  try {
    mkdirSync(getDataDir({ ...process.env }), { recursive: true });
    database = new Database(databasePath());
    database.pragma('busy_timeout = 1000');
    database.transaction(() => {
      const initialized = database!.prepare("SELECT 1 FROM sqlite_master WHERE name = 'samples'").get();
      database!.exec('CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, label TEXT, duration_ms REAL, timestamp REAL, errored INTEGER)');
      const insert = database!.prepare('INSERT INTO samples (label, duration_ms, timestamp, errored) VALUES (?, ?, ?, ?)');
      if (!initialized) {
        for (const legacy of loadFromDisk()) insert.run(legacy.label, legacy.durationMs, legacy.timestamp, legacy.errored ? 1 : 0);
      }
      if (sample) insert.run(sample.label, sample.durationMs, sample.timestamp, sample.errored ? 1 : 0);
      database!.prepare('DELETE FROM samples WHERE id NOT IN (SELECT id FROM samples ORDER BY id DESC LIMIT ?)').run(MAX_SAMPLES);
    }).immediate();
  } catch {
    console.warn('[recall-metrics] Could not persist timing.');
  } finally {
    database?.close();
  }
}

/** Persist each sample before returning; transactions serialize existing producers. */
export function recordTiming(sample: RecallTimingSample): void {
  if (!Number.isFinite(sample.durationMs) || !Number.isFinite(sample.timestamp)) return;
  writeSamples(sample);
}

/** Compatibility for callers that previously forced the buffered JSON flush. */
export function flushTimingBuffer(): void {
  // Every recording is already persisted. Reads never flush.
}

/** No cached hydrate: a native reader sees samples recorded after its first GET. */
export function readTimingBuffer(): RecallTimingSample[] {
  if (!existsSync(databasePath())) return loadFromDisk();
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath(), { readonly: true, fileMustExist: true });
    return readSamples(database);
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

/** Test-only reset. */
export function __resetTimingBuffer(): void {
  writeSamples();
  const database = new Database(databasePath());
  try { database.exec('DELETE FROM samples'); } finally { database.close(); }
}

// ── timing wrappers ───────────────────────────────────────────────────────

/**
 * Wrap an async function with `performance.now()` timing. Records exactly
 * one sample per call (success or throw). Re-throws the original error so
 * call sites preserve their existing behaviour — instrumentation must not
 * change the recall contract.
 */
export async function withTiming<T>(label: string, fn: () => PromiseLike<T>): Promise<T> {
  const started = performance.now();
  let errored = false;
  try {
    return await fn();
  } catch (err) {
    errored = true;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - started);
    recordTiming({
      label,
      durationMs,
      timestamp: Date.now(),
      errored: errored ? true : undefined,
    });
    if (durationMs > 200) {
      console.log(`[recall-metrics] ${label} ${durationMs.toFixed(1)}ms${errored ? ' (errored)' : ''}`);
    }
  }
}

/**
 * Sync variant for call sites that aren't promise-shaped (the proposer's
 * SQLite read happens inside a synchronous prepare/.all loop). Same recording
 * semantics as `withTiming`.
 */
export function withTimingSync<T>(label: string, fn: () => T): T {
  const started = performance.now();
  let errored = false;
  try {
    return fn();
  } catch (err) {
    errored = true;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - started);
    recordTiming({
      label,
      durationMs,
      timestamp: Date.now(),
      errored: errored ? true : undefined,
    });
    if (durationMs > 200) {
      console.log(`[recall-metrics] ${label} ${durationMs.toFixed(1)}ms${errored ? ' (errored)' : ''}`);
    }
  }
}

// ── percentile helpers ────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  // Nearest-rank — small dataset, no need for linear interpolation.
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

export interface RecallTimingSummary {
  totalSamples: number;
  /** Samples with timestamp newer than `windowMs` ago. */
  windowedSamples: number;
  windowMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  errorCount: number;
  /** Per-label breakdown across the windowed samples. */
  byLabel: Array<{
    label: string;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Compute aggregate stats over the buffer. `windowMs` filters to recent
 * samples only — defaults to the last 24h, which is what the Diagnostics
 * tab surfaces. Threshold doc references the 7-day signal — callers can
 * pass a wider window for that lookup.
 */
export function summarizeTimings(windowMs = DEFAULT_WINDOW_MS): RecallTimingSummary {
  const all = readTimingBuffer();
  const cutoff = Date.now() - Math.max(0, windowMs);
  const windowed = windowMs > 0
    ? all.filter((s) => s.timestamp >= cutoff)
    : all;

  if (windowed.length === 0) {
    return {
      totalSamples: all.length,
      windowedSamples: 0,
      windowMs,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      errorCount: 0,
      byLabel: [],
    };
  }

  const allDurations = windowed.map((s) => s.durationMs).sort((a, b) => a - b);
  const errorCount = windowed.reduce((n, s) => n + (s.errored ? 1 : 0), 0);

  const labelGroups = new Map<string, number[]>();
  for (const sample of windowed) {
    const arr = labelGroups.get(sample.label);
    if (arr) arr.push(sample.durationMs);
    else labelGroups.set(sample.label, [sample.durationMs]);
  }

  const byLabel = Array.from(labelGroups.entries())
    .map(([label, raw]) => {
      const sorted = [...raw].sort((a, b) => a - b);
      return {
        label,
        samples: sorted.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
      };
    })
    .sort((a, b) => b.samples - a.samples);

  return {
    totalSamples: all.length,
    windowedSamples: windowed.length,
    windowMs,
    p50Ms: percentile(allDurations, 50),
    p95Ms: percentile(allDurations, 95),
    p99Ms: percentile(allDurations, 99),
    maxMs: allDurations[allDurations.length - 1] ?? 0,
    errorCount,
    byLabel,
  };
}
