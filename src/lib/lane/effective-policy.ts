import type { DurableReviewAssessment } from './durable-review-approval';
import type { LaneMergePolicy } from './merge-mode';
import type { ReviewRiskClassification } from './review-risk';
import type { RequireApproval, SettingSource } from '@/lib/operator/defaults';

export type PolicyPrecedence = 'saved' | 'inherited' | 'run-effective';
export interface PolicyValue<T> {
  value: T;
  source: string;
  precedence: PolicyPrecedence;
}
export interface PolicyHold { source: string; reason: string; precedence?: PolicyPrecedence }
export interface EffectivePolicyInput {
  projectId: string | null;
  laneId: string;
  headSha: string | null;
  reviewMode: 'automatic' | 'manual' | null;
  reviewOverride: boolean;
  risk: ReviewRiskClassification | null;
  correctionBounds: { maximum: number; used: number } | null;
  mergePolicy: LaneMergePolicy | null;
  approvalPosture: { value: RequireApproval; source: SettingSource } | null;
  review: DurableReviewAssessment | null;
  holds: PolicyHold[];
  errors: string[];
}
const field = <T>(value: T, source: string, precedence: PolicyPrecedence): PolicyValue<T> => ({ value, source, precedence });

/** Read projection only. A ready review is never a publication authorization. */
export function composeEffectivePolicy(input: EffectivePolicyInput) {
  const holds = [...input.holds];
  for (const reason of input.errors) holds.push({ source: 'unknown-state', reason });
  if (!input.headSha || !input.reviewMode || !input.risk || !input.correctionBounds || !input.mergePolicy || !input.approvalPosture || !input.review) {
    holds.push({ source: 'unknown-state', reason: 'Effective policy state is unknown or unreadable; maintainer inspection is required.' });
  }
  if (input.reviewMode === 'manual') holds.push({ source: 'review-mode', reason: 'Manual review was requested for this process.' });
  if (input.risk?.tier === 'high') holds.push({ source: 'review-risk', reason: `Sensitive changes require maintainer inspection. ${input.risk.reasons.join(' ')}` });
  if (input.correctionBounds && input.correctionBounds.used >= input.correctionBounds.maximum) {
    holds.push({ source: 'correction-bounds', reason: 'The correction budget is exhausted.' });
  }
  if (input.review?.approved && !input.review.highConfidence) holds.push({ source: 'durable-review', reason: 'The durable review has findings or parser uncertainty; maintainer inspection is required.' });
  if (!input.review?.approved) holds.push({ source: 'durable-review', reason: input.review?.reason ?? 'Durable review is unreadable.' });
  // PR-first completion remains the recommendation even where legacy direct merge
  // is available. Downstream execution must still evaluate all of its own gates.
  const reason = holds.length ? holds.map(hold => hold.reason).join(' ') : 'Independent review is recorded. Prepare a pull request through existing checks and approval gates; publication requires a separate decision.';
  return {
    schema: 'o8/effective-policy/v1' as const,
    projectId: input.projectId, laneId: input.laneId, headSha: input.headSha,
    completion: 'pull_request' as const,
    reviewMode: field(input.reviewMode, 'review-mode', input.reviewOverride ? 'run-effective' : 'inherited'),
    riskClassification: field(input.risk, 'review-risk', 'run-effective'),
    correctionBounds: field(input.correctionBounds, 'review-author-correction', 'run-effective'),
    mergeMode: field(input.mergePolicy?.mode ?? null, 'dogfood-guard', input.mergePolicy?.mode === 'pr_only' ? 'run-effective' : 'inherited'),
    approvalPosture: field(input.approvalPosture?.value ?? null, 'operator-defaults.requireApproval', input.approvalPosture?.source === 'file' ? 'saved' : input.approvalPosture?.source === 'env' ? 'run-effective' : 'inherited'),
    durableReview: field(input.review, 'durable-review-approval', 'run-effective'),
    holds: field(holds.map(hold => ({ ...hold, precedence: hold.precedence ?? 'run-effective' as const })), 'composed-controls', 'run-effective'),
    nextAction: { ...field(holds.length ? 'human' as const : 'prepare_pull_request' as const, 'composed-controls', 'run-effective'), reason },
  };
}
export type EffectivePolicy = ReturnType<typeof composeEffectivePolicy>;
