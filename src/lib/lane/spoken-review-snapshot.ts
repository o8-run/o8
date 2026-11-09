import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneGit, LaneGitMetadataError, withLaneCommitDirectory, type LaneGitOptions } from '@/lib/lane/lane-git';

import {
  getLaneSpokenDiffFacts,
  spokenReviewSnapshotFingerprint,
} from '@/lib/lane/lane-diff-facts';
import { getApproval } from '@/lib/approvals/store';
import { currentSpokenReviewGovernanceFingerprint } from '@/lib/approvals/spoken-review-guard';
import { appendEvent, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import type { SpokenReviewResolutionTransition } from '@/lib/orchestrator/spoken-review-governance';

export class SpokenReviewSnapshotChangedError extends Error {
  constructor() {
    super('Packet diff changed after the spoken review. Review it again before continuing.');
    this.name = 'SpokenReviewSnapshotChangedError';
  }
}

export function validateSpokenReviewEvidenceBundle(input: {
  expectedDiffFingerprint?: string;
  expectedGovernanceFingerprint?: string;
  spokenReviewApprovalId?: string;
  spokenReviewClaimId?: string;
  spokenReviewUpdatedAt?: number;
  spokenReviewLaneStatus?: Lane['status'];
}): { present: boolean; complete: boolean } {
  const strings = [
    input.expectedDiffFingerprint,
    input.expectedGovernanceFingerprint,
    input.spokenReviewApprovalId,
    input.spokenReviewClaimId,
    input.spokenReviewLaneStatus,
  ].map((value) => value?.trim() || '');
  const present = strings.some(Boolean) || input.spokenReviewUpdatedAt !== undefined;
  const complete = strings.every(Boolean)
    && Number.isFinite(input.spokenReviewUpdatedAt);
  return { present, complete: !present || complete };
}

export function spokenReviewResolutionTransition(input: {
  spokenReviewClaimId?: string;
  spokenReviewUpdatedAt?: number;
  spokenReviewLaneStatus?: Lane['status'];
}): SpokenReviewResolutionTransition | undefined {
  if (
    !input.spokenReviewClaimId
    || input.spokenReviewUpdatedAt === undefined
    || !input.spokenReviewLaneStatus
  ) return undefined;
  return {
    claimId: input.spokenReviewClaimId,
    reviewedUpdatedAt: input.spokenReviewUpdatedAt,
    reviewedLaneStatus: input.spokenReviewLaneStatus,
  };
}

export function rejectInvalidSpokenReviewExecution(input: {
  lane: Lane;
  actor: LaneEventActor;
  verb: 'merge' | 'create_pr';
  strategy?: 'ours' | 'theirs' | 'manual';
  expectedDiffFingerprint?: string;
  expectedGovernanceFingerprint?: string;
  spokenReviewApprovalId?: string;
  spokenReviewClaimId?: string;
  spokenReviewUpdatedAt?: number;
  spokenReviewLaneStatus?: Lane['status'];
}): LaneCommandResult | null {
  const bundle = validateSpokenReviewEvidenceBundle(input);
  if (!bundle.present) return null;
  const approval = input.spokenReviewApprovalId
    ? getApproval(input.spokenReviewApprovalId)
    : null;
  const lastAudit = approval?.audit.at(-1);
  const continuation = approval?.continuation;
  const exactOwner = Boolean(
    bundle.complete
    && approval?.status === 'approved'
    && approval.resolution?.action === 'approved'
    && approval.resolution.actor === 'desktop'
    && approval.resolution.claimId === input.spokenReviewClaimId
    && approval.resolvedAt === approval.updatedAt
    && lastAudit?.type === 'approved'
    && lastAudit.actor === 'desktop'
    && lastAudit.timestamp === approval.resolvedAt
    && continuation?.kind === 'lane'
    && continuation.laneId === input.lane.id
    && continuation.verb === input.verb
    && (input.verb !== 'merge' || continuation.strategy === input.strategy),
  );
  if (exactOwner) return null;

  setLaneStatus(input.lane.id, 'reviewing', 'system', 'spoken_review_invalidated');
  appendEvent(input.lane.id, 'review_invalidated', input.actor, {
    reason: 'spoken_review_execution_changed',
    packetId: input.lane.packetId,
    approvalId: input.spokenReviewApprovalId,
  });
  return {
    ok: false,
    laneId: input.lane.id,
    note: 'The approval owner, action, or merge strategy changed after the spoken review. Review it again.',
    reason: 'governance_changed_since_spoken_review',
  };
}

export async function rejectSpokenReviewGovernanceDrift(input: {
  lane: Lane;
  actor: LaneEventActor;
  approvalId?: string;
  expectedFingerprint?: string;
  resolutionTransition?: SpokenReviewResolutionTransition;
  action: 'merging' | 'creating the pull request';
}): Promise<LaneCommandResult | null> {
  if (!input.expectedFingerprint) return null;
  const approval = input.approvalId ? getApproval(input.approvalId) : null;
  const currentFingerprint = approval
    ? await currentSpokenReviewGovernanceFingerprint(
      approval,
      input.lane,
      input.resolutionTransition,
    )
    : null;
  if (currentFingerprint === input.expectedFingerprint) return null;
  setLaneStatus(input.lane.id, 'reviewing', 'system', 'spoken_review_invalidated');
  appendEvent(input.lane.id, 'review_invalidated', input.actor, {
    reason: 'spoken_review_governance_changed',
    packetId: input.lane.packetId,
    approvalId: input.approvalId,
  });
  return {
    ok: false,
    laneId: input.lane.id,
    note: `Packet governance changed after the spoken review. Review it again before ${input.action}.`,
    reason: 'governance_changed_since_spoken_review',
  };
}

export async function rejectSpokenReviewSnapshotDrift(input: {
  lane: Lane;
  actor: LaneEventActor;
  expectedFingerprint?: string;
  action: 'merging' | 'creating the pull request';
}): Promise<LaneCommandResult | null> {
  if (!input.expectedFingerprint) return null;
  const current = await getLaneSpokenDiffFacts(input.lane);
  if (current.fingerprint === input.expectedFingerprint) return null;
  setLaneStatus(input.lane.id, 'reviewing', 'system', 'spoken_review_invalidated');
  appendEvent(input.lane.id, 'review_invalidated', input.actor, {
    reason: 'spoken_review_diff_changed',
    branch: input.lane.branch,
    baseBranch: input.lane.baseBranch,
    packetId: input.lane.packetId,
  });
  return {
    ok: false,
    laneId: input.lane.id,
    note: `Packet diff changed after the spoken review. Review it again before ${input.action}.`,
    reason: 'diff_changed_since_spoken_review',
  };
}

async function verifiedSpokenReviewSnapshot(lane: Lane, expectedFingerprint?: string) {
  const current = await getLaneSpokenDiffFacts(lane);
  if (expectedFingerprint && current.fingerprint !== expectedFingerprint) {
    throw new SpokenReviewSnapshotChangedError();
  }
  return current;
}

/** Resolve a clean reviewed snapshot to the exact commit SHA safe to publish. */
export async function resolveSpokenReviewSnapshotSha(input: {
  lane: Lane;
  expectedFingerprint?: string;
}) {
  const cwd = input.lane.worktreePath || input.lane.repoPath;
  if (!input.expectedFingerprint) {
    const branch = input.lane.branch?.trim();
    const { stdout } = await laneGit(cwd, input.lane.repoPath,
      ['rev-parse', '--verify', '--end-of-options', branch ? `refs/heads/${branch}^{commit}` : 'HEAD']);
    return stdout.trim();
  }
  const current = await verifiedSpokenReviewSnapshot(input.lane, input.expectedFingerprint);
  const { stdout } = await laneGit(cwd, input.lane.repoPath, ['rev-parse', `${current.headSha}^{tree}`]);
  if (stdout.trim() !== current.snapshotTreeHash) {
    throw new SpokenReviewSnapshotChangedError();
  }
  return current.headSha;
}

/**
 * Stage and commit exactly the worktree snapshot bound to a spoken review.
 *
 * An isolated temporary index stages the candidate tree without reading or
 * mutating the shared worktree index. The post-stage check proves the live
 * worktree still matches the reviewed fingerprint, and update-ref advances the
 * branch only while its reviewed HEAD remains unchanged. A lane with a recorded
 * branch commits onto it from a host-owned Git directory.
 */
export async function commitSpokenReviewSnapshot(input: {
  lane: Lane;
  commitMessage: string;
  expectedFingerprint?: string;
}): Promise<string> {
  const cwd = input.lane.worktreePath || input.lane.repoPath;
  const reviewed = await verifiedSpokenReviewSnapshot(input.lane, input.expectedFingerprint);
  const branch = input.lane.branch?.trim();
  if (branch) {
    return withLaneCommitDirectory(cwd, input.lane.repoPath, branch,
      ({ options }) => commitReviewedSnapshot(input, reviewed, options, `refs/heads/${branch}`));
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'o8-spoken-review-commit-'));
  try {
    return await commitReviewedSnapshot(input, reviewed, { indexFile: join(tempDir, 'index') });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function commitReviewedSnapshot(
  input: { lane: Lane; commitMessage: string; expectedFingerprint?: string },
  reviewed: Awaited<ReturnType<typeof verifiedSpokenReviewSnapshot>>,
  options: LaneGitOptions,
  laneBranchRef?: string,
): Promise<string> {
  const cwd = input.lane.worktreePath || input.lane.repoPath;
  await laneGit(cwd, input.lane.repoPath, ['read-tree', reviewed.headSha], options);
  await laneGit(cwd, input.lane.repoPath, ['add', '-A', '--', '.'], options);
  const { stdout: stagedTreeOutput } = await laneGit(cwd, input.lane.repoPath, ['write-tree'], options);
  const stagedTree = stagedTreeOutput.trim();
  const current = await verifiedSpokenReviewSnapshot(input.lane, input.expectedFingerprint);
  const stagedFingerprint = spokenReviewSnapshotFingerprint(
    reviewed.headSha,
    reviewed.against,
    stagedTree,
  );
  if (
    current.headSha !== reviewed.headSha
    || current.against !== reviewed.against
    || current.snapshotTreeHash !== stagedTree
    || (input.expectedFingerprint && stagedFingerprint !== input.expectedFingerprint)
  ) {
    throw new SpokenReviewSnapshotChangedError();
  }

  const { stdout: headTreeOutput } = await laneGit(cwd, input.lane.repoPath, ['rev-parse', `${reviewed.headSha}^{tree}`]);
  if (headTreeOutput.trim() === stagedTree) return reviewed.headSha;

  const { stdout: commitOutput } = await laneGit(cwd, input.lane.repoPath, [
    'commit-tree',
    stagedTree,
    '-p',
    reviewed.headSha,
    '-m',
    input.commitMessage,
  ], options);
  const commitSha = commitOutput.trim();
  const branchRef = laneBranchRef
    ?? (await laneGit(cwd, input.lane.repoPath, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
  try {
    await laneGit(cwd, input.lane.repoPath, ['update-ref', branchRef, commitSha, reviewed.headSha], options);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    throw new SpokenReviewSnapshotChangedError();
  }
  try {
    await laneGit(cwd, input.lane.repoPath, ['read-tree', commitSha]);
  } catch (error) {
    console.warn(`[spoken-review] Exact commit landed but the shared index could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return commitSha;
}

export async function commitSpokenReviewSnapshotWithDriftRecovery(input: {
  lane: Lane;
  actor: LaneEventActor;
  commitMessage: string;
  expectedFingerprint?: string;
}): Promise<{ snapshotSha?: string; result?: LaneCommandResult; error?: unknown }> {
  try {
    return { snapshotSha: await commitSpokenReviewSnapshot(input) };
  } catch (error) {
    if (!(error instanceof SpokenReviewSnapshotChangedError)) return { error };
    setLaneStatus(input.lane.id, 'reviewing', 'system', 'spoken_review_invalidated');
    appendEvent(input.lane.id, 'review_invalidated', input.actor, {
      reason: 'spoken_review_diff_changed_during_stage',
      branch: input.lane.branch,
      baseBranch: input.lane.baseBranch,
      packetId: input.lane.packetId,
    });
    return {
      result: {
        ok: false,
        laneId: input.lane.id,
        note: error.message,
        reason: 'diff_changed_since_spoken_review',
      },
    };
  }
}
