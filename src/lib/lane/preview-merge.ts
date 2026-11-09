/**
 * Merge preview — read-only wrapper around the merge gate (#623).
 *
 * Runs the policy checks plus a changed-file lint preflight and returns a
 * structured `{ checks[], blockers[] }` shape without touching the worktree
 * or issuing a merge commit. Used by the `o8_merge_preview` MCP tool so
 * orchestrator agents can "dry-run" a merge before committing to it.
 *
 * This is intentionally defensive: if the packet has no lane (archived,
 * never spawned, etc.) the preview returns a deterministic "unwired" shape
 * instead of throwing, so callers can distinguish "gate says no" from
 * "gate could not run".
 */

import { laneGit } from '@/lib/lane/lane-git';

import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import type { DirectiveCitationsPreview } from '@/lib/judgment/directive-citations-format';
import { runMergeGate, type MergeGateResult, type MergeViolation } from './merge-gate';
import { runLaneRebaseLint, UNCONFINED_LINT_NOTE, type LaneRebaseLintResult } from './rebase-lint';
import { immutableSnapshotDiffBase, resolveLaneReviewSource } from './review-source';
import { mergePreviewApproval, mergeReviewPrerequisites, type MergeReviewRequirements } from './merge-review-prerequisites';

// ── Public Types ──

/** One row per enforcement check, in the order listed below. */
export type MergeCheckName =
  | 'clean-worktree'
  | 'security-patterns'
  | 'diff-budget'
  | 'untracked-imports'
  | 'self-review-integrity'
  | 'typecheck'
  | 'lint'
  | 'contract-review'
  | 'durable-review'
  | 'file-size-approval'
  | 'merge-policy'
  | 'merge-approval'
  | 'mission-merge-hold'
  | 'session-merge-restriction'
  | 'packet-review'
  | 'pr-only'
  | 'dependency-materialization'
  | 'reviewed-head'
  | 'worktree-branch'
  | 'work-admission'
  | 'merge-order'
  | 'tests';

export type MergeCheckVerdict = 'pass' | 'fail' | 'skipped';

export interface MergeCheckResult {
  name: MergeCheckName;
  verdict: MergeCheckVerdict;
  /** Human-readable detail for failing checks. Empty string when passing. */
  detail?: string;
  /** Concrete command or operator action that clears this check. */
  actions?: string[];
}

/** Shape returned by `buildMergePreview` and by `o8_merge_preview`. */
export interface MergePreviewResult {
  packetId: string;
  /** True when the gate passed — a merge call would proceed past the gate. */
  wouldMerge: boolean;
  checks: MergeCheckResult[];
  /** Short category labels for every block-severity violation. */
  blockers: string[];
  branch: string | null;
  diffBase?: PacketDiffBaseResolution;
  reviewSource?: 'materialized' | 'immutable_snapshot';
  mergeUnavailableReason?: string;
  /** Populated when no lane is bound so the gate could not run. */
  unwired?: boolean;
  /** Advisory rule citations (#2446). Absent when judgment is off; the gate never reads it. */
  directiveCitations?: DirectiveCitationsPreview;
  /** Contract state that approval and merge still need, separate from mechanical checks. */
  reviewPrerequisite?: string;
  reviewRequirements?: MergeReviewRequirements;
}

interface MergePreviewOptions {
  orchestratorApproved?: boolean;
  /** Only the operator repair path may assess a pending gate card without requiring itself. */
  ignorePendingGateApproval?: boolean;
  /** Merge's sibling sequence dispatches each prerequisite individually. */
  skipMergeOrder?: boolean;
  /** Fingerprinting only: the exact owned approval transition proven by spoken-review-guard. */
  reviewResolutionProjection?: { approval: ApprovalRecord; laneStatus: Lane['status'] };
  /** Compute the advisory rule citations (#2446). Only surfaces that show them ask; default off, no git, no import. */
  directiveCitations?: boolean;
}

// ── Check-name mapping ──

const CATEGORY_TO_CHECK: Record<MergeViolation['category'], MergeCheckName> = {
  security: 'security-patterns',
  budget: 'diff-budget',
  integrity: 'self-review-integrity',
};

const ALL_CHECKS: MergeCheckName[] = [
  'clean-worktree',
  'security-patterns',
  'diff-budget',
  'untracked-imports',
  'self-review-integrity',
  'typecheck',
  'lint',
];

const POST_REBASE_CHECKS = new Set<MergeCheckName>(['typecheck', 'lint']);

// ── Shape translation ──

/**
 * Map a `MergeGateResult` into the structured preview shape.
 * Every check in `ALL_CHECKS` appears with a pass, fail, or skipped verdict.
 */
export function buildCheckList(
  result: MergeGateResult,
  verificationChecks: MergeCheckResult[] = [],
): MergeCheckResult[] {
  const firstViolationByCheck = new Map<MergeCheckName, MergeViolation>();
  for (const violation of result.violations) {
    if (violation.severity !== 'block') continue;
    // Integrity category covers both untracked-imports and self-review.
    // Disambiguate by label since both map to different check names.
    const check = resolveCheckName(violation);
    if (!firstViolationByCheck.has(check)) {
      firstViolationByCheck.set(check, violation);
    }
  }

  const verificationByName = new Map(verificationChecks.map((check) => [check.name, check]));

  return ALL_CHECKS.map((name) => {
    const verification = verificationByName.get(name);
    if (verification) return verification;
    if (POST_REBASE_CHECKS.has(name)) {
      return {
        name,
        verdict: 'skipped' as const,
        detail: 'Runs after rebase during approve_and_merge.',
      };
    }
    const violation = firstViolationByCheck.get(name);
    if (violation) {
      return { name, verdict: 'fail' as const, detail: violation.detail };
    }
    return { name, verdict: 'pass' as const };
  });
}

function resolveCheckName(violation: MergeViolation): MergeCheckName {
  if (violation.category !== 'integrity') {
    return CATEGORY_TO_CHECK[violation.category];
  }
  // Integrity violations come from two checks — the label distinguishes them.
  if (violation.label === 'Untracked imported files') {
    return 'untracked-imports';
  }
  if (violation.label === 'Operator checkout blocks base fast-forward') {
    return 'clean-worktree';
  }
  return 'self-review-integrity';
}

/** Derive a short blocker list from the gate result. Stable order, deduped. */
export function buildBlockerList(
  result: MergeGateResult,
  verificationChecks: MergeCheckResult[] = [],
): string[] {
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const check of buildCheckList(result, verificationChecks)) {
    if (check.verdict !== 'fail') continue;
    if (seen.has(check.name)) continue;
    seen.add(check.name);
    blockers.push(check.name);
  }
  return blockers;
}


/** Appends a card line to a check's detail. */
export function withCheckNote(detail: string | undefined, note: string | false | undefined): string | undefined {
  return [detail, note].filter(Boolean).join('\n') || undefined;
}

/** The lint row of the merge card; it says plainly when lint ran without the sandbox. */
export function lintPreviewCheck(result: LaneRebaseLintResult): MergeCheckResult {
  const note = result.unconfined && UNCONFINED_LINT_NOTE;
  if (!result.ok) return { name: 'lint', verdict: 'fail', detail: withCheckNote(result.output, note) };
  if (result.skipped) return { name: 'lint', verdict: 'skipped', detail: withCheckNote(result.skipped, note) };
  const detail = withCheckNote(result.detail, note);
  return { name: 'lint', verdict: 'pass', ...(detail ? { detail } : {}) };
}

// ── Preview runner ──

function hasApprovedOrchestratorReview(packetId: string): boolean {
  const mission = readOrchestratorControlPlaneState();
  return mission.packets.find((packet) => packet.id === packetId)?.review?.approved === true;
}

async function readDirtyWorktreeDetail(cwd: string, repoPath: string): Promise<string | null> {
  try {
    const output = (await laneGit(cwd, repoPath, ['status', '--porcelain'], {
      timeout: 5000, maxBuffer: 1024 * 1024,
    })).stdout.trim();
    if (!output) return null;
    const lines = output.split('\n').slice(0, 5);
    const suffix = output.split('\n').length > lines.length ? '\n...' : '';
    return `Uncommitted worktree changes are still present:\n${lines.join('\n')}${suffix}`;
  } catch {
    return 'Unable to verify that the worktree is clean.';
  }
}

/**
 * Run the merge gate against a lane and return the structured preview shape.
 * Callers already holding a `Lane` reference should use this path — it
 * avoids the extra `findLatestLaneByPacket` lookup.
 */
export async function buildPreviewForLane(
  lane: Lane,
  packetId: string,
  options: MergePreviewOptions = {},
): Promise<MergePreviewResult> {
  const reviewSource = await resolveLaneReviewSource(lane);
  if (reviewSource.kind === 'immutable_snapshot') {
    return {
      packetId,
      wouldMerge: false,
      checks: [...ALL_CHECKS.map((name) => ({ name, verdict: 'skipped' as const })),
        { name: 'worktree-branch', verdict: 'fail', actions: [`Run o8 packet restore ${packetId}, then rerun verification and merge-preview.`] }],
      blockers: ['workspace-parked'],
      branch: reviewSource.branch,
      diffBase: immutableSnapshotDiffBase(reviewSource, lane.baseBranch),
      reviewSource: reviewSource.kind,
      mergeUnavailableReason: 'Restore the parked workspace and rerun verification before merge.',
    };
  }
  const resolvedLane = lane.worktreePath === reviewSource.cwd
    ? lane
    : { ...lane, worktreePath: reviewSource.cwd };
  const orchestratorApproved = options.orchestratorApproved ?? hasApprovedOrchestratorReview(packetId);
  const gateResult = await runMergeGate(resolvedLane, undefined, orchestratorApproved);
  const baseRef = gateResult.diffBase?.mergeBase
    ?? gateResult.diffBase?.comparisonRef
    ?? lane.baseBranch;
  const lint = await runLaneRebaseLint({
    cwd: reviewSource.cwd,
    gitRepoPath: lane.repoPath,
    baseRef,
    actualBranch: lane.branch ?? 'packet branch',
    logPrefix: 'merge-preview',
  });
  const verificationChecks: MergeCheckResult[] = [
    {
      name: 'typecheck',
      verdict: 'skipped',
      detail: 'Runs after rebase during approve_and_merge.',
    },
    lintPreviewCheck(lint),
  ];
  // An approved operator merge card is consumed by the real merge as actor:user.
  // Security/budget/integrity policy findings are acknowledged by that card.
  const remainingViolations = gateResult.violations.filter(violation => violation.label === 'Operator checkout blocks base fast-forward');
  const effectiveGate = mergePreviewApproval(lane, false, options.reviewResolutionProjection?.approval).actor === 'user'
    ? { ...gateResult, passed: remainingViolations.every(violation => violation.severity !== 'block'), violations: remainingViolations } : gateResult;
  const checks = buildCheckList(effectiveGate, verificationChecks);
  const { resolveMergeTestReplayEnabledSync } = await import('@/lib/operator/defaults');
  if (resolveMergeTestReplayEnabledSync()) checks.push({ name: 'tests', verdict: 'skipped',
    detail: 'Configured test replay runs against the rebased integration state during merge.',
    actions: ['Pass the configured test replay against the rebased integration state before publication.'] });
  let packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    const { findMissionRegistryEntryByPacketId } = await import('@/lib/orchestrator/mission-registry');
    packet = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
  }
  let reviewPrerequisite: string | undefined;
  const prerequisites = await mergeReviewPrerequisites(resolvedLane, packet, gateResult, options.ignorePendingGateApproval, options.reviewResolutionProjection?.approval);
  checks.push(...prerequisites.checks);
  let contractReviewReady = true;
  if (packet?.taskContractRequired && packet.taskContract) {
    const assessment = prerequisites.review;
    contractReviewReady = assessment.contractCoverage?.status === 'passed';
    reviewPrerequisite = contractReviewReady
      ? 'The current HEAD has an approved review with task-contract evidence.'
      : `An approved review at the current HEAD still needs file or non-file requirement coverage and any process-constraint evidence. ${assessment.contractCoverage?.reason ?? assessment.reason}`;
    checks.push({
      name: 'contract-review',
      verdict: contractReviewReady ? 'pass' : 'fail',
      detail: reviewPrerequisite,
      actions: prerequisites.contractActions,
    });
  } else if (packet?.taskContractRequired && !packet.taskContract) {
    if (packet.taskContractSource === 'default') {
      const assessment = prerequisites.review;
      contractReviewReady = assessment.contractCoverage?.status === 'waived';
      reviewPrerequisite = contractReviewReady
        ? assessment.contractCoverage?.reason ?? 'The operator waived missing-contract coverage for this reviewed HEAD.'
        : `The runtime-default task contract was not captured. Requirement coverage is unproven; an explicit operator waiver at the current HEAD is required. ${assessment.reason}`;
      checks.push({ name: 'contract-review', verdict: contractReviewReady ? 'pass' : 'fail', detail: reviewPrerequisite, actions: prerequisites.contractActions });
    } else {
      contractReviewReady = false;
      reviewPrerequisite = 'The explicitly required task contract is missing; restore or capture it before approval.';
      checks.push({ name: 'contract-review', verdict: 'fail', detail: reviewPrerequisite, actions: prerequisites.contractActions });
    }
  }
  const dirtyDetail = await readDirtyWorktreeDetail(reviewSource.cwd, lane.repoPath);
  if (dirtyDetail) {
    const cleanCheck = checks.find((check) => check.name === 'clean-worktree');
    if (cleanCheck) {
      cleanCheck.verdict = 'fail';
      cleanCheck.detail = dirtyDetail;
    }
  }
  const { mergeRuntimePrerequisites } = await import('./merge-runtime-prerequisites');
  checks.push(...await mergeRuntimePrerequisites(resolvedLane));
  if (!options.skipMergeOrder) {
    const { mergeOrderPrerequisites } = await import('./merge-order-prerequisites');
    checks.push(...await mergeOrderPrerequisites(packetId, options.reviewResolutionProjection?.laneStatus));
  }
  for (const check of checks) {
    if (check.verdict !== 'fail' || check.actions?.length) continue;
    check.actions = check.name === 'clean-worktree'
      ? check.detail?.includes('checked out in another worktree')
        ? [`Run git worktree list; in the checkout holding ${lane.baseBranch}, switch to another existing branch or detach HEAD, then rerun merge-preview.`]
        : ['In the affected checkout, commit and review the listed changes, or remove only disposable uncommitted changes; then rerun merge-preview.']
      : check.name === 'lint'
        ? ['Fix the reported changed-file lint errors, commit and review the new HEAD, then rerun merge-preview.']
        : ['Resolve the reported security, budget or integrity findings, commit and review the new HEAD; an intentional policy override requires operator inspection and approval of the merge gate card.'];
  }
  const blockers = [...new Set(checks.filter(check => check.verdict === 'fail').map(check => check.name))];
  const directiveCitations = options.directiveCitations
    ? await (await import('@/lib/judgment/directive-citations')).directiveCitationsForPreview(lane, packetId, reviewSource.cwd, baseRef)
    : undefined;
  return {
    packetId,
    wouldMerge: blockers.length === 0,
    checks,
    blockers,
    branch: lane.branch ?? null,
    diffBase: gateResult.diffBase,
    reviewSource: reviewSource.kind,
    ...(reviewPrerequisite ? { reviewPrerequisite } : {}),
    reviewRequirements: prerequisites.requirements,
    ...(directiveCitations ? { directiveCitations } : {}),
  };
}

/**
 * Run the merge gate for a packet id and return the preview shape.
 * When the packet has no lane (archived / never spawned) returns a
 * deterministic "unwired" payload so callers can surface it cleanly.
 */
export async function previewPacketMerge(packetId: string): Promise<MergePreviewResult> {
  const lane = findLatestLaneByPacket(packetId);
  if (!lane) {
    return {
      packetId,
      wouldMerge: false,
      checks: ALL_CHECKS.map((name) => ({ name, verdict: 'skipped' as const })),
      blockers: ['no-lane'],
      mergeUnavailableReason: 'Dispatch the packet to create its lane before requesting a merge.',
      branch: null,
      unwired: true,
    };
  }
  return buildPreviewForLane(lane, packetId, { directiveCitations: true });
}
