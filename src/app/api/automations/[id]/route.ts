/**
 * /api/automations/[id] — update (PATCH) and delete an automation.
 *
 * PATCH  → { automation: AutomationRow }   partial update; cron change triggers nextRunAt recompute.
 * DELETE → { ok: true }
 *
 * Loopback-gated via middleware.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { automationApiRecord } from '@/lib/automations/api-shape';
import { updateAutomationRow } from '@/lib/automations/store';
import { signalAutomationsChanged } from '@/lib/automations/scheduler-signal';
import {
  ingestLaneAutomationSourceEvents,
  latestAutomationSourceSequence,
} from '@/lib/automations/source-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TriggerKind = 'manual' | 'cron' | 'watch';
const TRIGGER_KINDS = ['manual', 'cron', 'watch'] as const;
const WATCH_SOURCE_KINDS = ['managed_run', 'packet', 'repository'] as const;
const WATCH_ACTION_KINDS = ['dispatch', 'notify', 'steer', 'approval'] as const;

interface PatchBody {
  name?: string;
  prompt?: string;
  runtime?: string;
  repoPath?: string;
  branch?: string;
  triggerKind?: TriggerKind;
  cronExpr?: string | null;
  enabled?: boolean;
  projectId?: string | null;
  catchUpPolicy?: 'latest' | 'all' | 'skip';
  repoConcurrencyLimit?: number;
  precheckCommand?: string | null;
  precheckTimeoutMs?: number;
  watchSourceKind?: 'managed_run' | 'packet' | 'repository';
  watchSourceId?: string | null;
  watchEventTypes?: string[];
  watchLiteralFilter?: string | null;
  watchQuietMs?: number | null;
  watchMinIntervalMs?: number;
  watchBatchWindowMs?: number;
  watchMaxFiresPerTick?: number;
  watchExpiresAt?: number | null;
  watchActionKind?: 'dispatch' | 'notify' | 'steer' | 'approval';
  watchTargetLaneId?: string | null;
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: PatchBody;
  try { body = await request.json() as PatchBody; }
  catch { return NextResponse.json({ error: 'invalid json body' }, { status: 400 }); }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Compose the patch. Only set the fields the caller sent; respect existing
  // values for the rest. Cron recompute fires if EITHER triggerKind flipped to
  // cron OR cronExpr changed while staying on cron.
  const next: Partial<typeof automations.$inferInsert> = {
    updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  if (typeof body.name === 'string') next.name = body.name.trim();
  if (typeof body.prompt === 'string') next.prompt = body.prompt.trim();
  if (typeof body.runtime === 'string') next.runtime = body.runtime.trim();
  if (typeof body.repoPath === 'string') next.repoPath = body.repoPath.trim();
  if (typeof body.branch === 'string') next.branch = (body.branch.trim() || 'main');
  if (body.projectId !== undefined) next.projectId = body.projectId;
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.catchUpPolicy !== undefined) {
    if (!['latest', 'all', 'skip'].includes(body.catchUpPolicy)) {
      return NextResponse.json({ error: 'invalid catchUpPolicy' }, { status: 400 });
    }
    next.catchUpPolicy = body.catchUpPolicy;
  }
  if (body.repoConcurrencyLimit !== undefined) {
    if (!Number.isInteger(body.repoConcurrencyLimit) || body.repoConcurrencyLimit < 1 || body.repoConcurrencyLimit > 16) {
      return NextResponse.json({ error: 'repoConcurrencyLimit must be between 1 and 16' }, { status: 400 });
    }
    next.repoConcurrencyLimit = body.repoConcurrencyLimit;
  }
  if (body.precheckCommand !== undefined) {
    next.precheckCommand = typeof body.precheckCommand === 'string' && body.precheckCommand.trim()
      ? body.precheckCommand.trim()
      : null;
    if (next.precheckCommand && next.precheckCommand.length > 4_096) {
      return NextResponse.json({ error: 'precheckCommand must be 4096 characters or fewer' }, { status: 400 });
    }
  }
  if (body.precheckTimeoutMs !== undefined) {
    if (!Number.isInteger(body.precheckTimeoutMs) || body.precheckTimeoutMs < 1_000 || body.precheckTimeoutMs > 300_000) {
      return NextResponse.json({ error: 'precheckTimeoutMs must be between 1000 and 300000' }, { status: 400 });
    }
    next.precheckTimeoutMs = body.precheckTimeoutMs;
  }
  if (body.watchSourceKind !== undefined) {
    if (!WATCH_SOURCE_KINDS.includes(body.watchSourceKind)) {
      return NextResponse.json({ error: 'invalid watchSourceKind' }, { status: 400 });
    }
    next.watchSourceKind = body.watchSourceKind;
  }
  if (body.watchSourceId !== undefined) {
    if ((body.watchSourceId?.trim().length ?? 0) > 256) {
      return NextResponse.json({ error: 'watchSourceId must be 256 characters or fewer' }, { status: 400 });
    }
    next.watchSourceId = body.watchSourceId?.trim() || null;
  }
  if (body.watchEventTypes !== undefined) {
    if (!Array.isArray(body.watchEventTypes) || body.watchEventTypes.length > 16
      || body.watchEventTypes.some((value) => typeof value !== 'string' || value.trim().length > 80)) {
      return NextResponse.json({ error: 'watchEventTypes accepts at most 16 values of 80 characters' }, { status: 400 });
    }
    next.watchEventTypesJson = JSON.stringify(body.watchEventTypes.map((value) => value.trim()).filter(Boolean));
  }
  if (body.watchLiteralFilter !== undefined) {
    if ((body.watchLiteralFilter?.trim().length ?? 0) > 512) {
      return NextResponse.json({ error: 'watchLiteralFilter must be 512 characters or fewer' }, { status: 400 });
    }
    next.watchLiteralFilter = body.watchLiteralFilter?.trim() || null;
  }
  if (body.watchQuietMs !== undefined) {
    if (body.watchQuietMs != null && (!Number.isInteger(body.watchQuietMs) || body.watchQuietMs < 1_000 || body.watchQuietMs > 86_400_000)) {
      return NextResponse.json({ error: 'watchQuietMs must be between 1000 and 86400000' }, { status: 400 });
    }
    next.watchQuietMs = body.watchQuietMs;
  }
  if (body.watchMinIntervalMs !== undefined) {
    if (!Number.isInteger(body.watchMinIntervalMs) || body.watchMinIntervalMs < 0 || body.watchMinIntervalMs > 86_400_000) {
      return NextResponse.json({ error: 'watchMinIntervalMs must be between 0 and 86400000' }, { status: 400 });
    }
    next.watchMinIntervalMs = body.watchMinIntervalMs;
  }
  if (body.watchBatchWindowMs !== undefined) {
    if (!Number.isInteger(body.watchBatchWindowMs) || body.watchBatchWindowMs < 0 || body.watchBatchWindowMs > 86_400_000) {
      return NextResponse.json({ error: 'watchBatchWindowMs must be between 0 and 86400000' }, { status: 400 });
    }
    next.watchBatchWindowMs = body.watchBatchWindowMs;
  }
  if (body.watchMaxFiresPerTick !== undefined) {
    if (!Number.isInteger(body.watchMaxFiresPerTick) || body.watchMaxFiresPerTick < 1 || body.watchMaxFiresPerTick > 16) {
      return NextResponse.json({ error: 'watchMaxFiresPerTick must be between 1 and 16' }, { status: 400 });
    }
    next.watchMaxFiresPerTick = body.watchMaxFiresPerTick;
  }
  if (body.watchExpiresAt !== undefined) {
    if (body.watchExpiresAt != null && (!Number.isFinite(body.watchExpiresAt) || body.watchExpiresAt <= Date.now())) {
      return NextResponse.json({ error: 'watchExpiresAt must be in the future' }, { status: 400 });
    }
    next.watchExpiresAt = body.watchExpiresAt;
  }
  if (body.watchActionKind !== undefined) {
    if (!WATCH_ACTION_KINDS.includes(body.watchActionKind)) {
      return NextResponse.json({ error: 'invalid watchActionKind' }, { status: 400 });
    }
    next.watchActionKind = body.watchActionKind;
  }
  if (body.watchTargetLaneId !== undefined) {
    if ((body.watchTargetLaneId?.trim().length ?? 0) > 256) {
      return NextResponse.json({ error: 'watchTargetLaneId must be 256 characters or fewer' }, { status: 400 });
    }
    next.watchTargetLaneId = body.watchTargetLaneId?.trim() || null;
  }

  if (body.triggerKind !== undefined && !TRIGGER_KINDS.includes(body.triggerKind)) {
    return NextResponse.json({ error: 'invalid triggerKind' }, { status: 400 });
  }
  const triggerKind: TriggerKind = body.triggerKind ?? existing.triggerKind as TriggerKind;
  const cronExpr = body.cronExpr !== undefined ? body.cronExpr : existing.cronExpr;
  if (body.triggerKind !== undefined || body.cronExpr !== undefined) {
    next.triggerKind = triggerKind;
    next.cronExpr = triggerKind === 'cron' ? cronExpr : null;
    if (triggerKind === 'cron') {
      if (!cronExpr) return NextResponse.json({ error: 'cronExpr required when triggerKind=cron' }, { status: 400 });
      if (!validateCron(cronExpr)) return NextResponse.json({ error: `invalid cron expression: ${cronExpr}` }, { status: 400 });
      next.nextRunAt = computeNextRunAt(cronExpr, Date.now());
    } else {
      next.nextRunAt = null;
    }
  }

  if (triggerKind === 'watch') {
    const sourceKind = body.watchSourceKind ?? existing.watchSourceKind;
    const actionKind = body.watchActionKind ?? existing.watchActionKind;
    const targetLaneId = body.watchTargetLaneId !== undefined ? body.watchTargetLaneId : existing.watchTargetLaneId;
    if (!sourceKind) return NextResponse.json({ error: 'watchSourceKind required when triggerKind=watch' }, { status: 400 });
    if (actionKind === 'steer' && !targetLaneId?.trim()) {
      return NextResponse.json({ error: 'watchTargetLaneId required for steer actions' }, { status: 400 });
    }
    const repoPath = body.repoPath?.trim() || existing.repoPath;
    const sourceId = body.watchSourceId !== undefined ? body.watchSourceId?.trim() || null : existing.watchSourceId;
    const sourceChanged = existing.triggerKind !== 'watch'
      || sourceKind !== existing.watchSourceKind
      || sourceId !== existing.watchSourceId
      || repoPath !== existing.repoPath;
    if (sourceChanged) {
      if (sourceKind === 'packet') ingestLaneAutomationSourceEvents(1_000);
      next.watchCheckpoint = latestAutomationSourceSequence({ sourceKind, repoPath, sourceId });
      next.watchLastFireAt = null;
    }
  }

  const updated = updateAutomationRow(id, next);
  if (!updated) return NextResponse.json({ error: 'update failed' }, { status: 500 });
  return NextResponse.json({ automation: automationApiRecord(updated) });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  db.delete(automations).where(eq(automations.id, id)).run();
  signalAutomationsChanged();
  return NextResponse.json({ ok: true });
}
