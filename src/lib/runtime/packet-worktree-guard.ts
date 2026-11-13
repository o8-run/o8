import { preparationFailureDetails } from '@/lib/worktree/preparation-failure';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  releasePacketStorageAfterWorktreeProvisionFailure,
  type PacketWorktreeProvisionStorageRelease,
} from '@/lib/lane/lane-storage-release';
import { getLane, getLaneEvents, setLaneStatus, updateLane } from '@/lib/lane/registry';
import type { LaneStatus } from '@/lib/lane/types';

export const PACKET_WORKTREE_PROVISION_FAILED = 'packet_worktree_provision_failed';

interface PacketWorktreeRequest {
  existingLaneId?: string;
  isolate?: boolean;
  packetId?: string;
}

export function packetRequiresWorktree(request: PacketWorktreeRequest): boolean {
  return Boolean(request.existingLaneId && request.packetId && request.isolate);
}

export function packetWorktreeProvisionError(
  request: PacketWorktreeRequest,
  runtime: string,
  repoPath: string,
  causeInput: unknown,
  note: string,
  laneStatus?: Extract<LaneStatus, 'awaiting_input' | 'failed'>,
): Error {
  if (!packetRequiresWorktree(request)) {
    return causeInput instanceof Error ? causeInput : new Error(note);
  }

  const laneId = request.existingLaneId!;
  const packetId = request.packetId!;
  const details = preparationFailureDetails(causeInput);
  const events = getLaneEvents(laneId, 200);
  const start = events.findLastIndex(event => event.verb === 'worktree_provision_started');
  const install = start < 0 ? undefined : events.slice(start + 1).findLast(event => event.actor === 'system' && event.payload.packetId === packetId && event.verb === 'worktree_preparation_timing'
    && event.payload.stage === 'dependency_install' && event.payload.phase === 'failed');
  const cause = typeof install?.payload.cause === 'string' ? install.payload.cause : details.cause;
  const lane = getLane(laneId);
  let storageRelease: PacketWorktreeProvisionStorageRelease = {
    decision: 'deferred',
    ownerGeneration: null,
    releasedReservations: 0,
    releasedBytes: 0,
    retainedOwnerIds: [packetId],
    reason: 'packet_association_unprovable',
  };
  if (lane) {
    try {
      storageRelease = releasePacketStorageAfterWorktreeProvisionFailure(lane, packetId);
    } catch (error) {
      storageRelease = {
        ...storageRelease,
        reason: 'storage_release_failed',
        error: error instanceof Error ? error.message : String(error),
      };
      console.warn(
        `[runtime-launch] Failed to release packet storage after worktree provision failure for ${laneId}:`,
        error,
      );
    }
  }
  const timedOutPreparation = lane?.status === 'awaiting_orchestrator'
    && lane.lastEventLabel === 'launch_stalled' && lane.sessionKey === null;
  if (lane?.status === 'launching' || timedOutPreparation) {
    setLaneStatus(
      laneId,
      storageRelease.decision === 'deferred' ? 'awaiting_input' : laneStatus ?? 'failed',
      'system',
      PACKET_WORKTREE_PROVISION_FAILED,
    );
  }
  if (lane) updateLane(laneId, { outcomeNote: cause }, 'system');
  try {
    recordLaneEvent(laneId, 'worktree_provision_failed', 'system', {
      code: PACKET_WORKTREE_PROVISION_FAILED,
      runtime,
      packetId,
      laneId,
      repoPath,
      cause,
      note: cause,
      ...(details.cleanup ? { cleanup: details.cleanup } : {}),
      storageRelease,
    });
  } catch (error) {
    console.warn(
      `[runtime-launch] Failed to record ${PACKET_WORKTREE_PROVISION_FAILED} for ${laneId}:`,
      error,
    );
  }

  return new Error(
    `[${PACKET_WORKTREE_PROVISION_FAILED}] Cannot launch ${runtime} packet outside a managed worktree: ${cause}`,
  );
}
