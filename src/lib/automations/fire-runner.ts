import { eq } from 'drizzle-orm';

import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt } from './cron';
import { ensureAutomationPrecheck } from './precheck';
import type { RunAutomationResult } from './runner';
import { getAutomationFire, settleAutomationFire, type AutomationFire } from './fire-store';

export async function runClaimedAutomationFire(
  fire: AutomationFire,
  now: () => number = Date.now,
): Promise<AutomationFire | undefined> {
  if (fire.status !== 'leased' || !fire.claimedBy || !fire.leaseToken) return undefined;
  const db = getDb();
  if (!db) return undefined;
  const row = db.select().from(automations).where(eq(automations.id, fire.automationId)).get();
  if (!row) return getAutomationFire(fire.id);

  db.update(automations).set({
    lastRunAt: fire.claimedAt ?? now(),
    lastRunStatus: 'running',
  }).where(eq(automations.id, row.id)).run();

  const precheck = await ensureAutomationPrecheck(fire, now);
  if (precheck.action !== 'continue') {
    const settledPrecheck = settleAutomationFire({
      fireId: fire.id,
      workerId: fire.claimedBy,
      leaseToken: fire.leaseToken,
      ok: precheck.action === 'skip',
      note: precheck.note,
      nowMs: now(),
      terminalOnFailure: true,
    });
    if (!settledPrecheck) return undefined;
    db.update(automations).set({
      lastRunStatus: precheck.action === 'skip' ? 'ok' : 'error',
      lastErrorMessage: precheck.action === 'skip' ? null : precheck.note,
      nextRunAt: fire.source === 'manual' && row.triggerKind === 'cron' && row.cronExpr
        ? computeNextRunAt(row.cronExpr, fire.claimedAt ?? now())
        : row.nextRunAt,
    }).where(eq(automations.id, row.id)).run();
    return settledPrecheck;
  }

  let result: RunAutomationResult;
  try {
    if (fire.source === 'watch') {
      const { runWatchAutomationAction } = await import('./watch-actions');
      result = await runWatchAutomationAction(row, fire);
    } else {
      const { runAutomation } = await import('./runner');
      result = await runAutomation(row);
    }
  } catch (error) {
    result = {
      ok: false,
      note: error instanceof Error ? error.message : 'automation runner failed',
    };
  }
  const settled = settleAutomationFire({
    fireId: fire.id,
    workerId: fire.claimedBy,
    leaseToken: fire.leaseToken,
    ok: result.ok,
    laneId: result.laneId,
    note: result.note,
    nowMs: now(),
  });
  if (!settled) return undefined;

  db.update(automations).set({
    lastRunStatus: settled.status === 'succeeded' ? 'ok' : 'error',
    lastLaneId: settled.laneId ?? row.lastLaneId,
    lastErrorMessage: settled.status === 'succeeded' ? null : settled.resultNote,
    nextRunAt: fire.source === 'manual' && row.triggerKind === 'cron' && row.cronExpr
      ? computeNextRunAt(row.cronExpr, fire.claimedAt ?? now())
      : row.nextRunAt,
  }).where(eq(automations.id, row.id)).run();
  return settled;
}
