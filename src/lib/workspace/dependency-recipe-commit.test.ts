import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real Git fixtures, without the production credential-store child policy.
vi.mock('@/lib/providers/child-process', async () => {
  const native = await import('node:child_process');
  return { ...native, execFileReadOnly: native.execFile, spawnReadOnly: native.spawn, execFileSyncReadOnly: native.execFileSync };
});

import {
  deriveDependencyInstallRecipe,
  deriveDependencyInstallRecipeAtCommit,
  type SupportedPackageManager,
} from './dependency-install';

const roots: string[] = [];
const versions = { npm: '11.8.0', pnpm: '10.6.5', yarn: '4.6.0', bun: '1.2.5' };
const locks = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lockb' };
const commands = { npm: 'npm ci', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --immutable', bun: 'bun install --frozen-lockfile' };
const options = {
  resolveVersion: async (manager: SupportedPackageManager) => versions[manager],
  runtimeFacts: { abi: '127', platform: 'darwin' as const, architecture: 'arm64' },
};
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function put(root: string, name: string, bytes: string | Buffer): void {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), bytes);
}
function commit(root: string): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}
function fixture(manager: SupportedPackageManager = 'npm', objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-immutable-recipe-'));
  roots.push(root);
  git(root, 'init', '-q', `--object-format=${objectFormat}`);
  put(root, 'package.json', JSON.stringify({
    name: 'immutable-recipe', packageManager: `${manager}@${versions[manager]}`,
    o8DependencyClone: { lifecycleInputs: ['scripts/postinstall.dat'] },
  }));
  put(root, locks[manager], Buffer.from([0, 255, 195, 40, 10]));
  put(root, 'scripts/postinstall.dat', Buffer.from([255, 0, 1, 128]));
  put(root, 'patches/dependency.patch', 'patch-v1\n');
  put(root, 'packages/child/package.json', '{"name":"child"}');
  put(root, 'README.md', 'docs-v1\n');
  if (manager === 'yarn') {
    put(root, '.yarnrc.yml', 'yarnPath: tools/yarn.cjs\n');
    put(root, 'tools/yarn.cjs', 'module.exports = {};\n');
  } else put(root, '.npmrc', 'audit=false\n');
  commit(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('immutable commit dependency recipe', () => {
  it.each(['npm', 'pnpm', 'yarn', 'bun'] as const)('matches clean %s recipes at two commits and ignores staged, dirty, and untracked donor inputs', async (manager) => {
    const root = fixture(manager);
    const first = git(root, 'rev-parse', 'HEAD');
    const expectedFirst = await deriveDependencyInstallRecipe(root, commands[manager], options);
    expect(await deriveDependencyInstallRecipeAtCommit(root, first, commands[manager], options)).toEqual(expectedFirst);
    put(root, 'README.md', 'docs-v2\n');
    put(root, 'patches/dependency.patch', 'patch-v2\n');
    const second = commit(root);
    const expectedSecond = await deriveDependencyInstallRecipe(root, commands[manager], options);
    expect(expectedSecond.key).not.toBe(expectedFirst.key);
    put(root, locks[manager], 'dirty lock');
    git(root, 'add', locks[manager]);
    put(root, 'package.json', 'invalid donor manifest');
    put(root, 'patches/dependency.patch', 'dirty patch');
    put(root, 'scripts/postinstall.dat', 'dirty lifecycle input');
    put(root, 'README.md', 'dirty unrelated file');
    if (manager === 'yarn') put(root, 'tools/yarn.cjs', 'dirty yarn executable');
    put(root, '.env.local', 'TOKEN=untracked-secret\n');
    put(root, '.pnpmfile.cjs', 'process.env.DO_NOT_READ\n');
    const beforeStatus = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
    const beforeIndex = readFileSync(path.join(root, '.git/index'));
    const beforeManifest = readFileSync(path.join(root, 'package.json'));
    expect(await deriveDependencyInstallRecipeAtCommit(root, first, commands[manager], options)).toEqual(expectedFirst);
    expect(await deriveDependencyInstallRecipeAtCommit(root, second, commands[manager], options)).toEqual(expectedSecond);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(second);
    expect(git(root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(beforeStatus);
    expect(readFileSync(path.join(root, '.git/index'))).toEqual(beforeIndex);
    expect(readFileSync(path.join(root, 'package.json'))).toEqual(beforeManifest);
  });

  it('matches a SHA-256 Git repository recipe', async () => {
    const root = fixture('npm', 'sha256');
    const sha = git(root, 'rev-parse', 'HEAD');
    expect(sha).toHaveLength(64);
    expect(await deriveDependencyInstallRecipeAtCommit(root, sha, commands.npm, options))
      .toEqual(await deriveDependencyInstallRecipe(root, commands.npm, options));
  });

  it('does not follow Git replacement objects for the pinned commit', async () => {
    const root = fixture();
    const first = git(root, 'rev-parse', 'HEAD');
    const expected = await deriveDependencyInstallRecipe(root, commands.npm, options);
    put(root, 'patches/dependency.patch', 'replacement patch\n');
    const second = commit(root);
    git(root, 'replace', first, second);
    expect(await deriveDependencyInstallRecipeAtCommit(root, first, commands.npm, options)).toEqual(expected);
  });

  it.each([
    ['.npmrc', '//registry.npmjs.org/:_authToken=committed-secret\n', /Credential-bearing/],
    ['.npmrc', 'cache=../outside\n', /redirect/],
    ['.pnpmfile.cjs', 'module.exports = process.env.SECRET\n', /Credential-bearing/],
  ] as const)('preserves tracked config checks for %s', async (name, content, reason) => {
    const root = fixture();
    put(root, name, content);
    await expect(deriveDependencyInstallRecipeAtCommit(root, commit(root), commands.npm, options)).rejects.toThrow(reason);
  });

  it('rejects symlink Yarn executable config targets', async () => {
    const root = fixture('yarn');
    rmSync(path.join(root, 'tools/yarn.cjs'));
    symlinkSync('../README.md', path.join(root, 'tools/yarn.cjs'));
    await expect(deriveDependencyInstallRecipeAtCommit(root, commit(root), commands.yarn, options)).rejects.toThrow(/regular file/);
  });

  it('derives an older commit while a newer commit changes the package-manager contract', async () => {
    const root = fixture();
    const first = git(root, 'rev-parse', 'HEAD');
    const expected = await deriveDependencyInstallRecipe(root, commands.npm, options);
    put(root, 'package.json', '{"packageManager":"pnpm@10.6.5"}');
    rmSync(path.join(root, locks.npm));
    put(root, locks.pnpm, 'pnpm-lock\n');
    commit(root);
    expect(await deriveDependencyInstallRecipeAtCommit(root, first, commands.npm, options)).toEqual(expected);
  });

  it.each(['HEAD', 'main', '-'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(40)])('refuses a non-existent or non-immutable commit %s', async (value) => {
    const root = fixture();
    await expect(deriveDependencyInstallRecipeAtCommit(root, value, commands.npm, options)).rejects.toThrow();
  });

  it('rejects a tree object supplied as the commit identity', async () => {
    const root = fixture();
    await expect(deriveDependencyInstallRecipeAtCommit(root, git(root, 'rev-parse', 'HEAD^{tree}'), commands.npm, options)).rejects.toThrow();
  });

  it.each(['package.json', 'package-lock.json', '.npmrc', 'patches/dependency.patch', 'scripts/postinstall.dat'])('rejects symlink recipe input %s', async (name) => {
    const root = fixture();
    rmSync(path.join(root, name));
    symlinkSync('README.md', path.join(root, name));
    const sha = commit(root);
    await expect(deriveDependencyInstallRecipeAtCommit(root, sha, commands.npm, options)).rejects.toThrow(/regular file|unsupported/);
  });

  it('rejects unsupported Git tree entries', async () => {
    const root = fixture();
    const sha = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/submodule`);
    git(root, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'gitlink');
    await expect(deriveDependencyInstallRecipeAtCommit(root, git(root, 'rev-parse', 'HEAD'), commands.npm, options)).rejects.toThrow(/unsupported/i);
  });

  it.each(['file:packages/child', 'link:packages/child', 'workspace:*'])('fails closed for unsupported local dependency %s', async (specifier) => {
    const root = fixture();
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    put(root, 'package.json', JSON.stringify({ ...manifest, dependencies: { child: specifier } }));
    await expect(deriveDependencyInstallRecipeAtCommit(root, commit(root), commands.npm, options)).rejects.toThrow(/local dependency|workspace dependency/i);
  });
});
