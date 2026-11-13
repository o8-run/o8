import { resolveGitBinary } from '@/lib/git/binary';
import type { ApprovalRecord, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { allFindingsResolved } from '@/lib/approvals/orchestrator-review';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import type { Lane } from '@/lib/lane/types';
import type { ContractCoverageResult } from '@/lib/orchestrator/task-contract-coverage';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import { resolvePacketTaskContractGate } from '@/lib/lane/task-contract-gate';

export interface DurableReviewAssessment {
  approved: boolean;
  diffBudgetWaived: boolean;
  highConfidence: boolean;
  approvalId: string | null;
  reason: string;
  secondPassPending?: boolean;
  /**
   * Deterministic per-requirement coverage verdict. Present whenever a sealed
   * contract applied; `null` for legacy packets. Merge preview surfaces
   * `missingRequirementIds` so a targeted repair knows exactly what to fix.
   */
  contractCoverage?: ContractCoverageResult | null;
}

function carriesAcceptedFinding(approval: ApprovalRecord): boolean {
  const findings = approval.args?.findings;
  return Array.isArray(findings) && findings.some((finding) => (
    finding !== null
    && typeof finding === 'object'
    && (finding as { resolution?: unknown }).resolution === 'accepted'
    && (finding as { severity?: unknown }).severity !== 'note'
  ));
}

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  if (typeof argsHead === 'string') {
    return argsHead;
  }

  return approval.metadata?.['Reviewed HEAD'];
}

function reviewVerdictTimestamp(approval: ApprovalRecord): number {
  for (let index = approval.audit.length - 1; index >= 0; index -= 1) {
    const event = approval.audit[index];
    if (event?.type === 'orchestrator_review') return event.timestamp;
  }
  return approval.updatedAt;
}

function reviewFindingsAreResolved(approval: ApprovalRecord): boolean {
  const findings = approval.args?.findings;
  if (findings === undefined) return true;
  if (!Array.isArray(findings)) return false;
  return allFindingsResolved(findings as OrchestratorReviewFinding[]);
}


/**
 * Resolve the sealed contract and the review's recorded evidence, then run the
 * deterministic gate.
 *
 * A missing required contract blocks approval unless the current-HEAD review
 * carries an explicit operator waiver for a runtime-default contract. An
 * explicitly armed contract is never waivable through that path.
 */
async function assessContractCoverage(
  lane: Pick<Lane, 'id' | 'packetId' | 'worktreePath' | 'repoPath' | 'baseBranch' | 'runtime'>,
  approval: ApprovalRecord,
  reviewedHeadSha: string,
): Promise<ContractCoverageResult | null> {
  if (!lane.packetId) return null;

  let contract: PacketTaskContract | null = null;
  let enforceCoverage = false;
  let missingDefaultContract = false;
  try {
    const gate = await resolvePacketTaskContractGate({ lane });
    if (!gate.packetFound) return null;
    contract = gate.taskContract;
    enforceCoverage = gate.enforceCoverage;
    missingDefaultContract = gate.missingDefaultContract;
  } catch (error) {
    // A packet binding exists but its contract requirement could not be read.
    // Treating that as legacy would let an unverifiable packet merge, so this
    // fails closed. Genuine legacy packets are the `!packet` case above, which
    // returns null and is judged exactly as before.
    console.error(
      `[contract-coverage] control-plane state unreadable for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      status: 'failed',
      reason: 'Packet state could not be read, so contract coverage is unverifiable.',
      contractVersion: null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [],
    };
  }
  if (!enforceCoverage) return null;

  if (missingDefaultContract) {
    const waiverReason = approval.args?.missingContractWaiverReason;
    const normalizedWaiverReason = typeof waiverReason === 'string' ? waiverReason.trim() : '';
    const hasOperatorReceipt = normalizedWaiverReason.length > 0
      && approval.audit.some((event) => event.type === 'updated'
        && event.actor === 'desktop'
        && event.reviewedHeadSha === reviewedHeadSha
        && event.rawText === normalizedWaiverReason);
    if (hasOperatorReceipt) {
      return {
        status: 'waived',
        reason: `The runtime-default contract was missing. An operator explicitly waived requirement coverage for this reviewed HEAD: ${normalizedWaiverReason}`,
        contractVersion: null,
        reviewedHeadSha,
        checks: [],
        missingRequirementIds: [],
      };
    }
    return {
      status: 'failed',
      reason: 'The runtime-default contract was missing. Requirement coverage is unproven; an operator must recover the contract or explicitly waive this state for the current HEAD.',
      contractVersion: null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [],
    };
  }

  try {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');
    const cwd = lane.worktreePath || lane.repoPath || '';
    const changed = await listChangedPathsForCoverage(lane, cwd, reviewedHeadSha);
    if (!changed.resolved) {
      return {
        status: 'failed',
        reason: 'The packet diff base could not be resolved, so coverage could not be checked against the full change.',
        contractVersion: contract?.version ?? null,
        reviewedHeadSha,
        checks: [],
        missingRequirementIds: [
          ...(contract?.requirements.map((requirement) => requirement.id) ?? []),
          ...(contract?.processConstraints?.map((constraint) => constraint.id) ?? []),
        ],
      };
    }
    return evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approval.args),
      reviewedHeadSha,
      changedPaths: changed.paths,
      repositoryPaths: changed.repositoryPaths,
    });
  } catch (error) {
    console.error(
      `[contract-coverage] evaluation failed for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      status: 'failed',
      reason: 'Contract coverage could not be evaluated, and this packet requires it.',
      contractVersion: contract?.version ?? null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [
        ...(contract?.requirements.map((requirement) => requirement.id) ?? []),
        ...(contract?.processConstraints?.map((constraint) => constraint.id) ?? []),
      ],
    };
  }
}

/**
 * Paths the packet changed, resolved against the packet's real diff base rather
 * than the previous commit.
 *
 * `HEAD~1..HEAD` was wrong: a multi-commit packet that touched a file in an
 * earlier commit would have its evidence rejected as "not in the change", which
 * fails a correct review for a bookkeeping reason. This reuses the same base
 * resolution merge preview uses, so the gate and the preview agree on what the
 * packet actually changed.
 */
export async function listChangedPathsForCoverage(
  lane: Pick<Lane, 'id' | 'baseBranch'>,
  cwd: string,
  headSha: string,
): Promise<{ paths: string[]; repositoryPaths: string[]; resolved: boolean }> {
  if (!cwd) return { paths: [], repositoryPaths: [], resolved: false };
  const { execFile } = await import('@/lib/providers/child-process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const collect = async (args: string[]): Promise<string[] | null> => {
    try {
      const { stdout } = await run(resolveGitBinary(), args, { windowsHide: true, cwd, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  let comparisonRef: string | null = null;
  try {
    const resolution = await resolveLaneAttributionBase(lane, cwd, headSha);
    comparisonRef = resolution.mergeBase ?? resolution.comparisonRef ?? null;
  } catch {
    comparisonRef = null;
  }

  // The reviewed commit range only. Uncommitted edits are not part of the
  // commit the review is pinned to, so they cannot satisfy its evidence (#2254).
  const committed = comparisonRef ? await collect(['diff', '--name-only', `${comparisonRef}..${headSha}`]) : null;

  // If we could not establish the packet's range, say so rather than silently
  // grading against a narrower set of files than the packet really touched.
  const repositoryPaths = await collect(['ls-tree', '-r', '--name-only', headSha]);
  if (committed === null || repositoryPaths === null) return { paths: [], repositoryPaths: [], resolved: false };
  return { paths: committed, repositoryPaths, resolved: true };
}

const UNCOMMITTED_PATHS_SHOWN = 10;

/**
 * Paths with uncommitted changes (tracked or untracked, respecting ignores).
 * Returns null when git cannot answer, so callers fail closed.
 */
async function listUncommittedPaths(cwd: string): Promise<string[] | null> {
  const { execFile } = await import('@/lib/providers/child-process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)(
      resolveGitBinary(),
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { windowsHide: true, cwd, maxBuffer: 8 * 1024 * 1024 },
    );
    const entries = stdout.split('\0');
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.length < 4) continue;
      paths.push(entry.slice(3));
      // Renames and copies carry their source path as the next entry.
      if (entry[0] === 'R' || entry[0] === 'C') index += 1;
    }
    return paths;
  } catch {
    return null;
  }
}

function formatUncommittedPaths(paths: string[]): string {
  const shown = paths.slice(0, UNCOMMITTED_PATHS_SHOWN).join(', ');
  const more = paths.length - UNCOMMITTED_PATHS_SHOWN;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

// Durable approved-review reader. This is the only signal that authorizes a
// non-user merge or PR action to skip the operator approval card.
export async function assessDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath' | 'baseBranch' | 'runtime'>,
  candidateSha?: string,
): Promise<DurableReviewAssessment> {
  try {
    const [{ listApprovalsForContext }, { normalizeHeadSha, readHeadSha }] = await Promise.all([
      import('@/lib/approvals/store'),
      import('@/lib/lane/head-sha-lock'),
    ]);
    const approvals = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    });
    const completedReviews = approvals.filter(
      (approval) => (
        approval.toolName === 'orchestrator_review'
        && approval.args?.reviewSuperseded !== true
        && typeof approval.args?.reviewTurnId === 'string'
        && approval.args.reviewTurnOutcome === 'completed'
      ),
    );
    if (completedReviews.length === 0) {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'No durable approved AI review exists.' };
    }

    const cwd = lane.worktreePath || lane.repoPath;
    if (!cwd) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Lane has no reviewable repository path.' };

    let currentHead: string | undefined;
    try {
      currentHead = normalizeHeadSha(candidateSha ?? await readHeadSha(cwd, lane.repoPath));
    } catch {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD could not be verified against the AI review.' };
    }
    if (!currentHead) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD is unavailable.' };

    const reviewsByRecency = completedReviews.slice().sort((left, right) => (
      reviewVerdictTimestamp(right) - reviewVerdictTimestamp(left)
      || right.updatedAt - left.updatedAt
      || right.id.localeCompare(left.id)
    ));
    const matchingHead = reviewsByRecency.filter((approval) => {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(approval))?.toLowerCase();
      return reviewed !== undefined && reviewed === currentHead.toLowerCase();
    });
    const latestReview = matchingHead[0];
    if (!latestReview) {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(reviewsByRecency[0]!));
      return {
        approved: false,
        diffBudgetWaived: false,
        highConfidence: false,
        approvalId: null,
        reason: reviewed
          ? `Review pinned to ${reviewed} but current HEAD is ${currentHead}.`
          : 'The latest AI review is not pinned to the current HEAD.',
      };
    }
    const diffBudgetWaived = latestReview ? carriesAcceptedFinding(latestReview) : false;
    const reviewAuthorized = latestReview.status === 'approved'
      && latestReview.args?.approved !== false && reviewFindingsAreResolved(latestReview);
    // Coverage is independent of pending passes and dirty edits. Report it even
    // when another prerequisite withholds the review's merge authorization.
    const coverage = reviewAuthorized ? await assessContractCoverage(lane, latestReview, currentHead) : null;
    if (
      latestReview.status === 'approved'
      && latestReview.args?.approved !== false
      && reviewFindingsAreResolved(latestReview)
      && latestReview.args?.requiresSecondPass === true
      && latestReview.args?.secondPassAgreed !== true
    ) {
      return {
        approved: false,
        diffBudgetWaived,
        highConfidence: false,
        approvalId: null,
        reason: 'The latest AI review matches the current HEAD and is awaiting its required second pass.',
        secondPassPending: true,
        contractCoverage: coverage,
      };
    }
    const matching = latestReview
      && latestReview.status === 'approved'
      && latestReview.args?.approved !== false
      && reviewFindingsAreResolved(latestReview)
      ? latestReview
      : undefined;
    if (!matching) {
      return { approved: false, diffBudgetWaived, highConfidence: false, approvalId: null, reason: 'The latest AI review does not authorize the current HEAD.' };
    }

    // The review approves the commit at its pinned HEAD and nothing else. Edits
    // left in the worktree after that commit would be auto-committed into the
    // publication, so they withhold authorization until committed and reviewed.
    const uncommitted = await listUncommittedPaths(cwd);
    if (uncommitted === null) {
      return { approved: false, diffBudgetWaived, highConfidence: false, approvalId: null, contractCoverage: coverage, reason: 'Uncommitted worktree changes could not be checked against the reviewed HEAD.' };
    }
    if (uncommitted.length > 0) {
      return {
        approved: false,
        diffBudgetWaived,
        highConfidence: false,
        approvalId: null,
        reason: `Uncommitted edits are not covered by the AI review of ${currentHead}: ${formatUncommittedPaths(uncommitted)}. Commit them and review again.`,
        contractCoverage: coverage,
      };
    }

    // Coverage gate: an approved-looking review cannot authorize a merge unless
    // every sealed requirement has machine-checked production-path evidence at
    // the HEAD being approved. Legacy packets return not-applicable and pass.
    if (coverage && coverage.status === 'failed') {
      return {
        approved: false,
        diffBudgetWaived,
        highConfidence: false,
        approvalId: null,
        reason: `Task-contract coverage failed. ${coverage.reason}`,
        contractCoverage: coverage,
      };
    }

    const highConfidence = matching.risk === 'low'
      && typeof matching.args?.parseWarning !== 'string';
    return {
      approved: true,
      contractCoverage: coverage,
      diffBudgetWaived,
      highConfidence,
      approvalId: matching.id,
      reason: highConfidence
        ? 'Current HEAD has a clean, finding-free AI review.'
        : 'The AI review has findings or parser uncertainty.',
    };
  } catch {
    return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Durable AI review lookup failed.' };
  }
}

export async function supersedeDurableApprovedReviews(packetId: string, reason: string): Promise<number> {
  try {
    const { supersedeOrchestratorReviewApprovals } = await import('@/lib/approvals/store');
    return supersedeOrchestratorReviewApprovals(packetId, reason);
  } catch (error) {
    console.error(
      `[durable-review] Could not supersede approved reviews for packet ${packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function hasDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath' | 'baseBranch'>,
): Promise<boolean> {
  const runtime = Reflect.get(lane, 'runtime') as Lane['runtime'] | undefined;
  if (!runtime) return false;
  return (await assessDurableApprovedReview({
    ...lane,
    runtime,
  })).approved;
}
