import type { Lane, LaneEventVerb } from '@/lib/lane/types';
import type { RuntimeId } from '@/lib/runtimes/types';
import { recordLaneEvent } from '@/lib/lane/events';

// #1471 S1 — `kill_escalated` is a new lane-event verb owned by the
// state-machine-truth builder's union. Until it lands in `LaneEventVerb`, cast
// at the single emit site (INTEGRATION: add `| 'kill_escalated'` to the union).
const KILL_ESCALATED = 'kill_escalated' as unknown as LaneEventVerb;

/**
 * Reap live runtime processes for a set of lanes — shared by `stop-packet`
 * (#1286) and `reset_packet` (#1292) so BOTH hard-cancel the underlying process
 * before the lane's sessionKey is nulled. Without this, reset archived the lane
 * but left the `codex exec` churning, and when that orphan exited/failed the
 * agent-supervisor relaunched it into a sibling lane (the zombie-multiply bug).
 *
 * Interrupt (SIGINT via the runtime adapter) is a CLEAN stop, not a `failed`
 * status, so the supervisor does not auto-retry it — confirmed by stop-packet's
 * proven "not relaunched" behavior.
 */

export interface InterruptTarget {
  laneId: string;
  runtime: RuntimeId;
  sessionKey: string;
}

export interface LaneSessionArchiveOutcome extends InterruptTarget {
  archived: boolean;
  note: string;
}

export interface LaneSessionArchiveResult {
  targeted: number;
  archived: number;
  outcomes: LaneSessionArchiveOutcome[];
  failures: LaneSessionArchiveOutcome[];
}

export class LaneSessionArchiveUnconfirmedError extends Error {
  constructor(public readonly result: LaneSessionArchiveResult) {
    super(
      `Could not confirm archival for ${result.failures.length} owned worker session${result.failures.length === 1 ? '' : 's'}; lane and worktree retirement must remain held.`,
    );
    this.name = 'LaneSessionArchiveUnconfirmedError';
  }
}

/**
 * Pure: the lanes that have a live session to interrupt, as (laneId, runtime,
 * sessionKey) triples. Lanes with no/blank sessionKey are skipped (nothing to
 * reap). Captured from the lane list BEFORE any mutation nulls sessionKey.
 */
export function interruptableSessions(lanes: Lane[]): InterruptTarget[] {
  const out: InterruptTarget[] = [];
  for (const lane of lanes) {
    const sessionKey = lane.sessionKey?.trim();
    if (!sessionKey) continue;
    out.push({ laneId: lane.id, runtime: lane.runtime as RuntimeId, sessionKey });
  }
  return out;
}

/**
 * Interrupt each lane's live session through the universal runtime router
 * (reaps the process per-runtime). Best-effort: a failed kill is logged, not
 * thrown — the caller's archive still proceeds. Returns the number reaped.
 */
export async function interruptLaneSessions(lanes: Lane[]): Promise<number> {
  const targets = interruptableSessions(lanes);
  if (targets.length === 0) return 0;
  const { routeAction } = await import('@/lib/runtimes/registry');
  let interrupted = 0;
  for (const target of targets) {
    try {
      await routeAction(target.runtime, 'interrupt', target.sessionKey);
      interrupted += 1;
    } catch (error) {
      console.warn(`[reap-sessions] interrupt failed for lane ${target.laneId} (${target.runtime}):`, error);
    }
  }
  return interrupted;
}

/**
 * #1471 S1 — CONFIRMED kill with escalation. The plain `interruptLaneSessions`
 * above fires a single best-effort SIGINT and returns; the caller then flips the
 * lane's status whether or not the process actually died — the lie #1471 filed.
 *
 * This reaps each lane's live session through the SIGINT → SIGTERM → SIGKILL
 * escalation ladder (`runtime/interrupt-escalation.ts`, PID-reuse-guarded) and
 * only reports `confirmed` after the process group and snapshotted descendants
 * are verified gone. It emits a `kill_escalated` lane event per stage so the
 * operator can audit exactly what ended the worker (payload {stage, pid, confirmed}) — the
 * stage names the MECHANISM, which on Windows is a single forced tree-kill on
 * every rung rather than three escalating signals.
 * When even the last rung can't be confirmed, `confirmed:false` bubbles up so
 * the caller marks the lane `kill_unconfirmed` instead of pretending it stopped.
 *
 * Every registry-backed owned worker gets the full ladder. Discovered sessions
 * without an o8-owned pid fall back to the single-signal interrupt, which stays
 * explicitly unverified in the event.
 */
export interface ConfirmedKillStage {
  /**
   * What actually ended (or failed to end) the worker, not which rung asked.
   * `taskkill-tree` is the only mechanism Windows has, so all three rungs
   * record it there — the ladder's own signal names would claim a graceful
   * stop for a forced kill. `interrupt` is the unverified single-shot fallback.
   */
  stage: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'taskkill-tree' | 'interrupt';
  confirmed: boolean;
  pid?: number;
}

export interface ConfirmedKillOutcome {
  laneId: string;
  sessionKey: string;
  runtime: RuntimeId;
  confirmed: boolean;
  alreadyDead: boolean;
  pid?: number;
  stages: ConfirmedKillStage[];
  note: string;
}

async function killTargetConfirmed(target: InterruptTarget): Promise<ConfirmedKillOutcome> {
  const emit = (stage: ConfirmedKillStage, extra: Record<string, unknown> = {}) => {
    try {
      recordLaneEvent(target.laneId, KILL_ESCALATED, 'system', {
        sessionKey: target.sessionKey,
        stage: stage.stage,
        pid: stage.pid,
        confirmed: stage.confirmed,
        ...extra,
      });
    } catch (error) {
      console.warn(`[kill] failed to record kill_escalated for lane ${target.laneId}:`, error);
    }
  };

  const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
  const result = await escalateInterruptOwnedSurface(target.sessionKey);
  if (result) {
    const stages: ConfirmedKillStage[] = result.steps.map((step) => ({
      stage: step.mechanism,
      confirmed: step.confirmedDead,
      pid: result.pid,
    }));
    for (const stage of stages) emit(stage);
    return {
      laneId: target.laneId,
      sessionKey: target.sessionKey,
      runtime: target.runtime,
      confirmed: result.confirmedDead,
      alreadyDead: result.alreadyDead,
      pid: result.pid,
      stages,
      note: result.note,
    };
  }

  // Discovered sessions first route through their adapter so it can resolve the
  // process that actually owns the session. A successful signal enqueue is not
  // proof of death: only a returned pid can enter the same probe/escalation
  // ladder used for o8-owned workers. Adapters without pid evidence fail closed
  // and keep the lane/worktree bound.
  try {
    const { routeAction } = await import('@/lib/runtimes/registry');
    const res = await routeAction(target.runtime, 'interrupt', target.sessionKey);
    const pids = [...new Set((res.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) {
      const stage: ConfirmedKillStage = { stage: 'interrupt', confirmed: false };
      emit(stage, { verified: false });
      return {
        laneId: target.laneId,
        sessionKey: target.sessionKey,
        runtime: target.runtime,
        confirmed: false,
        alreadyDead: false,
        stages: [stage],
        note: res.note || 'Interrupt was requested, but no live pid was available to confirm process exit.',
      };
    }

    const { escalateInterrupt } = await import('@/lib/runtime/interrupt-escalation');
    const results = [];
    const stages: ConfirmedKillStage[] = [];
    for (const pid of pids) {
      const escalation = await escalateInterrupt({ pid });
      results.push(escalation);
      for (const step of escalation.steps) {
        const stage: ConfirmedKillStage = {
          stage: step.mechanism,
          confirmed: step.confirmedDead,
          pid,
        };
        stages.push(stage);
        emit(stage, { verified: true });
      }
    }
    const confirmed = results.every((entry) => entry.confirmedDead);
    return {
      laneId: target.laneId,
      sessionKey: target.sessionKey,
      runtime: target.runtime,
      confirmed,
      alreadyDead: results.every((entry) => entry.alreadyDead),
      pid: pids[0],
      stages,
      note: confirmed
        ? results.map((entry) => entry.note).join(' ')
        : `Process exit could not be confirmed. ${results.map((entry) => entry.note).join(' ')}`,
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    console.warn(`[kill] interrupt failed for lane ${target.laneId} (${target.runtime}):`, error);
    return {
      laneId: target.laneId,
      sessionKey: target.sessionKey,
      runtime: target.runtime,
      confirmed: false,
      alreadyDead: false,
      stages: [],
      note,
    };
  }
}

/**
 * Confirmed-kill each lane's live session (SIGINT→SIGTERM→SIGKILL + exit probe).
 * Returns one outcome per lane that HAD a session; lanes with no sessionKey are
 * skipped. Never throws — a failed kill is captured as `confirmed:false`.
 */
export async function killLaneSessionsConfirmed(lanes: Lane[]): Promise<ConfirmedKillOutcome[]> {
  const targets = interruptableSessions(lanes);
  const outcomes: ConfirmedKillOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await killTargetConfirmed(target));
  }
  return outcomes;
}

/**
 * #1292 ROOT — archive each lane's owned-session DIRECTORY (move it to the
 * runtime's `-archive` tree) after the process is interrupted. Reset previously
 * archived the LANE + nulled fields but LEFT the `~/.o8/owned-<runtime>/<id>/`
 * dir in the ACTIVE tree, so on the next app launch the owned-session discovery
 * (`computeFleetAdditions` — which has no retirement gate, only a 24h age
 * filter) re-found the orphan and re-created a phantom lane. This was the real
 * multiply root: 1 dispatch left N session dirs that each re-spawned a lane on
 * every restart until manually archived. Moving the dir to `-archive` removes it
 * from discovery; the transcript stays reviewable (archive-aware tail). Best-
 * effort per lane. Returns the number archived.
 */
export async function archiveLaneSessions(lanes: Lane[]): Promise<LaneSessionArchiveResult> {
  await import('@/lib/runtimes');
  const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
  const targets = interruptableSessions(lanes).filter((target) => target.sessionKey.includes('-owned:'));
  const outcomes: LaneSessionArchiveOutcome[] = [];
  for (const target of targets) {
    try {
      const { persistRuntimeSessionCost } = await import('@/lib/orchestrator/cost-persistence');
      await persistRuntimeSessionCost({
        sessionKey: target.sessionKey,
        runtime: target.runtime,
        repoPath: lanes.find((lane) => lane.id === target.laneId)?.worktreePath
          ?? lanes.find((lane) => lane.id === target.laneId)?.repoPath
          ?? process.cwd(),
        laneId: target.laneId,
        packetId: lanes.find((lane) => lane.id === target.laneId)?.packetId ?? null,
      });
      let result: { archived?: boolean } | null = null;
      const registeredLifecycle = getOwnedSessionLifecycle(target.sessionKey);
      if (registeredLifecycle) {
        result = await registeredLifecycle.archiveSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('codex-owned:')) {
        const { archiveOwnedCodexSession } = await import('@/lib/codex/owned');
        result = await archiveOwnedCodexSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('claude-code-owned:')) {
        const { archiveOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
        result = await archiveOwnedClaudeCodeSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('gemini-owned:')) {
        const { archiveOwnedGeminiSession } = await import('@/lib/gemini/owned');
        result = await archiveOwnedGeminiSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('opencode-owned:')) {
        const { archiveOwnedOpencodeSession } = await import('@/lib/opencode/owned');
        result = await archiveOwnedOpencodeSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('cursor-owned:')) {
        const { archiveOwnedCursorSession } = await import('@/lib/cursor/owned');
        result = await archiveOwnedCursorSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('grok-owned:')) {
        const { archiveOwnedGrokSession } = await import('@/lib/grok/owned');
        result = await archiveOwnedGrokSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('prime-agent-owned:')) {
        const { archiveOwnedPrimeAgentSession } = await import('@/lib/prime-agent/owned');
        result = await archiveOwnedPrimeAgentSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('pi-owned:')) {
        const { archiveOwnedPiSession } = await import('@/lib/pi/owned');
        result = await archiveOwnedPiSession(target.sessionKey);
      }
      const archived = result?.archived === true;
      const note = archived
        ? 'Owned session directory archived.'
        : 'Owned session directory archive was not confirmed.';
      outcomes.push({ ...target, archived, note });
      if (!archived) {
        console.warn(`[reap-sessions] session-dir archive was not confirmed for lane ${target.laneId} (${target.runtime}).`);
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      outcomes.push({ ...target, archived: false, note });
      console.warn(`[reap-sessions] session-dir archive failed for lane ${target.laneId} (${target.runtime}):`, error);
    }
  }
  const failures = outcomes.filter((outcome) => !outcome.archived);
  return {
    targeted: targets.length,
    archived: outcomes.length - failures.length,
    outcomes,
    failures,
  };
}

export async function archiveLaneSessionsConfirmed(lanes: Lane[]): Promise<LaneSessionArchiveResult> {
  const result = await archiveLaneSessions(lanes);
  assertLaneSessionsArchived(result);
  return result;
}

export function assertLaneSessionsArchived(result: LaneSessionArchiveResult): void {
  if (result.failures.length > 0) {
    throw new LaneSessionArchiveUnconfirmedError(result);
  }
}
