/**
 * In-process compactor scheduler (#961).
 *
 * Called once from ws-server boot. Schedules fact compaction to run once
 * per 24 hours while the app is open. The initial run fires after a short
 * delay so it doesn't block server startup.
 *
 * State:
 *   ~/.o8/last-compaction    — ISO timestamp of the last successful run
 *   ~/.o8/logs/compactor.log — append-only log for each run
 *
 * Disable via O8_DISABLE_COMPACTOR=1.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { recurring } from '@/lib/background-work/ledger';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 30_000; // 30s — let server stabilize before first run
const LAST_COMPACTION_FILE = 'last-compaction';
const LOG_DIR = 'logs';
const LOG_FILE = 'compactor.log';

function getLastCompactionPath(): string {
  return join(getDataDir(), LAST_COMPACTION_FILE);
}

function getLogPath(): string {
  return join(getDataDir(), LOG_DIR, LOG_FILE);
}

function readLastCompactionMs(): number {
  const p = getLastCompactionPath();
  if (!existsSync(p)) return 0;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

function writeLastCompaction(): void {
  try {
    writeFileSync(getLastCompactionPath(), new Date().toISOString() + '\n', 'utf-8');
  } catch (err) {
    console.warn('[compactor-scheduler] could not write last-compaction marker:', err);
  }
}

function appendLog(line: string): void {
  try {
    const logDir = join(getDataDir(), LOG_DIR);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(getLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf-8');
  } catch {
    // log failures are non-fatal
  }
}

async function runCompactionCycle(): Promise<void> {
  const dbPath = join(getDataDir(), 'cortex-ide.db');
  if (!existsSync(dbPath)) {
    console.log('[compactor-scheduler] DB not found, skipping compaction');
    appendLog('skip: DB not found');
    return;
  }

  appendLog('start');
  const t0 = Date.now();

  try {
    // Dynamic import keeps better-sqlite3 out of the critical boot path.
    const [{ default: Database }, { runCompaction }] = await Promise.all([
      import('better-sqlite3'),
      import('@/lib/cortex/compactor'),
    ]);

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    // Other processes (Next server, MCP servers) write to this DB concurrently;
    // without a busy_timeout a contended write throws SQLITE_BUSY immediately
    // and silently aborts the whole compaction cycle.
    db.pragma('busy_timeout = 5000');

    const result = runCompaction(
      {
        dryRun: false,
        confidenceFloor: 0.3,
        decayDays: 90,
        decayFactor: 0.9,
        jaccardThreshold: 0.85,
        skipDecay: false,
        skipJaccard: false,
        reportContradictions: false,
        contradictionMinOverlap: 8,
      },
      db,
    );

    db.close();
    writeLastCompaction();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const summary = `done in ${elapsed}s — orphans=${result.orphansRemoved} low-conf=${result.lowConfRemoved} dupes=${result.dupesRemoved} decayed=${result.decayed} jaccard=${result.jaccardRemoved}`;
    console.log(`[compactor-scheduler] ${summary}`);
    appendLog(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[compactor-scheduler] compaction failed: ${msg}`);
    appendLog(`error: ${msg}`);
  }
}

/**
 * Boot the in-process compactor scheduler.
 *
 * Returns immediately — all timers call .unref() so they don't keep
 * the process alive if everything else has exited.
 */
export function bootCompactorScheduler(): void {
  if (process.env.O8_DISABLE_COMPACTOR === '1') {
    console.log('[compactor-scheduler] disabled via O8_DISABLE_COMPACTOR=1');
    return;
  }

  const lastRunMs = readLastCompactionMs();
  const msSinceLast = Date.now() - lastRunMs;
  const needsRun = msSinceLast >= TWENTY_FOUR_HOURS_MS;

  console.log(
    needsRun
      ? `[compactor-scheduler] last run ${Math.round(msSinceLast / 3_600_000)}h ago — scheduling initial run in ${INITIAL_DELAY_MS / 1000}s`
      : `[compactor-scheduler] last run ${Math.round(msSinceLast / 3_600_000)}h ago — next run in ${Math.round((TWENTY_FOUR_HOURS_MS - msSinceLast) / 3_600_000)}h`,
  );

  if (needsRun) {
    setTimeout(() => {
      void runCompactionCycle();
    }, INITIAL_DELAY_MS).unref();
  }

  // 24h interval — regardless of whether the initial run fired, keep cycling.
  const intervalMs = needsRun
    ? TWENTY_FOUR_HOURS_MS + INITIAL_DELAY_MS
    : TWENTY_FOUR_HOURS_MS - msSinceLast;

  setTimeout(() => {
    void runCompactionCycle();
    recurring('cortex-compactor', () => {
      void runCompactionCycle();
    }, TWENTY_FOUR_HOURS_MS).unref();
  }, intervalMs).unref();
}
