import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { WorktreeManager } from './manager';

const roots: string[] = [];
const setup: RepoSetupConfig = {
  envMode: 'skip',
  envFiles: [],
  installCommand: null,
  installOnCreateWorkspace: false,
  buildCommand: null,
  runBuildOnCreateWorkspace: false,
  devCommand: null,
  defaultPort: null,
  workspaceIsolationPreference: 'auto',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

afterEach(() => {
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_APFS_COW_WORKSPACES;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace isolation default real path', () => {
  it.skipIf(process.platform !== 'darwin')(
    'gives a caller with no isolation preference an APFS clone, unless the clone flag is 0 (#5079)',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'o8-default-isolation-'));
      roots.push(root);
      const repo = path.join(root, 'repo');
      git(root, 'init', '-q', '-b', 'main', repo);
      git(repo, 'config', 'user.name', 'o8-test');
      git(repo, 'config', 'user.email', 'test@invalid');
      writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-qm', 'fixture');
      process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
      process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-default-isolation-root-'));
      roots.push(process.env.O8_WORKTREE_ROOT);
      const manager = new WorktreeManager(repo);
      Object.defineProperty(manager, 'injectSafetyHooks', { value: async () => {} });
      const created: string[] = [];
      try {
        // No isolationPreference, as for a caller whose repo setup was never saved.
        const clone = await manager.create({ agentType: 'codex', taskName: 'default isolation', baseBranch: 'main', repoSetup: setup });
        created.push(clone.id);
        expect(clone.isolationKind).toBe('apfs-cow-clone');

        process.env.O8_APFS_COW_WORKSPACES = '0';
        const worktree = await manager.create({ agentType: 'codex', taskName: 'opted out isolation', baseBranch: 'main', repoSetup: setup });
        created.push(worktree.id);
        expect(worktree.isolationKind).toBe('git-worktree');
      } finally {
        for (const id of created) await manager.cleanup(id, { force: true, deleteBranch: true });
      }
    },
    120_000,
  );
});
