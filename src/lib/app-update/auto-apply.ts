import 'server-only';

import { recordForcedRestart } from './forced-restart-receipt';
import { recoverStoppedNativeTask } from './native-task';
import { validRestartReservation } from '@/lib/setup/cli-operation-admission';
import { randomUUID } from 'node:crypto';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { checkFreshness, UPDATE_CHECK_INTERVAL_MS } from './fresh-check';
import { getUpdateIdleWindow } from './idle-window';
import { isSelfUpdatableInstall } from './install-target';
import { getRunningInstallInfo } from './install-info';
import { getAppUpdateState, recordAppUpdateInstall, recordAutoApply, recordAutoApplyWait } from './relaunch-state';
import { describeUpdateBlockers } from './update-card-view';

// With o8 next as the window there is no webview to run an operator's Update
// click, so the apply route leaves the request here for the native loop.
let manualApply: { requestedAt: string; force: boolean; attemptId: string | null } | null = null;

export function requestNativeApply(force: boolean): string {
  manualApply = { requestedAt: new Date().toISOString(), force, attemptId: null };
  return manualApply.requestedAt;
}

export function getNativeApplyRequestTime(): string | null {
  return manualApply?.requestedAt ?? null;
}

/** Native owns the timer and effects. Every admission reads current persisted work. */
export async function controlAutoApply(input: Record<string, unknown>) {
  if (input.action === 'inspect-restart') {
    if (!validRestartReservation(input.reservationId)) return { allowed: false, error: { code: 'restart_reservation_invalid' } };
    const idle = await getUpdateIdleWindow(input.reservationId);
    if (input.force === true) recordForcedRestart('native-inspection', idle);
    return { allowed: input.force === true || idle.idle || idle.idleExceptParked, idle };
  }
  if (input.action === 'progress') {
    const current = getAppUpdateState().autoApply;
    if (!current?.attemptId || input.attemptId !== current.attemptId || current.phase !== 'installing') return { allowed: false, attemptMissing: true };
    const receivedBytes = input.receivedBytes;
    const totalBytes = input.totalBytes ?? null;
    if (!Number.isSafeInteger(receivedBytes) || (receivedBytes as number) < 0
      || (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || (totalBytes as number) <= 0))) {
      return { allowed: false, error: { code: 'invalid_progress' } };
    }
    recordAutoApply({ ...current, progress: { stage: 'downloading', receivedBytes: receivedBytes as number, totalBytes: totalBytes as number | null } });
    return { allowed: true };
  }
  // A terminal wait report already proves the download ended without installing.
  // Do not misreport its stopped-task receipt as an abandoned installation.
  if (input.action !== 'wait') recoverStoppedNativeTask();
  const manual = manualApply && (input.action === 'admit' ? !manualApply.attemptId
    : manualApply.attemptId === input.attemptId) ? manualApply : null;
  if (manual && (input.action === 'wait' || input.action === 'failed')) manualApply = null;
  const state = getAppUpdateState();
  const current = state.autoApply;
  const result = (allowed: boolean, extra: object = {}) => ({ allowed, state: getAppUpdateState(), ...extra });
  if (input.action !== 'admit' && input.action !== 'install' && input.action !== 'restart' && input.action !== 'failed' && input.action !== 'wait') {
    return result(false, { error: { code: 'invalid_auto_apply_action' } });
  }
  if (input.action !== 'admit') {
    if (!current?.attemptId || input.attemptId !== current.attemptId) return result(false, { attemptMissing: true });
    if (input.action === 'wait') {
      recordAutoApplyWait(current.attemptId);
      return result(false);
    }
    if (input.action === 'failed') {
      const error = typeof input.error === 'string' ? input.error.slice(0, 1_000) : 'Native update failed.';
      recordAppUpdateInstall({ outcome: 'failed', version: current.version, error });
      recordAutoApply({ ...current, phase: 'failed', error, manualRetryRequired: true });
      return result(false);
    }
  }
  const enabled = (await getOperatorDefaults()).values.updateAutoApply === 'idle';
  if (!enabled && !manual && input.action === 'admit') {
    if (current?.attemptId === input.attemptId && current?.phase === 'installing') {
      recordAppUpdateInstall({ outcome: 'failed', version: current.version, error: 'Automatic updates were turned off before installation.' });
      recordAutoApply({ ...current, phase: 'waiting' });
    }
    return result(false);
  }
  if (!isSelfUpdatableInstall(await getRunningInstallInfo())) return result(false);
  if (input.action === 'admit') {
    if (!manual && current?.manualRetryRequired && current.version === state.version) return result(false);
    if (current?.attemptId && current.attemptId === input.attemptId && current.phase !== 'failed') {
      return result(true, { attemptId: current!.attemptId, version: current!.version, installed: current!.installed });
    }
    const { checkAgeMs } = checkFreshness();
    if (!state.updatePending || !state.version || state.check.outcome !== 'available'
      || checkAgeMs === null || checkAgeMs >= UPDATE_CHECK_INTERVAL_MS
      || state.lastInstall?.outcome === 'started' || current?.phase === 'installing') return result(false);
  }
  const idle = await getUpdateIdleWindow();
  // No awaits between this ownership recheck and the synchronous claim below.
  const latest = getAppUpdateState();
  if (input.action === 'admit' && (latest.lastInstall !== state.lastInstall || latest.autoApply !== current)) return result(false);
  if (input.action !== 'admit' && latest.autoApply?.attemptId !== input.attemptId) return result(false, { attemptMissing: true });
  const blockers = describeUpdateBlockers({ idle });
  const allowed = (enabled || manual !== null) && (manual?.force === true || idle.idle || idle.idleExceptParked);
  const activity = {
    attemptId: input.action !== 'admit' ? current!.attemptId : allowed
      ? typeof input.attemptId === 'string' && input.attemptId.length <= 100 ? input.attemptId : randomUUID() : null,
    version: input.action !== 'admit' ? current!.version : state.version!,
    installed: input.action === 'restart' || (input.action === 'admit' && state.lastInstall?.outcome === 'installed'
      && state.lastInstall.version === state.version),
    phase: allowed ? input.action === 'restart' ? 'restarting' as const : 'installing' as const : 'waiting' as const,
    blockers, error: null,
    progress: !allowed ? null : {
      stage: input.action === 'restart' ? 'restarting' as const : input.action === 'install' ? 'installing' as const : 'downloading' as const,
      receivedBytes: 0, totalBytes: null,
    },
  };
  if (allowed && input.action === 'admit') recordAppUpdateInstall({ outcome: 'started', version: activity.version });
  if (allowed && manual && input.action === 'admit') manualApply = { ...manual, attemptId: activity.attemptId };
  recordAutoApply(activity);
  return result(allowed, { attemptId: activity.attemptId, version: activity.version, installed: activity.installed, idle });
}
