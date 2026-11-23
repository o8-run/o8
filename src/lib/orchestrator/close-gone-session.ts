import type { Lane } from '@/lib/lane/types';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { assertOrphanProcessesAbsent, type OrphanRunMarker } from './close-orphaned-process';
import { lstat } from 'node:fs/promises';
import { getSqlite } from '@/lib/db';

const RUN_MARKER = /^[A-Za-z0-9._-]{1,160}$/;

export interface GoneCloseSession {
  /** Runs that never recorded a process: only their packet and run markers were checked. */
  runsWithoutProcess: number;
}

/**
 * Missing or already-archived metadata needs no detach write: the session is
 * gone from the active root. This settles absence and grants no deletion authority.
 *
 * A packet reset may clear the lane's own packet or session fields while the
 * packet still binds that lane, so the close supplies both. Older workers could
 * leave token rows that never recorded a process; with the operator's
 * missing-worktree acknowledgement those rows are checked by marker only, and a
 * lane that never recorded a workspace path is checked without one.
 */
export async function confirmGoneCloseSession(lane: Lane, close: {
  packetId: string;
  sessionKey: string;
  acknowledgeMissingWorktree: boolean;
}): Promise<GoneCloseSession | null> {
  if ((lane.packetId && lane.packetId !== close.packetId)
    || (lane.sessionKey && lane.sessionKey !== close.sessionKey)) return null;
  const sessionKey = close.sessionKey;
  const worktreePath = lane.worktreePath?.trim() || null;
  if (!sessionKey || (!worktreePath && !close.acknowledgeMissingWorktree)) return null;
  try {
    if (worktreePath) {
      try { await lstat(worktreePath); return null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    }
    const lifecycle = getOwnedSessionLifecycle(sessionKey);
    const gone = async () => ['missing', 'archived'].includes(await lifecycle!.sessionState(sessionKey));
    if (!lifecycle || !await gone()) return null;
    const rows = getSqlite().prepare(`SELECT lease_process_marker AS runId, lease_process_pid AS pid,
      lease_process_group_id AS processGroupId FROM worker_tokens
      WHERE packet_id = ? AND scope = 'local-packet' ORDER BY id LIMIT 17`).all(close.packetId) as {
        runId: unknown; pid: unknown; processGroupId: unknown;
      }[];
    if (rows.length > 16) return null;
    const runs: OrphanRunMarker[] = [];
    let runsWithoutProcess = 0;
    for (const row of rows) {
      const complete = typeof row.runId === 'string' && RUN_MARKER.test(row.runId)
        && Number.isSafeInteger(row.pid) && (row.pid as number) > 0
        && Number.isSafeInteger(row.processGroupId) && (row.processGroupId as number) > 0;
      if (complete) {
        runs.push({ runId: row.runId as string, pid: row.pid as number, processGroupId: row.processGroupId as number });
        continue;
      }
      if (!close.acknowledgeMissingWorktree || row.pid !== null || row.processGroupId !== null) return null;
      runsWithoutProcess += 1;
      if (row.runId === null) continue;
      if (typeof row.runId !== 'string' || !RUN_MARKER.test(row.runId)) return null;
      runs.push({ runId: row.runId, pid: null, processGroupId: null });
    }
    if (new Set(runs.map(run => run.runId)).size !== runs.length) return null;
    await assertOrphanProcessesAbsent({ runtime: lane.runtime, packetId: close.packetId, runs,
      sourcePath: worktreePath, candidatePath: worktreePath });
    return await gone() ? { runsWithoutProcess } : null;
  } catch { return null; }
}
