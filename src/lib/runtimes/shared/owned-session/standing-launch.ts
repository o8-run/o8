import { withOwnedBridgeMutation } from '@/lib/runtime/owned-bridge-launch';
import { probeOwnedRunMarker } from './run-process-proof';
import { spawnBridgeTerminalSession, isBridgeSessionAlive, BridgeSpawnNotSubmittedError } from '@/lib/runtime/pty-bridge';
import { readStandingLane } from '@/lib/lane/standing-store';
import { withStandingLaneMutation } from '@/lib/lane/standing-lock';
import { listOwnedActiveRuns, readOwnedSessionRecord } from '../owned-session-index';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { cancelLaunchedRun } from './launch-admission-outcome';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

/** Include initial launches in the same lane lease already used by resume. */
export function withStandingLaunchMutation<T>(laneId: string | undefined, action: () => Promise<T>): Promise<T> {
  return laneId && readStandingLane(laneId) ? withStandingLaneMutation(laneId, action) : action();
}

/** Stop waits for every launch, even before its surface is attached to the lane. */
export function withStandingStopMutation<T>(laneId: string, action: () => Promise<T>): Promise<T> {
  return withStandingLaunchMutation(laneId, async () => {
    if (readStandingLane(laneId)) {
      for (const run of await listOwnedActiveRuns(Date.now(), true)) {
        const session = await readOwnedSessionRecord(run.surfaceId);
        if (session?.laneId !== laneId) continue;
        const result = await escalateInterruptOwnedSurface(run.surfaceId);
        if (!result?.confirmedDead) throw new Error('Standing launch termination is unconfirmed; Stop remains held.');
      }
    }
    return action();
  });
}

/** A submitted bridge request is ambiguous on error, never permission to spawn twice. */
export async function spawnJournaledStandingBridge(
  session: OwnedSessionRecord, run: OwnedRunRecord, io: OwnedSessionIo,
  request: Parameters<typeof spawnBridgeTerminalSession>[0],
): ReturnType<typeof spawnBridgeTerminalSession> {
  const standing = session.laneId && readStandingLane(session.laneId);
  if (standing) {
    run.tmuxSession = request.sessionName;
    run.detachMode = 'bridge';
    await io.saveSession(session);
  }
  try {
    return await spawnBridgeTerminalSession({ ...request, ...(standing ? { ownedSurfaceId: session.surfaceId } : {}) });
  } catch (error) {
    if (!standing) throw error;
    if (error instanceof BridgeSpawnNotSubmittedError) {
      delete run.tmuxSession; delete run.detachMode;
      await io.saveSession(session);
      throw error;
    }
    // Name and marker were persisted before submission, so a dropped PID reply
    // cannot hide a child. Unknown bridge liveness must retain the journal.
    await withOwnedBridgeMutation(session.surfaceId, () => cancelLaunchedRun(session, run, io, {
      isAlive: async () => {
        const alive = await isBridgeSessionAlive(request.sessionName, { requireConfirmation: true });
        const marker = alive ? 'live' : await probeOwnedRunMarker(run.processMarker);
        return { alive: alive || marker !== 'clear', confirmedDead: !alive && marker === 'clear' };
      },
    }));
    throw error;
  }
}
