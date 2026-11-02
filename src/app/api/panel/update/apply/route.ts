import { recordForcedRestart } from '@/lib/app-update/forced-restart-receipt';
import { checkFreshness, ensureFreshUpdateCheck, UPDATE_RETRY } from '@/lib/app-update/fresh-check';
import { requestNativeApply } from '@/lib/app-update/auto-apply';
import { inspectCliOperationAdmission } from '@/lib/setup/cli-operation-admission';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getUpdateIdleWindow, type UpdateIdleWindow } from '@/lib/app-update/idle-window';
import { getAppUpdateState } from '@/lib/app-update/relaunch-state';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import packageJson from '../../../../../../package.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json({ ...(payload as object), ...checkFreshness() }, { status, headers: NO_STORE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailableIdleWindow(error: unknown): UpdateIdleWindow {
  return {
    idle: false,
    idleExceptParked: false,
    parkedLanes: [],
    active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [] },
    unavailable: [error instanceof Error ? error.message : 'idle-window'],
    checkedAt: new Date().toISOString(),
  };
}

async function readIdleWindow(): Promise<UpdateIdleWindow> {
  try {
    return await getUpdateIdleWindow();
  } catch (error) {
    return unavailableIdleWindow(error);
  }
}

export async function GET() {
  const idle = await readIdleWindow();
  // The state carries the last install attempt, so a caller can read a failed apply back (#3588).
  // currentVersion names the running server, so the o8 next Update pill can show it (#5069).
  return response({ ok: true, idle, state: getAppUpdateState(), currentVersion: packageJson.version });
}

export async function POST(request: Request) {
  const parsed = await request.json().catch(() => null);
  if (parsed !== null && !isRecord(parsed)) {
    return response({
      ok: false,
      error: { code: 'invalid_request', message: 'Request body must be a JSON object.' },
    }, 400);
  }
  const body = parsed ?? {};
  for (const field of ['checkNow', 'checkOnly']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      return response({ ok: false, error: { code: 'invalid_request', message: `${field} must be boolean.` } }, 400);
    }
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    return response({
      ok: false,
      error: { code: 'invalid_force', message: 'force must be boolean.' },
    }, 400);
  }

  const force = body.force === true;
  if (!await ensureFreshUpdateCheck(body.checkNow === true || body.checkOnly === true)) return response({ ok: false, requested: false,
    error: { code: 'update_check_unavailable', message: 'A fresh native updater check did not finish within 25 seconds.', ...UPDATE_RETRY },
    state: getAppUpdateState() }, 503);
  const state = getAppUpdateState();
  if (body.checkOnly === true) {
    const failed = state.check.outcome === 'failed' || state.check.outcome === 'never';
    return response({ ok: !failed, requested: false, state,
      result: { code: `check_${state.check.outcome}` },
      message: failed ? state.check.error ?? 'The native updater check failed.'
        : state.updatePending ? `Update ${state.version} is ready.` : 'o8 is up to date.',
      ...(failed ? { error: { code: state.check.errorCode ?? 'update_check_failed', message: state.check.error ?? 'The native updater check failed.' } } : {}),
    }, failed ? 409 : 200);
  }
  if (!state.updatePending) {
    if (state.check.outcome === 'current') {
      return response({
        ok: true,
        requested: false,
        result: { code: 'already_current' },
        message: 'The last updater check completed and this install is current.',
        state,
      });
    }
    const errorCode = state.check.errorCode ?? 'update_state_inconsistent';
    const message = state.check.outcome === 'failed'
      ? `The last updater check failed${state.check.error ? `: ${state.check.error}` : '.'}`
      : force
        ? 'Force cannot apply an update because no updater check has completed since the app server started.'
        : state.check.error ?? 'No updater check has completed since the app server started.';
    return response({
      ok: false,
      requested: false,
      error: { code: errorCode, message },
      state,
    }, 409);
  }

  const admission = inspectCliOperationAdmission();
  if (!force && admission.blocked) return response({ ok: false, requested: false,
    error: { code: admission.code, message: admission.message }, state }, 409);

  const idle = await readIdleWindow();
  if (!force && !(idle.idle || idle.idleExceptParked)) {
    return response({
      ok: false,
      requested: false,
      error: {
        code: 'update_apply_busy',
        message: 'Update apply refused because work is live. Retry when idle or pass force:true.',
      },
      idle,
      state,
    }, 409);
  }

  if (force) {
    try { recordForcedRestart('update-apply', { admission, idle }); }
    catch { return response({ ok: false, requested: false, error: { code: 'restart_receipt_unavailable',
      message: 'The forced restart receipt could not be recorded.' } }, 503); }
  }
  // o8 next is the window of the packaged macOS app (#5069): no webview listens
  // for the apply mutation, so the shell's native updater installs and restarts.
  if (process.env.O8_NEXT_MAIN_WINDOW === '1') {
    requestNativeApply(force);
    return response({
      ok: true,
      requested: true,
      forced: force,
      message: `Update${state.version ? ` ${state.version}` : ''} apply request sent to the native updater.`,
      idle,
      state,
    }, 202);
  }
  const now = new Date().toISOString();
  const published = await publishRealtimeMutation({
    mutation: {
      mutationId: `app-update-apply-${randomUUID()}`,
      source: 'server',
      action: 'app-update-apply-requested',
      status: 'queued',
      createdAt: now,
      timestamp: now,
      note: `Apply update${state.version ? ` ${state.version}` : ''}${force ? ' with force' : ''}.`,
      force,
    },
  });
  if (!published) {
    return response({
      ok: false,
      requested: false,
      error: { code: 'update_signal_unavailable', message: 'The realtime bridge could not accept the update request.', ...UPDATE_RETRY },
      idle,
      state,
    }, 503);
  }

  return response({
    ok: true,
    requested: true,
    forced: force,
    message: `Update${state.version ? ` ${state.version}` : ''} apply request sent to the app webview.`,
    idle,
    state,
  }, 202);
}
