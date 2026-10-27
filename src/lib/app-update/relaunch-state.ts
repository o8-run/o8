import 'server-only';
import type { AppUpdateBlockers } from './update-hub-client';
import { updateCheckTicket, type UpdateCheckTicket } from './check-order';

export interface AppUpdateAutoApplyState {
  attemptId: string | null;
  manualRetryRequired?: boolean;
  phase: 'installing' | 'restarting' | 'waiting' | 'failed';
  version: string;
  installed: boolean;
  blockers: AppUpdateBlockers;
  error: string | null;
}

export interface AppUpdateState {
  autoApply: AppUpdateAutoApplyState | null;
  info: Record<string, unknown> | null;
  updatePending: boolean;
  version: string | null;
  updatedAt: string | null;
  check: AppUpdateCheckState;
  /** The webview's latest install attempt (#3588). A successful one restarts the app, which clears this state. */
  lastInstall: AppUpdateInstallState | null;
}

export interface AppUpdateInstallState {
  outcome: 'started' | 'installed' | 'failed';
  version: string | null;
  at: string;
  error: string | null;
}

export type AppUpdateCheckOutcome = 'never' | 'available' | 'current' | 'failed';

export interface AppUpdateCheckState extends Partial<UpdateCheckTicket> {
  outcome: AppUpdateCheckOutcome;
  checkedAt: string | null;
  errorCode: 'update_check_not_run' | 'update_check_failed' | null;
  error: string | null;
}

const NEVER_CHECKED_MESSAGE = 'No updater check has completed since the app server started.';

let orderedCheck: UpdateCheckTicket | null = null;
const retiredCheckSessions = new Set<string>();
let state: AppUpdateState = {
  autoApply: null,
  info: null,
  updatePending: false,
  version: null,
  updatedAt: null,
  check: {
    outcome: 'never',
    checkedAt: null,
    errorCode: 'update_check_not_run',
    error: NEVER_CHECKED_MESSAGE,
  },
  lastInstall: null,
};

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function setAppUpdateState(update: {
  info?: Record<string, unknown> | null;
  updatePending: boolean;
  version?: string | null;
  checkOutcome?: AppUpdateCheckOutcome;
  checkedAt?: string | null;
  checkError?: string | null;
  checkSequence?: number;
  checkSession?: string;
  channel?: UpdateCheckTicket['channel'];
  generation?: number;
}): AppUpdateState {
  const ticket = updateCheckTicket(update);
  if (!ticket && orderedCheck) return state;
  const sameSession = ticket && orderedCheck?.checkSession === ticket.checkSession;
  if (ticket && (retiredCheckSessions.has(ticket.checkSession)
    || (sameSession && (ticket.checkSequence <= orderedCheck!.checkSequence
      || ticket.generation < orderedCheck!.generation)))) return state;
  const outcome = update.checkOutcome ?? (update.updatePending ? 'available' : 'current');
  const checkedAt = outcome === 'never' ? null : update.checkedAt ?? new Date().toISOString();
  if (state.check.outcome !== 'never') {
    if (outcome === 'never') return state;
    const previousCheckMs = Date.parse(state.check.checkedAt ?? '');
    const nextCheckMs = Date.parse(checkedAt ?? '');
    if (!sameSession && Number.isFinite(previousCheckMs) && Number.isFinite(nextCheckMs) && nextCheckMs < previousCheckMs) {
      return state;
    }
  }
  const error = outcome === 'never'
    ? NEVER_CHECKED_MESSAGE
    : outcome === 'failed'
      ? update.checkError?.trim().slice(0, 1_000) || 'The updater check failed without an error message.'
      : null;
  if (ticket) {
    if (orderedCheck && !sameSession) retiredCheckSessions.add(orderedCheck.checkSession);
    orderedCheck = ticket;
  }
  state = {
    autoApply: state.autoApply,
    info: update.info ?? (update.updatePending ? state.info : null),
    updatePending: update.updatePending,
    version: update.updatePending ? update.version ?? null : null,
    updatedAt: new Date().toISOString(),
    check: {
      ...(ticket ?? {}),
      outcome,
      checkedAt,
      errorCode: outcome === 'never'
        ? 'update_check_not_run'
        : outcome === 'failed'
          ? 'update_check_failed'
          : null,
      error,
    },
    lastInstall: state.lastInstall,
  };
  return state;
}

export function recordAutoApply(autoApply: AppUpdateAutoApplyState | null): AppUpdateState {
  state = { ...state, autoApply };
  return state;
}

/** The native download ended without an installation effect. Release its claim. */
export function recordAutoApplyWait(attemptId: string): void {
  if (state.autoApply?.attemptId !== attemptId || state.autoApply.installed) return;
  state = { ...state, lastInstall: state.lastInstall?.version === state.autoApply.version ? null : state.lastInstall,
    autoApply: { ...state.autoApply, attemptId: null, phase: 'waiting', error: null, manualRetryRequired: false } };
}

/** Records the start or the failure of an install, with the error message for a failure. */
export function recordAppUpdateInstall(update: { outcome: 'started' | 'installed' | 'failed' | 'cancelled'; version?: string | null; error?: string | null }): AppUpdateState {
  if (update.outcome === 'cancelled') {
    if (state.lastInstall?.outcome === 'started' && state.lastInstall.version === (update.version ?? null)) state = { ...state, lastInstall: null };
    return state;
  }
  state = {
    ...state,
    autoApply: update.outcome === 'started' ? null : state.autoApply,
    lastInstall: {
      outcome: update.outcome,
      version: update.version?.trim() || null,
      at: new Date().toISOString(),
      error: update.outcome === 'failed'
        ? update.error?.trim().slice(0, 1_000) || 'The install failed without an error message.'
        : null,
    },
  };
  return state;
}
