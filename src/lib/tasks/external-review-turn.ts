import type { Lane } from '@/lib/lane/types';
import { getLaneEvents } from '@/lib/lane/registry';
import { getSqlite } from '@/lib/db';

/** Authorize the exact completed independent turn, never an operator-supplied claim. */
export function completedExternalReviewTurn(lane: Lane, turnId: string, claimOwner: string) {
  const revision = getSqlite().prepare('SELECT head_sha FROM external_pr_review_revisions WHERE packet_id = ?').get(lane.packetId) as { head_sha: string } | undefined;
  const events = getLaneEvents(lane.id, 1000);
  const started = events.find(e => e.verb === 'review_turn_started')?.payload;
  const finished = events.find(e => e.verb === 'review_turn_finished')?.payload;
  const queue = getSqlite().prepare("SELECT id FROM review_queue WHERE lane_id = ? AND status = 'in_progress' AND claim_owner = ?").get(lane.id, claimOwner) as { id: string } | undefined;
  const thread = `auto-review-${lane.id}-${queue?.id}`;
  if (!revision || !queue || started?.reviewTurnId !== turnId || finished?.reviewTurnId !== turnId || finished.outcome !== 'completed'
    || started.surface !== 'auto-review' || started.expectedHeadSha !== revision.head_sha
    || ![thread, `${thread}-verdict-retry`].includes(String(started.threadId))
    || !String(started.sessionThreadId).startsWith('thoughts-auto-review-')) throw new Error('The external review turn was interrupted or superseded.');
  return { id: turnId, threadId: String(started.threadId), surface: 'auto-review', expectedHeadSha: revision.head_sha,
    backend: String(started.backend), formatRetryRejecting: started.formatRetryRejecting === true };
}
