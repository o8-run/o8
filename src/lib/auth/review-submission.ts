import 'server-only';
import { getSqlite } from '@/lib/db';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { findActiveReviewTurn } from '@/lib/lane/review-turn-state';
import { recordLaneEvent } from '@/lib/lane/events';
import { mintPacketWorkerToken, resolvePacketWorkerToken } from './packet-worker-token';
import type { RequestPrincipalContext } from './principal';

export type ReviewSubmissionPrincipal = { role: 'operator' } | {
  role: 'assigned_reviewer'; packetId: string; tokenId: string; reviewTurnId: string; reviewerRuntime: string;
};
export class ReviewSubmissionError extends Error {
  readonly code = 'reviewer_assignment_required';
  constructor() { super('Review submission requires the assigned reviewer or an operator.'); }
}

/** Internal assignment boundary. Each assignment receives a separate credential. */
export function mintAssignedReviewerToken(packetId: string, reviewTurnId: string): string {
  const lane = findLatestLaneByPacket(packetId);
  const turn = lane ? findActiveReviewTurn(lane.id) : null;
  if (!lane || !turn?.backend || turn.id !== reviewTurnId) throw new ReviewSubmissionError();
  const token = mintPacketWorkerToken(packetId, { processMarker: reviewTurnId });
  const identity = resolvePacketWorkerToken(token);
  if (!identity) throw new ReviewSubmissionError();
  recordLaneEvent(lane.id, 'update', 'system', { event: 'reviewer_assignment', packetId, reviewTurnId, reviewerTokenId: identity.tokenId });
  return token;
}

export function reviewSubmissionPrincipal(principal: RequestPrincipalContext, packetId: string): ReviewSubmissionPrincipal | null {
  if (principal.role === 'operator') return { role: 'operator' };
  if (principal.role !== 'worker' || principal.readOnly || principal.packetId !== packetId || !principal.tokenId || !principal.leaseProcessMarker) return null;
  try {
    const lane = findLatestLaneByPacket(packetId);
    const turn = lane ? findActiveReviewTurn(lane.id) : null;
    if (!lane || !turn?.backend || turn.id !== principal.leaseProcessMarker) return null;
    const row = getSqlite().prepare(`SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'update' AND actor = 'system'
      AND json_extract(payload_json, '$.event') = 'reviewer_assignment' ORDER BY rowid DESC LIMIT 1`).get(lane.id) as { payload_json: string } | undefined;
    const assignment = row ? JSON.parse(row.payload_json) as Record<string, unknown> : null;
    const credential = getSqlite().prepare("SELECT id FROM worker_tokens WHERE id = ? AND packet_id = ? AND scope = 'local-packet' AND lease_process_marker = ? AND revoked_at IS NULL")
      .get(principal.tokenId, packetId, turn.id);
    if (!credential || assignment?.packetId !== packetId || assignment.reviewTurnId !== turn.id || assignment.reviewerTokenId !== principal.tokenId) return null;
    return { role: 'assigned_reviewer', packetId, tokenId: principal.tokenId, reviewTurnId: turn.id, reviewerRuntime: turn.backend };
  } catch { return null; }
}

/** Recheck the assignment at the persistence boundary after asynchronous review reads. */
export function assertReviewSubmissionCurrent(principal: ReviewSubmissionPrincipal): void {
  if (principal.role === 'operator') return;
  const current = reviewSubmissionPrincipal({ role: 'worker', packetId: principal.packetId, tokenId: principal.tokenId,
    leaseProcessMarker: principal.reviewTurnId, leaseProcessPid: null, leaseProcessGroupId: null }, principal.packetId);
  if (current?.role !== 'assigned_reviewer' || current.reviewTurnId !== principal.reviewTurnId || current.reviewerRuntime !== principal.reviewerRuntime) throw new ReviewSubmissionError();
}
