import { getSqlite } from '@/lib/db';
import { preparationFailureDetails } from '@/lib/worktree/preparation-failure';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  releasePacketStorageAfterWorktreeProvisionFailure,
  type PacketWorktreeProvisionStorageRelease,
} from '@/lib/lane/lane-storage-release';
import { getLane, setLaneStatus, updateLane } from '@/lib/lane/registry';
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
  let cause = details.cause;
  try {
    // Failure also fences attempts that stop before admission or run as background setup.
    // Read durably; cleanup progress can exceed the recent-event window.
    const row = getSqlite().prepare(`SELECT payload_json FROM lane_events
      WHERE lane_id = ? AND actor = 'system' AND verb = 'worktree_preparation_timing'
        AND json_extract(payload_json, '$.packetId') = ?
        AND json_extract(payload_json, '$.stage') = 'dependency_install'
        AND rowid > COALESCE((SELECT MAX(rowid) FROM lane_events WHERE lane_id = ?
          AND actor = 'system' AND verb IN ('worktree_provision_started', 'worktree_provision_failed')), 0)
      ORDER BY rowid DESC LIMIT 1`).get(laneId, packetId, laneId) as { payload_json: string } | undefined;
    const install = row ? JSON.parse(row.payload_json) as Record<string, unknown> : null;
    if (install?.phase === 'failed' && typeof install.cause === 'string') cause = preparationFailureDetails(install.cause).cause;
  } catch { /* Optional diagnostics must not prevent failure and storage settlement. */ }
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
