import { withStandingLaneMutation } from '@/lib/lane/standing-lock';
import { findLaneBySession, getLane } from '@/lib/lane/registry';
import { readStandingLane } from '@/lib/lane/standing-store';
import type { OwnedSessionRecord, OwnedWorkspaceBinding } from './types';

/** Called inside the existing owned surface lock, after its previous run settles. */
export function bindStandingTask(session: OwnedSessionRecord, binding: OwnedWorkspaceBinding): boolean {
  if (!session.laneId) return false;
  const standing = readStandingLane(session.laneId);
  if (!standing) return false;
  const lane = getLane(session.laneId);
  const task = standing.tasks.find(task => task.id === lane?.packetId);
  if (standing.stopped || standing.removed || !lane || lane.sessionKey !== session.surfaceId || !task) {
    throw new Error('Standing lane is stopped or its task binding changed.');
  }
  session.packetId = task.id;
  session.branch = task.branch;
  session.title = task.prompt.slice(0, 120);
  session.autoRetry = false;
  session.workspaceBinding = { ...binding, logicalWorkspaceId: `standing:${lane.id}`, packetId: task.id };
  return true;
}

/** Synchronous fence next to credential policy verification and the actual spawn. */
export function assertStandingSpawn(session: OwnedSessionRecord): void {
  if (!session.laneId) return;
  const standing = readStandingLane(session.laneId);
  if (!standing) return;
  const lane = getLane(session.laneId);
  if (standing.stopped || standing.removed || !lane || lane.packetId !== session.packetId
    || (lane.sessionKey && lane.sessionKey !== session.surfaceId)
    || session.model !== standing.model || session.effort !== standing.effort) {
    throw new Error('Standing worker stopped or its pinned task, runtime, model or effort changed.');
  }
}

export function withStandingSessionMutation<T>(surfaceId: string, action: () => Promise<T>): Promise<T> {
  const lane = findLaneBySession(surfaceId);
  return lane && readStandingLane(lane.id) ? withStandingLaneMutation(lane.id, action) : action();
}
