import 'server-only';
import { createConnection } from 'node:net';
import { getUpdateIdleWindow } from './idle-window';
import { inspectCliOperationAdmission } from '@/lib/setup/cli-operation-admission';
import type { AppUpdateState } from './relaunch-state';

/** Only the launcher sets this on its server children; native-main also exists in classic. */
export function launcherOwnsUpdates() { return Boolean(process.env.O8_LAUNCHER_SOCKET); }

interface Status {
  ok: boolean;
  state: string;
  current?: string;
  available?: { version: string; notes?: string; date?: string } | null;
  error?: string | null;
}
const STATES = new Set(['idle', 'checking', 'current', 'available', 'staging', 'staged', 'installing', 'failed', 'unsupported']);

/** The launcher answers a check only when it finishes, so it gets the classic fresh-check wait. */
const CHECK_DEADLINE_MS = 25_000;

/** Total deadline includes connect and slow/partial replies, with a bounded response. */
export function launcherRequest(op: 'update-status' | 'update-check' | 'update-apply'): Promise<Status> {
  return new Promise((resolve, reject) => {
    const peer = createConnection({ path: process.env.O8_LAUNCHER_SOCKET! });
    let bytes = '';
    const timer = setTimeout(() => finish(), op === 'update-check' ? CHECK_DEADLINE_MS : 2000);
    function finish(value?: Status) {
      clearTimeout(timer); peer.destroy();
      if (value) resolve(value); else reject(new Error('Launcher updater unavailable.'));
    }
    peer.on('error', () => finish());
    peer.on('connect', () => peer.end(JSON.stringify({ op })));
    peer.on('data', chunk => {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > 65536) return finish();
      if (bytes.includes('\n')) parse();
    });
    peer.on('end', parse);
    function parse() {
      try {
        const value = JSON.parse(bytes);
        if (typeof value.ok !== 'boolean' || !STATES.has(value.state)
          || (value.error != null && typeof value.error !== 'string')
          || (value.available != null && typeof value.available.version !== 'string')) return finish();
        finish(value);
      } catch { finish(); }
    }
  });
}

export function launcherState(status: Status): AppUpdateState {
  const version = status.available?.version ?? null;
  const failed = status.state === 'failed' || status.state === 'unsupported';
  const outcome = failed ? 'failed' : version ? 'available' : status.state === 'current' ? 'current' : 'never';
  return {
    updatePending: Boolean(version), version, updatedAt: null,
    info: status.available ? { ...status.available, body: status.available.notes } : null,
    heldUpdate: version ? { phase: status.state === 'staged' ? 'ready' : status.state === 'staging' ? 'downloading' : status.state,
      version, error: status.error ?? null } : null,
    autoApply: null, lastInstall: null,
    // The protocol has no check timestamp. Do not invent freshness on each poll.
    check: { outcome, checkedAt: null, errorCode: failed ? 'update_check_failed' : outcome === 'never' ? 'update_check_not_run' : null,
      error: status.error ?? null },
  };
}
export function launcherUnavailable() {
  return Response.json({ ok: false, requested: false, error: { code: 'launcher_updater_unavailable',
    message: 'The launcher updater is unavailable.', retryable: true, retryAfterMs: 5000 } },
  { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function launcherSnapshot() {
  const status = await launcherRequest('update-status');
  return { ok: status.ok, state: launcherState(status), currentVersion: status.current,
    checkRequestedAt: null, applyRequestedAt: null, checkedAt: null, checkAgeMs: null };
}

export async function launcherApply(body: Record<string, unknown>) {
  try {
    let status = await launcherRequest('update-status');
    // A staged bundle is already held by the controller. Checking it would be refused as busy.
    if (!['staged', 'staging', 'checking', 'installing'].includes(status.state)) status = await launcherRequest('update-check');
    const state = launcherState(status);
    const respond = (payload: object, code = 200) => Response.json({ ...payload, state, checkedAt: null, checkAgeMs: null },
      { status: code, headers: { 'Cache-Control': 'no-store, max-age=0' } });
    if (!status.ok || state.check.outcome === 'failed') return respond({ ok: false, requested: false,
      error: { code: 'update_check_failed', message: status.error ?? 'Launcher check failed.' } }, 409);
    if (['checking', 'staging', 'installing'].includes(status.state)) return respond({ ok: false, requested: false,
      error: { code: 'update_apply_in_progress', message: 'The launcher updater is busy. Retry shortly.' } }, 409);
    if (body.checkOnly === true) return respond({ ok: true, requested: false, result: { code: `check_${state.check.outcome}` } });
    if (!state.updatePending) return respond({ ok: true, requested: false, result: { code: 'already_current' } });
    const admission = inspectCliOperationAdmission();
    if (admission.blocked) return respond({ ok: false, requested: false,
      error: { code: admission.code, message: admission.message } }, 409);
    const idle = await getUpdateIdleWindow();
    if (!(idle.idle || idle.idleExceptParked)) return respond({ ok: false, requested: false, idle,
      error: { code: 'update_apply_busy', message: 'Update apply refused because work is live.' } }, 409);
    // The socket protocol does not grant a force override. Final launcher admission
    // remains authoritative even if an HTTP client supplies force:true.
    // The launcher performs final restart admission and shutdown itself. No classic apply signal.
    const applied = await launcherRequest('update-apply');
    return respond({ ok: applied.ok, requested: applied.ok, forced: false,
      ...(applied.ok ? { message: 'Update apply requested from the launcher.' }
        : { error: { code: 'update_apply_busy', message: applied.error ?? 'Launcher apply refused.' } }) }, applied.ok ? 202 : 409);
  } catch { return launcherUnavailable(); }
}
