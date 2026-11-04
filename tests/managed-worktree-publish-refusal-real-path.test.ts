import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

function makeRepo(root: string): string {
  const repo = path.join(root, 'repo');
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

function mockObservedStorage(): void {
  vi.doMock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
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
}

function configureManagedWorktreeRoot(root: string): void {
  const worktreeRoot = path.join(root, 'worktrees');
  mkdirSync(worktreeRoot);
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
}

afterEach(() => {
  vi.doUnmock('@/lib/worktree/materialization-leaf-io');
  vi.doUnmock('@/lib/worktree/storage-telemetry');
  vi.doUnmock('@/lib/worktree/apfs');
  vi.resetModules();
});

it('refuses launch without overwriting or hiding tracked local Claude settings', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-hook-tracked-local-refusal-')));
  const repo = makeRepo(root);
  const settingsBytes = '{"permissions":{"deny":["Bash"]}}\n';
  mkdirSync(path.join(repo, '.claude'));
  writeFileSync(path.join(repo, '.claude', 'settings.local.json'), settingsBytes);
  execFileSync('git', ['add', '-f', '.claude/settings.local.json'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'tracked local settings',
  ], { cwd: repo });
  const worktree = path.join(root, 'worktree');
  execFileSync('git', ['worktree', 'add', '-qb', 'inline/hook-tracked-local-refusal', worktree], {
    cwd: repo,
  });
  const { captureWorktreeMaterializationIdentity } = await import(
    '@/lib/worktree/materialization-identity'
  );
  const { writeManagedWorkspaceSafetyHooks } = await import('@/lib/worktree/safety-hooks');

  await expect(writeManagedWorkspaceSafetyHooks(
    repo,
    worktree,
    await captureWorktreeMaterializationIdentity(worktree),
  )).rejects.toThrow(/refuses to replace existing \.claude\/settings\.local\.json/);

  expect(readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toBe(settingsBytes);
  expect(readFileSync(path.join(worktree, '.claude', 'settings.local.json'), 'utf8')).toBe(settingsBytes);
  expect(execFileSync(
    'git', ['show', 'HEAD:.claude/settings.local.json'], { cwd: repo, encoding: 'utf8' },
  )).toBe(settingsBytes);
  expect(() => execFileSync(
    'git', ['config', '--worktree', '--get', 'core.excludesFile'], { cwd: worktree },
  )).toThrow();
  expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'))
    .not.toContain('.claude/settings.local.json');
  rmSync(root, { recursive: true, force: true });
}, 60_000);

it('refuses launch and retains authority when the final hook-settings publish is replaced', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-hook-publish-refusal-')));
  const repo = makeRepo(root);
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  let admitted = '';
  vi.doMock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
    return {
      ...actual,
      writePinnedWorkspaceFile: async (
        workspacePath: string,
        identity: Parameters<typeof actual.writePinnedWorkspaceFile>[1],
        relativePath: string,
        content: string,
      ) => actual.writePinnedWorkspaceFile(workspacePath, identity, relativePath, content, async (segment) => {
        if (relativePath !== '.claude/settings.local.json' || segment !== 'atomic-opened') return;
        const target = path.join(workspacePath, '.claude', 'settings.local.json');
        admitted = `${target}-admitted`;
        renameSync(target, admitted);
        writeFileSync(target, '{"attacker":true}\n');
      }),
    };
  });
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'hook-publish-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  })).rejects.toThrow('target changed before direct write');

  const workspace = path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId);
  expect(readFileSync(path.join(workspace, '.claude', 'settings.local.json'), 'utf8'))
    .toBe('{"attacker":true}\n');
  expect(existsSync(admitted)).toBe(true);
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeDefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

it('refuses launch without mutating an existing hardlinked local hook-settings target', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-hook-hardlink-refusal-')));
  const repo = makeRepo(root);
  const external = path.join(root, 'external-settings');
  writeFileSync(external, 'external-sentinel');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'hook-hardlink-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;
  const manager = new WorktreeManager(repo);
  Object.defineProperty(manager, 'bootstrapEnvFiles', {
    value: async (workspacePath: string) => {
      mkdirSync(path.join(workspacePath, '.claude'), { recursive: true });
      linkSync(external, path.join(workspacePath, '.claude', 'settings.local.json'));
    },
  });

  await expect(manager.create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  })).rejects.toThrow(/refuses to replace existing \.claude\/settings\.local\.json/);

  expect(readFileSync(external, 'utf8')).toBe('external-sentinel');
  expect(existsSync(path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId))).toBe(false);
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeUndefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

it('refuses launch without copying env bytes into a replaced final target', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-env-target-refusal-')));
  const repo = makeRepo(root);
  writeFileSync(path.join(repo, '.env'), 'trusted-secret');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  let admitted = '';
  vi.doMock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
    return {
      ...actual,
      createPinnedWorkspaceBinding: async (
        workspacePath: string,
        identity: Parameters<typeof actual.createPinnedWorkspaceBinding>[1],
        relativePath: string,
        input: Parameters<typeof actual.createPinnedWorkspaceBinding>[3],
      ) => actual.createPinnedWorkspaceBinding(workspacePath, identity, relativePath, input, async (segment) => {
        if (relativePath !== '.env' || segment !== 'copy-file-opened') return;
        const target = path.join(workspacePath, '.env');
        admitted = `${target}-admitted`;
        renameSync(target, admitted);
        writeFileSync(target, 'external-sentinel');
      }),
    };
  });
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'env-target-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    envFiles: ['.env'],
    envMode: 'copy',
    isolationPreference: 'git-worktree',
  })).rejects.toThrow('copied target is not exclusively linked');

  const workspace = path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId);
  expect(readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('external-sentinel');
  expect(readFileSync(admitted, 'utf8')).toBe('');
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeDefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

it('refuses launch when a bootstrapped env symlink is replaced before its receipt', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-env-symlink-refusal-')));
  const repo = makeRepo(root);
  const source = path.join(repo, '.env');
  writeFileSync(source, 'trusted-secret');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  let admitted = '';
  vi.doMock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
    return {
      ...actual,
      createPinnedWorkspaceBinding: async (
        workspacePath: string,
        identity: Parameters<typeof actual.createPinnedWorkspaceBinding>[1],
        relativePath: string,
        input: Parameters<typeof actual.createPinnedWorkspaceBinding>[3],
      ) => actual.createPinnedWorkspaceBinding(workspacePath, identity, relativePath, input, async (segment) => {
        if (relativePath !== '.env' || segment !== 'symlink-created') return;
        const target = path.join(workspacePath, '.env');
        admitted = `${target}-admitted`;
        renameSync(target, admitted);
        writeFileSync(target, 'external-sentinel');
      }),
    };
  });
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'env-symlink-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    envFiles: ['.env'],
    envMode: 'symlink',
    isolationPreference: 'git-worktree',
  })).rejects.toThrow('symlink target changed before its receipt');

  expect(readFileSync(path.join(path.dirname(admitted), '.env'), 'utf8')).toBe('external-sentinel');
  expect(readlinkSync(admitted)).toBe(source);
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeDefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

it('refuses launch and retains authority when the final hydrated-cache publish is replaced', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-cache-publish-refusal-')));
  const repo = makeRepo(root);
  mkdirSync(path.join(repo, '.next', 'cache'), { recursive: true });
  writeFileSync(path.join(repo, '.next', 'cache', 'trusted'), 'trusted-cache');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  vi.doMock('@/lib/worktree/apfs', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
    getApfsCowCapability: vi.fn(async () => ({
      macos: true, apfs: true, sameVolume: true, canCowClone: true,
    })),
  }));
  let admitted = '';
  const delegatedHydrationModes: string[] = [];
  vi.doMock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
    return {
      ...actual,
      createPinnedWorkspaceBinding: async (
        workspacePath: string,
        identity: Parameters<typeof actual.createPinnedWorkspaceBinding>[1],
        relativePath: string,
        input: Parameters<typeof actual.createPinnedWorkspaceBinding>[3],
      ) => {
        // This fixture targets copy hooks even when native directory cloning works.
        if (input.mode === 'clone-tree') return 'unsupported';
        delegatedHydrationModes.push(input.mode);
        return actual.createPinnedWorkspaceBinding(workspacePath, identity, relativePath, input, async (segment) => {
          if (relativePath !== '.next/cache' || segment !== 'target-created') return;
          const target = path.join(workspacePath, '.next', 'cache');
          admitted = `${target}-admitted`;
          renameSync(target, admitted);
          mkdirSync(target);
          writeFileSync(path.join(target, 'unrelated-sentinel'), 'preserve');
        });
      },
    };
  });
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'cache-publish-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    isolationPreference: 'apfs-cow-clone',
  })).rejects.toThrow('hydration target changed before population');

  const workspace = path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId);
  expect(readFileSync(path.join(workspace, '.next', 'cache', 'unrelated-sentinel'), 'utf8'))
    .toBe('preserve');
  expect(readdirSync(admitted)).toEqual([]);
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeDefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
  expect(delegatedHydrationModes).toEqual(['copy-tree']);
}, 60_000);

it('refuses launch and retains authority when direct cache hydration fails after a partial copy', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-cache-partial-refusal-')));
  const repo = makeRepo(root);
  mkdirSync(path.join(repo, '.next', 'cache'), { recursive: true });
  writeFileSync(path.join(repo, '.next', 'cache', 'a-trusted'), 'trusted-cache');
  const failingSource = path.join(repo, '.next', 'cache', 'b-fail');
  writeFileSync(failingSource, 'must-not-launch');
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  configureManagedWorktreeRoot(root);
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  mockObservedStorage();
  vi.doMock('@/lib/worktree/apfs', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
    getApfsCowCapability: vi.fn(async () => ({
      macos: true, apfs: true, sameVolume: true, canCowClone: true,
    })),
  }));
  const delegatedHydrationModes: string[] = [];
  vi.doMock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
    let sourceSteps = 0;
    return {
      ...actual,
      createPinnedWorkspaceBinding: async (
        workspacePath: string,
        identity: Parameters<typeof actual.createPinnedWorkspaceBinding>[1],
        relativePath: string,
        input: Parameters<typeof actual.createPinnedWorkspaceBinding>[3],
      ) => {
        // This fixture targets copy hooks even when native directory cloning works.
        if (input.mode === 'clone-tree') return 'unsupported';
        delegatedHydrationModes.push(input.mode);
        return actual.createPinnedWorkspaceBinding(workspacePath, identity, relativePath, input, async (segment) => {
          if (relativePath !== '.next/cache' || segment !== 'source') return;
          sourceSteps += 1;
          if (sourceSteps === 2) unlinkSync(failingSource);
        });
      },
    };
  });
  const { closeDb } = await import('@/lib/db');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout, WORKTREE_INDEX_EXCLUSION_SUFFIX } = await import('@/lib/worktree/root-layout');
  const id = 'cache-partial-refusal';
  const worktreeId = `${id}${WORKTREE_INDEX_EXCLUSION_SUFFIX}`;

  await expect(new WorktreeManager(repo).create({
    agentType: 'codex',
    taskName: id,
    baseBranch: 'main',
    branchName: `inline/${id}`,
    managed: true,
    skipSetup: true,
    isolationPreference: 'apfs-cow-clone',
  })).rejects.toBeInstanceOf(Error);

  const workspace = path.join(resolveWorktreeRootLayout(repo).primaryBase, worktreeId);
  expect(readFileSync(path.join(workspace, '.next', 'cache', 'a-trusted'), 'utf8'))
    .toBe('trusted-cache');
  await expect(withWorktreeMetaTransaction(
    repo,
    async (transaction) => (await transaction.readAll())[worktreeId]?.materializationIdentity,
  )).resolves.toBeDefined();
  closeDb();
  rmSync(root, { recursive: true, force: true });
  expect(delegatedHydrationModes).toEqual(['copy-tree']);
}, 60_000);
