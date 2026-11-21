import type { Lane } from '@/lib/lane/types';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { assertOrphanProcessesAbsent } from './close-orphaned-process';
import { lstat } from 'node:fs/promises';
import { getSqlite } from '@/lib/db';

/**
 * Missing or already-archived metadata needs no detach write: the session is
 * gone from the active root. This settles absence and grants no deletion authority.
 */
export async function confirmGoneCloseSession(lane: Lane): Promise<boolean> {
  if (!lane.packetId || !lane.worktreePath || !lane.sessionKey) return false;
  try {
    try { await lstat(lane.worktreePath); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    const lifecycle = getOwnedSessionLifecycle(lane.sessionKey);
    const gone = async () => ['missing', 'archived'].includes(await lifecycle!.sessionState(lane.sessionKey!));
    if (!lifecycle || !await gone()) return false;
    const runs = getSqlite().prepare(`SELECT lease_process_marker AS runId, lease_process_pid AS pid,
      lease_process_group_id AS processGroupId FROM worker_tokens
      WHERE packet_id = ? AND scope = 'local-packet' ORDER BY id LIMIT 17`).all(lane.packetId) as {
        runId: string; pid: number; processGroupId: number;
      }[];
    if (runs.length > 16 || new Set(runs.map(run => run.runId)).size !== runs.length || runs.some(run => typeof run.runId !== 'string'
      || !/^[A-Za-z0-9._-]{1,160}$/.test(run.runId) || !Number.isSafeInteger(run.pid) || run.pid <= 0
      || !Number.isSafeInteger(run.processGroupId) || run.processGroupId <= 0)) return false;
    await assertOrphanProcessesAbsent({ runtime: lane.runtime, packetId: lane.packetId, runs,
      sourcePath: lane.worktreePath, candidatePath: lane.worktreePath });
    return await gone();
  } catch { return false; }
}
