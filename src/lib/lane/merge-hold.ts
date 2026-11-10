/**
 * Mission merge hold (#3740). A packet created with `holdMerges` stops at an
 * approved review: every merge that does not come from the operator routes to
 * an approval card instead of merging, so "do not merge" survives the
 * reviewer's and the lead's merge calls.
 */

import { getApproval } from '@/lib/approvals/store';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { getLane } from './registry';
import { latestCorrectionReview } from '@/lib/orchestrator/correction-review';

export const MERGE_HOLD_POLICY_RULE_ID = 'mission-merge-hold';

export function isPacketMergeHeld(packetId: string | null | undefined): boolean {
  const id = packetId?.trim();
  if (!id) return false;
  // Saved-finding corrections stop at independent review. Operator merge cards
  // retain their existing authority; a review alone never releases this hold.
  if (latestCorrectionReview(id)) return true;
  const entry = findMissionRegistryEntryByPacketId(id, { includeArchived: true });
  return entry?.mission.packets.some((packet) => packet.id === id && packet.mergeHold === true) ?? false;
}

/** True for a merge or PR card whose packet is held, which no agent tool may approve. */
export function isMergeApprovalHeld(approvalId: string): boolean {
  const approval = getApproval(approvalId);
  if (!approval) return false;
  if (approval.policyRuleId === MERGE_HOLD_POLICY_RULE_ID) return true;
  const continuation = approval.continuation;
  const packetId = continuation?.kind === 'lane' && continuation.verb !== 'resume'
    ? getLane(continuation.laneId)?.packetId : approval.metadata?.Packet;
  return isPacketMergeHeld(packetId);
}
