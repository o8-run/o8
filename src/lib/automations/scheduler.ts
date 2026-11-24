/** Durable automation scheduler backed by per-fire SQLite leases. */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import {
  claimNextAutomationFire,
  materializeDueAutomationFires,
  type AutomationFire,
} from './fire-store';
import { runClaimedAutomationFire } from './fire-runner';
import { materializeWatchAutomationFires } from './watch-store';
import { pruneAutomationSourceEvents } from './source-events';
import { onAutomationSchedulerSignal } from './scheduler-signal';
import { trackRun } from '@/lib/background-work/ledger';

// While fires are open or a watch has to look for new events, the scheduler
// checks this often. With nothing like that it sleeps until the next due time.
const TICK_MS = 30_000;
// A timer longer than this is re-checked first: system sleep stretches timers.
const MAX_SLEEP_MS = 15 * 60_000;
// A watched source event is handled after this short pause, batching a burst.
const SOURCE_EVENT_DELAY_MS = 1_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY_CAP = 4;
const HEARTBEAT_PATH = path.join(getDataDir(), 'automations-scheduler.heartbeat');
/** Read by other processes (the launcher) to wake the server when an automation is due. */
export const NEXT_DUE_PATH = path.join(getDataDir(), 'automations-next-due.json');
const SCHEDULER_WORKER_ID = `scheduler:${process.env.O8_BOOT_ID?.trim() || process.pid}:${randomUUID()}`;

let started = false;
let bootedAt = 0;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let ticking = false;
let tickAgain = false;
let lastPruneAt = 0;
let lastNextDue = '';

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeHeartbeat(nowMs: number, summary: Record<string, unknown> = {}): void {
  try {
    writeFileSync(HEARTBEAT_PATH, `${JSON.stringify({
      lastTickAt: nowMs,
      bootedAt,
      tickIntervalMs: TICK_MS,
      concurrencyCap: positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP),
      ...summary,
    })}\n`);
  } catch {
    // Diagnostic only; durable fire state remains authoritative.
  }
}

export interface AutomationSchedulerPlan {
  /** When the scheduler must next run, or null when nothing is scheduled. */
  nextDueAt: number | null;
  /** True while the scheduler checks every TICK_MS (open fires, polled watches). */
  polling: boolean;
  reason: string;
}

/** Everything that can make the scheduler run, read from durable state. */
export function planAutomationScheduler(nowMs: number = Date.now()): AutomationSchedulerPlan {
  const sqlite = getSqlite();
  const openFire = sqlite.prepare(`
    SELECT 1 FROM automation_fires WHERE status IN ('pending', 'leased', 'retrying', 'recovered') LIMIT 1
  `).get();
  if (openFire) return { nextDueAt: nowMs + TICK_MS, polling: true, reason: 'open fires' };
  // Lane events have no write hook, a quiet watch fires on elapsed time, and a
  // watch held by its batch window or minimum interval still has unread events.
  const polledWatch = sqlite.prepare(`
    SELECT 1 FROM automations a
    WHERE a.enabled = 1 AND a.trigger_kind = 'watch' AND a.watch_source_kind IS NOT NULL
      AND a.symon_fuzzy_condition IS NULL
      AND (a.watch_source_kind = 'packet' OR a.watch_quiet_ms IS NOT NULL OR EXISTS (
        SELECT 1 FROM automation_source_events e
        WHERE e.source_kind = a.watch_source_kind AND e.sequence > a.watch_checkpoint))
    LIMIT 1
  `).get();
  if (polledWatch) return { nextDueAt: nowMs + TICK_MS, polling: true, reason: 'watches' };
  const due = sqlite.prepare(`
    SELECT MIN(at) AS at FROM (
      SELECT next_run_at AS at FROM automations
      WHERE enabled = 1 AND trigger_kind = 'cron' AND next_run_at IS NOT NULL
      UNION ALL
      SELECT watch_expires_at AS at FROM automations
      WHERE enabled = 1 AND trigger_kind = 'watch' AND watch_expires_at IS NOT NULL
    )
  `).get() as { at: number | null };
  if (due.at != null) return { nextDueAt: due.at, polling: false, reason: 'next scheduled automation' };
  return { nextDueAt: null, polling: false, reason: 'no automation due' };
}

/** Rewrite the next-due file only when what it says changes. */
function writeNextDue(plan: AutomationSchedulerPlan, nowMs: number): void {
  const body = plan.polling
    ? { nextDueAt: null, stayAwake: true, reason: plan.reason }
    : { nextDueAt: plan.nextDueAt, stayAwake: false, reason: plan.reason };
  const text = JSON.stringify(body);
  if (text === lastNextDue) return;
  try {
    const temporary = `${NEXT_DUE_PATH}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...body, writtenAt: nowMs })}\n`);
    renameSync(temporary, NEXT_DUE_PATH);
    lastNextDue = text;
  } catch {
    // A missing file only means the server is not woken early; it still runs on time while up.
  }
}

function arm(extraDueAt?: number): void {
  if (!started) return;
  const nowMs = Date.now();
  let plan: AutomationSchedulerPlan;
  try { plan = planAutomationScheduler(nowMs); }
  catch (error) {
    console.warn('[automations-scheduler] planning failed; retrying shortly:', error instanceof Error ? error.message : error);
    plan = { nextDueAt: nowMs + TICK_MS, polling: true, reason: 'planning failed' };
  }
  writeNextDue(plan, nowMs);
  const dueAt = [plan.nextDueAt, extraDueAt].filter((at): at is number => at != null)
    .reduce<number | null>((earliest, at) => (earliest === null || at < earliest ? at : earliest), null);
  if (timer) clearTimeout(timer);
  timer = null;
  timerDueAt = dueAt;
  if (dueAt === null) return;
  timer = setTimeout(() => {
    timer = null;
    // Woken early to re-check a long sleep: plan again without running a tick.
    if (Date.now() < dueAt) { arm(); return; }
    void tick();
  }, Math.min(Math.max(0, dueAt - nowMs), MAX_SLEEP_MS));
  timer.unref();
}

async function tick(): Promise<void> {
  if (ticking) { tickAgain = true; return; }
  ticking = true;
  try {
    await trackRun('automations-scheduler', () => runAutomationSchedulerTick());
    if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = Date.now();
      pruneAutomationSourceEvents();
    }
  } catch (error) {
    console.warn('[automations-scheduler] tick failed:', error instanceof Error ? error.message : error);
  } finally {
    ticking = false;
    if (tickAgain) { tickAgain = false; arm(Date.now()); }
    else arm();
  }
}

export async function runAutomationSchedulerTick(input: {
  nowMs?: number;
  workerId?: string;
  concurrencyCap?: number;
  leaseMs?: number;
  maxClaims?: number;
} = {}): Promise<{ materialized: AutomationFire[]; completed: AutomationFire[] }> {
  const nowMs = input.nowMs ?? Date.now();
  const workerId = input.workerId ?? SCHEDULER_WORKER_ID;
  const concurrencyCap = Math.max(1, Math.floor(
    input.concurrencyCap ?? positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP),
  ));
  const leaseMs = input.leaseMs ?? positiveEnv('O8_AUTOMATION_LEASE_MS', DEFAULT_LEASE_MS);
  const maxClaims = Math.max(concurrencyCap, Math.floor(input.maxClaims ?? concurrencyCap * 4));
  const materialized = [
    ...materializeDueAutomationFires(nowMs),
    ...materializeWatchAutomationFires(nowMs),
  ];
  const completed: AutomationFire[] = [];

  while (completed.length < maxClaims) {
    const wave: AutomationFire[] = [];
    while (wave.length < concurrencyCap && completed.length + wave.length < maxClaims) {
      const fire = claimNextAutomationFire({
        workerId,
        leaseMs,
        concurrencyCap,
        nowMs,
      });
      if (!fire) break;
      wave.push(fire);
    }
    if (wave.length === 0) break;
    const settled = await Promise.all(wave.map((fire) => (
      runClaimedAutomationFire(fire, input.nowMs == null ? Date.now : () => nowMs)
    )));
    completed.push(...settled.filter((fire): fire is AutomationFire => Boolean(fire)));
  }

  writeHeartbeat(Date.now(), {
    materialized: materialized.length,
    completed: completed.length,
  });
  return { materialized, completed };
}

/** When the scheduler will next run in this process, for tests and diagnostics. */
export function automationSchedulerTimerDueAt(): number | null {
  return timerDueAt;
}

export function bootAutomationsScheduler(): void {
  if (started) return;
  if (process.env.O8_DISABLE_AUTOMATIONS === '1') {
    console.log('[automations-scheduler] disabled via O8_DISABLE_AUTOMATIONS=1');
    return;
  }
  started = true;
  bootedAt = Date.now();
  try { lastNextDue = JSON.stringify((({ writtenAt: _, ...rest }) => rest)(JSON.parse(readFileSync(NEXT_DUE_PATH, 'utf8')))); }
  catch { lastNextDue = ''; }
  onAutomationSchedulerSignal((reason) => arm(reason === 'source_event' ? Date.now() + SOURCE_EVENT_DELAY_MS : undefined));
  try {
    lastPruneAt = Date.now();
    const pruned = pruneAutomationSourceEvents();
    if (pruned > 0) console.log(`[automations-scheduler] pruned ${pruned} source events past retention`);
  } catch (error) {
    console.warn('[automations-scheduler] source event prune failed:', error instanceof Error ? error.message : error);
  }
  arm();
  console.log(
    `[automations-scheduler] wakes when due (next ${timerDueAt === null ? 'none' : new Date(timerDueAt).toISOString()}) · `
    + `concurrency ${positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP)} · next-due ${NEXT_DUE_PATH}`,
  );
}

/** Tests: stop the timer and forget boot state. */
export function resetAutomationsSchedulerForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  timerDueAt = null;
  started = false;
  lastNextDue = '';
  onAutomationSchedulerSignal(null);
}
