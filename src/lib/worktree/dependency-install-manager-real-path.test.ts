import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { RepoSetupConfig } from '@/lib/repos/types';
import type { Lane } from '@/lib/lane/types';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { parkWorkspace } from '@/lib/workspace/hibernator';
import { repoSetupBoundRecipeKey, repoSetupCopyBindingRequirements } from '@/lib/workspace/repo-setup';
import { restoreWorkspace } from '@/lib/workspace/restorer';
import { readDependencySeedImage } from '@/lib/workspace/dependency-seed-registry';
import { scanWorkspaceStorageState } from '@/lib/workspace/storage-verifier';
import { WorktreeManager } from './manager';

const roots: string[] = [];

beforeEach(() => {
  process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createFixture(): { repo: string; setup: RepoSetupConfig } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-dependency-recipe-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'o8-test');
  git(repo, 'config', 'user.email', 'test@invalid');
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'manager-dependency-fixture',
    version: '1.0.0',
    private: true,
    packageManager: `npm@${npmVersion}`,
    scripts: {
      postinstall: "node -e \"const fs=require('fs');fs.mkdirSync('node_modules/postinstall-private',{recursive:true});fs.writeFileSync('node_modules/postinstall-private/sentinel',process.cwd()+'|workspace-private\\n');fs.mkdirSync('node_modules/.bin',{recursive:true});fs.writeFileSync('node_modules/.bin/fixture-gate','#!/bin/sh\\necho ready\\n');fs.chmodSync('node_modules/.bin/fixture-gate',0o755)\"",
    },
  }));
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: repo,
    stdio: 'ignore',
  });
  git(repo, 'add', '.gitignore', 'package.json', 'package-lock.json');
  git(repo, 'commit', '-qm', 'fixture');
  return {
    repo,
    setup: {
      envMode: 'skip',
      envFiles: [],
      installCommand: 'npm ci --prefer-offline',
      installOnCreateWorkspace: true,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'git-worktree',
    },
  };
}

function expectPostinstallSentinel(workspacePath: string, marker = 'workspace-private'): void {
  const value = readFileSync(
    path.join(workspacePath, 'node_modules', 'postinstall-private', 'sentinel'),
    'utf8',
  ).trimEnd();
  const separator = value.lastIndexOf('|');
  expect(separator).toBeGreaterThan(0);
  expect(realpathSync(value.slice(0, separator))).toBe(realpathSync(workspacePath));
  expect(value.slice(separator + 1)).toBe(marker);
}

afterEach(() => {
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_APFS_COW_WORKSPACES;
  delete process.env.O8_APFS_DEPENDENCY_IMAGES;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed creation dependency recipe real path', () => {
  it.skipIf(process.platform !== 'darwin')(
    'gives a repo with no saved isolation setting an APFS clone, unless the clone flag is 0 (#5079)',
    async () => {
      // The caller passes no isolationPreference, as for a repo whose setup was never saved.
      const { repo, setup } = createFixture();
      const unsaved: RepoSetupConfig = { ...setup, installOnCreateWorkspace: false };
      process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
      process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-default-isolation-root-'));
      roots.push(process.env.O8_WORKTREE_ROOT);
      const manager = new WorktreeManager(repo);
      Object.defineProperty(manager, 'injectSafetyHooks', { value: async () => {} });
      const created: string[] = [];
      try {
        const clone = await manager.create({ agentType: 'codex', taskName: 'default isolation', baseBranch: 'main', repoSetup: unsaved });
        created.push(clone.id);
        expect(clone.isolationKind).toBe('apfs-cow-clone');

        process.env.O8_APFS_COW_WORKSPACES = '0';
        const worktree = await manager.create({ agentType: 'codex', taskName: 'opted out isolation', baseBranch: 'main', repoSetup: unsaved });
        created.push(worktree.id);
        expect(worktree.isolationKind).toBe('git-worktree');
      } finally {
        for (const id of created) await manager.cleanup(id, { force: true, deleteBranch: true });
      }
    },
    120_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'reuses lifecycle-disabled APFS dependencies and falls back when the recipe changes',
    async () => {
      const { repo, setup } = createFixture();
      setup.installCommand = 'npm ci --prefer-offline --ignore-scripts';
      process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
      process.env.O8_APFS_COW_WORKSPACES = '1';
      process.env.O8_APFS_DEPENDENCY_IMAGES = '1';
      process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-apfs-dependency-root-'));
      roots.push(process.env.O8_WORKTREE_ROOT);
      const manager = new WorktreeManager(repo);
      Object.defineProperty(manager, 'injectSafetyHooks', { value: async () => {} });
      const createdIds: string[] = [];
      try {
        const coldStartedAt = performance.now();
        const first = await manager.create({
          agentType: 'codex',
          taskName: 'lifecycle dependency image seed',
          baseBranch: 'main',
          repoSetup: { ...setup, workspaceIsolationPreference: 'apfs-cow-clone' },
        });
        createdIds.push(first.id);
        const coldMs = Math.round(performance.now() - coldStartedAt);
        expect(first.isolationKind).toBe('apfs-cow-clone');
        expect(first.dependencyMaterialization?.mode).toBe('native');
        const readyDeadline = Date.now() + 90_000;
        while (readDependencySeedImage(first.dependencyRecipeKey!)?.state !== 'ready') {
          if (Date.now() >= readyDeadline) throw new Error('First lifecycle-disabled dependency image was not published.');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const reuseStartedAt = performance.now();
        const second = await manager.create({
          agentType: 'codex',
          taskName: 'lifecycle dependency image reuse',
          baseBranch: 'main',
          repoSetup: { ...setup, workspaceIsolationPreference: 'apfs-cow-clone' },
        });
        createdIds.push(second.id);
        const reuseMs = Math.round(performance.now() - reuseStartedAt);
        console.info(`[apfs-dependency-disabled] first=${coldMs}ms reuse=${reuseMs}ms`);
        expect(second.dependencyMaterialization).toMatchObject({
          mode: 'image',
          recipeKey: first.dependencyRecipeKey,
        });
        const secondNodeModules = path.join(second.path, 'node_modules');
        expect(lstatSync(secondNodeModules).isSymbolicLink()).toBe(false);
        expect(existsSync(
          path.join(second.path, 'node_modules', 'postinstall-private', 'sentinel'),
        )).toBe(false);
        writeFileSync(
          path.join(second.path, 'node_modules', 'second-only-mutation'),
          'second-only-mutation\n',
        );
        expect(existsSync(
          path.join(first.path, 'node_modules', 'second-only-mutation'),
        )).toBe(false);

        const manifestPath = path.join(repo, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          version: string;
          scripts: Record<string, string>;
        };
        manifest.version = '1.0.1';
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
          cwd: repo,
          stdio: 'ignore',
        });
        git(repo, 'add', 'package.json', 'package-lock.json');
        git(repo, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'recipe drift');
        const fallback = await manager.create({
          agentType: 'codex',
          taskName: 'lifecycle dependency recipe fallback',
          baseBranch: 'main',
          repoSetup: { ...setup, workspaceIsolationPreference: 'apfs-cow-clone' },
        });
        createdIds.push(fallback.id);
        expect(fallback.dependencyMaterialization?.mode).toBe('native');
        expect(fallback.dependencyRecipeKey).not.toBe(first.dependencyRecipeKey);
        expect(existsSync(
          path.join(fallback.path, 'node_modules', 'postinstall-private', 'sentinel'),
        )).toBe(false);
        const fallbackReadyDeadline = Date.now() + 90_000;
        while (readDependencySeedImage(fallback.dependencyRecipeKey!)?.state !== 'ready') {
          if (Date.now() >= fallbackReadyDeadline) {
            throw new Error('Changed lifecycle-disabled dependency image was not published.');
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        let cleanupError: unknown;
        for (const id of createdIds.reverse()) {
          try {
            await manager.cleanup(id, { force: true, deleteBranch: true });
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (cleanupError) throw cleanupError;
      }
    },
    180_000,
  );

  it('executes the saved npm contract, persists its recipe, and isolates postinstall output', async () => {
    const { repo, setup } = createFixture();
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-dependency-root-'));
    roots.push(process.env.O8_WORKTREE_ROOT);
    const manager = new WorktreeManager(repo);

    const coldStartedAt = performance.now();
    const first = await manager.create({
      agentType: 'codex',
      taskName: 'dependency recipe first',
      baseBranch: 'main',
      repoSetup: setup,
    });
    const coldMs = Math.round(performance.now() - coldStartedAt);
    const nativeCacheStartedAt = performance.now();
    const second = await manager.create({
      agentType: 'codex',
      taskName: 'dependency recipe second',
      baseBranch: 'main',
      repoSetup: setup,
    });
    const nativeCacheMs = Math.round(performance.now() - nativeCacheStartedAt);
    console.info(`[thin-workspaces] npm cold=${coldMs}ms native-cache=${nativeCacheMs}ms`);

    expect(first.dependencyRecipeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(second.dependencyRecipeKey).toBe(first.dependencyRecipeKey);
    expect((await manager.get(first.id))?.dependencyRecipeKey).toBe(first.dependencyRecipeKey);
    const relativeSentinel = path.join('node_modules', 'postinstall-private', 'sentinel');
    expectPostinstallSentinel(first.path);
    expectPostinstallSentinel(second.path);
    expect(existsSync(path.join(repo, relativeSentinel))).toBe(false);

    writeFileSync(path.join(first.path, relativeSentinel), 'first-only-mutation\n');
    expectPostinstallSentinel(second.path);
    expect(existsSync(path.join(repo, relativeSentinel))).toBe(false);
  }, 120_000);

  it('runs the saved install when stale completion markers already exist', async () => {
    const { repo, setup } = createFixture();
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-stale-dependency-root-'));
    roots.push(process.env.O8_WORKTREE_ROOT);
    const manager = new WorktreeManager(repo);
    const created = await manager.create({
      agentType: 'codex',
      taskName: 'stale dependency marker',
      baseBranch: 'main',
      repoSetup: setup,
      skipSetup: true,
    });
    const staleRoot = path.join(created.path, 'node_modules');
    mkdirSync(path.join(staleRoot, '.bin'), { recursive: true });
    mkdirSync(path.join(staleRoot, 'stale'), { recursive: true });
    writeFileSync(path.join(staleRoot, '.package-lock.json'), '{"stale":true}\n');
    writeFileSync(path.join(staleRoot, 'stale', 'marker'), 'must be replaced\n');

    const recipeKey = await manager.runSetup(created.path, undefined, setup);

    expect(recipeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(staleRoot, 'stale', 'marker'))).toBe(false);
    expectPostinstallSentinel(created.path);
  }, 120_000);

  it('keeps a killed install runtime inside the exact workspace cleanup authority', async () => {
    const { repo, setup } = createFixture();
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-killed-install-root-'));
    roots.push(process.env.O8_WORKTREE_ROOT);
    const manager = new WorktreeManager(repo);
    const created = await manager.create({
      agentType: 'codex',
      taskName: 'killed dependency install',
      baseBranch: 'main',
      repoSetup: setup,
      skipSetup: true,
    });
    const receiptPath = path.join(path.dirname(repo), 'killed-install-receipt.json');
    const outsidePath = path.join(path.dirname(repo), 'unrelated-outside.txt');
    writeFileSync(outsidePath, 'preserve outside\n');
    const runnerPath = path.join(path.dirname(repo), 'killed-install-runner.mts');
    const dependencyInstallUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/dependency-install.ts'),
    ).href;
    writeFileSync(runnerPath, `
      import { writeFileSync } from 'node:fs';
      const dependencyInstall = await import(${JSON.stringify(dependencyInstallUrl)});
      const runDependencyInstall = dependencyInstall.runDependencyInstall
        ?? dependencyInstall.default?.runDependencyInstall;
      const input = JSON.parse(process.env.O8_KILLED_INSTALL_INPUT);
      void runDependencyInstall(input.workspacePath, input.command, {
        cacheRoot: input.cacheRoot,
        run: async (invocation) => {
          writeFileSync(input.receiptPath, JSON.stringify({ home: invocation.env.HOME }));
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        },
      });
    `);
    const child = spawnSync(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
        O8_KILLED_INSTALL_INPUT: JSON.stringify({
          workspacePath: created.path,
          command: setup.installCommand,
          cacheRoot: path.join(path.dirname(repo), 'killed-install-cache'),
          receiptPath,
        }),
      },
      encoding: 'utf8',
    });
    expect(child.signal, JSON.stringify({
      status: child.status,
      error: child.error?.message,
      stdout: child.stdout,
      stderr: child.stderr,
    })).toBe('SIGKILL');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { home: string };
    const runtimeRoot = path.dirname(receipt.home);
    expect(path.relative(created.path, runtimeRoot).startsWith('..')).toBe(false);
    expect(existsSync(runtimeRoot)).toBe(true);

    await expect(manager.cleanup(created.id, { force: true, deleteBranch: true })).resolves.toBe(true);
    expect(existsSync(created.path)).toBe(false);
    expect(readFileSync(outsidePath, 'utf8')).toBe('preserve outside\n');
  }, 120_000);

  it('binds a lock commit made before the first park scan and restores that recipe', async () => {
    const { repo: repoPath, setup } = createFixture();
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-park-order-root-'));
    roots.push(process.env.O8_WORKTREE_ROOT);
    const manager = new WorktreeManager(repoPath);
    const packetId = `dependency-park-order-${Date.now()}`;
    const created = await manager.create({
      agentType: 'codex',
      taskName: 'dependency park order',
      packetId,
      baseBranch: 'main',
      repoSetup: setup,
      skipSetup: true,
    });
    const surfaceId = `dependency-park-order:${packetId}`;
    await manager.linkSession(created.id, surfaceId);
    const repo: RepoRegistryEntry = {
      id: `repo-${packetId}`,
      name: 'dependency park order',
      localPath: repoPath,
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: '2026-08-15T00:00:00.000Z',
      lastOpenedAt: null,
      storagePressureParkingDisabled: false,
      setup,
    };
    const lane: Lane = {
      id: `lane-${packetId}`,
      projectId: null,
      label: 'dependency park order',
      repoPath,
      worktreePath: created.path,
      branch: created.branch,
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey: surfaceId,
      packetId,
      prNumber: null,
      status: 'reviewing',
      ownership: 'managed',
      writerToken: null,
      lastHeartbeatAt: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
      lastEventAt: null,
      lastEventLabel: null,
    };
    let binding: OwnedWorkspaceBindingReceipt = {
      surfaceId,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: null,
        packetId,
        cwd: created.path,
        version: 1,
        verifiedAt: '2026-08-15T00:00:00.000Z',
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    };
    registerOwnedSessionLifecycleHandler({
      runtimeId: 'codex',
      surfaceIdPrefix: `dependency-park-order:${packetId}`,
      commandLabel: 'dependency-park-order-test',
      resolveRoot: () => path.dirname(repoPath),
      sessionState: async () => 'active',
      archiveSession: async () => ({ archived: false, note: 'unused' }),
      getWorkspaceBinding: async () => binding,
      rebindWorkspace: async (_surfaceId, input) => {
        binding = {
          ...binding,
          binding: {
            ...binding.binding,
            repositoryUuid: input.repositoryUuid,
            packetId: input.packetId,
            cwd: path.resolve(input.nextCwd),
            version: binding.binding.version + 1,
          },
        };
        return { status: 'rebound', receipt: binding };
      },
    });
    const processProbe = async (sessionKey: string) => ({
      state: 'quiescent' as const,
      identity: { ownership: 'owned' as const, pidIdentity: 'not_applicable' as const, sessionKey },
      probes: [],
      reasons: [],
      checkedAt: '2026-08-15T00:00:00.000Z',
    });
    const measureStorage = async (target: string) => ({
      availableBytes: existsSync(target) ? 1_000_000 : 2_000_000,
      logicalBytes: existsSync(target) ? 100_000 : null,
      measuredAt: '2026-08-15T00:00:00.000Z',
    });
    let expectedRecipeKey = '';
    let firstScanCount = 0;
    const parked = await parkWorkspace({
      repositoryUuid: repo.id,
      packetId,
      operationId: `${packetId}:park`,
    }, {
      listRepos: async () => [repo],
      findLaneByPacket: () => lane,
      processProbe,
      measureStorage,
      firstScan: async (workspacePath, options) => {
        if (firstScanCount++ === 0) {
          writeFileSync(
            path.join(workspacePath, 'package-lock.json'),
            `${readFileSync(path.join(workspacePath, 'package-lock.json'), 'utf8')}\n`,
          );
          git(workspacePath, 'add', 'package-lock.json');
          git(
            workspacePath,
            '-c', 'user.name=o8-test',
            '-c', 'user.email=test@invalid',
            'commit', '-qm', 'lock before first scan',
          );
          expectedRecipeKey = await repoSetupBoundRecipeKey(
            repo,
            await repoSetupCopyBindingRequirements(repo),
            workspacePath,
          ) ?? '';
        }
        return scanWorkspaceStorageState(workspacePath, options);
      },
    });

    expect(parked, JSON.stringify(parked)).toMatchObject({
      status: 'parked',
      snapshot: { dependencyRecipeKey: expectedRecipeKey },
    });
    const restored = await restoreWorkspace({
      repositoryUuid: repo.id,
      packetId,
      operationId: `${packetId}:restore`,
    }, {
      listRepos: async () => [repo],
      findLaneByPacket: () => lane,
      processProbe,
    });
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored' });
    expectPostinstallSentinel(created.path);
  }, 180_000);
});
