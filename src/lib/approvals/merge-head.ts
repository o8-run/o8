import type { ApprovalRecord } from './types';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import { checkExpectedHeadSha } from '@/lib/lane/head-sha-lock';

/** A merge card authorizes its saved commit, never the checkout observed on confirmation. */
export async function checkApprovalMergeHead(approval: ApprovalRecord, spokenHead?: string) {
  const continuation = approval.continuation;
  if (continuation?.kind !== 'lane' || continuation.verb !== 'merge') return null;
  const sha = spokenHead ?? continuation.expectedHeadSha;
  const lane = getLane(continuation.laneId);
  const refuse = (code: string, message: string) => {
    if (lane) setLaneStatus(lane.id, 'reviewing', 'system', 'review_invalidated');
    return { code, message };
  };
  if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return refuse('approved_head_required', 'This merge continuation has no approved head SHA. Return to review before merging.');
  if (!lane) return refuse('approved_head_unavailable', 'The approved lane is unavailable. Return to review.');
  // Remote lanes verify the fetched source at their existing merge entry point.
  if ((lane.runtime as string) === 'remote-customer') return null;
  try {
    const head = await checkExpectedHeadSha(lane.worktreePath || lane.repoPath, sha, lane.repoPath);
    if (!head.ok) return refuse('head_moved_since_review', 'The head changed after approval. Return to review before merging.');
  } catch { return refuse('approved_head_unavailable', 'The approved head could not be checked. Return to review.'); }
  return null;
}
