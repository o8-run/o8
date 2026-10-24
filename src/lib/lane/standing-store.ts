import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';

export interface StandingTask {
  id: string;
  prompt: string;
  branch: string;
  baseCommit?: string;
  startedAt?: string;
  runId?: string;
  phase: 'queued' | 'dispatching' | 'running' | 'publishing' | 'done';
  commit?: string;
  prNumber?: number;
  prUrl?: string;
  receiptId?: string;
}
export interface StandingLaneState {
  model: string;
  effort: ThinkingEffort;
  stopped: boolean;
  removed: boolean;
  blockedReason: string | null;
  /** Newest run whose complete process tree was proved absent before checkout reuse. */
  processSettlement?: { runId: string; totalRuns: number };
  tasks: StandingTask[];
}

/** Standing mode is an append-only extension of the existing lane event log. */
export function readStandingLane(laneId: string): StandingLaneState | null {
  const row = getSqlite().prepare(`SELECT payload_json FROM lane_events
    WHERE lane_id = ? AND json_type(payload_json, '$.standingLane') = 'object'
    ORDER BY rowid DESC LIMIT 1`).get(laneId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json).standingLane as StandingLaneState : null;
}

export function saveStandingLane(laneId: string, state: StandingLaneState): void {
  // A stop may win while a dispatch or publication is awaiting I/O.
  const current = readStandingLane(laneId);
  recordLaneEvent(laneId, 'update', 'system', {
    standingLane: { ...state, stopped: state.stopped || current?.stopped === true,
      removed: state.removed || current?.removed === true },
  });
}

export function holdStandingLane(laneId: string): void {
  const state = readStandingLane(laneId);
  if (state && !state.stopped) saveStandingLane(laneId, { ...state, stopped: true });
}
