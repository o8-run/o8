import { preparationFailureDetails, type PreparationCleanup } from '@/lib/worktree/preparation-failure';
import { getSqlite } from '@/lib/db';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import type { Lane } from '@/lib/lane/types';

export interface LaneTerminalReason {
  code: string;
  cleanup?: PreparationCleanup;
  cause: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Read durable diagnostics, including failures that happened before a session existed. */
export function readLaneTerminalReason(lane: Lane | null | undefined): LaneTerminalReason | null {
  if (!lane || (!isLaneTerminal(lane.status) && !lane.status.startsWith('awaiting_'))) return null;
  const fallback = { code: lane.lastEventLabel || lane.status, cause: lane.outcomeNote || null };
  if (lane.status === 'completed') return fallback;
  // Ignore prior attempts after a new launch, and prior failures after completion.
  // rowid orders same-millisecond events by their durable insertion order.
  const rows = getSqlite().prepare(`
    SELECT verb, payload_json FROM lane_events
    WHERE lane_id = ? AND verb IN ('status_change', 'worktree_provision_failed', 'runtime_process_exit')
    ORDER BY rowid DESC
  `).iterate(lane.id) as Iterable<{ verb: string; payload_json: string }>;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (row.verb === 'status_change') {
      if (['launching', 'running', 'completed', 'idle'].includes(String(payload.status))) break;
      if (text(payload.reason)) return { code: text(payload.eventLabel) || fallback.code, cause: text(payload.reason) };
      continue;
    }
    if (row.verb === 'worktree_provision_failed') {
      const details = preparationFailureDetails(text(payload.cause) || text(payload.note) || 'Worktree preparation failed');
      const cleanup = payload.cleanup as PreparationCleanup | undefined;
      return { code: text(payload.code) || 'packet_worktree_provision_failed', cause: details.cause,
        ...(cleanup?.status === 'needs_cleanup' && typeof cleanup.reason === 'string' ? { cleanup } : details.cleanup ? { cleanup: details.cleanup } : {}) };
    }
    if (payload.runtimeOutcome !== 'failed'
      && (payload.classification === 'clean-exit' || (payload.exitCode === 0 && !payload.signal))) break;
    return {
      code: text(payload.code) || 'runtime_process_exit',
      cause: text(payload.cause) || text(payload.reason) || text(payload.stderr)
        || `Worker exited with code ${String(payload.exitCode ?? 'unknown')}${payload.signal ? ` (${String(payload.signal)})` : ''}.`,
    };
  }
  return fallback;
}

function laneTerminalReasons(lanes: Lane[]) {
  return lanes.flatMap((lane) => {
    const terminalReason = readLaneTerminalReason(lane);
    return terminalReason ? [{ laneId: lane.id, packetId: lane.packetId, status: lane.status, terminalReason }] : [];
  });
}

/** Bound status snapshots; filtered lane reads can still retrieve older diagnostics. */
export function laneTerminalReasonSnapshot(lanes: Lane[]) {
  const newest = [...lanes].reverse().filter((lane) => isLaneTerminal(lane.status) || lane.status.startsWith('awaiting_')).sort((left, right) => Date.parse(right.lastEventAt || right.updatedAt) - Date.parse(left.lastEventAt || left.updatedAt));
  return { terminalReasons: laneTerminalReasons(newest.slice(0, 50)), terminalReasonsTruncated: newest.length > 50 };
}
