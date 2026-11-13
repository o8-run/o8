import { checkReviewRunPolicy, reviewRunPolicy } from './review-run-policy';
import type { DurableReviewAssessment } from '@/lib/lane/durable-review-approval';
import type { OversizedChangedFile } from '@/lib/lane/file-size-policy';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { MergeGateResult } from '@/lib/lane/merge-gate';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { findLatestMergeApproval } from './merge-approval-context';
import { isPacketMergeHeld } from './merge-hold';
import { requirementFilePaths, requirementUsesFile } from '@/lib/orchestrator/task-contract-coverage';

export interface MergeReviewRequirements {
  contractKind: 'none' | 'default-captured' | 'default-missing' | 'armed';
  contractVersion: number | null;
  captured: boolean;
  requirementIds: string[];
  processConstraintIds: string[];
  oversizedFiles: OversizedChangedFile[];
  review: Pick<DurableReviewAssessment, 'approved' | 'approvalId' | 'reason'> & { secondPassPending: boolean };
  actions: string[];
}

/** Matches approveAndMergeSinglePacket's effective actor, including approved size cards. */
export function mergePreviewApproval(lane: Lane, ignorePendingGateApproval = false, projection?: ApprovalRecord) {
  const latest = lane.packetId ? findLatestMergeApproval(lane.packetId, lane.id, lane.sessionKey) : null;
  const approval = latest?.id === projection?.id && projection?.continuation?.kind === 'lane'
    && projection.continuation.laneId === lane.id && projection.continuation.verb === 'merge' ? projection : latest;
  const held = isPacketMergeHeld(lane.packetId);
  const operatorClearingGate = ignorePendingGateApproval && approval?.status === 'pending' && approval.policyRuleId === 'merge-gate-violation';
  return { approval, held, actor: (approval?.status === 'approved' || operatorClearingGate) && !held ? 'user' as const : 'orchestrator' as const };
}

function shellArgument(value: string): string {
  return /^[\w./=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Read merge's review, size, policy and hold gates without creating approval cards. */
export async function mergeReviewPrerequisites(lane: Lane, packet: OrchestratorPacket | undefined, gate: MergeGateResult, ignorePendingGateApproval = false, projection?: ApprovalRecord) {
  const [{ assessDurableApprovedReview, listChangedPathsForCoverage }, { formatOversizedFiles, getOversizedChangedFilesForLane },
    { evaluatePolicy }, { buildLanePolicyContext }, { readHeadSha }, { resolveRequireApprovalSync }, { decideSurfaceMerge }] = await Promise.all([
    import('@/lib/lane/durable-review-approval'), import('@/lib/lane/file-size-policy'),
    import('@/lib/approvals/policies'), import('@/lib/lane/commands-approval'), import('@/lib/lane/head-sha-lock'),
    import('@/lib/operator/defaults'), import('@/lib/lane/surface-merge-decision'),
  ]);
  const { approval, held, actor } = mergePreviewApproval(lane, ignorePendingGateApproval, projection);
  const review = await assessDurableApprovedReview(lane);
  const head = await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath);
  const packetId = shellArgument(lane.packetId ?? lane.id);
  const mergeCommand = `o8 packet approve-merge ${packetId} --expected-sha ${head}`;
  const reviewCommand = `o8 packet review ${packetId} --approve --expected-sha ${head}`;
  const cardAction = approval?.status === 'pending'
    ? `Have the operator inspect and approve card ${approval.id} (${approval.title}) in Approvals.`
    : `Run ${mergeCommand} to create the approval card, then have the operator inspect and approve it in Approvals.`;
  const sizeAction = approval?.status === 'pending' ? cardAction
    : `Run ${mergeCommand} to create the "Override file size limit" card, then have the operator inspect and approve it in Approvals.`;
  const oversizedFiles = await getOversizedChangedFilesForLane(lane);
  const sizePolicy = oversizedFiles.length ? evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
    orchestratorReviewed: packet?.review?.approved === true || review.diffBudgetWaived, fileSizeLimitExceeded: true,
  })) : null;
  const sizeApprovalRequired = actor !== 'user' && sizePolicy?.requiresApproval === true;
  const required = packet?.taskContractRequired === true;
  const contract = packet?.taskContract;
  const contractKind: MergeReviewRequirements['contractKind'] = !required ? 'none'
    : packet?.taskContractSource === 'default' ? contract ? 'default-captured' : 'default-missing' : 'armed';
  const contractActions: string[] = [];
  if (required && contract) {
    const files = await listChangedPathsForCoverage(lane, lane.worktreePath || lane.repoPath, head);
    const flags = [`--contract-version ${contract.version}`];
    for (const requirement of contract.requirements) {
      const citedFile = requirementFilePaths(requirement.productionPath, files.paths)[0]
        ?? requirementFilePaths(requirement.productionPath, files.repositoryPaths)[0]
        ?? requirement.productionPath.split(/\s*(?:->|→|:|#)\s*/)[0];
      flags.push(requirementUsesFile(requirement.productionPath, files.repositoryPaths)
        ? `--coverage ${shellArgument(`${requirement.id}=${citedFile}`)}`
        : `--requirement-evidence ${shellArgument(`${requirement.id}=command:<observed reference>`)}`);
    }
    for (const constraint of contract.processConstraints ?? []) {
      flags.push(`--process-evidence ${shellArgument(`${constraint.id}=command:<observed reference>`)}`);
    }
    contractActions.push(`Run ${reviewCommand} ${flags.join(' ')}. Replace observation references with the actual transcript, lane-event or command evidence from the review.`);
  } else if (contractKind === 'default-missing') {
    contractActions.push(`Recover the runtime-default contract, or have the operator run ${reviewCommand} --waive-missing-contract '<bounded reason for accepting unproven coverage>'.`);
  } else if (required) {
    contractActions.push('Restore or capture the explicitly armed task contract before review; a missing-contract waiver cannot clear this state.');
  }
  const reviewActions = review.secondPassPending
    ? [`Complete the required blind second-pass AI review at HEAD ${head}; inspect it with o8 packet info ${packetId}. The second reviewer must agree before an automatic merge.`]
    : [`Resolve the AI review findings and record an approved review at HEAD ${head} using ${reviewCommand}.`, ...contractActions];
  const runGate = await checkReviewRunPolicy(lane);
  const checks: MergeCheckResult[] = [
    ...(reviewRunPolicy().enabled ? [{ name: runGate.ok ? 'review-run-evidence' as const : runGate.code, verdict: runGate.ok ? 'pass' as const : 'fail' as const, detail: runGate.message,
      actions: ['Exercise the exact reviewed commit and submit structured runEvidence; prose does not count.'] }] : []),
    { name: 'durable-review', verdict: actor === 'user' || review.approved ? 'pass' : 'fail', detail: review.reason, actions: reviewActions },
    { name: 'file-size-approval', verdict: sizeApprovalRequired ? 'fail' : 'pass',
      detail: oversizedFiles.length ? `${formatOversizedFiles(oversizedFiles)}. ${sizeApprovalRequired ? 'Operator size approval is required.' : 'Size policy is satisfied.'}` : 'No oversized changed files require approval.',
      actions: [sizeAction, 'Alternatively reduce the listed files below the size threshold, commit and review the new HEAD.'] },
  ];
  // Evaluate the eventual policy using an approved review: otherwise an early
  // missing review would conceal an always/surface approval needed afterwards.
  const surface = actor !== 'user' && resolveRequireApprovalSync() === 'surface' ? await decideSurfaceMerge(lane, gate) : null;
  const policy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
    hasApprovedReview: true, orchestratorReviewed: true, gatePassed: gate.passed,
    surfaceReviewRequired: surface?.surface === true,
  }));
  checks.push({ name: 'merge-policy', verdict: actor !== 'user' && policy.requiresApproval ? 'fail' : 'pass',
    detail: [policy.reason, ...(surface?.reasons ?? [])].join(' '), actions: [cardAction] });
  if (approval?.status === 'pending' && approval.policyRuleId !== 'file_size_limit'
    && !(ignorePendingGateApproval && approval.policyRuleId === 'merge-gate-violation')) {
    checks.push({ name: 'merge-approval', verdict: 'fail', detail: `Pending ${approval.title} (${approval.id}).`, actions: [cardAction] });
  }
  checks.push({ name: 'mission-merge-hold', verdict: actor !== 'user' && held ? 'fail' : 'pass',
    detail: held ? 'This mission holds merges for the operator.' : 'The mission does not hold merges.', actions: [cardAction] });
  const { assertSessionMergeAllowed, packetRuleThread } = await import('@/lib/orchestrator/session-merge-restriction');
  try {
    assertSessionMergeAllowed(lane.packetId);
    checks.push({ name: 'session-merge-restriction', verdict: 'pass' });
  } catch (error) {
    const { listSessionRules } = await import('@/lib/db/session-rules-store');
    let action = 'Have the operator restore the packet parent identity and remove its no-merge session rule before retrying.';
    try {
      const thread = packetRuleThread(lane.packetId);
      const ids = thread ? listSessionRules(thread).filter(rule => rule.constraint === 'no_merge').map(rule => rule.id) : [];
      action = `Have the operator remove no-merge rule(s) ${ids.join(', ')} in originating chat ${thread}. Approval cards cannot override session restrictions.`;
    } catch { /* Inconsistent identity remains a refusal. */ }
    checks.push({ name: 'session-merge-restriction', verdict: 'fail', detail: error instanceof Error ? error.message : 'Session restriction is unavailable.', actions: [action] });
  }
  if (packet?.review?.approved === false) {
    checks.push({ name: 'packet-review', verdict: 'fail', detail: 'Packet review is not approved.', actions: reviewActions });
  }
  const { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } = await import('@/lib/lane/dogfood-guard');
  checks.push({ name: 'pr-only', verdict: dogfoodPrOnlyActive() ? 'fail' : 'pass', detail: DOGFOOD_PR_ONLY_NOTE,
    actions: ['Stop the autonomous PR-only loop through its operator control before requesting a direct merge.'] });
  const actions = [...contractActions, ...checks.filter(check => check.verdict === 'fail').flatMap(check => check.actions ?? [])];
  const requirements: MergeReviewRequirements = { contractKind, contractVersion: contract?.version ?? null,
    captured: Boolean(contract), requirementIds: contract?.requirements.map(r => r.id) ?? [],
    processConstraintIds: contract?.processConstraints?.map(c => c.id) ?? [], oversizedFiles,
    review: { approved: review.approved, approvalId: review.approvalId, reason: review.reason, secondPassPending: review.secondPassPending === true },
    actions: [...new Set(actions)] };
  return { review, checks, requirements, contractActions, ready: checks.every(check => check.verdict !== 'fail') };
}
