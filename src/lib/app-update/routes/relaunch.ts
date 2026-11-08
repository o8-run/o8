import { recordForcedRestart } from '@/lib/app-update/forced-restart-receipt';
import { getUpdateIdleWindow } from '@/lib/app-update/idle-window';
import { inspectCliOperationAdmission } from '@/lib/setup/cli-operation-admission';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getAppUpdateState } from '@/lib/app-update/relaunch-state';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (isRecord(body) && body.force !== undefined && typeof body.force !== 'boolean') {
    return NextResponse.json({ ok: false, error: { code: 'invalid_force', message: 'force must be boolean.' } }, { status: 400 });
  }
  const force = isRecord(body) && body.force === true;
  const ifUpdatePending = isRecord(body) && body.ifUpdatePending === true;
  const state = getAppUpdateState();

  if (ifUpdatePending && !state.updatePending) {
    return NextResponse.json({
      ok: true,
      relaunched: false,
      skipped: true,
      reason: 'no-update-pending',
      message: 'No downloaded update is pending; restart skipped.',
      state,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const admission = inspectCliOperationAdmission();
  if (!force && admission.blocked) return NextResponse.json({ ok: false, relaunched: false,
    error: { code: admission.code, message: admission.message } }, { status: 409 });

  if (force) {
    const idle = await getUpdateIdleWindow().catch(() => ({ unavailable: true }));
    try { recordForcedRestart('app-relaunch', { admission, idle }); }
    catch { return NextResponse.json({ ok: false, error: { code: 'restart_receipt_unavailable',
      message: 'The forced restart receipt could not be recorded.' } }, { status: 503 }); }
  }
  const now = new Date().toISOString();
  await publishRealtimeMutation({
    mutation: {
      mutationId: `app-relaunch-${randomUUID()}`,
      source: 'server',
      action: 'app-relaunch-requested',
      force,
      status: 'queued',
      createdAt: now,
      timestamp: now,
      note: ifUpdatePending
        ? `Apply pending update${state.version ? ` ${state.version}` : ''}.`
        : 'Restart requested from o8 CLI/API.',
    },
  });

  return NextResponse.json({
    ok: true,
    relaunched: true,
    skipped: false,
    message: 'Restart request published to the dashboard.',
    state,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
