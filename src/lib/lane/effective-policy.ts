import type { DurableReviewAssessment } from './durable-review-approval';
import type { LaneMergePolicy } from './merge-mode';
import type { ReviewRiskClassification } from './review-risk';
import type { RequireApproval, SettingSource } from '@/lib/operator/defaults';

/** file -> saved; env -> run-effective; profile/default -> inherited.
 * derived marks computed facts; constant marks a fixed implementation bound. */
export type PolicyPrecedence = 'saved' | 'inherited' | 'run-effective' | 'derived' | 'constant';
export interface PolicyValue<T> { value: T; source: string; precedence: PolicyPrecedence }
export type PolicyOperation = 'create_pr' | 'merge' | 'correction' | 'review';
/** Closed hold sources. A hold's blocks names the affected operation, not a grant. */
export type PolicyHoldSource = 'unknown-state' | 'review-mode' | 'review-risk' | 'review-risk-uncertain'
  | 'correction-bounds' | 'durable-review' | 'packet-hold' | 'merge-hold' | 'session-restriction'
  | 'dogfood-guard' | 'lane-state' | 'missing-worktree' | 'existing-pull-request'
  | 'scope-expansion' | 'protected-test-change' | 'approval-posture';
export interface PolicyHold {
  source: PolicyHoldSource;
  reason: string;
  precedence: PolicyPrecedence;
  blocks: PolicyOperation[];
}
/** human = inspect holds/uncertainty; approval_required = obtain the existing
 * create_pr approval; prepare_pull_request = preparation may proceed, subject
 * to all unevaluated controls. None of these authorizes publication or merge. */
export type PolicyNextAction = 'human' | 'approval_required' | 'prepare_pull_request';
export type UnevaluatedPolicyControl = 'runMergeGate' | 'file-size-limit' | 'contract-coverage'
  | 'run-preflight' | 'spoken-review-evidence' | 'publication-transaction' | 'test-removals';
export interface CreatePrApproval { requiresApproval: boolean; ruleId: string | null; reason: string }

/** Operator-only snapshot for an orchestrator actor. Consumers must compare
 * headSha with the HEAD they act on and ignore null-head results. readAt is
 * observation time, never a lease. Refresh after any policy/hold/HEAD change.
 * reviewMode reads O8_REVIEW_MODE from the API server's environment.
 * mergeMode reports ONLY the PR-only safety wall: direct is not merge permission.
 * durableReview does not evaluate contract coverage in this read projection.
 * nextAction conservatively returns human for any hold, even a hold on another
 * operation; blocks explains its actual scope. Absence of holds never clears
 * unevaluatedControls or authorizes execution. */
export interface EffectivePolicy {
  schema: 'o8/effective-policy/v1';
  actor: 'orchestrator';
  readAt: string;
  projectId: string | null;
  laneId: string;
  headSha: string | null;
  comparisonRef: string | null;
  completion: 'pull_request';
  reviewMode: PolicyValue<'automatic' | 'manual' | null>;
  riskClassification: PolicyValue<ReviewRiskClassification | null>;
  correctionBounds: { maximum: PolicyValue<number | null>; used: PolicyValue<number | null> };
  mergeMode: PolicyValue<LaneMergePolicy['mode'] | null>;
  approvalPosture: PolicyValue<RequireApproval | null>;
  createPrApproval: PolicyValue<CreatePrApproval | null>;
  durableReview: PolicyValue<DurableReviewAssessment | null>;
  holds: PolicyValue<PolicyHold[]>;
  nextAction: PolicyValue<PolicyNextAction> & { reason: string };
  unevaluatedControls: UnevaluatedPolicyControl[];
}
export interface EffectivePolicyInput {
  projectId: string | null;
  laneId: string;
  headSha: string | null;
  comparisonRef: string | null;
  readAt: string;
  reviewMode: 'automatic' | 'manual' | null;
  reviewOverride: boolean;
  risk: ReviewRiskClassification | null;
  correctionBounds: { maximum: number; used: number } | null;
  mergePolicy: LaneMergePolicy | null;
  approvalPosture: { value: RequireApproval; source: SettingSource } | null;
  createPrApproval: CreatePrApproval | null;
  review: DurableReviewAssessment | null;
  holds: PolicyHold[];
  errors: string[];
}
const field = <T>(value: T, source: string, precedence: PolicyPrecedence): PolicyValue<T> => ({ value, source, precedence });
export function settingPrecedence(source: SettingSource | undefined): PolicyPrecedence {
  return source === 'file' ? 'saved' : source === 'env' ? 'run-effective' : 'inherited';
}

/** Pure composition of already-read controls and facts. No execution authority. */
export function composeEffectivePolicy(input: EffectivePolicyInput): EffectivePolicy {
  const holds = [...input.holds];
  const hold = (source: PolicyHoldSource, reason: string, blocks: PolicyOperation[] = ['create_pr', 'merge']) => {
    holds.push({ source, reason, blocks, precedence: 'derived' });
  };
  for (const reason of input.errors) hold('unknown-state', reason);
  if (!input.headSha || !input.reviewMode || !input.risk || !input.correctionBounds || !input.mergePolicy || !input.approvalPosture || !input.review || !input.createPrApproval) {
    hold('unknown-state', 'PR preparation is held: effective policy inputs are unknown or unreadable; maintainer inspection is required.');
  }
  if (input.reviewMode === 'manual') hold('review-mode', 'Automatic review is held by the API server review-mode override.', ['review']);
  if (input.risk?.tier === 'high') hold('review-risk', 'PR preparation and merge need maintainer inspection of the recorded high-risk review.');
  if (input.correctionBounds && input.correctionBounds.used >= input.correctionBounds.maximum) {
    hold('correction-bounds', 'Sending another author correction is blocked: the correction budget is exhausted.', ['correction']);
  }
  if (input.review?.approved && !input.review.highConfidence) hold('durable-review', 'PR preparation is held: the durable review has findings or parser uncertainty.');
  if (!input.review?.approved) hold('durable-review', `PR preparation needs a durable approved review: ${input.review?.reason ?? 'Review state is unreadable.'}`);
  const human = holds.length > 0;
  if (input.createPrApproval?.requiresApproval) hold('approval-posture', `Creating a PR requires an approval card: ${input.createPrApproval.reason}`, ['create_pr']);
  const action: PolicyNextAction = human ? 'human' : input.createPrApproval?.requiresApproval ? 'approval_required' : 'prepare_pull_request';
  return {
    schema: 'o8/effective-policy/v1', actor: 'orchestrator', readAt: input.readAt,
    projectId: input.projectId, laneId: input.laneId, headSha: input.headSha, comparisonRef: input.comparisonRef,
    completion: 'pull_request',
    reviewMode: field(input.reviewMode, 'API server O8_REVIEW_MODE', input.reviewOverride ? 'run-effective' : 'inherited'),
    riskClassification: field(input.risk, 'review_risk_classified', 'derived'),
    correctionBounds: { maximum: field(input.correctionBounds?.maximum ?? null, 'review-author-correction', 'constant'),
      used: field(input.correctionBounds?.used ?? null, 'review-author-correction', 'derived') },
    mergeMode: field(input.mergePolicy?.mode ?? null, 'dogfood-guard', input.mergePolicy?.mode === 'pr_only' ? 'run-effective' : 'inherited'),
    approvalPosture: field(input.approvalPosture?.value ?? null, 'operator-defaults.requireApproval', settingPrecedence(input.approvalPosture?.source)),
    createPrApproval: field(input.createPrApproval, 'evaluatePolicy(buildLanePolicyContext)', 'derived'),
    durableReview: field(input.review, 'durable-review-approval (coverage unevaluated)', 'derived'),
    holds: field(holds, 'composed-controls', 'derived'),
    nextAction: { ...field(action, 'composed-controls', 'derived'), reason: holds.length ? holds.map(hold => hold.reason).join(' ')
      : 'Prepare a pull request, then evaluate every unevaluated control through the existing execution path before publication.' },
    unevaluatedControls: ['runMergeGate', 'file-size-limit', 'contract-coverage', 'run-preflight', 'spoken-review-evidence', 'publication-transaction', 'test-removals'],
  };
}
