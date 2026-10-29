import { recoverStoppedNativeTask } from '@/lib/app-update/native-task';
import { NextResponse } from 'next/server';
import { getRequestedCheckTime } from '@/lib/app-update/fresh-check';
import { controlAutoApply, getNativeApplyRequestTime } from '@/lib/app-update/auto-apply';
import { updateCheckTicket } from '@/lib/app-update/check-order';

import {
  getAppUpdateState,
  recordAppUpdateInstall,
  setAppUpdateState,
  type AppUpdateCheckOutcome,
} from '@/lib/app-update/relaunch-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CHECK_OUTCOMES = new Set<AppUpdateCheckOutcome>(['never', 'available', 'current', 'failed']);
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function invalidState(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400, headers: NO_STORE_HEADERS });
}

export async function GET() {
  return NextResponse.json({ ok: true, state: getAppUpdateState(), checkRequestedAt: getRequestedCheckTime(),
    applyRequestedAt: getNativeApplyRequestTime() }, { headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (isRecord(body) && isRecord(body.autoApply)) {
    try {
      return NextResponse.json(await controlAutoApply(body.autoApply), { headers: NO_STORE_HEADERS });
    } catch {
      return NextResponse.json({ allowed: false, error: { code: 'auto_apply_inventory_unavailable',
        message: 'Update work inventory is unavailable.', retryable: true, retryAfterMs: 5_000 } },
      { status: 503, headers: NO_STORE_HEADERS });
    }
  }
  // An install outcome from the webview (#3588), separate from check results.
  if (isRecord(body) && isRecord(body.install)) {
    const { outcome, version, error } = body.install;
    if (outcome !== 'started' && outcome !== 'installed' && outcome !== 'failed' && outcome !== 'cancelled') {
      return invalidState('invalid_install_outcome', 'install.outcome must be started, installed, failed, or cancelled.');
    }
    recoverStoppedNativeTask();
    if (['installing', 'restarting'].includes(getAppUpdateState().autoApply?.phase ?? '')) {
      return NextResponse.json({ error: { code: 'update_install_in_progress',
        message: 'The native updater is already installing this update.' } }, { status: 409, headers: NO_STORE_HEADERS });
    }
    const state = recordAppUpdateInstall({ outcome,
      version: typeof version === 'string' ? version : null,
      error: typeof error === 'string' ? error : null });
    return NextResponse.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
  }
  if (!isRecord(body) || typeof body.updatePending !== 'boolean') {
    return invalidState('invalid_update_pending', 'updatePending must be boolean.');
  }
  if (typeof body.checkOutcome !== 'string' || !CHECK_OUTCOMES.has(body.checkOutcome as AppUpdateCheckOutcome)) {
    return invalidState('invalid_check_outcome', 'checkOutcome must be never, available, current, or failed.');
  }
  const checkOutcome = body.checkOutcome as AppUpdateCheckOutcome;
  if (checkOutcome === 'available' && !body.updatePending) {
    return invalidState('invalid_update_state', 'available requires updatePending to be true.');
  }
  if ((checkOutcome === 'never' || checkOutcome === 'current') && body.updatePending) {
    return invalidState('invalid_update_state', `${checkOutcome} requires updatePending to be false.`);
  }
  if (checkOutcome !== 'never'
    && (typeof body.checkedAt !== 'string' || !body.checkedAt.trim() || !Number.isFinite(Date.parse(body.checkedAt)))) {
    return invalidState('invalid_checked_at', 'checkedAt must be an ISO timestamp after a check runs.');
  }

  const ticket = updateCheckTicket(body);
  if (['checkSession', 'checkSequence', 'channel', 'generation'].some(key => key in body) && !ticket) {
    return invalidState('invalid_check_ticket', 'An ordered check requires its native session, sequence, channel, and generation.');
  }

  const state = setAppUpdateState({
    ...(ticket ?? {}),
    updatePending: body.updatePending,
    version: typeof body.version === 'string' && body.version.trim() ? body.version.trim() : null,
    checkOutcome,
    checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : null,
    info: isRecord(body.info) ? body.info : null,
    checkError: typeof body.checkError === 'string' ? body.checkError : null,
  });
  return NextResponse.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
}
