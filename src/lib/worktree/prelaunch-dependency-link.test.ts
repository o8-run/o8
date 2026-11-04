import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { buildPiWriteHelper } from '../../../tests/helpers/pi-write-helper';
import { WorktreeManager } from './manager';

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

const execFileAsync = promisify(execFile);
const roots: string[] = [];

// Supervised dependency installs run through the Pi write helper, a cold cargo build; build it
// once per file, outside any test's own timeout.
beforeAll(() => { if (process.platform !== 'win32') buildPiWriteHelper(); }, 600_000);

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'o8 test',
      GIT_AUTHOR_EMAIL: 'test@o8.local',
      GIT_COMMITTER_NAME: 'o8 test',
      GIT_COMMITTER_EMAIL: 'test@o8.local',
    },
  });
}

async function npm(cwd: string, args: string[]) {
  const invocation = cliInvocation('npm', args);
  await execFileAsync(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development' },
  });
}

async function createFixture(options: { lockfile: boolean; typescript?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), 'o8-local-deps-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  await execFileAsync('git', ['init', '--bare', origin]);
  await execFileAsync('git', ['clone', origin, repo]);
  await git(repo, ['checkout', '-b', 'main']);

  const dependencyName = options.typescript ? 'fixture-typescript' : 'local-dep';
  const dependencyDir = path.join(repo, 'dep');
  await mkdir(path.join(dependencyDir, 'bin'), { recursive: true });
  await writeFile(
    path.join(dependencyDir, 'package.json'),
    JSON.stringify({
      name: dependencyName,
      version: '1.0.0',
      ...(options.typescript ? { bin: { tsc: 'bin/tsc.js' } } : {}),
    }),
  );
  if (options.typescript) {
    const tsc = path.join(dependencyDir, 'bin', 'tsc.js');
    await writeFile(tsc, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (fs.lstatSync('node_modules').isSymbolicLink()) process.exit(41);",
      '',
    ].join('\n'));
    await chmod(tsc, 0o755);
    await writeFile(path.join(repo, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n');
  }
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: { [dependencyName]: 'file:./dep' },
    }),
  );
  if (options.lockfile) {
    await npm(repo, ['install', '--package-lock-only', '--ignore-scripts']);
  }
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'fixture']);
  await git(repo, ['push', '-u', 'origin', 'main']);
  return { root, repo };
}

async function addHostSentinel(repo: string) {
  const sentinel = path.join(repo, 'node_modules', 'host-only', 'sentinel.js');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'module.exports = true;\n');
  return sentinel;
}

async function linkDirectory(source: string, target: string) {
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  delete process.env.O8_WORKTREE_ROOT;
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe('prelaunch dependency isolation', () => {
  it('installs and typechecks with worktree-local dependencies', async () => {
    const { root, repo } = await createFixture({ lockfile: true, typescript: true });
    const hostSentinel = await addHostSentinel(repo);
    process.env.O8_WORKTREE_ROOT = path.join(root, 'managed-worktrees');

    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'local dependency resolution',
      branchName: 'worktree/codex/local-dependency-resolution',
      baseBranch: 'main',
    });

    const worktreeModules = path.join(worktree.path, 'node_modules');
    expect((await lstat(worktreeModules)).isDirectory()).toBe(true);
    expect((await lstat(worktreeModules)).isSymbolicLink()).toBe(false);
    expect(await lstat(path.join(worktreeModules, 'fixture-typescript')).then(() => true)).toBe(true);
    expect(await lstat(hostSentinel).then(() => true)).toBe(true);
    expect(path.dirname(worktree.path)).not.toBe(path.dirname(repo));

    // This is the exact destructive path from #1764: a worker is free to run
    // npm ci in its own directory, and the operator checkout must survive it.
    await npm(worktree.path, ['ci', '--prefer-offline']);
    expect(await lstat(hostSentinel).then(() => true)).toBe(true);
  }, 120_000);
});

describe('legacy linked node_modules migration', () => {
  it('unlinks before npm ci and preserves the host tree', async () => {
    const { repo } = await createFixture({ lockfile: true });
    const hostSentinel = await addHostSentinel(repo);
    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'legacy lockfile link',
      skipSetup: true,
    });
    const worktreeModules = path.join(worktree.path, 'node_modules');
    await linkDirectory(path.join(repo, 'node_modules'), worktreeModules);

    await (manager as unknown as { runSetup(p: string): Promise<void> }).runSetup(worktree.path);

    expect(await lstat(hostSentinel).then(() => true)).toBe(true);
    expect((await lstat(worktreeModules)).isDirectory()).toBe(true);
    expect((await lstat(worktreeModules)).isSymbolicLink()).toBe(false);
    expect(await lstat(path.join(worktreeModules, 'local-dep')).then(() => true)).toBe(true);
  }, 120_000);

  // Dependency installs are driven by a detected package manager, so a
  // repository with neither a lockfile nor a packageManager declaration
  // installs nothing. The legacy link still has to go: leaving it would let
  // the packet's own npm reach the operator's node_modules.
  it('unlinks and preserves the host tree when there is nothing to install', async () => {
    const { repo } = await createFixture({ lockfile: false });
    const hostSentinel = await addHostSentinel(repo);
    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'legacy no-lockfile link',
      skipSetup: true,
    });
    const worktreeModules = path.join(worktree.path, 'node_modules');
    await linkDirectory(path.join(repo, 'node_modules'), worktreeModules);

    await (manager as unknown as { runSetup(p: string): Promise<void> }).runSetup(worktree.path);

    expect(await lstat(hostSentinel).then(() => true)).toBe(true);
    expect(await lstat(path.join(repo, 'node_modules', 'host-only')).then(() => true)).toBe(true);
    expect(await lstat(worktreeModules).then(() => true).catch(() => false)).toBe(false);
  }, 120_000);
});

describe('prelaunch typecheck skip', () => {
  it('creates the worktree when the repo has no TypeScript at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'o8-prelaunch-skip-'));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    await execFileAsync('git', ['init', '--bare', origin]);
    await execFileAsync('git', ['clone', origin, repo]);
    await git(repo, ['checkout', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'fixture']);
    await git(repo, ['push', '-u', 'origin', 'main']);

    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'no typescript in this repo',
    });

    expect((await lstat(worktree.path)).isDirectory()).toBe(true);
  }, 60_000);
});
