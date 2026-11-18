import { execFileSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateOperatorDefaults } from '@/lib/operator/defaults';

import {
  APFS_DEPENDENCY_IMAGES_ENV,
  detachDependencyMaterialization,
  materializeDependencyInstall,
  queueDependencyImagePublication,
  reconcileDependencyMaterializations,
  type DependencyImageProvider,
  type DependencyMaterializationReceipt,
} from './dependency-materializer';
import { deriveDependencyInstallRecipe } from './dependency-install';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-dependency-materializer-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'dependency-materializer-fixture',
    version: '1.0.0',
    private: true,
    packageManager: 'npm@10.0.0',
  }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'dependency-materializer-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'dependency-materializer-fixture', version: '1.0.0' } },
  }));
  git(root, 'add', '.gitignore', 'package.json', 'package-lock.json');
  git(
    root,
    '-c', 'user.name=o8-test',
    '-c', 'user.email=test@invalid',
    'commit', '-qm', 'fixture',
  );
  return root;
}

function provider(overrides: Partial<DependencyImageProvider> = {}): DependencyImageProvider {
  return {
    lookupReadyImage: vi.fn(async () => ({ status: 'missing' as const })),
    mount: vi.fn(async () => {
      throw new Error('unexpected mount');
    }),
    captureSource: vi.fn(async ({ workspacePath, installReceipt }) => {
      const workspace = lstatSync(workspacePath);
      const sourcePath = path.join(workspacePath, 'node_modules');
      const source = lstatSync(sourcePath);
      return {
        version: 1 as const,
        receiptId: 'captured-source',
        recipeKey: installReceipt.recipe.key,
        workspacePath,
        workspaceDevice: workspace.dev,
        workspaceInode: workspace.ino,
        sourcePath,
        sourceDevice: source.dev,
        sourceInode: source.ino,
        treeDigest: 'captured-tree',
      };
    }),
    publish: vi.fn(async ({ sourceReceipt }) => ({
      recipeKey: sourceReceipt.recipeKey,
      generation: 'published-generation',
    })),
    detach: vi.fn(async () => {}),
    reconcile: vi.fn(async () => []),
    ...overrides,
  };
}

function options(imageProvider: DependencyImageProvider) {
  return {
    provider: imageProvider,
    platform: 'darwin' as const,
    env: { [APFS_DEPENDENCY_IMAGES_ENV]: '1' },
    probeApfs: async () => true,
    resolveVersion: async () => '10.0.0',
    run: vi.fn(async (invocation: { cwd: string }) => {
      mkdirSync(path.join(invocation.cwd, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(invocation.cwd, 'node_modules', 'fixture', 'index.js'), 'module.exports = true;\n');
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dependency materializer policy boundary', () => {
  it('refuses native fallback when admission only reserved an APFS clone', async () => {
    const workspace = fixture();
    const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci --ignore-scripts', { resolveVersion: async () => '10.0.0' });
    const run = vi.fn();
    await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
      resolveVersion: async () => '10.0.0', requiredCloneRecipeKey: recipe.key, run,
      env: { [APFS_DEPENDENCY_IMAGES_ENV]: '0' },
    })).rejects.toThrow('fresh native-install reservation');
    expect(run).not.toHaveBeenCalled();
  });

  it('checks the actual target recipe rather than trusting prepared reuse evidence', async () => {
    const workspace = fixture();
    const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci --ignore-scripts', { resolveVersion: async () => '10.0.0' });
    const run = vi.fn();
    const forged = { ...recipe, key: '0'.repeat(64) };
    await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
      resolveVersion: async () => '10.0.0', requiredCloneRecipeKey: forged.key, preparedRecipe: forged, run,
      env: { [APFS_DEPENDENCY_IMAGES_ENV]: '0' },
    })).rejects.toThrow('recipe changed after APFS storage admission');
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'uses the operator default when env is unset', setting: true, env: {}, expected: 'image' },
    { label: 'lets env 0 force off', setting: true, env: { [APFS_DEPENDENCY_IMAGES_ENV]: '0' }, expected: 'native' },
    { label: 'lets env 1 force on', setting: false, env: { [APFS_DEPENDENCY_IMAGES_ENV]: '1' }, expected: 'image' },
  ] as const)('$label', async ({ setting, env, expected }) => {
    await updateOperatorDefaults({ apfsDependencyImages: setting });
    const workspace = fixture();
    const imageProvider = provider({
      lookupReadyImage: vi.fn(async ({ recipe }) => ({
        status: 'ready' as const,
        authority: { recipeKey: recipe.key, generation: 'ready-generation' },
      })),
      mount: vi.fn(async ({ workspacePath, recipe }) => {
        mkdirSync(path.join(workspacePath, 'node_modules', 'fixture'), { recursive: true });
        return {
          leaseId: 'truth-table-lease',
          recipeKey: recipe.key,
          generation: 'ready-generation',
        };
      }),
    });

    const result = await materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline --ignore-scripts',
      { ...options(imageProvider), env },
    );

    expect(result.receipt.mode).toBe(expected);
  });

  it('uses native TW-09 only for a missing image and defers publication until readiness', async () => {
    const workspace = fixture();
    const imageProvider = provider();
    const materializerOptions = options(imageProvider);
    const result = await materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline --ignore-scripts',
      materializerOptions,
    );

    expect(result.receipt).toMatchObject({
      mode: 'native',
      leaseId: null,
      generation: null,
    });
    expect(imageProvider.publish).not.toHaveBeenCalled();
    const publication = queueDependencyImagePublication(workspace, result.receipt);
    expect(publication).not.toBeNull();
    await publication;
    expect(imageProvider.publish).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('mounts a ready exact generation, persists its lease, and detaches it exactly', async () => {
    const workspace = fixture();
    const detach = vi.fn(async () => {});
    const imageProvider = provider({
      lookupReadyImage: vi.fn(async ({ recipe }) => ({
        status: 'ready' as const,
        authority: { recipeKey: recipe.key, generation: 'ready-generation' },
      })),
      mount: vi.fn(async ({ workspacePath, recipe, afterLeasePrepared }) => {
        await afterLeasePrepared?.({
          leaseId: 'exact-lease',
          recipeKey: recipe.key,
          generation: 'ready-generation',
          workspacePath,
        });
        mkdirSync(path.join(workspacePath, 'node_modules', 'fixture'), { recursive: true });
        writeFileSync(path.join(workspacePath, 'node_modules', 'fixture', 'index.js'), 'mounted\n');
        return {
          leaseId: 'exact-lease',
          recipeKey: recipe.key,
          generation: 'ready-generation',
        };
      }),
      detach,
    });
    const materializerOptions = options(imageProvider);
    const result = await materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline --ignore-scripts',
      materializerOptions,
    );

    expect(result.installReceipt).toBeNull();
    expect(result.receipt).toMatchObject({
      mode: 'image',
      leaseId: 'exact-lease',
      generation: 'ready-generation',
    });
    expect(materializerOptions.run).not.toHaveBeenCalled();
    await detachDependencyMaterialization(workspace, result.receipt);
    expect(detach).toHaveBeenCalledWith('exact-lease', { registryRoot: undefined });
  });

  it('remounts an exact ready generation through a new prepared-to-mounted lease', async () => {
    const workspace = fixture();
    const installCommand = 'npm ci --prefer-offline --ignore-scripts';
    const recipe = await deriveDependencyInstallRecipe(workspace, installCommand, {
      resolveVersion: async () => '10.0.0',
    });
    const persisted: Array<string | null> = [];
    const exactGenerationRemount = {
      recipeKey: recipe.key,
      generation: 'ready-generation',
      workspacePath: workspace,
    };
    const mount = vi.fn(async ({
      workspacePath,
      afterLeasePrepared,
      expectedLease,
      exactGenerationRemount: receivedAuthority,
    }: Parameters<DependencyImageProvider['mount']>[0]) => {
      expect(expectedLease).toBeUndefined();
      expect(receivedAuthority).toEqual(exactGenerationRemount);
      await afterLeasePrepared?.({
        leaseId: 'new-remount-lease',
        recipeKey: recipe.key,
        generation: 'ready-generation',
        workspacePath,
      });
      mkdirSync(path.join(workspacePath, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(workspacePath, 'node_modules', 'fixture', 'index.js'), 'mounted\n');
      return {
        leaseId: 'new-remount-lease',
        recipeKey: recipe.key,
        generation: 'ready-generation',
      };
    });
    const imageProvider = provider({
      lookupReadyImage: vi.fn(async () => ({
        status: 'ready' as const,
        authority: { recipeKey: recipe.key, generation: 'ready-generation' },
      })),
      mount,
    });

    const result = await materializeDependencyInstall(workspace, installCommand, {
      ...options(imageProvider),
      preparedRecipe: recipe,
      exactGenerationRemount,
      persistReceipt: async (receipt) => { persisted.push(receipt?.status ?? null); },
    });

    expect(exactGenerationRemount).not.toHaveProperty('leaseId');
    expect(persisted).toEqual(['prepared', 'mounted']);
    expect(result.receipt).toMatchObject({
      status: 'mounted',
      leaseId: 'new-remount-lease',
      recipeKey: recipe.key,
      generation: 'ready-generation',
    });
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('keeps expected-lease adoption separate from exact-generation remount', async () => {
    const workspace = fixture();
    const installCommand = 'npm ci --prefer-offline --ignore-scripts';
    const recipe = await deriveDependencyInstallRecipe(workspace, installCommand, {
      resolveVersion: async () => '10.0.0',
    });
    const expectedLease = {
      leaseId: 'prepared-crash-lease',
      recipeKey: recipe.key,
      generation: 'ready-generation',
      workspacePath: workspace,
    };
    const mount = vi.fn(async ({
      workspacePath,
      expectedLease: receivedLease,
      exactGenerationRemount,
    }: Parameters<DependencyImageProvider['mount']>[0]) => {
      expect(receivedLease).toEqual(expectedLease);
      expect(exactGenerationRemount).toBeUndefined();
      mkdirSync(path.join(workspacePath, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(workspacePath, 'node_modules', 'fixture', 'index.js'), 'mounted\n');
      return {
        leaseId: expectedLease.leaseId,
        recipeKey: recipe.key,
        generation: 'ready-generation',
      };
    });
    const imageProvider = provider({
      lookupReadyImage: vi.fn(async () => ({
        status: 'ready' as const,
        authority: { recipeKey: recipe.key, generation: 'ready-generation' },
      })),
      mount,
    });

    const result = await materializeDependencyInstall(workspace, installCommand, {
      ...options(imageProvider),
      preparedRecipe: recipe,
      expectedLease,
    });

    expect(result.receipt.leaseId).toBe(expectedLease.leaseId);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'poisoned'] as const)(
    'fails closed when an exact remount generation is %s',
    async (state) => {
      const workspace = fixture();
      const installCommand = 'npm ci --prefer-offline --ignore-scripts';
      const recipe = await deriveDependencyInstallRecipe(workspace, installCommand, {
        resolveVersion: async () => '10.0.0',
      });
      const lookupReadyImage = vi.fn(async () => state === 'missing'
        ? { status: 'missing' as const }
        : {
            status: 'ready' as const,
            authority: { recipeKey: recipe.key, generation: 'other-generation' },
          });
      const imageProvider = provider({ lookupReadyImage });
      const materializerOptions = {
        ...options(imageProvider),
        preparedRecipe: recipe,
        exactGenerationRemount: {
          recipeKey: recipe.key,
          generation: 'required-generation',
          workspacePath: workspace,
        },
      };

      await expect(materializeDependencyInstall(
        workspace,
        installCommand,
        materializerOptions,
      )).rejects.toThrow(/ready generation authority|generation differs/);
      expect(materializerOptions.run).not.toHaveBeenCalled();
      expect(lookupReadyImage).toHaveBeenCalledTimes(1);
      expect(imageProvider.mount).not.toHaveBeenCalled();
    },
  );

  it.each(['lookup', 'mount'] as const)('falls back to native installation when %s authority is unusable', async (phase) => {
    const workspace = fixture();
    const imageProvider = provider({
      lookupReadyImage: phase === 'lookup'
        ? vi.fn(async () => { throw new Error('corrupt ready image'); })
        : vi.fn(async ({ recipe }) => ({
            status: 'ready' as const,
            authority: { recipeKey: recipe.key, generation: 'poison-generation' },
          })),
      mount: vi.fn(async () => { throw new Error('partial attach'); }),
    });
    const materializerOptions = options(imageProvider);

    const result = await materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline --ignore-scripts',
      materializerOptions,
    );
    expect(result.receipt.mode).toBe('native');
    expect(materializerOptions.run).toHaveBeenCalledTimes(1);
  });

  it('exact-detaches and clears its prepared receipt when a post-mount boundary throws', async () => {
    const workspace = fixture();
    const detach = vi.fn(async () => {});
    const persisted: Array<string | null> = [];
    const imageProvider = provider({
      lookupReadyImage: vi.fn(async ({ recipe }) => ({
        status: 'ready' as const,
        authority: { recipeKey: recipe.key, generation: 'ready-generation' },
      })),
      mount: vi.fn(async ({ workspacePath, recipe, afterLeasePrepared }) => {
        await afterLeasePrepared?.({
          leaseId: 'post-mount-lease',
          recipeKey: recipe.key,
          generation: 'ready-generation',
          workspacePath,
        });
        mkdirSync(path.join(workspacePath, 'node_modules', 'fixture'), { recursive: true });
        writeFileSync(path.join(workspacePath, 'node_modules', 'fixture', 'index.js'), 'mounted\n');
        return {
          leaseId: 'post-mount-lease',
          recipeKey: recipe.key,
          generation: 'ready-generation',
        };
      }),
      detach,
    });

    await expect(materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline --ignore-scripts',
      {
        ...options(imageProvider),
        persistReceipt: async (receipt) => { persisted.push(receipt?.status ?? null); },
        afterMount: async () => { throw new Error('post-mount seam'); },
      },
    )).rejects.toThrow('post-mount seam');

    expect(persisted).toEqual(['prepared', null]);
    expect(detach).toHaveBeenCalledWith('post-mount-lease', { registryRoot: undefined });
  });

  it('keeps lifecycle-enabled npm recipes on the native path without image lookup', async () => {
    const workspace = fixture();
    const imageProvider = provider();
    const materializerOptions = options(imageProvider);
    const result = await materializeDependencyInstall(
      workspace,
      'npm ci --prefer-offline',
      materializerOptions,
    );

    expect(result.receipt.mode).toBe('native');
    expect(imageProvider.lookupReadyImage).not.toHaveBeenCalled();
    expect(queueDependencyImagePublication(workspace, result.receipt)).toBeNull();
  }, 15_000);

  it('adopts a crash-replayed prepared receipt before the workspace returns to mounted', async () => {
    const workspace = fixture();
    const canonicalWorkspace = realpathSync(workspace);
    const imageProvider = provider({
      reconcile: vi.fn(async () => [{
        leaseId: 'restart-lease',
        recipeKey: 'b'.repeat(64),
        generation: 'restart-generation',
        workspacePath: canonicalWorkspace,
        state: 'mounted' as const,
      }]),
    });
    const promoted: string[] = [];
    const unavailable = vi.fn(async () => {});
    const root = lstatSync(workspace);
    const result = await reconcileDependencyMaterializations([{
      workspacePath: canonicalWorkspace,
      receipt: {
        mode: 'image',
        status: 'prepared',
        installCommand: 'npm ci --ignore-scripts',
        recipeKey: 'b'.repeat(64),
        leaseId: 'restart-lease',
        generation: 'restart-generation',
        workspaceDevice: root.dev,
        workspaceInode: root.ino,
      },
      promoteMounted: async (receipt) => { promoted.push(receipt.status); },
      markUnavailable: unavailable,
    }], imageProvider);

    expect(result).toMatchObject({ adopted: 1, complete: true });
    expect(promoted).toEqual(['mounted']);
    expect(unavailable).not.toHaveBeenCalled();
    expect(imageProvider.detach).not.toHaveBeenCalled();
  });

  it.each(['missing', 'replaced', 'ambiguous'] as const)(
    'clears and exact-detaches a mounted lease when its workspace root is %s',
    async (rootState) => {
      const workspace = fixture();
      const canonicalWorkspace = realpathSync(workspace);
      const originalWorkspace = `${workspace}-original`;
      const root = lstatSync(workspace);
      const events: string[] = [];
      const promoted = vi.fn(async () => {});
      const unavailable = vi.fn(async (receipt: DependencyMaterializationReceipt | null) => {
        expect(receipt).toBeNull();
        events.push('metadata-cleared');
      });
      const detach = vi.fn(async () => {
        events.push('lease-detached');
      });
      const receipt = {
        mode: 'image' as const,
        status: 'prepared' as const,
        installCommand: 'npm ci --ignore-scripts',
        recipeKey: 'd'.repeat(64),
        leaseId: `root-${rootState}-lease`,
        generation: 'root-generation',
        workspaceDevice: root.dev,
        workspaceInode: root.ino,
      };
      const imageProvider = provider({
        reconcile: vi.fn(async () => [{
          leaseId: receipt.leaseId,
          recipeKey: receipt.recipeKey,
          generation: receipt.generation,
          workspacePath: canonicalWorkspace,
          state: 'mounted' as const,
        }]),
        detach,
      });

      renameSync(workspace, originalWorkspace);
      if (rootState === 'replaced') {
        mkdirSync(workspace);
        writeFileSync(path.join(workspace, 'wrong-occupant'), 'preserve me\n');
      } else if (rootState === 'ambiguous') {
        symlinkSync(originalWorkspace, workspace);
      }
      const occupant = rootState === 'missing' ? null : lstatSync(workspace);
      let result;
      try {
        result = await reconcileDependencyMaterializations([{
          workspacePath: canonicalWorkspace,
          receipt,
          promoteMounted: promoted,
          markUnavailable: unavailable,
        }], imageProvider);
        if (occupant) {
          const after = lstatSync(workspace);
          expect({ device: after.dev, inode: after.ino, symlink: after.isSymbolicLink() })
            .toEqual({
              device: occupant.dev,
              inode: occupant.ino,
              symlink: occupant.isSymbolicLink(),
            });
        }
        if (rootState === 'replaced') {
          expect(readFileSync(path.join(workspace, 'wrong-occupant'), 'utf8'))
            .toBe('preserve me\n');
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        renameSync(originalWorkspace, workspace);
      }

      expect(result).toMatchObject({
        adopted: 0,
        detachedUnowned: 1,
        unavailable: 1,
        blocked: 0,
        complete: true,
      });
      expect(events).toEqual(['metadata-cleared', 'lease-detached']);
      expect(promoted).not.toHaveBeenCalled();
      expect(unavailable).toHaveBeenCalledTimes(1);
      await detachDependencyMaterialization(workspace);
      expect(detach).toHaveBeenCalledTimes(1);
    },
  );

  it('holds workspace startup when a replaced root lease cannot exact-detach', async () => {
    const workspace = fixture();
    const canonicalWorkspace = realpathSync(workspace);
    const originalWorkspace = `${workspace}-original`;
    const root = lstatSync(workspace);
    const unavailable = vi.fn(async () => {});
    const detach = vi.fn(async () => { throw new Error('ambiguous detach authority'); });
    const imageProvider = provider({
      reconcile: vi.fn(async () => [{
        leaseId: 'blocked-root-lease',
        recipeKey: 'e'.repeat(64),
        generation: 'root-generation',
        workspacePath: canonicalWorkspace,
        state: 'mounted' as const,
      }]),
      detach,
    });
    renameSync(workspace, originalWorkspace);
    mkdirSync(workspace);
    let result;
    try {
      result = await reconcileDependencyMaterializations([{
        workspacePath: canonicalWorkspace,
        receipt: {
          mode: 'image',
          status: 'mounted',
          installCommand: 'npm ci --ignore-scripts',
          recipeKey: 'e'.repeat(64),
          leaseId: 'blocked-root-lease',
          generation: 'root-generation',
          workspaceDevice: root.dev,
          workspaceInode: root.ino,
        },
        promoteMounted: vi.fn(async () => {}),
        markUnavailable: unavailable,
      }], imageProvider);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      renameSync(originalWorkspace, workspace);
    }

    expect(result).toMatchObject({ unavailable: 1, blocked: 1, complete: false });
    expect(unavailable).toHaveBeenCalledWith(null);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('exact-detaches a crash-before-metadata mount during restart reconciliation', async () => {
    const workspace = fixture();
    const detach = vi.fn(async () => {});
    const imageProvider = provider({
      reconcile: vi.fn(async () => [{
        leaseId: 'unowned-lease',
        recipeKey: 'c'.repeat(64),
        generation: 'unowned-generation',
        workspacePath: workspace,
        state: 'mounted' as const,
      }]),
      detach,
    });

    const result = await reconcileDependencyMaterializations([], imageProvider);

    expect(result).toMatchObject({
      inspected: 1,
      detachedUnowned: 1,
      blocked: 0,
      complete: true,
    });
    expect(detach).toHaveBeenCalledWith('unowned-lease', { registryRoot: undefined });
  });
});
