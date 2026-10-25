import { escalateInterrupt, type InterruptEscalationDeps } from '@/lib/runtime/interrupt-escalation';
import { ownedSupervisorClient } from '@/lib/runtime/o8d-supervisor';
import { recordLaneEvent } from '@/lib/lane/events';
import { assertOwnedActionAdmission } from './action-admission';
import { assertStandingSpawn } from './standing-task';
import { attachSupervisedRun } from './supervised-run';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

/** Called under the surface lock after EVERY transport has published its exact run. */
export function confirmOwnedLaunchAdmission(
  session: OwnedSessionRecord, run: OwnedRunRecord, io: OwnedSessionIo,
): Promise<never> | void {
  try {
    assertStandingSpawn(session);
    assertOwnedActionAdmission(session, run.id);
  } catch (error) {
    return cancelLaunchedRun(session, run, io).then(() => { throw error; });
  }
}

export async function cancelLaunchedRun(session: OwnedSessionRecord, run: OwnedRunRecord, io: OwnedSessionIo, deps?: Partial<InterruptEscalationDeps>): Promise<void> {
  // The surface lock is already held. The public Stop wrapper would reacquire it.
  const result = await escalateInterrupt(run, run.supervisor ? {
    isAlive: async () => {
      const state = await attachSupervisedRun(run, session.surfaceId);
      return { alive: !state.groupEmpty, confirmedDead: state.groupEmpty };
    },
    kill: async (_target, signal) => { await ownedSupervisorClient().signal(run.supervisor!, signal); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  } : deps);
  const current = await io.findSession(session.surfaceId);
  if (!current || current.activeRun?.id !== run.id) throw new Error('Cancelled launch process ownership changed; termination remains held.');
  const interrupted = { ...current.activeRun, interruptRequestedAt: current.activeRun.interruptRequestedAt ?? new Date().toISOString(),
    ...(result.confirmedDead ? { outcome: 'interrupted' as const, finishedAt: new Date().toISOString(),
      spawnState: run.spawnState === 'prepared' ? 'reconciled_clear' as const : run.spawnState } : {}) };
  current.recentRuns = current.recentRuns.map(entry => entry.id === run.id ? interrupted : entry);
  current.activeRun = result.confirmedDead ? undefined : interrupted;
  await io.saveSession(current);
  Object.assign(session, current);
  if (session.laneId) for (const step of result.steps) {
    try { recordLaneEvent(session.laneId, 'kill_escalated', 'system', {
      surfaceId: session.surfaceId, runId: run.id, pid: run.pid, stage: step.mechanism, confirmed: step.confirmedDead,
    }); } catch { /* Durable process outcome remains authoritative if telemetry is unavailable. */ }
  }
  if (!result.confirmedDead) throw new Error('Launch was cancelled, but worker termination is unconfirmed; the exact run remains held.');
}
