/** Durable automation scheduler backed by per-fire SQLite leases. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  claimNextAutomationFire,
  materializeDueAutomationFires,
  type AutomationFire,
} from './fire-store';
import { runClaimedAutomationFire } from './fire-runner';
import { materializeWatchAutomationFires } from './watch-store';

const TICK_MS = 30_000;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY_CAP = 4;
const HEARTBEAT_PATH = path.join(getDataDir(), 'automations-scheduler.heartbeat');
const SCHEDULER_WORKER_ID = `scheduler:${process.env.O8_BOOT_ID?.trim() || process.pid}:${randomUUID()}`;

let started = false;
let bootedAt = 0;

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

export function bootAutomationsScheduler(): void {
  if (started) return;
  started = true;
  if (process.env.O8_DISABLE_AUTOMATIONS === '1') {
    console.log('[automations-scheduler] disabled via O8_DISABLE_AUTOMATIONS=1');
    return;
  }
  bootedAt = Date.now();
  console.log(
    `[automations-scheduler] durable tick every ${TICK_MS / 1000}s · `
    + `concurrency ${positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP)} · `
    + `heartbeat ${HEARTBEAT_PATH}`,
  );
  setTimeout(() => { void runAutomationSchedulerTick(); }, 2_000).unref();
  setInterval(() => { void runAutomationSchedulerTick(); }, TICK_MS).unref();
}
