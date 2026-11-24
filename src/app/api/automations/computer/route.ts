import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { controlComputerJob, undoComputerJobAction } from '@/lib/automations/computer-job-control';
import { readComputerJobs } from '@/lib/automations/computer-jobs';
import { requirePanelAuth } from '@/lib/panel/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID = /^(?:user|cron):[^\s]{1,300}$/;

function operatorOnly(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ ok: false, error: 'operator_required' }, { status: 403 });
  }
  return null;
}

/**
 * Everything scheduled on this Mac. Read when someone asks (the Scheduled
 * screen opening or refreshing), never on a timer. Only the operator: a
 * worker has no use for the machine's job list.
 */
export async function GET(request: NextRequest) {
  const refused = operatorOnly(request);
  if (refused) return refused;
  const report = await readComputerJobs();
  return NextResponse.json({ ok: true, ...report }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

/**
 * Stop or disable one of the user's own jobs, or undo a logged change.
 * `{ id, action, confirm }` needs `confirm` to name the job; without it the
 * reply says what would run and what the change does.
 */
export async function POST(request: NextRequest) {
  const refused = operatorOnly(request);
  if (refused) return refused;
  const body = await request.json().catch(() => null) as { id?: unknown; action?: unknown; confirm?: unknown; undo?: unknown } | null;
  if (body && typeof body.undo === 'string' && /^[0-9a-f-]{36}$/.test(body.undo)) {
    const result = await undoComputerJobAction(body.undo);
    return result.ok ? NextResponse.json(result) : NextResponse.json(result, { status: result.status });
  }
  if (!body || typeof body.id !== 'string' || !ID.test(body.id) || (body.action !== 'stop' && body.action !== 'disable')) {
    return NextResponse.json({ ok: false, error: 'invalid job change' }, { status: 400 });
  }
  const result = await controlComputerJob({
    id: body.id, action: body.action, confirm: typeof body.confirm === 'string' ? body.confirm : '',
  });
  return result.ok ? NextResponse.json(result) : NextResponse.json(result, { status: result.status });
}
