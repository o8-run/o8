import { NextResponse } from 'next/server';
import type { automations } from '@/lib/db/schema';
import { listAutomationRows, updateAutomationRow } from '@/lib/automations/store';
import { runManualAutomationRequest } from '@/lib/automations/manual-run';

type Row = Pick<typeof automations.$inferSelect,
  'id' | 'name' | 'triggerKind' | 'cronExpr' | 'enabled' | 'lastRunAt' | 'lastRunStatus' | 'nextRunAt'>;
const headers = { 'Cache-Control': 'no-store, max-age=0' };

export function projectAutomation(row: Row) {
  return {
    id: row.id,
    name: row.name,
    schedule: {
      kind: row.triggerKind,
      cronExpr: row.triggerKind === 'cron' ? row.cronExpr : null,
      timezone: 'desktop-local',
      description: row.triggerKind === 'cron'
        ? describeSchedule(row.cronExpr)
        : row.triggerKind === 'watch' ? 'When watched events occur' : 'Manual only',
    },
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    nextRunAt: row.enabled && row.triggerKind === 'cron' ? row.nextRunAt : null,
  };
}

function describeSchedule(expr: string | null): string {
  if (expr === '* * * * *') return 'Every minute';
  const interval = expr?.match(/^\*\/(\d+) \* \* \* \*$/);
  if (interval) return `Every ${interval[1]} minutes`;
  const daily = expr?.match(/^(\d+) (\d+) \* \* \*$/);
  if (daily) return `Daily at ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')} (desktop time)`;
  const fields = expr?.trim().split(/\s+/) ?? [];
  return `Desktop time: minute ${fields[0]}, hour ${fields[1]}, day of month ${fields[2]}, month ${fields[3]}, day of week ${fields[4]} (0 is Sunday; * means any)`;
}

export function listMobileAutomations() {
  try {
    return NextResponse.json({ automations: listAutomationRows().map(projectAutomation) }, { headers });
  } catch {
    return NextResponse.json({ error: 'Automations unavailable' }, { status: 503, headers });
  }
}

export async function setMobileAutomationEnabled(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'enabled')
    || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
    return NextResponse.json({ error: 'Expected only enabled: boolean' }, { status: 400, headers });
  }
  const { id } = await ctx.params;
  try {
    const row = updateAutomationRow(id, {
      enabled: (body as { enabled: boolean }).enabled,
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    return row
      ? NextResponse.json({ automation: projectAutomation(row) }, { headers })
      : NextResponse.json({ error: 'Automation not found' }, { status: 404, headers });
  } catch {
    return NextResponse.json({ error: 'Automation update unavailable' }, { status: 503, headers });
  }
}

export async function runMobileAutomation(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'clientMutationId')
    || typeof (body as { clientMutationId?: unknown }).clientMutationId !== 'string'
    || !(body as { clientMutationId: string }).clientMutationId.trim()
    || (body as { clientMutationId: string }).clientMutationId.length > 128) {
    return NextResponse.json({ error: 'Expected only clientMutationId: nonempty string (max 128)' }, { status: 400, headers });
  }
  try {
    const response = await runManualAutomationRequest(new Request(request.url, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }), ctx);
    const result = await response.json();
    return NextResponse.json({
      ok: result.ok === true,
      queued: result.queued === true,
      replayed: result.replayed === true,
      fireId: result.fire?.id ?? result.fireId ?? null,
      status: result.fire?.status ?? null,
    }, { status: response.status, headers });
  } catch {
    return NextResponse.json({ error: 'Automation run unavailable' }, { status: 503, headers });
  }
}
