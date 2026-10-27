import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, getLane, setLaneStatus } from '@/lib/lane/registry';
import { POST_WORKTREE_LAUNCH_MS } from '@/lib/runtime/launch-deadline';
import { withOwnedArtifactRootLock } from './artifact-admission';
import { archiveOwnedSessionDir, assertOwnedSessionArchivable } from './archive';
import { attachSupervisedRun } from './supervised-run';
import { probeOwnedRunMarker } from './run-process-proof';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
async function processClear(run: OwnedRunRecord, surfaceId: string): Promise<boolean> {
  if (run.spawnState === 'prepared') return false;
  if (run.supervisor) {
    const proof = await attachSupervisedRun(run, surfaceId);
    return proof.state === 'exited' && proof.groupEmpty;
  }
  if (process.platform === 'win32' || !Number.isSafeInteger(run.pid) || run.pid <= 0
    || !run.processGroupId || run.processGroupId <= 0 || run.tmuxSession
    || !/^[A-Za-z0-9._-]{1,160}$/.test(run.processMarker ?? '')) return false;
  return absent(run.pid) && absent(-run.processGroupId) && await probeOwnedRunMarker(run.processMarker) === 'clear';
}

function candidate(session: OwnedSessionRecord, timedOutBeforeSpawn: boolean): boolean {
  const ledger = session.runIdentityLedger;
  const age = Date.now() - Date.parse(session.createdAt);
  return !session.threadId && !session.activeRun && !session.detachedAt && Number.isFinite(age)
    && (timedOutBeforeSpawn ? session.recentRuns.length === 0 : age >= POST_WORKTREE_LAUNCH_MS)
    && ledger?.version === 1 && ledger.complete === true && Number.isSafeInteger(ledger.totalRuns)
    && ledger.totalRuns === session.recentRuns.length;
}

/** Exact directory and fresh absence proof share the existing cross-process spawn lock. */
export async function retireUnstartedSession(runtime: string, root: string, sessionDir: string, observed: OwnedSessionRecord, io: OwnedSessionIo, timedOutBeforeSpawn = false): Promise<boolean> {
  if ((!timedOutBeforeSpawn && runtime !== 'antigravity') || !candidate(observed, timedOutBeforeSpawn)) return false;
  return withOwnedArtifactRootLock(root, async () => {
    const canonicalRoot = await realpath(root);
    const directory = await lstat(sessionDir);
    const name = path.basename(sessionDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(sessionDir) !== path.join(canonicalRoot, name)) return false;
    const session = await io.loadSession(sessionDir);
    if (session.surfaceId !== `${runtime}-owned:${name}` || path.resolve(session.sessionDir) !== path.resolve(sessionDir)
      || !candidate(session, timedOutBeforeSpawn)) return false;
    const started = Date.parse(session.createdAt);
    if (!Number.isFinite(started) || (!timedOutBeforeSpawn && Date.now() - started < POST_WORKTREE_LAUNCH_MS)) return false;
    for (const run of session.recentRuns) if (!await processClear(run, session.surfaceId)) return false;
    const current = await lstat(sessionDir);
    if (current.dev !== directory.dev || current.ino !== directory.ino || current.isSymbolicLink()) return false;
    if (!await assertOwnedSessionArchivable(root, sessionDir)) return false;
    session.orphanedAt = new Date().toISOString();
    session.orphanedReason = 'runtime_launch_timeout: no persistent thread or active process after the launch deadline.';
    await io.saveSession(session);
    const result = await archiveOwnedSessionDir(root, session);
    if (!result.archived) return false;
    if (session.laneId) {
      const lane = getLane(session.laneId);
      if (lane?.sessionKey === session.surfaceId && ['launching', 'running'].includes(lane.status)) {
        appendEvent(lane.id, 'runtime_launch_step', 'system', {
          packetId: session.packetId, runtime, step: 'first_thread', phase: 'failed', code: 'runtime_launch_timeout',
          elapsedMs: Date.now() - started, deadlineMs: POST_WORKTREE_LAUNCH_MS,
        });
        setLaneStatus(lane.id, 'failed', 'system', 'runtime_launch_timeout');
      }
    }
    return true;
  }).catch(() => false);
}
