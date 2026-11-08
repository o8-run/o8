import type { AppUpdateBlockers } from '@/lib/app-update/types';

export interface UpdateInfo {
  version: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
  releaseUrl?: string;
}

export interface UpdateCheckReport {
  outcome: 'never' | 'available' | 'current' | 'failed';
  checkedAt: string | null;
  error: string | null;
}

/** The updater can reject with an Error, an empty Error or a plain string; keep whatever it said. */
export function describeInstallError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  if (typeof error === 'string') return error.trim();
  try { return JSON.stringify(error) ?? ''; } catch { return ''; }
}

interface UpdateIdleLaneView { label?: string; status?: string; processLive?: boolean }
export interface UpdateIdleResponse {
  idle?: {
    idle?: boolean;
    idleExceptParked?: boolean;
    parkedLanes?: UpdateIdleLaneView[];
    unavailable?: string[];
    active?: {
      lanes?: UpdateIdleLaneView[];
      terminalSessions?: Array<{ name?: string }>;
      managedRuns?: Array<{ command?: string }>;
      ownedSessions?: Array<{ surfaceId?: string }>;
      cloudJobs?: Array<{ id?: string }>;
      cliInstallers?: Array<{ runtime?: string; state?: string }>;
      workLaunches?: Array<{ label?: string }>;
      restartPending?: boolean;
    };
  };
}

/** Parked records are preserved by restart and never represent running work. */
export function canRestartWhenIdle(payload: UpdateIdleResponse | null): boolean {
  return payload?.idle?.idle === true || payload?.idle?.idleExceptParked === true;
}

export function describeWaitingUpdate(payload: UpdateIdleResponse | null, installed: boolean): string {
  const { live } = describeUpdateBlockers(payload);
  const prefix = installed ? 'Update installed.' : 'Update ready.';
  return live.length ? `${prefix} Waiting for: ${live.join('; ')}.`
    : canRestartWhenIdle(payload) ? `${prefix} Restart now to apply it. Waiting tasks keep their state.`
      : `${prefix} Running-work inventory is unavailable. Check again or confirm a restart.`;
}

/** This label never promises an override of the native installer reservation. */
export function updateRestartLabel(blockers: AppUpdateBlockers | null | undefined): string {
  return blockers?.live.length && !blockers.live.some(item => item.startsWith('CLI update')
    || item.startsWith('Another app restart')) ? 'Restart anyway' : 'Restart now';
}

const PARKED_LABEL: Record<string, string> = {
  reviewing: 'waiting for review',
  awaiting_input: 'waiting for input',
  awaiting_orchestrator: 'waiting for the lead',
  awaiting_human: 'waiting for you',
  paused: 'paused',
  idle: 'idle',
  recovering: 'stopped, can retry',
};

/** Names what a restart would wait for, from GET /api/panel/update/apply. */
export function describeUpdateBlockers(payload: UpdateIdleResponse | null): AppUpdateBlockers {
  const idle = payload?.idle;
  const name = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  const parkedStatuses = new Set((idle?.parkedLanes ?? []).map(lane => lane.status));
  const live = [
    ...(idle?.active?.lanes ?? [])
      .filter(lane => lane.processLive || !parkedStatuses.has(lane.status))
      .map(lane => `${name(lane.label, 'Task')} (${(lane.status ?? 'active').replace(/_/g, ' ')})`),
    ...(idle?.active?.terminalSessions ?? []).map(session => `Terminal ${name(session.name, 'session')}`),
    ...(idle?.active?.managedRuns ?? []).map(run => `Run: ${name(run.command, 'command')}`),
    ...(idle?.active?.ownedSessions ?? []).map(session => `Agent session ${name(session.surfaceId, '')}`.trim()),
    ...(idle?.active?.workLaunches ?? []).map(work => name(work.label, 'Starting process')),
    ...(idle?.active?.cloudJobs ?? []).map(job => `Cloud job ${name(job.id, '')}`.trim()),
    ...(idle?.active?.restartPending ? ['Another app restart is already reserved'] : []),
    ...(idle?.active?.cliInstallers ?? []).map(installer => installer.state === 'active'
      ? `CLI update for ${name(installer.runtime, 'your tool')} is running`
      : `CLI update for ${name(installer.runtime, 'your tool')} ${installer.state === 'interrupted' ? 'was interrupted' : 'has unconfirmed ownership'}; verify the tool and update receipt before retrying restart`),
    ...(idle?.unavailable ?? []).map(item => item === 'terminal-sessions' ? 'Terminal list unavailable' : item === 'cli-update-ownership' ? 'CLI update ownership unavailable; check its update receipt before restarting' : `Check unavailable: ${item}`),
  ];
  const parked = (idle?.parkedLanes ?? [])
    .map(lane => `${name(lane.label, 'Task')} (${PARKED_LABEL[lane.status ?? ''] ?? (lane.status ?? 'parked').replace(/_/g, ' ')})`);
  return { live, parked };
}

export function stringFromRecord(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function normalizeUpdateInfo(payload: unknown): UpdateInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const version = stringFromRecord(record, ['version']);
  if (!version) return null;
  return {
    version,
    currentVersion: stringFromRecord(record, ['currentVersion', 'current_version']),
    notes: stringFromRecord(record, ['notes', 'body']),
    date: stringFromRecord(record, ['date']),
    releaseUrl: stringFromRecord(record, ['releaseUrl', 'release_url', 'url']),
  };
}

export function updateCheckReport(
  outcome: UpdateCheckReport['outcome'],
  error: unknown = null,
  checkedAt = new Date().toISOString(),
): UpdateCheckReport {
  const errorText = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  return {
    outcome,
    checkedAt: outcome === 'never' ? null : checkedAt,
    error: outcome === 'failed' ? errorText.trim().slice(0, 1_000) || 'Unknown updater error.' : null,
  };
}

export function normalizeUpdateCheckReport(payload: unknown): UpdateCheckReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== 'current' && outcome !== 'failed') return null;
  const checkedAt = stringFromRecord(record, ['checkedAt', 'checked_at']) ?? new Date().toISOString();
  return updateCheckReport(outcome, record.error, checkedAt);
}
