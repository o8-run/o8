/**
 * Merge evidence capture after the reviewed HEAD moves (#2271).
 *
 * A packet workspace that already holds a durable snapshot for an older HEAD
 * (a rebase, a rerun, or an operator touch-up commit landed afterwards) must
 * still produce merge evidence for the HEAD being merged. Capture supersedes the
 * older generation instead of refusing, keeps that generation in the append-only
 * receipt chain, and resolves retries for the same HEAD to the same generation.
 *
 * Reachability rule: the merge case drives performWorktreeSideMerge against a
 * registered repository, a manager-created worktree, and persisted lane plus
 * workspace-snapshot state. The idempotency case drives the same exported
 * capture function the merge path calls.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-evidence-generation-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { createLane } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { addRepo } = await import('@/lib/repos/registry');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
const { captureWorkspaceMaterializationSnapshot } = await import('@/lib/workspace/workspace-materialization-retirement');
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
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  const localPath = realpathSync(repo);
  const registered = await addRepo(localPath);
  return { repo: localPath, repositoryUuid: registered.id };
}

async function makePacketWorkspace(name: string) {
  const { repo, repositoryUuid } = await makeRepo(name);
  const packetId = `pkt-${name}`;
  const branch = `inline/${name}`;
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
  writeFileSync(join(worktree.path, 'feature.txt'), 'first reviewed generation\n');
  const headA = commitAll(worktree.path, 'worker change [via-o8]');
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
  });
  return { repo, repositoryUuid, packetId, worktreePath: worktree.path, lane, headA };
}

beforeAll(async () => {
  // The storage governor is not under test; keep its reserve out of the way.
  await updateOperatorDefaults({
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('merge evidence capture after the reviewed HEAD moves', () => {
  it('supersedes an older-HEAD snapshot with a new generation and merges with the new evidence', async () => {
    const { repo, repositoryUuid, packetId, worktreePath, lane, headA } =
      await makePacketWorkspace('o8-evidence-supersede');

    // Evidence was already captured for HEAD A.
    const first = await captureWorkspaceMaterializationSnapshot(repo, worktreePath, 'merge', {
      mergeCandidateSha: headA,
      reviewedHeadSha: headA,
    });
    expect(first).toMatchObject({ snapshotGeneration: 1, headCommit: headA, state: 'materialized' });
    const recoveryRefA = first!.recoveryRef;

    // An operator touch-up commit moves the reviewed HEAD to B.
    writeFileSync(join(worktreePath, 'feature.txt'), 'first reviewed generation\ntouch-up\n');
    const headB = commitAll(worktreePath, 'operator touch-up [via-o8]');

    const result = await performWorktreeSideMerge({
      lane,
      command: { verb: 'merge', laneId: lane.id, actor: 'system', orchestratorReviewed: true },
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval,
    });

    expect(result.note).not.toContain('no longer identifies the reviewed merge HEAD');
    expect(result.ok).toBe(true);
    expect(git(repo, ['show', 'HEAD:feature.txt'])).toBe('first reviewed generation\ntouch-up');

    // The current generation certifies B. Worktree cleanup after the merge is a
    // separate, host-dependent step, so the state is not pinned here.
    const current = getWorkspaceSnapshot(repositoryUuid, packetId)!;
    expect(current).toMatchObject({ snapshotGeneration: 2, headCommit: headB });
    expect(current.recoveryRef).not.toBe(recoveryRefA);
    expect(git(repo, ['rev-parse', current.recoveryRef])).toBe(headB);

    // Generation 1 for A is retained, unmutated, in the receipt chain.
    const history = listWorkspaceSnapshotTransitions(repositoryUuid, packetId);
    const created = history.filter((receipt) => receipt.kind === 'created');
    expect(created.map((receipt) => receipt.snapshotGeneration)).toEqual([1, 2]);
    expect(created[0]).toMatchObject({
      snapshotFingerprint: first!.snapshotFingerprint,
      receipt: { mergeCandidateSha: headA, reviewedHeadSha: headA },
    });
    expect(created[1]!.receipt).toMatchObject({
      reviewedHeadSha: headB,
      previousSnapshotGeneration: 1,
      previousSnapshotFingerprint: first!.snapshotFingerprint,
      previousSnapshot: { headCommit: headA, recoveryRef: recoveryRefA },
    });
    expect(git(repo, ['rev-parse', recoveryRefA])).toBe(headA);
  }, 180_000);

  it('resolves a repeated capture for the same reviewed HEAD to the same generation', async () => {
    const { repo, repositoryUuid, packetId, worktreePath, headA } =
      await makePacketWorkspace('o8-evidence-idempotent');

    await captureWorkspaceMaterializationSnapshot(repo, worktreePath, 'merge', {
      mergeCandidateSha: headA,
      reviewedHeadSha: headA,
    });
    const againA = await captureWorkspaceMaterializationSnapshot(repo, worktreePath, 'merge', {
      mergeCandidateSha: headA,
      reviewedHeadSha: headA,
    });
    expect(againA).toMatchObject({ snapshotGeneration: 1, version: 1, headCommit: headA });

    writeFileSync(join(worktreePath, 'feature.txt'), 'rerun output\n');
    const headB = commitAll(worktreePath, 'rerun [via-o8]');
    const evidenceB = { mergeCandidateSha: headB, reviewedHeadSha: headB };

    const firstB = await captureWorkspaceMaterializationSnapshot(repo, worktreePath, 'merge', evidenceB);
    const retryB = await captureWorkspaceMaterializationSnapshot(repo, worktreePath, 'merge', evidenceB);
    expect(firstB).toMatchObject({ snapshotGeneration: 2, headCommit: headB, state: 'materialized' });
    expect(retryB).toEqual(firstB);

    const history = listWorkspaceSnapshotTransitions(repositoryUuid, packetId);
    expect(history.map((receipt) => [receipt.kind, receipt.snapshotGeneration])).toEqual([
      ['created', 1],
      ['created', 2],
    ]);
  }, 180_000);
});
