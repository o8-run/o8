import type { Lane } from '@/lib/lane/types';
import { getSqlite } from '@/lib/db';

export function isExternalReviewPacket(packetId: string | null | undefined): boolean {
  return Boolean(packetId && getSqlite().prepare('SELECT 1 FROM external_pr_review_revisions WHERE packet_id = ?').get(packetId));
}

/** Authorize the exact completed independent turn, never an operator-supplied claim. */
export function completedExternalReviewTurn(lane: Lane, turnId: string, claimOwner: string) {
  const revision = getSqlite().prepare('SELECT head_sha, base_sha FROM external_pr_review_revisions WHERE packet_id = ?').get(lane.packetId) as { head_sha: string; base_sha: string } | undefined;
  const latest = (verb: string): Record<string, unknown> | undefined => {
    const row = getSqlite().prepare('SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = ? ORDER BY rowid DESC LIMIT 1').get(lane.id, verb) as {payload_json: string} | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  };
  const started = latest('review_turn_started');
  const finished = latest('review_turn_finished');
  const queue = getSqlite().prepare("SELECT id FROM review_queue WHERE lane_id = ? AND status = 'in_progress' AND claim_owner = ?").get(lane.id, claimOwner) as { id: string } | undefined;
  const thread = `auto-review-${lane.id}-${queue?.id}`;
  if (!revision || lane.baseBranch !== revision.base_sha || !queue || started?.reviewTurnId !== turnId || finished?.reviewTurnId !== turnId || finished.outcome !== 'completed'
    || started.surface !== 'auto-review' || started.expectedHeadSha !== revision.head_sha
    || ![thread, `${thread}-verdict-retry`].includes(String(started.threadId))
    || !String(started.sessionThreadId).startsWith('thoughts-auto-review-')) throw new Error('The external review turn was interrupted or superseded.');
  return { id: turnId, threadId: String(started.threadId), surface: 'auto-review', expectedHeadSha: String(started.expectedHeadSha),
    backend: String(started.backend), formatRetryRejecting: started.formatRetryRejecting === true };
}
