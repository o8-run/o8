import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDependencyInstall, type DependencyInstallInvocation } from './dependency-install';
import { DEPENDENCY_CACHE_POLICY, pruneDependencyCaches } from './dependency-cache-retention';

const roots: string[] = [];
const managedName = process.platform === 'darwin' ? 'managed-v1.noindex' : 'managed-v1';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-cache-retention-'));
  roots.push(root);
  const cacheRoot = path.join(root, 'caches');
  mkdirSync(cacheRoot, { mode: 0o700 });
  const workspace = (name: string, lock = 'lock-v1') => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', packageManager: 'npm@11.8.0' }));
    writeFileSync(path.join(dir, 'package-lock.json'), lock);
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture'], { cwd: dir });
    return dir;
  };
  return { root, cacheRoot, workspace };
}

function writeInstall(invocation: DependencyInstallInvocation): string {
  const cache = invocation.env.npm_config_cache!;
  writeFileSync(path.join(cache, 'package.tgz'), Buffer.alloc(8192, 'x'));
  mkdirSync(path.join(invocation.cwd, 'node_modules'), { recursive: true });
  writeFileSync(path.join(invocation.cwd, 'node_modules', 'fixture.js'), 'private dependency');
  return cache;
}

const keep = { ...DEPENDENCY_CACHE_POLICY };
const empty = { ...keep, maxBytes: 0, maxEntries: 0 };
const resolveVersion = async () => '11.8.0';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dependency cache retention through the install entry point', { timeout: 30_000 }, () => {
  it('bounds completed caches by bytes without deleting installed dependencies or legacy caches', async () => {
    const { cacheRoot, workspace } = fixture();
    const repo = workspace('repo');
    const legacy = path.join(cacheRoot, 'npm', 'old-cache');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'keep'), 'legacy');
    let cache = '';
    const receipt = await runDependencyInstall(repo, 'npm ci', {
      cacheRoot, cachePolicy: { ...keep, maxBytes: 0 }, resolveVersion,
      run: async invocation => { cache = writeInstall(invocation); },
    });
    expect(cache).toContain(`${path.sep}${managedName}${path.sep}npm${path.sep}`);
    expect(existsSync(cache)).toBe(false);
    expect(readFileSync(path.join(repo, 'node_modules', 'fixture.js'), 'utf8')).toBe('private dependency');
    expect(readFileSync(path.join(legacy, 'keep'), 'utf8')).toBe('legacy');
    expect(receipt.cacheRetention).toMatchObject({ status: 'within-budget', retainedBytes: 0, retainedEntries: 0, legacyPreserved: true });
    expect(receipt.cacheRetention?.removed).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(cacheRoot, managedName, '.o8-retention.json'), 'utf8'))).toEqual(receipt.cacheRetention);
  });

  it('evicts the least recently used recipe when the entry count is exceeded', async () => {
    const { cacheRoot, workspace } = fixture();
    const caches: string[] = [];
    const install = async (repo: string) => runDependencyInstall(repo, 'npm ci', {
      cacheRoot, cachePolicy: { ...keep, maxEntries: 1 }, resolveVersion,
      run: async invocation => { caches.push(writeInstall(invocation)); },
    });
    await install(workspace('first', 'lock-v1'));
    const second = await install(workspace('second', 'lock-v2'));
    expect(existsSync(caches[0]!)).toBe(false);
    expect(existsSync(caches[1]!)).toBe(true);
    expect(second.cacheRetention).toMatchObject({ status: 'within-budget', retainedEntries: 1 });
  });

  it('keeps the shared cache until both concurrent installers have finished', async () => {
    const { cacheRoot, workspace } = fixture();
    const firstRepo = workspace('first');
    const secondRepo = workspace('second');
    let startFirst!: () => void;
    let startSecond!: () => void;
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstStarted = new Promise<void>(resolve => { startFirst = resolve; });
    const secondStarted = new Promise<void>(resolve => { startSecond = resolve; });
    const firstFinish = new Promise<void>(resolve => { finishFirst = resolve; });
    const secondFinish = new Promise<void>(resolve => { finishSecond = resolve; });
    let cache = '';
    const first = runDependencyInstall(firstRepo, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => { cache = writeInstall(invocation); startFirst(); await firstFinish; },
    });
    await firstStarted;
    const second = runDependencyInstall(secondRepo, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => { expect(writeInstall(invocation)).toBe(cache); startSecond(); await secondFinish; },
    });
    await secondStarted;
    finishFirst();
    const partial = await first;
    expect(partial.cacheRetention?.status).toBe('held');
    expect(partial.cacheRetention?.retainedBytes).toBeNull();
    expect(existsSync(cache)).toBe(true);
    finishSecond();
    const completed = await second;
    expect(completed.cacheRetention?.status).toBe('within-budget');
    expect(existsSync(cache)).toBe(false);
  });

  it('retains reservations after runner failure instead of guessing installer children are dead', async () => {
    const { cacheRoot, workspace } = fixture();
    let cache = '';
    await expect(runDependencyInstall(workspace('repo'), 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => { cache = writeInstall(invocation); throw new Error('installer interrupted'); },
    })).rejects.toThrow('installer interrupted');
    const result = await pruneDependencyCaches(cacheRoot, empty);
    expect(result.status).toBe('held');
    expect(result.held).toEqual([expect.objectContaining({ reason: 'active-or-unresolved-installer' })]);
    expect(existsSync(cache)).toBe(true);
    expect(readdirSync(path.dirname(cache)).some(name => name.startsWith('.o8-active-'))).toBe(true);
  });

  it('preserves an inode-replaced recipe and its unrecognized original directory', async () => {
    const { cacheRoot, workspace } = fixture();
    let cache = '';
    await runDependencyInstall(workspace('repo'), 'npm ci', {
      cacheRoot, resolveVersion, run: async invocation => { cache = writeInstall(invocation); },
    });
    const recipe = path.dirname(cache);
    const record = readFileSync(path.join(recipe, '.o8-cache.json'));
    renameSync(recipe, `${recipe}-saved`);
    mkdirSync(recipe, { mode: 0o700 });
    writeFileSync(path.join(recipe, '.o8-cache.json'), record);
    writeFileSync(path.join(recipe, 'keep'), 'replacement');
    const result = await pruneDependencyCaches(cacheRoot, empty);
    expect(result.status).toBe('held');
    expect(result.removed).toEqual([]);
    expect(readFileSync(path.join(recipe, 'keep'), 'utf8')).toBe('replacement');
    expect(existsSync(`${recipe}-saved`)).toBe(true);
  });

  it('never follows a manager symlink into another directory', async () => {
    const { root, cacheRoot } = fixture();
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep'), 'outside');
    mkdirSync(path.join(cacheRoot, managedName), { recursive: true, mode: 0o700 });
    symlinkSync(outside, path.join(cacheRoot, managedName, 'npm'));
    const result = await pruneDependencyCaches(cacheRoot, empty);
    expect(result.status).toBe('held');
    expect(result.held[0]?.reason).toBe('unsafe-manager-namespace');
    expect(readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('outside');
  });

  it('expires an unused completed cache while preserving a corrupt record', async () => {
    const { cacheRoot, workspace } = fixture();
    let cache = '';
    await runDependencyInstall(workspace('repo'), 'npm ci', {
      cacheRoot, resolveVersion, run: async invocation => { cache = writeInstall(invocation); },
    });
    const recordPath = path.join(path.dirname(cache), '.o8-cache.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    writeFileSync(recordPath, 'invalid');
    expect((await pruneDependencyCaches(cacheRoot, empty)).status).toBe('held');
    expect(existsSync(cache)).toBe(true);
    record.lastUsedAt = Date.now() - keep.maxAgeMs - 1000;
    writeFileSync(recordPath, JSON.stringify(record));
    const result = await pruneDependencyCaches(cacheRoot);
    expect(result.status).toBe('within-budget');
    expect(result.removed).toHaveLength(1);
    expect(existsSync(cache)).toBe(false);
  });

  it('refuses another profile with independent lock state before touching shared caches', async () => {
    const { root, cacheRoot, workspace } = fixture();
    let cache = '';
    await runDependencyInstall(workspace('repo'), 'npm ci', {
      cacheRoot, resolveVersion, run: async invocation => { cache = writeInstall(invocation); },
    });
    const previous = process.env.CORTEX_IDE_DB_PATH;
    process.env.CORTEX_IDE_DB_PATH = path.join(root, 'other-profile.db');
    try {
      await expect(pruneDependencyCaches(cacheRoot, empty)).rejects.toThrow('different or unproved lifecycle store');
      expect(existsSync(cache)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_IDE_DB_PATH;
      else process.env.CORTEX_IDE_DB_PATH = previous;
    }
  });
});
