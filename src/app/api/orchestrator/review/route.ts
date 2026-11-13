import { redactThreadValue } from '@/lib/threads/redaction';
import { reviewSubmissionPrincipal, ReviewSubmissionError } from '@/lib/auth/review-submission';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { submitPacketReview } from '@/lib/orchestrator/operator-mission-service';
import { parseReviewFindings } from '@/lib/orchestrator/review-finding-input';
import { readCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import { ReviewValidationError } from '@/lib/orchestrator/operator-mission-service/review-validation';
import { supplementPacketReviewProcessEvidence } from '@/lib/orchestrator/operator-mission-service/review-process-evidence';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  const principal = resolveRequestPrincipalContext(request);
  const ownershipRefusal = workerPacketRefusal(principal, packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  const submissionPrincipal = reviewSubmissionPrincipal(principal, packetId);
  if (!submissionPrincipal) return operatorError('reviewer_assignment_required', 'Review submission requires the assigned reviewer or an operator.', 403);

  if (typeof record.approved !== 'boolean') {
    return operatorError('invalid_request', 'approved is required.', 400);
  }
  if (record.supplementProcessEvidence !== undefined && (
    record.supplementProcessEvidence !== true || principal.role !== 'operator'
    || record.approved !== true || !Array.isArray(record.findings) || record.findings.length !== 0
  )) {
    return operatorError('invalid_process_evidence_supplement',
      'Process evidence supplementation requires an operator and an approved request with no replacement findings.',
      principal.role === 'operator' ? 422 : 403);
  }
  const waiverInput = record.missingContractWaiverReason;
  const waiverRefusal = principal.role !== 'operator' ? 'Only an operator can waive a missing runtime-default contract.'
    : record.approved !== true ? 'A missing-contract waiver requires an approved review.'
      : typeof waiverInput !== 'string' || !waiverInput.trim() || waiverInput.trim().length > 500
        ? 'A missing-contract waiver requires a nonempty reason of at most 500 characters.'
        : typeof record.reviewedHeadSha !== 'string' || !/^[0-9a-f]{40}$/i.test(record.reviewedHeadSha.trim())
          ? 'A missing-contract waiver requires the full 40-character reviewed HEAD.' : null;
  if (waiverInput !== undefined && waiverRefusal) {
    return operatorError(
      'invalid_missing_contract_waiver',
      waiverRefusal,
      principal.role === 'operator' ? 422 : 403,
    );
  }
  const clientKey = typeof record.clientMutationId === 'string'
    ? record.clientMutationId.trim()
    : typeof record.idempotencyKey === 'string'
      ? record.idempotencyKey.trim()
      : '';
  if (!clientKey) return operatorError('client_mutation_id_required', 'clientMutationId is required.', 400);
  const contractCoverageEvidence = record.contractCoverageEvidence === undefined
    ? undefined
    : readCoverageEvidence({ contractCoverageEvidence: record.contractCoverageEvidence });
  if (record.contractCoverageEvidence !== undefined && !contractCoverageEvidence) {
    return operatorError(
      'invalid_request',
      'contractCoverageEvidence must include contractVersion, headSha, and requirement entries.',
      400,
    );
  }

  const reviewInput = {
      packetId,
      runEvidence: redactThreadValue(record.runEvidence) as import('@/lib/orchestrator/review-run-evidence').ReviewRunEvidence | undefined,
      submissionPrincipal,
      findings: parseReviewFindings(record.findings),
      approved: record.approved,
      reviewedHeadSha: typeof record.reviewedHeadSha === 'string' && record.reviewedHeadSha.trim()
        ? record.reviewedHeadSha.trim()
        : undefined,
      contractCoverageEvidence: contractCoverageEvidence ?? undefined,
      ...(record.supplementProcessEvidence === true ? { supplementProcessEvidence: true } : {}),
      ...(waiverInput !== undefined ? { missingContractWaiverReason: (waiverInput as string).trim() } : {}),
  };
  const canonicalBody = JSON.stringify(reviewInput);
  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'packet_review',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'clientMutationId was used for another review.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The review receipt store is unavailable.', 503);
    }
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'packet_review', scopeId: packetId, clientKey, body: canonicalBody }),
      verb: 'packet_review',
      scopeId: packetId,
    }, async () => {
      try {
        return { ok: true as const, result: reviewInput.supplementProcessEvidence
          ? await supplementPacketReviewProcessEvidence(reviewInput)
          : await submitPacketReview(reviewInput) };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : 'Unable to submit review.',
          code: error instanceof ReviewValidationError || error instanceof ReviewSubmissionError ? error.code : 'review_failed',
          status: error instanceof ReviewSubmissionError ? 403 : error instanceof ReviewValidationError ? 422 : 500,
        };
      }
    });
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet review') ?? operatorSuccess(replayShape(outcome), 202);
    if (!outcome.result.ok) {
      const response = operatorError(outcome.result.code ?? 'review_failed', outcome.result.message, outcome.result.status ?? 500);
      if (outcome.replayed) response.headers.set('x-o8-idempotency-replayed', '1');
      return response;
    }
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit review.';
    return operatorError('review_failed', message, 500, error);
  }
}
