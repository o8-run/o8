import { randomBytes } from 'node:crypto';
import type { PhoneToolReview } from '../confirm';
import { approval, lane, laneResult } from './scope';
import { request, required, str, trim, type Args, type Json } from './transport';
interface Receipt {
  approvalId: string; packetId: string; title: string; summary: string; expires: number;
  reviewedHeadSha: string; reviewedDiffFingerprint: string; reviewedGovernanceFingerprint: string;
}
const receipts = new Map<string, Receipt>();
async function evidence(packet: string, id: string, signal: AbortSignal) {
  const state = await request(`/api/orchestrator/review-state?packetId=${encodeURIComponent(packet)}&spoken=1&approvalId=${encodeURIComponent(id)}`, signal);
  const review = state.spokenReview as Json | undefined, e = review?.evidence as Json | undefined;
  if (!review || !e || !trim(review, 'spokenSummary') || !trim(e, 'headSha') || !trim(e, 'fingerprint') || !trim(e, 'governanceFingerprint')) {
    throw new Error('o8 did not bind the spoken review to packet HEAD, diff and governance; do not approve this packet yet');
  }
  return { state, review, e, reviewedHeadSha: trim(e, 'headSha'), reviewedDiffFingerprint: trim(e, 'fingerprint'), reviewedGovernanceFingerprint: trim(e, 'governanceFingerprint') };
}
export async function reviewDiff(args: Args, signal: AbortSignal) {
  const l = await lane(args, 'packetId', signal), a = await approval(args, signal);
  if (a.packetId !== trim(l, 'packetId')) throw new Error(`approvalId '${a.id}' does not belong to packetId '${trim(l, 'packetId')}'`);
  const e = await evidence(a.packetId, a.id, signal), token = randomBytes(32).toString('hex'), expires = Date.now() + 300_000;
  for (const [key, r] of receipts) if (r.expires <= Date.now() || r.approvalId === a.id) receipts.delete(key);
  receipts.set(token, { approvalId: a.id, packetId: a.packetId, title: a.title, summary: [...str(e.review, 'spokenSummary')].slice(0, 1200).join(''), expires,
    reviewedHeadSha: e.reviewedHeadSha, reviewedDiffFingerprint: e.reviewedDiffFingerprint, reviewedGovernanceFingerprint: e.reviewedGovernanceFingerprint });
  return { ok: true, ...laneResult(l), branch: str(e.state, 'branch'), state: str(e.state, 'state', 'working'), stat: trim(e.e, 'stat') || 'no changes',
    reviewedHeadSha: e.reviewedHeadSha, reviewedDiffFingerprint: e.reviewedDiffFingerprint, reviewedGovernanceFingerprint: e.reviewedGovernanceFingerprint,
    reviewReceipt: token, reviewReceiptExpiresAt: expires, spokenSummary: str(e.review, 'spokenSummary'), spokenReview: e.review };
}
async function preflight(args: Args, signal: AbortSignal, consume: boolean) {
  const a = await approval(args, signal);
  if (!a.packetId) return { a, receipt: null };
  const token = required(args, 'reviewReceipt'), r = receipts.get(token);
  if (!r || r.expires <= Date.now()) throw new Error('The spoken review receipt is missing, expired, or already used. Review the packet again before approving or rejecting it.');
  if (r.approvalId !== a.id || r.packetId !== a.packetId || r.title !== a.title) throw new Error('That spoken review receipt belongs to a different approval or packet. Review this exact packet before continuing.');
  // Burn before the network check: failed/interrupted writes cannot replay consent.
  if (consume) receipts.delete(token);
  const current = await evidence(a.packetId, a.id, signal);
  if (r.reviewedHeadSha !== current.reviewedHeadSha) throw new Error(`Packet HEAD changed after the spoken review: reviewed ${r.reviewedHeadSha}, current ${current.reviewedHeadSha}. Review it again before continuing.`);
  if (r.reviewedDiffFingerprint !== current.reviewedDiffFingerprint) throw new Error('The packet diff changed after the spoken review. Review it again before continuing.');
  if (r.reviewedGovernanceFingerprint !== current.reviewedGovernanceFingerprint) throw new Error('The approval or governance state changed after the spoken review. Review it again before continuing.');
  return { a, receipt: r };
}
export async function approvalReview(tool: string, args: Args, signal: AbortSignal): Promise<PhoneToolReview> {
  const { a, receipt } = await preflight(args, signal, false), verb = tool === 'o8_approve_item' ? 'Approve' : 'Reject';
  const reason = tool === 'o8_reject_item' ? trim(args, 'reason') : '';
  return { summary: receipt ? `${verb} “${a.title}” after this review: ${receipt.summary}${reason ? ` Reason: ${reason}` : ''}` : `${verb} ${a.id} in o8${reason ? `: ${reason}` : ''}`,
    target: { approvalId: a.id, ...(a.packetId ? { packetId: a.packetId } : {}) } };
}
export async function decideApproval(tool: string, args: Args, signal: AbortSignal) {
  const { a, receipt: r } = await preflight(args, signal, true), approve = tool === 'o8_approve_item';
  const body: Json = { action: approve ? 'approve' : 'reject', id: a.id };
  if (r) body.spokenReviewEvidence = { approvalId: r.approvalId, packetId: r.packetId, reviewedHeadSha: r.reviewedHeadSha, reviewedDiffFingerprint: r.reviewedDiffFingerprint, reviewedGovernanceFingerprint: r.reviewedGovernanceFingerprint };
  if (!approve && trim(args, 'reason')) body.reason = trim(args, 'reason');
  const response = await request('/api/panel/approvals', signal, body);
  if (response.ok !== true) throw new Error(`Couldn't ${approve ? 'approve' : 'reject'} “${a.title}”: ${str(response, 'error', 'o8 returned an error')}`);
  return { [approve ? 'approved' : 'rejected']: true, approvalId: a.id, title: a.title, note: str(response, 'note') };
}
