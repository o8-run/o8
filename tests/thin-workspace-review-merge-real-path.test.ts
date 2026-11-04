/**
 * Thin Workspaces — review matrix real-path coverage (adversarial rows).
 *
 * Two rows the 2026-08-18 ground-truth audit left OPEN:
 *
 *   1. MERGE CONFLICT. A workspace that was parked and later restored, whose
 *      branch conflicts with an advanced base at merge time. The real
 *      worktree-side merge helper must fail CLOSED — a structured conflict
 *      escalation, the operator checkout untouched, no stash, no partial merge,
 *      and the reviewed work still recoverable.
 *
 *   2. POST-RESTORE APPROVAL RE-VALIDATION. An approval granted against the
 *      PARKED snapshot's diff must not authorize a merge after the workspace is
 *      restored and its tree changes. Both the packet merge entry point
 *      (approveAndMergePacket) and the spoken-review pins carried into
 *      performWorktreeSideMerge must re-validate against live truth.
 *
 * Reachability rule: every case drives the real entry point against persisted
 * lane / approval / workspace-snapshot state, never a guard in isolation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { WorkspaceSnapshotState } from '@/lib/worktree/snapshot-state-types';

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-tw-review-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { createLane, getLane } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { addRepo } = await import('@/lib/repos/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { createApproval, listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
const { claimApprovalResolution } = await import('@/lib/approvals/resolution');
const { currentSpokenReviewGovernanceFingerprint } = await import('@/lib/approvals/spoken-review-guard');
const { getLaneSpokenDiffFacts, spokenReviewSnapshotFingerprint } = await import('@/lib/lane/lane-diff-facts');
const { createWorkspaceSnapshot, getWorkspaceSnapshot, transitionWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const { approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

const tempDirs: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  const baseCommit = commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  const resolved = { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo), baseCommit };
  const registered = await addRepo(resolved.repo);
  return { ...resolved, repositoryUuid: registered.id };
}

async function makeWorktree(repo: string, packetId: string, branch: string) {
  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  return worktree;
}

/**
 * Drive the real workspace-snapshot state machine through the full park cycle
 * and (optionally) back out through restore, so the lane under test is a
 * genuinely parked-then-restored thin workspace rather than a hand-set flag.
 */
function driveSnapshot(input: {
  repositoryUuid: string;
  packetId: string;
  laneId: string;
  originalPath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  restore: boolean;
}) {
  const diffFingerprint = spokenReviewSnapshotFingerprint(input.headCommit, input.baseCommit, input.treeSha);
  const created = createWorkspaceSnapshot({
    repositoryUuid: input.repositoryUuid,
    packetId: input.packetId,
    laneId: input.laneId,
    originalPath: input.originalPath,
    branch: input.branch,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    treeSha: input.treeSha,
    recoveryRef: input.recoveryRef,
    diffFingerprint,
    sessionIdentities: [],
    creationId: `create-${input.packetId}`,
  });
  expect(created.status).toBe('created');
  let version = created.status === 'created' ? created.record.version : 0;

  const steps: Array<[WorkspaceSnapshotState, WorkspaceSnapshotState]> = [
    ['materialized', 'parkable'],
    ['parkable', 'hibernating'],
    ['hibernating', 'parked'],
  ];
  if (input.restore) {
    steps.push(['parked', 'restoring'], ['restoring', 'materialized']);
  }
  for (const [expectedState, toState] of steps) {
    const transitioned = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: `${input.packetId}-${toState}`,
      expectedState,
      expectedVersion: version,
      toState,
    });
    expect(transitioned.status).toBe('applied');
    if (transitioned.status === 'applied') version = transitioned.record.version;
  }
  return diffFingerprint;
}

function packetFixture(id: string, repoPath: string, branch: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: 'Thin workspace review packet',
    summary: 'Exercise the review matrix through the real merge path.',
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: null,
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    workspaceTargetPath: repoPath,
    branchTarget: branch,
  } as OrchestratorPacket;
}

beforeAll(async () => {
  // The storage governor is not under test here; keep its reserve out of the
  // way so these merge-path assertions do not depend on the host's free disk.
  await updateOperatorDefaults({
    productTelemetryEnabled: false,
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterAll(async () => {
  try {
    await updateOperatorDefaults({ productTelemetryEnabled: false });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('thin workspace review matrix — merge conflict against an advanced base', () => {
  it('a restored parked workspace whose branch conflicts with advanced main fails closed with no partial merge', async () => {
    const packetId = 'pkt-tw-restored-conflict';
    const branch = 'inline/tw-restored-conflict';
    const { repo, repositoryUuid, baseCommit } = await makeRepo('o8-tw-restored-conflict');
    const worktree = await makeWorktree(repo, packetId, branch);

    writeFileSync(join(worktree.path, 'file.txt'), 'worker\n');
    const reviewedHeadSha = commitAll(worktree.path, 'worker change [via-o8]');
    const treeSha = git(worktree.path, ['rev-parse', 'HEAD^{tree}']);
    const recoveryRef = `refs/o8/recovery/${packetId}`;
    git(worktree.path, ['update-ref', recoveryRef, reviewedHeadSha]);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex:${packetId}`,
    });

    // Park the workspace and bring it back — this is the thin-workspace lane.
    driveSnapshot({
      repositoryUuid,
      packetId,
      laneId: lane.id,
      originalPath: worktree.path,
      branch,
      baseCommit,
      headCommit: reviewedHeadSha,
      treeSha,
      recoveryRef,
      restore: true,
    });
    expect(getWorkspaceSnapshot(repositoryUuid, packetId)?.state).toBe('materialized');

    // Base advances with a conflicting edit to the same file while parked.
    writeFileSync(join(repo, 'file.txt'), 'upstream\n');
    const advancedMainSha = commitAll(repo, 'upstream conflicting change');
    git(repo, ['push', 'origin', 'main']);

    const result = await performWorktreeSideMerge({
      lane,
      command: { verb: 'merge', laneId: lane.id, actor: 'system', orchestratorReviewed: true },
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });

    // Fails closed: structured escalation, not a merge.
    expect(result.ok).toBe(false);
    expect(result.note).toContain('Rebase conflict escalated to operator');
    const conflictApproval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.policyRuleId === 'rebase_conflict_escalation');
    expect(conflictApproval).toBeTruthy();
    expect(conflictApproval?.metadata?.FailureCategory).toBe('rebase-conflict');
    expect(conflictApproval?.metadata?.ConflictFiles).toContain('file.txt');
    expect(conflictApproval?.risk).toBe('high');

    // No partial merge into the operator checkout, and no stash detour.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(advancedMainSha);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('upstream');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);

    // No lost work: the reviewed commit is still on disk and still reachable.
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(git(worktree.path, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['rev-parse', recoveryRef])).toBe(reviewedHeadSha);

    // The lane is not left claiming a release it never got.
    expect(getLane(lane.id)?.status).not.toBe('merged');
    expect(getLane(lane.id)?.status).not.toBe('released');
  }, 40_000);
});

describe('thin workspace review matrix — post-restore approval re-validation', () => {
  it('an approval pinned to the parked diff does not authorize a merge after the restored tree changes', async () => {
    const packetId = 'pkt-tw-post-restore-approval';
    const branch = 'inline/tw-post-restore-approval';
    const { repo, repositoryUuid, baseCommit } = await makeRepo('o8-tw-post-restore-approval');
    const worktree = await makeWorktree(repo, packetId, branch);

    writeFileSync(join(worktree.path, 'feature.txt'), 'reviewed\n');
    const parkedHeadSha = commitAll(worktree.path, 'reviewed work [via-o8]');
    const treeSha = git(worktree.path, ['rev-parse', 'HEAD^{tree}']);
    const recoveryRef = `refs/o8/recovery/${packetId}`;
    git(worktree.path, ['update-ref', recoveryRef, parkedHeadSha]);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex:${packetId}`,
    });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath: repo,
      packets: [packetFixture(packetId, repo, 'main')],
    });

    // The operator approves the PARKED diff.
    driveSnapshot({
      repositoryUuid,
      packetId,
      laneId: lane.id,
      originalPath: worktree.path,
      branch,
      baseCommit,
      headCommit: parkedHeadSha,
      treeSha,
      recoveryRef,
      restore: false,
    });
    expect(getWorkspaceSnapshot(repositoryUuid, packetId)?.state).toBe('parked');
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: parkedHeadSha });

    // Restore the workspace, then the tree changes underneath the approval.
    const parked = getWorkspaceSnapshot(repositoryUuid, packetId)!;
    for (const [expectedState, toState] of [['parked', 'restoring'], ['restoring', 'materialized']] as Array<[WorkspaceSnapshotState, WorkspaceSnapshotState]>) {
      const transitioned = transitionWorkspaceSnapshot({
        repositoryUuid,
        packetId,
        transitionId: `${packetId}-restore-${toState}`,
        expectedState,
        expectedVersion: getWorkspaceSnapshot(repositoryUuid, packetId)!.version,
        toState,
      });
      expect(transitioned.status).toBe('applied');
    }
    expect(parked.headCommit).toBe(parkedHeadSha);

    writeFileSync(join(worktree.path, 'feature.txt'), 'reviewed\nunreviewed addition\n');
    const restoredHeadSha = commitAll(worktree.path, 'post-restore change [via-o8]');
    expect(restoredHeadSha).not.toBe(parkedHeadSha);

    const mainBeforeMerge = git(repo, ['rev-parse', 'HEAD']);
    const result = await approveAndMergePacket({ packetId });

    // The stale approval is re-validated against live truth and refused.
    expect(result).toMatchObject({
      merged: false,
      reason: 'head_moved_since_review',
      reviewedHeadSha: parkedHeadSha,
      currentHeadSha: restoredHeadSha,
    });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(mainBeforeMerge);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(worktree.path, 'feature.txt'))).toBe(true);
  }, 40_000);

  it('spoken-review pins captured while parked are refused once the restored workspace diverges', async () => {
    const packetId = 'pkt-tw-post-restore-spoken';
    const branch = 'inline/tw-post-restore-spoken';
    const { repo, repositoryUuid, baseCommit } = await makeRepo('o8-tw-post-restore-spoken');
    const worktree = await makeWorktree(repo, packetId, branch);

    writeFileSync(join(worktree.path, 'spoken.txt'), 'reviewed\n');
    const parkedHeadSha = commitAll(worktree.path, 'reviewed spoken work [via-o8]');
    const treeSha = git(worktree.path, ['rev-parse', 'HEAD^{tree}']);
    const recoveryRef = `refs/o8/recovery/${packetId}`;
    git(worktree.path, ['update-ref', recoveryRef, parkedHeadSha]);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex:${packetId}`,
    });

    driveSnapshot({
      repositoryUuid,
      packetId,
      laneId: lane.id,
      originalPath: worktree.path,
      branch,
      baseCommit,
      headCommit: parkedHeadSha,
      treeSha,
      recoveryRef,
      restore: true,
    });

    // Approval + spoken pins are captured against the reviewed (parked) truth.
    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha: parkedHeadSha,
      requiresSecondPass: false,
    });
    const approval = createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'worker',
      sessionKey: lane.sessionKey!,
      title: 'Merge reviewed packet',
      description: 'Merge reviewed packet',
      summary: 'Merge reviewed packet',
      risk: 'high',
      policyRuleId: 'lane-merge',
      continuation: { kind: 'lane', laneId: lane.id, verb: 'merge' },
    });
    const reviewedFacts = await getLaneSpokenDiffFacts(lane);
    const governanceFingerprint = await currentSpokenReviewGovernanceFingerprint(approval, lane);
    const reviewedLaneStatus = getLane(lane.id)!.status;
    const claim = claimApprovalResolution(approval.id, 'approve', 'desktop', undefined, approval.updatedAt);

    // The restored workspace then diverges from what was approved.
    writeFileSync(join(worktree.path, 'spoken.txt'), 'reviewed\nsmuggled\n');
    const divergedHeadSha = commitAll(worktree.path, 'post-restore divergence [via-o8]');
    expect(divergedHeadSha).not.toBe(parkedHeadSha);

    const mainBeforeMerge = git(repo, ['rev-parse', 'HEAD']);
    const result = await performWorktreeSideMerge({
      lane,
      command: {
        verb: 'merge',
        laneId: lane.id,
        actor: 'user',
        expectedHeadSha: parkedHeadSha,
        expectedDiffFingerprint: reviewedFacts.fingerprint,
        expectedGovernanceFingerprint: governanceFingerprint,
        spokenReviewApprovalId: approval.id,
        spokenReviewClaimId: claim.claimId,
        spokenReviewUpdatedAt: approval.updatedAt,
        spokenReviewLaneStatus: reviewedLaneStatus,
      },
      actor: 'user',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });

    expect(result.ok).toBe(false);
    // The governance check runs first, and its fingerprint covers the merge preview and the
    // review approval for the current head, so the diverged head is refused there.
    expect(result.reason).toBe('governance_changed_since_spoken_review');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(mainBeforeMerge);
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('base');
    expect(existsSync(join(repo, 'spoken.txt'))).toBe(false);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(divergedHeadSha);
  }, 40_000);
});
