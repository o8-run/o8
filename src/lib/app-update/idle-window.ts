import { SELF_REQUEST_HEADERS } from '@/lib/background-work/idle-gate';
import { inspectCliOperationAdmission, type CliInstallerActivity } from '@/lib/setup/cli-operation-admission';
import 'server-only';
import { listWorkLaunches } from './work-launch-admission';

import { isOwnedSessionKey, probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';
import { listLanes } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import type { LaneStatus } from '@/lib/lane/types';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { listManagedRuns } from '@/lib/runtimes/managed-runs/registry';
import { listOwnedActiveRuns, lookupOwnedActiveRunFresh } from '@/lib/runtimes/shared/owned-session-index';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { listJobs } from '@/lib/cloud/job-queue';

export interface UpdateIdleLane {
  id: string;
  label: string;
  status: LaneStatus;
  runtime: string;
  sessionKey: string | null;
  processLive?: boolean;
}

export interface UpdateIdleTerminalSession {
  name: string;
  kind: 'dash-shell' | 'tmux-attach' | 'managed-process';
  clientCount: number;
  cwd: string | null;
  commandHint: string | null;
}

export interface UpdateIdleManagedRun {
  id: string;
  session: string;
  command: string;
  cwd: string;
}

export interface UpdateIdleOwnedSession {
  surfaceId: string;
  pid: number | null;
  tmuxSession: string | null;
}

export interface UpdateIdleCloudJob {
  id: string;
  sessionId: string;
  packetId: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
}

/**
 * Lane states with no worker process: the task is waiting for review, input or
 * a retry. A restart keeps their persisted state. Process liveness is checked
 * separately because a parked status alone does not prove the worker exited.
 */
const PARKED_LANE_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  'idle', 'paused', 'awaiting_input', 'awaiting_orchestrator', 'awaiting_human', 'recovering', 'reviewing',
]);

export function isParkedLaneStatus(status: LaneStatus): boolean {
  return PARKED_LANE_STATUSES.has(status);
}

export interface UpdateIdleWindow {
  idle: boolean;
  /**
   * True when only persisted parked lanes remain, with no live worker or other
   * runtime blocker. Manual, automatic and remote apply may preserve these lanes.
   */
  idleExceptParked: boolean;
  /** Persisted parked lanes, listed separately from running work. */
  parkedLanes: UpdateIdleLane[];
  active: {
    lanes: UpdateIdleLane[];
    terminalSessions: UpdateIdleTerminalSession[];
    managedRuns: UpdateIdleManagedRun[];
    ownedSessions: UpdateIdleOwnedSession[];
    cloudJobs: UpdateIdleCloudJob[];
    cliInstallers?: CliInstallerActivity[];
    workLaunches?: Array<{ label: string }>;
    restartPending?: boolean;
  };
  unavailable: string[];
  checkedAt: string;
}

interface IdleWindowInput {
  lanes: UpdateIdleLane[];
  terminalSessions: UpdateIdleTerminalSession[];
  managedRuns: UpdateIdleManagedRun[];
  ownedSessions: UpdateIdleOwnedSession[];
  cloudJobs?: UpdateIdleCloudJob[];
  cliInstallers?: CliInstallerActivity[];
  cliAdmissionUnavailable?: boolean;
  restartPending?: boolean;
  terminalInventoryAvailable: boolean;
  workLaunches?: Array<{ label: string }>;
  checkedAt?: string;
}

export function evaluateUpdateIdleWindow(input: IdleWindowInput): UpdateIdleWindow {
  const activeLanes = input.lanes.filter((lane) => !isLaneTerminal(lane.status));
  const terminalSessions = input.terminalSessions.filter((session) => (
    session.kind === 'managed-process' || session.clientCount > 0
  ));
  const unavailable = input.terminalInventoryAvailable ? [] : ['terminal-sessions'];
  if (input.cliAdmissionUnavailable) unavailable.push('cli-update-ownership');
  const parkedLanes = activeLanes.filter((lane) => isParkedLaneStatus(lane.status) && !lane.processLive);
  const runningLanes = activeLanes.filter(lane => !parkedLanes.includes(lane));
  const otherWorkIdle = terminalSessions.length === 0
    && input.managedRuns.length === 0
    && input.ownedSessions.length === 0
    && (input.cloudJobs?.length ?? 0) === 0
    && (input.cliInstallers?.length ?? 0) === 0
    && (input.workLaunches?.length ?? 0) === 0
    && !input.restartPending
    && unavailable.length === 0;
  return {
    idle: activeLanes.length === parkedLanes.length && otherWorkIdle,
    idleExceptParked: activeLanes.length === parkedLanes.length && otherWorkIdle,
    parkedLanes,
    active: {
      lanes: runningLanes,
      workLaunches: input.workLaunches ?? [],
      terminalSessions,
      managedRuns: input.managedRuns,
      ownedSessions: input.ownedSessions,
      cloudJobs: input.cloudJobs ?? [],
      cliInstallers: input.cliInstallers ?? [],
      ...(input.restartPending ? { restartPending: true } : {}),
    },
    unavailable,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

/** Exported for tests. A background read: the server asking itself, not a client. */
export async function readTerminalInventory(): Promise<{
  available: boolean;
  sessions: UpdateIdleTerminalSession[];
}> {
  try {
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-voice-sessions`, {
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, ...SELF_REQUEST_HEADERS },
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { available: false, sessions: [] };
    const payload = await response.json() as { sessions?: unknown };
    if (!Array.isArray(payload.sessions)) return { available: false, sessions: [] };
    const sessions: UpdateIdleTerminalSession[] = [];
    for (const value of payload.sessions) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { available: false, sessions: [] };
      }
      const session = value as Record<string, unknown>;
      const kind = session.kind;
      if (
        typeof session.name !== 'string'
        || (kind !== 'dash-shell' && kind !== 'tmux-attach' && kind !== 'managed-process')
      ) return { available: false, sessions: [] };
      sessions.push({
        name: session.name,
        kind,
        clientCount: typeof session.clientCount === 'number' ? session.clientCount : 0,
        cwd: typeof session.cwd === 'string' ? session.cwd : null,
        commandHint: typeof session.commandHint === 'string' ? session.commandHint : null,
      });
    }
    return { available: true, sessions };
  } catch {
    return { available: false, sessions: [] };
  }
}

async function parkedLaneProcessLive(lane: ReturnType<typeof listLanes>[number]): Promise<boolean> {
  if (!isParkedLaneStatus(lane.status) || !lane.sessionKey) return false;
  // A restart decision must not reuse the fleet's short-lived session cache.
  if (isOwnedSessionKey(lane.sessionKey)) await lookupOwnedActiveRunFresh(lane.sessionKey);
  return await probeLaneSessionAlive(lane) !== false;
}

export async function getUpdateIdleWindow(reservationId?: string): Promise<UpdateIdleWindow> {
  const [terminalInventory, managedRuns, ownedSessions] = await Promise.all([
    readTerminalInventory(),
    listManagedRuns(),
    listOwnedActiveRuns(Date.now(), Boolean(reservationId)),
  ]);
  const lanes = await Promise.all(listLanes().map(async (lane) => ({
    id: lane.id,
    label: lane.label,
    status: lane.status,
    runtime: lane.runtime,
    sessionKey: lane.sessionKey,
    processLive: await parkedLaneProcessLive(lane),
  })));
  const cloudJobs = listJobs('team_default')
    .filter((job) => job.status === 'leased')
    .map((job) => ({
      id: job.id,
      sessionId: job.sessionId,
      packetId: job.packetId ?? null,
      workerId: job.claimedBy ?? null,
      leaseExpiresAt: job.leaseExpiresAt ?? null,
    }));
  const cliAdmission = inspectCliOperationAdmission(reservationId);
  return evaluateUpdateIdleWindow({
    lanes,
    workLaunches: listWorkLaunches(),
    cliInstallers: cliAdmission.installers,
    cliAdmissionUnavailable: cliAdmission.blocked && cliAdmission.installers.length === 0 && cliAdmission.code !== 'app_restart_pending',
    restartPending: cliAdmission.code === 'app_restart_pending',
    terminalSessions: terminalInventory.sessions,
    terminalInventoryAvailable: terminalInventory.available,
    ownedSessions: ownedSessions.map((session) => ({
      surfaceId: session.surfaceId,
      pid: session.pid ?? null,
      tmuxSession: session.tmuxSession ?? null,
    })),
    cloudJobs,
    managedRuns: managedRuns
      .filter((run) => run.status === 'running' || run.status === 'settling')
      .map((run) => ({ id: run.id, session: run.session, command: run.command, cwd: run.cwd })),
  });
}
