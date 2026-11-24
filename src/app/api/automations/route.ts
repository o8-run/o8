/**
 * /api/automations — list + create automations (cron-style scheduled runs).
 *
 * GET   → { automations: AutomationRow[] }
 * POST  → { automation: AutomationRow } | 4xx
 *
 * Gated by middleware loopback + ws-token (see GATED_PREFIXES in middleware.ts).
 * Owner is derived from the request body for now (single-user model). When
 * Team automations land (P3) the owner will come from the auth bridge.
 */

import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { automationApiRecord } from '@/lib/automations/api-shape';
import { listAutomationRows } from '@/lib/automations/store';
import { signalAutomationsChanged } from '@/lib/automations/scheduler-signal';
import {
  ingestLaneAutomationSourceEvents,
  latestAutomationSourceSequence,
} from '@/lib/automations/source-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TriggerKind = 'manual' | 'cron' | 'watch';
const WATCH_SOURCE_KINDS = ['managed_run', 'packet', 'repository'] as const;
const WATCH_ACTION_KINDS = ['dispatch', 'notify', 'steer', 'approval'] as const;

interface CreateBody {
  name?: string;
  owner?: string;
  projectId?: string | null;
  repoPath?: string;
  branch?: string;
  runtime?: string;
  prompt?: string;
  triggerKind?: TriggerKind;
  cronExpr?: string | null;
  enabled?: boolean;
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner');
  const db = getDb();
  if (!db) return NextResponse.json({ automations: [] });
  const rows = owner
    ? db.select().from(automations).where(eq(automations.owner, owner)).orderBy(desc(automations.createdAt)).all()
    : listAutomationRows();
  return NextResponse.json({ automations: rows.map(automationApiRecord) });
}

export async function POST(request: Request) {
  let body: CreateBody;
  try {
    body = await request.json() as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const owner = (body.owner ?? '').trim();
  const repoPath = (body.repoPath ?? '').trim();
  const runtime = (body.runtime ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  const triggerKind: TriggerKind = body.triggerKind === 'cron'
    ? 'cron'
    : body.triggerKind === 'watch' ? 'watch' : 'manual';
  const branch = (body.branch ?? 'main').trim() || 'main';
  const cronExpr = body.cronExpr ? body.cronExpr.trim() : null;
  const catchUpPolicy = body.catchUpPolicy === 'all' || body.catchUpPolicy === 'skip'
    ? body.catchUpPolicy
    : 'latest';
  const repoConcurrencyLimit = Number.isInteger(body.repoConcurrencyLimit)
    ? Number(body.repoConcurrencyLimit)
    : 1;
  const precheckCommand = typeof body.precheckCommand === 'string' && body.precheckCommand.trim()
    ? body.precheckCommand.trim()
    : null;
  const precheckTimeoutMs = body.precheckTimeoutMs == null ? 10_000 : Number(body.precheckTimeoutMs);
  const now = Date.now();

  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  if (!owner) return NextResponse.json({ error: 'owner required' }, { status: 400 });
  if (!repoPath) return NextResponse.json({ error: 'repoPath required' }, { status: 400 });
  if (!runtime) return NextResponse.json({ error: 'runtime required' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  if (repoConcurrencyLimit < 1 || repoConcurrencyLimit > 16) {
    return NextResponse.json({ error: 'repoConcurrencyLimit must be between 1 and 16' }, { status: 400 });
  }
  if (!Number.isInteger(precheckTimeoutMs) || precheckTimeoutMs < 1_000 || precheckTimeoutMs > 300_000) {
    return NextResponse.json({ error: 'precheckTimeoutMs must be between 1000 and 300000' }, { status: 400 });
  }
  if (precheckCommand && precheckCommand.length > 4_096) {
    return NextResponse.json({ error: 'precheckCommand must be 4096 characters or fewer' }, { status: 400 });
  }
  const watchSourceKind = body.watchSourceKind;
  if (body.watchEventTypes !== undefined && (!Array.isArray(body.watchEventTypes)
    || body.watchEventTypes.some((value) => typeof value !== 'string'))) {
    return NextResponse.json({ error: 'watchEventTypes must be an array of strings' }, { status: 400 });
  }
  const watchEventTypes = (body.watchEventTypes ?? []).map((value) => value.trim()).filter(Boolean);
  const watchActionKind = body.watchActionKind ?? 'dispatch';
  const watchMinIntervalMs = body.watchMinIntervalMs ?? 0;
  const watchBatchWindowMs = body.watchBatchWindowMs ?? 0;
  const watchMaxFiresPerTick = body.watchMaxFiresPerTick ?? 4;
  if (triggerKind === 'watch') {
    if (!watchSourceKind || !WATCH_SOURCE_KINDS.includes(watchSourceKind)) {
      return NextResponse.json({ error: 'watchSourceKind required when triggerKind=watch' }, { status: 400 });
    }
    if (watchEventTypes.length > 16 || watchEventTypes.some((value) => value.length > 80)) {
      return NextResponse.json({ error: 'watchEventTypes accepts at most 16 values of 80 characters' }, { status: 400 });
    }
    if (!WATCH_ACTION_KINDS.includes(watchActionKind)) {
      return NextResponse.json({ error: 'invalid watchActionKind' }, { status: 400 });
    }
    if ((body.watchSourceId?.trim().length ?? 0) > 256) {
      return NextResponse.json({ error: 'watchSourceId must be 256 characters or fewer' }, { status: 400 });
    }
    if ((body.watchLiteralFilter?.trim().length ?? 0) > 512) {
      return NextResponse.json({ error: 'watchLiteralFilter must be 512 characters or fewer' }, { status: 400 });
    }
    if ((body.watchTargetLaneId?.trim().length ?? 0) > 256) {
      return NextResponse.json({ error: 'watchTargetLaneId must be 256 characters or fewer' }, { status: 400 });
    }
    if (watchActionKind === 'steer' && !body.watchTargetLaneId?.trim()) {
      return NextResponse.json({ error: 'watchTargetLaneId required for steer actions' }, { status: 400 });
    }
    if (!Number.isInteger(watchMinIntervalMs) || watchMinIntervalMs < 0 || watchMinIntervalMs > 86_400_000) {
      return NextResponse.json({ error: 'watchMinIntervalMs must be between 0 and 86400000' }, { status: 400 });
    }
    if (!Number.isInteger(watchBatchWindowMs) || watchBatchWindowMs < 0 || watchBatchWindowMs > 86_400_000) {
      return NextResponse.json({ error: 'watchBatchWindowMs must be between 0 and 86400000' }, { status: 400 });
    }
    if (!Number.isInteger(watchMaxFiresPerTick) || watchMaxFiresPerTick < 1 || watchMaxFiresPerTick > 16) {
      return NextResponse.json({ error: 'watchMaxFiresPerTick must be between 1 and 16' }, { status: 400 });
    }
    if (body.watchQuietMs != null && (!Number.isInteger(body.watchQuietMs) || body.watchQuietMs < 1_000 || body.watchQuietMs > 86_400_000)) {
      return NextResponse.json({ error: 'watchQuietMs must be between 1000 and 86400000' }, { status: 400 });
    }
    if (body.watchExpiresAt != null && (!Number.isFinite(body.watchExpiresAt) || body.watchExpiresAt <= now)) {
      return NextResponse.json({ error: 'watchExpiresAt must be in the future' }, { status: 400 });
    }
  }
  if (triggerKind === 'cron') {
    if (!cronExpr) return NextResponse.json({ error: 'cronExpr required when triggerKind=cron' }, { status: 400 });
    if (!validateCron(cronExpr)) return NextResponse.json({ error: `invalid cron expression: ${cronExpr}` }, { status: 400 });
  }

  const id = `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nextRunAt = triggerKind === 'cron' && cronExpr ? computeNextRunAt(cronExpr, now) : null;
  const enabled = body.enabled !== false;
  if (triggerKind === 'watch' && watchSourceKind === 'packet') ingestLaneAutomationSourceEvents(1_000, now);
  const watchCheckpoint = triggerKind === 'watch' && watchSourceKind
    ? latestAutomationSourceSequence({
        sourceKind: watchSourceKind,
        repoPath,
        sourceId: body.watchSourceId?.trim() || null,
      })
    : 0;

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  db.insert(automations).values({
    id,
    name,
    owner,
    projectId: body.projectId ?? null,
    repoPath,
    branch,
    runtime,
    prompt,
    triggerKind,
    cronExpr,
    enabled,
    nextRunAt,
    catchUpPolicy,
    repoConcurrencyLimit,
    precheckCommand,
    precheckTimeoutMs,
    watchSourceKind: triggerKind === 'watch' ? watchSourceKind : null,
    watchSourceId: triggerKind === 'watch' ? body.watchSourceId?.trim() || null : null,
    watchEventTypesJson: JSON.stringify(watchEventTypes),
    watchLiteralFilter: triggerKind === 'watch' ? body.watchLiteralFilter?.trim() || null : null,
    watchQuietMs: triggerKind === 'watch' ? body.watchQuietMs ?? null : null,
    watchMinIntervalMs,
    watchBatchWindowMs,
    watchMaxFiresPerTick,
    watchExpiresAt: triggerKind === 'watch' ? body.watchExpiresAt ?? null : null,
    watchActionKind,
    watchTargetLaneId: triggerKind === 'watch' ? body.watchTargetLaneId?.trim() || null : null,
    watchCheckpoint,
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastLaneId: null,
  }).run();
  signalAutomationsChanged();

  const created = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!created) return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  return NextResponse.json({ automation: automationApiRecord(created) });
}
