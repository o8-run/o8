import { randomUUID } from 'node:crypto';
import type { ApprovalRecord } from './types';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import { checkExpectedHeadSha, resolveHeadSha } from '@/lib/lane/head-sha-lock';
import { fetchWorkerRun } from '@/lib/worker/runs';
import { fetchWorkerBranch, cleanupRemoteMergeWorktree } from '@/lib/lane/remote-fetch';

/** Check the approved source before answering with delivery policy or integrating it. */
export async function checkLaneMergeHead(laneId: string, approvedHead?: string) {
  const sha = approvedHead?.toLowerCase();
  const lane = getLane(laneId);
  const refuse = (code: string, message: string) => {
    if (lane) setLaneStatus(lane.id, 'reviewing', 'system', 'review_invalidated');
    return { code, message };
  };
  if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return refuse('approved_head_required', 'This merge continuation has no approved head SHA. Return to review before merging.');
  if (!lane) return refuse('approved_head_unavailable', 'The approved lane is unavailable. Return to review.');
  let remotePath: string | undefined;
  try {
    if ((lane.runtime as string) === 'remote-customer') {
      const run = fetchWorkerRun(lane.id);
      if (!run?.remoteBranch) return refuse('approved_head_unavailable', 'The remote source is unavailable. Return to review.');
      const fetched = await fetchWorkerBranch(lane.repoPath, run.remoteBranch, `approval-check-${randomUUID()}`);
      if (!fetched.ok) return refuse('approved_head_unavailable', 'The remote source could not be fetched. Return to review.');
      remotePath = fetched.tempWorktreePath;
    }
    const cwd = remotePath ?? lane.worktreePath ?? lane.repoPath;
    const head = await checkExpectedHeadSha(cwd, sha, lane.repoPath);
    if (!head.ok) return refuse('head_moved_since_review', 'The head changed after approval. Return to review before merging.');
    if (!await resolveHeadSha(cwd, sha, lane.repoPath)) return refuse('approved_head_unavailable', 'The approved commit could not be resolved. Return to review.');
  } catch { return refuse('approved_head_unavailable', 'The approved head could not be checked. Return to review.'); }
  finally { if (remotePath) await cleanupRemoteMergeWorktree(lane.repoPath, remotePath); }
  return null;
}

/** A merge card authorizes its saved commit, never the checkout observed on confirmation. */
export async function checkApprovalMergeHead(approval: ApprovalRecord, spokenHead?: string) {
  const continuation = approval.continuation;
  return continuation?.kind === 'lane' && continuation.verb === 'merge'
    ? checkLaneMergeHead(continuation.laneId, spokenHead ?? continuation.expectedHeadSha) : null;
}
