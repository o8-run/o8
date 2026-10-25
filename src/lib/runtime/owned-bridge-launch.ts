import { withResourceLease } from '@/lib/leases/resource-lease-guard';
import { readStandingLane } from '@/lib/lane/standing-store';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { assertStandingSpawn } from '@/lib/runtimes/shared/owned-session/standing-task';
import { assertOwnedActionAdmission } from '@/lib/runtimes/shared/owned-session/action-admission';

export async function withOwnedBridgeMutation<T>(surfaceId: string, action: () => Promise<T>): Promise<T> {
  const result = await withResourceLease({ resource: `owned-bridge:${surfaceId}`,
    owner: { id: `owned-bridge:${process.pid}`, label: 'Owned bridge mutation', pid: process.pid },
    actor: 'system:owned-bridge', maxWaitMs: 15000 }, action);
  if (result.state !== 'completed') throw new Error(result.refusal.message);
  return result.value;
}

/** A disconnected HTTP client cannot authorize a request that arrives after Stop. */
export async function withOwnedBridgeLaunchAdmission<T>(input: {
  ownedSurfaceId?: string; sessionName: string; env?: Record<string, string>; laneId?: string; packetId?: string;
}, spawn: () => T): Promise<T> {
  if (!input.ownedSurfaceId) {
    if (input.laneId && readStandingLane(input.laneId)) throw new Error('Standing bridge launch requires its exact owned run.');
    return spawn();
  }
  const surfaceId = input.ownedSurfaceId;
  return withOwnedBridgeMutation(surfaceId, async () => {
    const session = await readOwnedSessionRecord(surfaceId);
    const run = session?.activeRun;
    if (!session || !run || run.spawnState !== 'prepared' || run.interruptRequestedAt
      || session.laneId !== input.laneId || session.packetId !== input.packetId
      || run.tmuxSession !== input.sessionName || !run.processMarker
      || run.processMarker !== input.env?.O8_OWNED_RUN_MARKER) {
      throw new Error('Owned bridge launch was cancelled or its exact run changed.');
    }
    assertStandingSpawn(session);
    assertOwnedActionAdmission(session, run.id);
    // No await between durable admission and PTY creation.
    return spawn();
  });
}
