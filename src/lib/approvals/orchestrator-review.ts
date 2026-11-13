import { reviewExecution, type ReviewRunEvidence } from '@/lib/orchestrator/review-run-evidence';
import type {
  ApprovalAuditEvent,
  ApprovalRisk,
  CreateApprovalInput,
  OrchestratorReviewFinding,
} from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';
import type { ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';

export interface OrchestratorReviewRecordInput {
  runEvidence?: ReviewRunEvidence;
  findings: OrchestratorReviewFinding[];
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
  reviewedHeadSha?: string;
  contractCoverageEvidence?: ReviewCoverageEvidence;
  requiresSecondPass?: boolean;
  rawText?: string;
  parseWarning?: string;
  reviewTurnId?: string;
  reviewTurnOutcome?: 'active' | 'completed' | 'failed' | 'quota_discarded';
}

function trimOptional(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeReviewFinding(finding: OrchestratorReviewFinding): OrchestratorReviewFinding {
  const normalizedLine = typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
    ? Math.floor(finding.line)
    : undefined;
  return {
    file: finding.file.trim(),
    line: normalizedLine,
    severity: finding.severity,
    description: finding.description.trim(),
    resolution: finding.resolution,
    fixSuggestion: trimOptional(finding.fixSuggestion),
  };
}

function buildOrchestratorReviewNote(review: OrchestratorReviewRecordInput) {
  const reviewer = review.reviewer ?? 'orchestrator';
  const verdict = reviewExecution(review.approved, review.reviewedHeadSha, review.runEvidence).verdictLabel;
  const findingCount = review.findings.length;
  const findingsSummary = findingCount === 0
    ? 'no findings'
    : `${findingCount} finding${findingCount === 1 ? '' : 's'}`;
  const diffSummary = review.diffSha ? ` Diff ${review.diffSha}.` : '';
  const parseSummary = review.parseWarning ? ` Parser warning: ${review.parseWarning}.` : '';
  return `${reviewer} ${verdict} with ${findingsSummary}.${diffSummary}${parseSummary}`;
}

export function normalizeOrchestratorReview(review: OrchestratorReviewRecordInput): OrchestratorReviewRecordInput {
  return {
    ...reviewExecution(review.approved, review.reviewedHeadSha, review.runEvidence),
    findings: review.findings.map(normalizeReviewFinding),
    reviewer: trimOptional(review.reviewer),
    approved: review.approved,
    diffSha: trimOptional(review.diffSha),
    reviewedHeadSha: trimOptional(review.reviewedHeadSha),
    contractCoverageEvidence: review.contractCoverageEvidence,
    requiresSecondPass: review.requiresSecondPass === true,
    rawText: trimOptional(review.rawText),
    parseWarning: trimOptional(review.parseWarning),
    reviewTurnId: trimOptional(review.reviewTurnId),
    reviewTurnOutcome: review.reviewTurnOutcome,
  };
}

export function allFindingsResolved(findings: OrchestratorReviewFinding[]) {
  return findings.every((finding) => finding.resolution !== 'deferred');
}

export function deriveOrchestratorReviewRisk(review: OrchestratorReviewRecordInput): ApprovalRisk {
  if (!review.approved) {
    return 'high';
  }

  if (review.findings.some((finding) => (
    finding.resolution === 'deferred'
    && (finding.severity === 'bug' || finding.severity === 'rule_violation')
  ))) {
    return 'high';
  }

  if (review.findings.length > 0) {
    return 'medium';
  }

  return 'low';
}

export function buildOrchestratorReviewEvent(review: OrchestratorReviewRecordInput): ApprovalAuditEvent {
  return {
    ...reviewExecution(review.approved, review.reviewedHeadSha, review.runEvidence),
    type: 'orchestrator_review',
    actor: 'orchestrator',
    timestamp: Date.now(),
    note: buildOrchestratorReviewNote(review),
    findings: review.findings.length > 0 ? review.findings : undefined,
    reviewer: review.reviewer,
    approved: review.approved,
    diffSha: review.diffSha,
    reviewedHeadSha: review.reviewedHeadSha,
    parseWarning: review.parseWarning,
    rawText: review.rawText,
  };
}

export function buildOrchestratorReviewApprovalInput(
  packetId: string,
  lane: Lane | null,
  review: OrchestratorReviewRecordInput,
): CreateApprovalInput {
  return {
    source: 'runtime',
    runtime: lane?.runtime ?? 'codex',
    agent: lane?.label ?? review.reviewer ?? 'Orchestrator',
    sessionKey: lane?.sessionKey || (lane ? `lane:${lane.id}` : `packet:${packetId}`),
    title: 'Orchestrator review',
    description: lane
      ? `Orchestrator review for lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`
      : `Orchestrator review for packet ${packetId}`,
    summary: lane
      ? `Orchestrator review: ${lane.branch} → ${lane.baseBranch}`
      : `Orchestrator review: ${packetId}`,
    toolName: 'orchestrator_review',
    args: {
      packetId,
      ...reviewExecution(review.approved, review.reviewedHeadSha, review.runEvidence),
      approved: review.approved,
      findings: review.findings,
      ...(review.reviewedHeadSha ? { reviewedHeadSha: review.reviewedHeadSha } : {}),
      ...(review.contractCoverageEvidence ? { contractCoverageEvidence: review.contractCoverageEvidence } : {}),
      requiresSecondPass: review.requiresSecondPass === true,
      secondPassAgreed: false,
      ...(review.parseWarning ? { parseWarning: review.parseWarning } : {}),
      ...(review.rawText ? { rawText: review.rawText } : {}),
      ...(review.reviewTurnId ? { reviewTurnId: review.reviewTurnId } : {}),
      ...(review.reviewTurnOutcome ? { reviewTurnOutcome: review.reviewTurnOutcome } : {}),
    },
    risk: deriveOrchestratorReviewRisk(review),
    metadata: {
      Packet: packetId,
      ...(lane ? {
        Lane: lane.id,
        Branch: lane.branch,
        Base: lane.baseBranch,
        Runtime: lane.runtime,
      } : {}),
      ...(review.reviewer ? { Reviewer: review.reviewer } : {}),
      ...(review.diffSha ? { 'Diff SHA': review.diffSha } : {}),
      ...(review.reviewedHeadSha ? { 'Reviewed HEAD': review.reviewedHeadSha } : {}),
      ...(review.parseWarning ? { 'Parse Warning': review.parseWarning } : {}),
    },
  };
}
