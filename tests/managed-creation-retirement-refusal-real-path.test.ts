import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/worktree/apfs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: vi.fn(async () => ({
    macos: true,
    apfs: true,
    sameVolume: true,
    canCowClone: true,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-create-retire-refusal-')));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { closeDb } = await import('@/lib/db');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
const { retireExactManagedDirectory } = await import('@/lib/workspace/exact-managed-directory-retirement');
const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');

function makeRepo(label: string): string {
  const repo = path.join(root, label);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'tracked.txt'), 'owned\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'owned',
  ], { cwd: repo });
  return repo;
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

it.each(['git-worktree', 'apfs-cow-clone'] as const)(
  'retains %s ownership when failed-creation retirement refuses, then reclaims on restart',
  async (isolationKind) => {
    const repo = makeRepo(`repo-${isolationKind}`);
    const id = `rollback-${isolationKind}`;
    const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;
    const manager = new WorktreeManager(repo);
    Object.defineProperty(manager, 'runSetupWithMaterialization', {
      value: async () => { throw new Error('forced setup failure'); },
    });
    Object.defineProperty(manager, 'hydrateApfsCowAssets', { value: async () => [] });
    Object.defineProperty(manager, 'bootstrapEnvFiles', { value: async () => {} });
    Object.defineProperty(manager, 'injectSafetyHooks', { value: async () => {} });
    Object.defineProperty(manager, 'resetTrackedWorkspaceChanges', { value: async () => {} });
    Object.defineProperty(manager, 'retireFailedManagedCreation', {
      value: async (worktreeId: string, directoryPath: string,
        identity: WorktreeMaterializationIdentity, parentIdentity: WorktreeMaterializationIdentity) => {
        await retireExactManagedDirectory({ repositoryPath: repo, worktreeId, directoryPath,
          identity, parentIdentity, retirementReason: 'creation-rollback',
          beforeRetirementRename: async () => { throw new Error('forced exact-retirement refusal'); },
        });
      },
    });

    await expect(manager.create({
      agentType: 'codex',
      taskName: id,
      baseBranch: 'main',
      branchName: `inline/${id}`,
      managed: true,
      skipSetup: false,
      isolationPreference: isolationKind,
    })).rejects.toThrow('durable workspace ownership was retained');

    const retained = await withWorktreeMetaTransaction(
      repo,
      async (transaction) => (await transaction.readAll())[worktreeId],
    );
    expect(retained?.materializationIdentity).toBeDefined();
    expect(retained?.materializationParentIdentity).toBeDefined();
    expect(existsSync(retained!.materializationIdentity!.canonicalPath)).toBe(true);
    expect(readExactWorkspaceClaim('managed-retirement', repo, worktreeId)?.authority?.retirementReason).toBe('creation-rollback');

    await expect(new WorktreeManager(repo).cleanup(
      worktreeId,
      { force: true, deleteBranch: true, overrideLiveGuard: true },
    )).resolves.toBe(true);
    expect(existsSync(retained!.materializationIdentity!.canonicalPath)).toBe(false);
    await expect(withWorktreeMetaTransaction(
      repo,
      async (transaction) => (await transaction.readAll())[worktreeId],
    )).resolves.toBeUndefined();
  },
  180_000,
);

it('retires prepared Git authority when git worktree add fails', async () => {
  const repo = makeRepo('repo-git-add-failure');
  const id = 'git-add-failure';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'missing-base-branch',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  })).rejects.toThrow();

  expect(existsSync(path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId))).toBe(false);
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId],
  )).resolves.toBeUndefined();
}, 30_000);
