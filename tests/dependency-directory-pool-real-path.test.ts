import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeDependencyInstall } from '@/lib/workspace/dependency-materializer';
import { dependencyDirectoryPoolStatus, waitForDependencyDirectoryPool } from '@/lib/workspace/dependency-directory-pool';
import * as storage from '@/lib/worktree/storage-telemetry';
import * as leaf from '@/lib/worktree/materialization-leaf-io';
import { getDataDir } from '@/lib/data-dir-migration';

const roots: string[] = [];
afterEach(async () => {
  await waitForDependencyDirectoryPool();
  vi.restoreAllMocks();
  rmSync(path.join(getDataDir(), 'dependency-directory-pool-v1'), { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function installBaseline(source: string, command = 'npm ci --ignore-scripts') {
  await materializeDependencyInstall(source, command, { platform: 'darwin', resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run: async () => {} });
}

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-directory-clone-')));
  roots.push(root);
  const source = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const packages = { 'node_modules/fixture': { version: '1.0.0' } };
  writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  mkdirSync(path.join(source, 'tools'));
  writeFileSync(path.join(source, 'tools/package.json'), '{"name":"unrelated-tool"}');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
  git('clone', '--local', '-q', source, workspace);
  mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(source, 'node_modules', 'fixture'));
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0","bin":"../tool.js"}');
  writeFileSync(path.join(source, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  writeFileSync(path.join(source, 'node_modules', 'tool.js'), 'private\n');
  symlinkSync('../tool.js', path.join(source, 'node_modules', '.bin', 'tool'));
  await installBaseline(source);
  return { root, source, workspace };
}

const options = (source: string) => ({ cloneSourceWorkspace: source, useDependencyPool: true,
  resolveVersion: async () => '11.8.0', env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
  run: async () => { throw new Error('Unexpected installer fallback'); },
});

async function warm(source: string, root: string) {
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', '--local', '-q', source, seed]);
  await materializeDependencyInstall(seed, 'npm ci --ignore-scripts', options(source));
  await waitForDependencyDirectoryPool();
}

it.skipIf(process.platform !== 'darwin')('consumes distinct validated trees once and refills within the slot and byte bounds', async () => {
  const { source, workspace, root } = await fixture();
  await warm(source, root);
  expect(await dependencyDirectoryPoolStatus()).toMatchObject({ state: 'ready', readyTrees: 2 });
  const second = path.join(root, 'second');
  execFileSync('git', ['clone', '--local', '-q', source, second]);
  const clone = vi.spyOn(leaf, 'clonePinnedWorkspaceDirectory');
  const selections: string[] = [];
  await Promise.all([workspace, second].map((target) => materializeDependencyInstall(target, 'npm ci --ignore-scripts', {
    ...options(source), onSelection: async (selection) => { selections.push(selection.path); },
  })));
  expect(selections).toEqual(['dependency-pool', 'dependency-pool']);
  expect(clone.mock.calls.filter(([target]) => target === workspace || target === second)).toHaveLength(0);
  const file = 'node_modules/tool.js';
  const inodes = [source, workspace, second].map((dir) => lstatSync(path.join(dir, file)).ino);
  expect(new Set(inodes).size).toBe(3);
  writeFileSync(path.join(workspace, file), 'worker');
  expect(readFileSync(path.join(source, file), 'utf8')).toBe('private\n');
  expect(readFileSync(path.join(second, file), 'utf8')).toBe('private\n');
  await waitForDependencyDirectoryPool();
  const status = await dependencyDirectoryPoolStatus();
  expect(status.readyTrees).toBe(2);
  expect(status.logicalBytes).toBeLessThanOrEqual(status.policy.maxTrees * status.policy.maxTreeBytes);
}, 180_000);

it.skipIf(process.platform !== 'darwin').each(['lockfile', 'lifecycle'])('refuses a ready tree after changed %s inputs through materialization', async (kind) => {
  const { source, workspace, root } = await fixture();
  await warm(source, root);
  if (kind === 'lockfile') writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  else {
    writeFileSync(path.join(workspace, 'setup.js'), '// changed lifecycle input');
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', o8DependencyClone: { lifecycleInputs: ['setup.js'] } }));
    execFileSync('git', ['add', 'package.json', 'setup.js'], { cwd: workspace });
  }
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'changed dependency input'], { cwd: workspace });
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  const selected = vi.fn();
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', { ...options(source), run, onSelection: selected });
  expect(run).toHaveBeenCalledOnce();
  expect(selected).toHaveBeenCalledWith({ path: 'native-install', reason: 'source-inputs-mismatch' });
}, 180_000);

it.skipIf(process.platform !== 'darwin')('reuses ready trees across source-only commits with the declared lifecycle identity', async () => {
  const { source, workspace, root } = await fixture();
  await warm(source, root);
  writeFileSync(path.join(source, 'README.md'), 'source-only change');
  execFileSync('git', ['add', 'README.md'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'source only'], { cwd: source });
  const selected = vi.fn();
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', { ...options(source), onSelection: selected });
  expect(result.receipt.source).toBe('dependency-pool');
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ path: 'dependency-pool', reason: 'matching-inputs' }));
}, 180_000);

it.skipIf(process.platform !== 'darwin')('recovers a slot claimed by an exited consumer and refills it', async () => {
  const { source, workspace, root } = await fixture();
  await warm(source, root);
  const slot = path.join(getDataDir(), 'dependency-directory-pool-v1/slot-0');
  execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '--input-type=module', '-e', `
    const ownerModule = await import('./src/lib/workspace/dependency-pool-owner.ts');
    const identityModule = await import('./src/lib/worktree/materialization-identity.ts');
    const owner = ownerModule.default ?? ownerModule;
    const identity = identityModule.default ?? identityModule;
    if (!await owner.claimDependencyPoolSlot(await identity.captureWorktreeMaterializationIdentity(process.argv[1]))) throw new Error('Claim failed');
  `, slot], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', options(source));
  expect(result.receipt.source).toBe('dependency-pool');
  await waitForDependencyDirectoryPool();
  expect(await dependencyDirectoryPoolStatus()).toMatchObject({ state: 'ready', readyTrees: 2 });
}, 180_000);

it.skipIf(process.platform !== 'darwin')('preserves an occupied destination during pool publication', async () => {
  const { source, workspace, root } = await fixture();
  await warm(source, root);
  let inode: number | undefined;
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    ...options(source), onSelection: async (selection) => {
      if (selection.path !== 'dependency-pool') return;
      mkdirSync(path.join(workspace, 'node_modules'));
      inode = lstatSync(path.join(workspace, 'node_modules')).ino;
    },
  })).rejects.toThrow('Dependency pool rename refused');
  expect(lstatSync(path.join(workspace, 'node_modules')).ino).toBe(inode);
  expect(readFileSync(path.join(source, 'node_modules/tool.js'), 'utf8')).toBe('private\n');
}, 180_000);

it.skipIf(process.platform !== 'darwin')('holds an unreceipted slot and exposes reduced pool capacity without deleting it', async () => {
  const { source, root } = await fixture();
  const slot = path.join(getDataDir(), 'dependency-directory-pool-v1/slot-0');
  mkdirSync(slot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(slot, 'preserve.txt'), 'unproved ownership');
  await warm(source, root);
  expect(readFileSync(path.join(slot, 'preserve.txt'), 'utf8')).toBe('unproved ownership');
  expect(await dependencyDirectoryPoolStatus()).toMatchObject({ readyTrees: 1, occupiedSlots: 2, heldSlots: 1 });
}, 180_000);

it.skipIf(process.platform !== 'darwin')('keeps dispatch on the current clone path when pool storage is held', async () => {
  const { source, workspace, root } = await fixture();
  vi.spyOn(storage, 'measureHostVolume').mockImplementation(async (targetPath) => ({
    accountingStatus: 'observed', probePath: targetPath, availableBytes: 0, freeBytes: 0,
    totalBytes: 100_000_000_000, error: null,
  } as Awaited<ReturnType<typeof storage.measureHostVolume>>));
  await warm(source, root);
  expect(await dependencyDirectoryPoolStatus()).toMatchObject({ state: 'held', readyTrees: 0 });
  const selected = vi.fn();
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', { ...options(source), onSelection: selected });
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ path: 'directory-clone', reason: 'matching-inputs' }));
}, 180_000);
