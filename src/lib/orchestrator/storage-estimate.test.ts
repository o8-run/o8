import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { observeRepoStorageEstimate } from './storage-estimate';
import { measureTrackedCheckout } from './storage-estimate-measurement';
import type { RepoSetupConfig } from '@/lib/repos/types';

vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));

const MIB = 1024 * 1024;
const temporaryDirectories: string[] = [];

function setup(installOnCreateWorkspace: boolean): RepoSetupConfig {
  return {
    envMode: 'copy', envFiles: [], installCommand: 'npm ci --prefer-offline',
    installOnCreateWorkspace, buildCommand: null, runBuildOnCreateWorkspace: false,
    devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto',
  };
}

function repository(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-storage-estimate-'));
  temporaryDirectories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, 'source.txt'), Buffer.alloc(MIB, 's'));
  execFileSync('git', ['add', 'source.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: repo });
  return repo;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('first-launch workspace storage estimation', () => {
  it('charges clone metadata and native writes instead of shared dependency payloads', async () => {
    const repo = repository();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const result = await observeRepoStorageEstimate(repo, {
      creationBaseCommit: base,
      readSetup: async () => setup(true),
      measureDependencies: async () => 2 * 1024 * MIB,
      readInput: async (_repo, name) => name === 'package.json' ? '{}' : null,
      observeReuse: async () => ({ recipeKey: 'a'.repeat(64), metadataBytes: 2 * MIB, nativeWriteBytes: 3 * MIB, entries: 512 }),
    });
    expect(result.source).toBe('apfs-clone-growth');
    expect(result.error).toContain('not exact allocated blocks');
    expect(result.dependencyCloneContract?.recipeKey).toBe('a'.repeat(64));
    expect(result.exactBytes).toBeLessThan(100 * MIB);
    expect(result.nativeInstallEstimateBytes).toBeGreaterThan(128 * MIB);
  });

  it('retains the native reservation when APFS reuse cannot be proved', async () => {
    const repo = repository();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const result = await observeRepoStorageEstimate(repo, {
      creationBaseCommit: base,
      readSetup: async () => setup(true),
      readInput: async (_repo, name) => name === 'package.json' ? '{}' : null,
      observeReuse: async () => { throw new Error('source changed'); },
    });
    expect(result.source).toBe('source-size-fallback');
    expect(result.dependencyCloneContract?.recipeKey).toBeUndefined();
    expect(result.exactBytes).toBeGreaterThan(128 * MIB);
  });
  it('measures a small repository on the first launch without a telemetry warmup', async () => {
    const result = await observeRepoStorageEstimate(repository());
    expect(result.status).toBe('observed');
    expect(result.exactBytes).toBeGreaterThan(MIB);
    expect(result.exactBytes).toBeLessThan(256 * MIB);
    expect(result.error).toBeNull();
  });

  it('does not charge unrelated source build output or old oversized worktrees', async () => {
    const repo = repository();
    const clean = await observeRepoStorageEstimate(repo);
    for (const relative of ['.next', 'src-tauri/target', '.cortex-worktrees/old']) {
      mkdirSync(path.join(repo, relative), { recursive: true });
      writeFileSync(path.join(repo, relative, 'output'), Buffer.alloc(MIB));
    }
    const result = await observeRepoStorageEstimate(repo, {
      readCachedMeasurement: () => ({
        path: repo, category: 'workspace', presence: 'present', count: 1,
        allocatedBytes: 100 * 1024 * MIB, logicalBytes: 100 * 1024 * MIB,
        countAccounting: 'observed', allocatedBytesAccounting: 'observed',
        logicalBytesAccounting: 'observed', errors: [],
      }),
      defer: () => {},
    });
    expect(result.exactBytes).toBe(clean.exactBytes);
    expect(result.workspacePaths).toContain(path.join(repo, '.cortex-worktrees/old'));
  });

  it('reports an unknown path as unknown instead of manufacturing an observed allocation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-storage-missing-'));
    temporaryDirectories.push(root);
    const result = await observeRepoStorageEstimate(path.join(root, 'missing'));
    expect(result.status).toBe('unknown');
    expect(result.exactBytes).toBeNull();
    expect(result.source).toBe('unknown');
    expect(result.error).toBeTruthy();
  });

  it('keeps a cold locked Node install launchable with a labelled bounded estimate', async () => {
    const repo = repository();
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0' } },
    }));
    const result = await observeRepoStorageEstimate(repo);
    expect(result.status).toBe('observed');
    expect(result.exactBytes).toBeLessThan(256 * MIB);
    expect(result.exactBytes).toBeGreaterThan(128 * MIB);
    expect(result.error).toContain('estimated from lock or manifest entries');
  });

  it('includes a measured large native dependency install without whole-source cache amplification', async () => {
    const repo = repository();
    const result = await observeRepoStorageEstimate(repo, {
      readSetup: async () => setup(true),
      measureDependencies: async () => 20 * 1024 * MIB,
    });
    expect(result.status).toBe('observed');
    expect(result.exactBytes).toBeGreaterThan(20 * 1024 * MIB);
    expect(result.error).toBeNull();
  });

  it('uses saved disabled install policy instead of charging existing dependencies', async () => {
    const repo = repository();
    writeFileSync(path.join(repo, 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}');
    const measureDependencies = vi.fn(async () => 20 * 1024 * MIB);
    const result = await observeRepoStorageEstimate(repo, {
      readSetup: async () => setup(false), measureDependencies,
    });
    expect(measureDependencies).not.toHaveBeenCalled();
    expect(result.exactBytes).toBeLessThan(256 * MIB);
  });

  it.each([0, MIB])('keeps a cold lock allowance when installed dependency evidence is %s bytes', async (bytes) => {
    const result = await observeRepoStorageEstimate(repository(), {
      readSetup: async () => setup(true),
      measureDependencies: async () => bytes,
      readInput: async (_repo, name) => name === 'package-lock.json'
        ? JSON.stringify({ packages: Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [`node_modules/package-${index}`, { version: '1.0.0' }]),
          ) })
        : name === 'package.json' ? '{"dependencies":{"fixture":"1.0.0"}}' : null,
    });
    expect(result.exactBytes).toBeGreaterThan(1000 * MIB);
    expect(result.error).toContain('estimated from lock or manifest entries');
  });

  it('reads checkout and install evidence from the creation commit instead of feature HEAD', async () => {
    const repo = repository();
    writeFileSync(path.join(repo, 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}');
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
        `node_modules/package-${index}`, { version: '1.0.0' },
      ])),
    }));
    execFileSync('git', ['add', 'package.json', 'package-lock.json'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'main install contract'], { cwd: repo });
    const creationBaseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
    rmSync(path.join(repo, 'package-lock.json'));
    writeFileSync(path.join(repo, 'package.json'), '{}');
    mkdirSync(path.join(repo, 'node_modules'));
    const measuredForeignDependencies = vi.fn(async () => 100 * 1024 * MIB);
    const result = await observeRepoStorageEstimate(repo, {
      creationBaseCommit, measureDependencies: measuredForeignDependencies,
    });
    expect(measuredForeignDependencies).not.toHaveBeenCalled();
    expect(result.exactBytes).toBeLessThan(2 * 1024 * MIB);
    expect(result.status).toBe('observed');
    expect(result.exactBytes).toBeGreaterThan(1000 * MIB);
    expect(result.error).toContain('estimated from lock or manifest entries');
  });

  it('preserves genuinely oversized checkout writes instead of capping the estimate', async () => {
    const result = await observeRepoStorageEstimate(repository(), {
      measureCheckout: async () => ({ bytes: 40 * 1024 * MIB, files: 1 }),
    });
    expect(result.status).toBe('observed');
    expect(result.exactBytes).toBeGreaterThan(40 * 1024 * MIB);
  });

  it('reports source probe failure as unknown', async () => {
    const result = await observeRepoStorageEstimate(repository(), {
      measureCheckout: async () => { throw new Error('Git source probe timed out'); },
    });
    expect(result).toMatchObject({ status: 'unknown', exactBytes: null, source: 'unknown' });
    expect(result.error).toContain('timed out');
  });

  it('bounds the total estimate wait when an observation never completes', async () => {
    const repo = repository();
    vi.useFakeTimers();
    try {
      const resultPromise = observeRepoStorageEstimate(repo, {
        measureCheckout: () => new Promise(() => {}),
        readSetup: async () => null,
        readInput: async () => null,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await resultPromise).toMatchObject({
        status: 'unknown', exactBytes: null, source: 'unknown',
        error: 'Workspace growth measurement timed out.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('charges tracked blob checkout writes independently of existing allocated or shared blocks', async () => {
    const run = vi.fn(async () => ({ stdout: `100644 blob ${'a'.repeat(40)} 4294967296\tlarge.bin\0` }));
    const measured = await measureTrackedCheckout('/fixture', run);
    expect(measured.bytes).toBe(4 * 1024 * 1024 * 1024);
    expect(run).toHaveBeenCalledWith('git', ['ls-tree', '-r', '-l', '-z', 'HEAD'], expect.objectContaining({
      timeout: 2_000, maxBuffer: 16 * MIB,
    }));
  });

  it('does not materialize submodule gitlinks or follow symlink targets', async () => {
    const run = async () => ({ stdout: [
      `160000 commit ${'a'.repeat(40)} -\tsubmodule`,
      `120000 blob ${'b'.repeat(40)} 20\tlink`,
    ].join('\0') + '\0' });
    expect(await measureTrackedCheckout('/fixture', run)).toEqual({ bytes: 4096, files: 1 });
  });
});
