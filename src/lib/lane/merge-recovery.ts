import type { OrchestratorPacketRecovery } from '@/lib/orchestrator/types';
import { appendEvent, getLane, updateLane } from './registry';
import { RECOVERABLE_WORK_EVENT, recoverableWorkMessage } from './recovery-info';
import type { Lane, LaneEventActor } from './types';
import { preserveLaneWorktreeHead } from './worktree-preservation';

export async function preserveAndRecordLaneRecovery(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath' | 'baseBranch'> & Partial<Pick<Lane, 'branch'>>,
  reason: string,
  options: { actor?: LaneEventActor; reviewed?: boolean } = {},
): Promise<OrchestratorPacketRecovery | null> {
  const actor = options.actor ?? 'system';
  const preservation = await preserveLaneWorktreeHead(lane);
  if (!preservation.preserved || !preservation.branchName) return null;
  const recovery: OrchestratorPacketRecovery = {
    outcome: 'archived_recoverable',
    preservedRef: preservation.branchName,
    preservedHeadSha: preservation.headSha ?? null,
    message: recoverableWorkMessage(preservation.branchName, preservation.headSha ?? null, options.reviewed),
    recommendedAction: 'retry_packet',
  };
  // A prior cleanup attempt can bank the ref and then fail to remove the tree.
  // Confirmed same-ref retries are safe, but only new preservation is an event.
  if (!preservation.alreadyPreserved) {
    appendEvent(lane.id, 'update', actor, {
      event: RECOVERABLE_WORK_EVENT,
      reason,
      preservedRef: recovery.preservedRef,
      preservedHeadSha: recovery.preservedHeadSha,
      reviewed: options.reviewed === true,
      recommendedAction: recovery.recommendedAction,
    });
  }

  const current = getLane(lane.id);
  if (current?.status === 'archived' && (!current.outcome || current.outcome === 'no_changes')) {
    updateLane(lane.id, {
      outcome: recovery.outcome,
      outcomeNote: recovery.message,
    }, actor);
  }
  return recovery;
}
