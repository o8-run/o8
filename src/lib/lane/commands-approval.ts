import { fetchWorkerRun } from '@/lib/worker/runs';
import { fetchWorkerBranch, cleanupRemoteMergeWorktree } from './remote-fetch';
import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import type { ApprovalRisk } from '@/lib/approvals/types';
import { buildPolicyContext } from '@/lib/approvals/policies';
import { startApprovalReferee } from '@/lib/approvals/referee';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { resolveRequireApprovalSync } from '@/lib/operator/defaults';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { parseGitDiff } from '@/lib/worktree/diff-parser';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import { resolvePacketDispatcher } from '@/lib/orchestrator/dispatcher-attribution';
import { assessDurableApprovedReview } from './durable-review-approval';
import { preserveAndRecordLaneRecovery } from './merge-recovery';
import { riskForChangedPaths } from './changed-path-risk';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import { readHeadSha } from '@/lib/lane/head-sha-lock';

const RECOVERABLE_MERGE_FAILURE_POLICIES = new Set([
  'merge-gate-violation',
  'rebase_conflict_escalation',
  'fast_forward_failure_escalation',
]);

type DiffLane = Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'> & Partial<Pick<Lane, 'id'>>;

async function readDiffForLane(lane: DiffLane) {
  const cwd = lane.worktreePath || lane.repoPath;

  if (lane.id) {
    const headSha = await readHeadSha(cwd, lane.repoPath);
    const diffBase = await resolveLaneAttributionBase({ id: lane.id, baseBranch: lane.baseBranch }, cwd, headSha,
      args => laneGit(cwd, lane.repoPath, args));
    const base = diffBase.mergeBase ?? diffBase.comparisonRef;
    const result = await laneGit(cwd, lane.repoPath, ['diff', `${base}...${headSha}`, '--no-color'], { maxBuffer: 10 * 1024 * 1024 });
    return { rawDiff: result.stdout.trim(), diffBase, headSha };
  }

  try {
    const result = await laneGit(cwd, lane.repoPath, ['diff', `${lane.baseBranch}...HEAD`, '--no-color'], { maxBuffer: 10 * 1024 * 1024 });
    return { rawDiff: result.stdout.trim(), diffBase: null, headSha: undefined };
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    try {
      const fallback = await laneGit(cwd, lane.repoPath, ['diff', 'HEAD~1', '--no-color'], { maxBuffer: 10 * 1024 * 1024 });
      return { rawDiff: fallback.stdout.trim(), diffBase: null, headSha: undefined };
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      return { rawDiff: '', diffBase: null, headSha: undefined };
    }
  }
}

async function readMergeApprovalDiff(lane: Lane) {
  if ((lane.runtime as string) !== 'remote-customer') return readDiffForLane(lane);
  const run = fetchWorkerRun(lane.id);
  if (!run?.remoteBranch) throw new Error('The remote source branch is unavailable. Return to review.');
  const fetched = await fetchWorkerBranch(lane.repoPath, run.remoteBranch, `approval-${run.id}`);
  if (!fetched.ok) throw new Error(fetched.note);
  try { return await readDiffForLane({ ...lane, worktreePath: fetched.tempWorktreePath }); }
  finally { await cleanupRemoteMergeWorktree(lane.repoPath, fetched.tempWorktreePath); }
}

export async function getDiffForLane(lane: DiffLane) {
  return (await readDiffForLane(lane)).rawDiff;
}

async function recordReviewLessonsForApproval(
  approvalId: string,
  lane: Lane,
  reviewSummary: string | undefined,
  files: ReturnType<typeof parseGitDiff>,
) {
  const summary = reviewSummary?.trim();
  if (!summary) {
    return;
  }

  const findings = extractReviewFindings(summary);
  const patterns = extractReviewPatterns(summary, findings);
  const conflictZones = buildConflictZonesFromDiffFiles(files);
  const approved = /\b(approve|approved|looks correct|ready to merge|ship it)\b/i.test(summary)
    ? true
    : /\b(request changes|reject|den(y|ied)|not ready|blocked)\b/i.test(summary)
      ? false
      : findings.length === 0;

  recordApprovalAudit(approvalId, 'orchestrator_review', 'orchestrator', summary, {
    findings: findings.length > 0 ? findings : undefined,
    reviewer: 'orchestrator',
    approved,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  });

  if (!lane.packetId || !lane.sessionKey) {
    return;
  }

  try {
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
  } catch (error) {
    console.error(`[context-relay] Failed to refresh reviewed packet context for ${lane.packetId}:`, error);
  }
}

export function buildLanePolicyContext(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  verb: 'create_pr' | 'merge',
  actor: LaneEventActor,
  opts?: {
    orchestratorReviewed?: boolean;
    fileSizeLimitExceeded?: boolean;
    gatePassed?: boolean;
    hasApprovedReview?: boolean;
    surfaceReviewRequired?: boolean;
  },
) {
  const requireApproval = resolveRequireApprovalSync();
  const autoReview = actor === 'orchestrator' && opts?.hasApprovedReview === true;
  return buildPolicyContext('lane_command', {
    verb,
    laneId: lane.id,
    autoReview,
    fileSizeLimitExceeded: opts?.fileSizeLimitExceeded === true,
    surfaceReviewRequired: opts?.surfaceReviewRequired === true,
  }, {
    workspacePath: lane.repoPath,
    requireApproval,
  });
}

export async function createLaneActionApproval(
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
    expectedHeadSha?: string;
    reviewSummary?: string;
    title: string;
    description: string;
    summary: string;
    risk: ApprovalRisk;
    /** Merge-mechanics failures: rate risk from the changed paths, with `risk` as the fallback. */
    riskFromChangedPaths?: boolean;
    policyRuleId: string;
    metadata?: Record<string, string>;
    note: string;
    gateResult?: import('@/lib/approvals/types').ApprovalGateResult;
    conflictReport?: import('@/lib/approvals/types').ApprovalConflictReport;
    strategy?: import('@/lib/approvals/types').MergeStrategy;
  },
): Promise<LaneCommandResult> {
  let approvedMergeFailure = false;
  let recovery: Awaited<ReturnType<typeof preserveAndRecordLaneRecovery>> = null;
  if (input.verb === 'merge' && RECOVERABLE_MERGE_FAILURE_POLICIES.has(input.policyRuleId)) {
    const review = await assessDurableApprovedReview(lane);
    approvedMergeFailure = review.approved;
    if (approvedMergeFailure) {
      try {
        recovery = await preserveAndRecordLaneRecovery(lane, input.policyRuleId, { reviewed: true });
      } catch (error) {
        console.error(
          `[merge-recovery] Failed to bank reviewed work for lane ${lane.id}; keeping the lane operator-actionable:`,
          error,
        );
      }
    }
  }
  const { rawDiff, diffBase, headSha } = await (input.verb === 'merge' ? readMergeApprovalDiff(lane) : readDiffForLane(lane));
  const expectedHeadSha = (input.expectedHeadSha ?? (input.verb === 'merge' ? headSha : undefined))?.toLowerCase();
  const files = parseGitDiff(rawDiff);
  const surfaceRoute = resolveRequireApprovalSync() === 'surface' && lane.packetId
    ? resolvePacketDispatcher(lane.packetId) ?? {
        dispatcher: { surface: 'operator' as const, id: 'desktop' },
        missionId: null,
      }
    : null;
  const approval = createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: input.title,
    description: recovery ? `${input.description}\n\n${recovery.message}` : input.description,
    summary: input.summary,
    diff: {
      path: 'multi-file',
      after: rawDiff || undefined,
      files,
    },
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.riskFromChangedPaths ? riskForChangedPaths(files, input.risk) : input.risk,
    policyRuleId: input.policyRuleId,
    args: surfaceRoute || recovery ? {
      ...(surfaceRoute ? {
        approvalRoute: 'dispatcher',
        dispatcherSurface: surfaceRoute.dispatcher.surface,
        dispatcherId: surfaceRoute.dispatcher.id,
        ...(surfaceRoute.missionId ? { dispatcherMissionId: surfaceRoute.missionId } : {}),
      } : {}),
      ...(recovery ? {
        preservedRef: recovery.preservedRef,
        preservedHeadSha: recovery.preservedHeadSha,
      } : {}),
    } : undefined,
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      ...(expectedHeadSha ? { 'Expected HEAD': expectedHeadSha } : {}),
      ...(recovery ? {
        'Recovery Ref': recovery.preservedRef,
        'Recovery HEAD': recovery.preservedHeadSha ?? 'unknown',
        'Recovery Action': recovery.recommendedAction,
      } : {}),
      ...(surfaceRoute ? {
        'Approval Route': 'dispatcher',
        'Dispatcher Surface': surfaceRoute.dispatcher.surface,
        'Dispatcher ID': surfaceRoute.dispatcher.id,
        ...(surfaceRoute.missionId ? { 'Dispatcher Mission': surfaceRoute.missionId } : {}),
      } : {}),
      ...input.metadata,
      ...(diffBase ? {
        'Base SHA': diffBase.mergeBase ?? diffBase.comparisonRef,
        'Changed file count': String(files.length),
      } : {}),
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
      expectedHeadSha,
      strategy: input.strategy,
    },
  });
  // Advisory referee read of the diff (#2435): detached, never awaited here,
  // and a no-op when judgment.provider is off.
  startApprovalReferee({
    approvalId: approval.id,
    packetId: lane.packetId ?? null,
    laneId: lane.id,
    files: files.map((file) => ({ path: file.path })),
    diffText: rawDiff,
  });
  await recordReviewLessonsForApproval(approval.id, lane, input.reviewSummary, files);
  setLaneStatus(
    lane.id,
    approvedMergeFailure && input.policyRuleId === 'merge-gate-violation'
      ? 'reviewing'
      : approvedMergeFailure ? 'awaiting_orchestrator' : 'awaiting_input',
    actor,
    approvedMergeFailure && input.policyRuleId === 'merge-gate-violation'
      ? 'merge_gate_blocked_after_approval'
      : approvedMergeFailure ? 'merge_blocked_recoverable' : surfaceRoute ? 'dispatcher_review_required' : 'approval_required',
  );
  void publishRealtimeMutation({
    mutation: {
      mutationId: `approval-create-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: surfaceRoute?.dispatcher.id ?? approval.sessionKey,
      status: 'pending',
      note: `Approval required: ${approval.title}`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: surfaceRoute ? ['global'] : ['global', 'mobileInbox'],
    sessionKeys: [surfaceRoute?.dispatcher.id ?? approval.sessionKey],
    fresh: true,
  });
  if (surfaceRoute?.dispatcher.surface === 'agent' && surfaceRoute.dispatcher.id !== lane.packetId) {
    const dispatcherPacketId = surfaceRoute.dispatcher.id;
    void import('@/lib/orchestrator/operator-mission-service/steer')
      .then(({ steerPacket }) => steerPacket({
        packetId: dispatcherPacketId,
        source: 'orchestrator',
        message: `Packet ${lane.packetId ?? lane.id} needs your review before merge. Inspect it with o8 packet diff ${lane.packetId ?? ''} and respond to approval ${approval.id}.`,
      }))
      .catch((error) => {
        console.error(`[surface-approval] Failed to ping agent dispatcher ${dispatcherPacketId}:`, error);
      });
  }
  return {
    ok: false,
    laneId: lane.id,
    note: recovery ? `${input.note} ${recovery.message}` : input.note,
    approvalId: approval.id,
  };
}
