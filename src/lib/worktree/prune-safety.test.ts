/**
 * Real-path prune SAFETY guards (#1585).
 *
 * Drives the REAL `WorktreeManager.prune()` seam — the same entry point the
 * throttled auto-prune (`headless-loop.ts pruneWorktreesIfDue`) hits — against
 * REAL git worktrees on disk, and asserts the four invariants that stop the
 * pruner from `rm -rf`'ing live workers' cwds (the fleet-kill of 2026-07-18):
 *
 *   (a) a worktree bound to a NON-TERMINAL lane survives the age sweep;
 *   (b) an orphan dir whose mtime probe reads unknown/zero is KEPT (+ warn);
 *   (c) a lane-registry import failure ABORTS the pass — `[]`, no disk touched;
 *   (d) a worktree with a live process cwd'd inside survives (fail closed);
 *   (e) a genuinely stale, clean, process-free, no-lane worktree IS pruned
 *       (the disk-hygiene purpose the May-2026 disk-full incident bought).
 *
 * These go through the live lane registry + a persisted operator-defaults in a
 * sandboxed CORTEX_IDE_DATA_DIR, so a regression in the guard chain reddens here.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const WORKTREE_DIR_NAME = '.cortex-worktrees';
// Well past STALE_THRESHOLD_MS (24h) so the age sweep considers the worktree.
const STALE_AGE_MS = 26 * 60 * 60_000;

let repoRoot: string;
let dataDir: string;
let base: string;
const bornProcs: ChildProcess[] = [];
const pathAliases: string[] = [];

async function git(args: string[], cwd: string) {
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Add a real git worktree under the repo's `.cortex-worktrees` and age its mtime. */
async function addWorktree(id: string, ageMs = STALE_AGE_MS): Promise<string> {
  const wtPath = path.join(base, id);
  await git(['worktree', 'add', wtPath, '-b', `worktree/codex/${id}`], repoRoot);
  const when = new Date(Date.now() - ageMs);
  const gitAdminPaths = await Promise.all(['HEAD', 'index'].map(async (name) => {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', name], { cwd: wtPath });
    return path.resolve(wtPath, stdout.trim());
  }));
  await Promise.all([
    utimes(wtPath, when, when),
    ...gitAdminPaths.map((gitPath) => utimes(gitPath, when, when).catch(() => {})),
  ]);
  const { captureWorktreeMaterializationIdentity } = await import('./materialization-identity');
  const { withWorktreeMetaTransaction } = await import('./metadata-store');
  const materializationIdentity = await captureWorktreeMaterializationIdentity(wtPath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(base);
  await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save(id, {
    id,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now() - ageMs,
    claudeManaged: false,
    taskName: id,
    branchName: `worktree/codex/${id}`,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
  return wtPath;
}

beforeEach(async () => {
  // realpath: macOS mkdtemp yields a /var symlink but git stores the resolved
  // /private/var path; the manager's #1404 realpath write-guard needs them equal.
  repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-prune-safety-')));
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-prune-safety-data-')));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;

  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf-8');
  await git(['add', 'seed.txt'], repoRoot);
  await git(['commit', '-m', 'seed'], repoRoot);

  base = path.join(repoRoot, WORKTREE_DIR_NAME);
  await mkdir(base, { recursive: true });
}, 60_000);

afterEach(async () => {
  for (const child of bornProcs.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/lane/registry');
  vi.doUnmock('@/lib/workspace/exact-managed-directory-retirement');
  vi.doUnmock('@/lib/workspace/dependency-materializer');
  vi.resetModules();
  for (const aliasPath of pathAliases.splice(0)) {
    await unlink(aliasPath).catch(() => {});
  }
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.CORTEX_IDE_DATA_DIR;
});

describe('WorktreeManager.prune() safety guards (#1585)', () => {
  it('(a)+(e) keeps a non-terminal-lane worktree but reaps a stale no-lane one', async () => {
    const { WorktreeManager } = await import('./manager');
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');

    const blockedPath = await addWorktree('packet-blocked');
    await addWorktree('packet-orphan-lane-free'); // no lane → genuine victim

    // A lane parked on an operator decision ("blocked — operator review
    // required" in the incident) is NON-TERMINAL and must protect its tree.
    const lane = createLane({
      repoPath: repoRoot,
      branch: 'worktree/codex/packet-blocked',
      baseBranch: 'main',
      runtime: 'codex',
      worktreePath: blockedPath,
    });
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'operator_review_required');

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-blocked');
    expect(pruned).toContain('packet-orphan-lane-free');
    expect(await exists(blockedPath), 'blocked-lane worktree survives').toBe(true);
    expect(await exists(path.join(base, 'packet-orphan-lane-free')), 'stale no-lane worktree reaped').toBe(false);
  }, 60_000);

  it('leaves a git worktree it has no metadata for out of the age sweep', async () => {
    const { WorktreeManager } = await import('./manager');
    // Another tool's worktree (a T3 checkout, a hand-made one) lives outside the managed base.
    const external = `${repoRoot}-external`;
    await git(['worktree', 'add', external, '-b', 'external/branch'], repoRoot);
    const when = new Date(Date.now() - STALE_AGE_MS);
    const gitAdminPaths = await Promise.all(['HEAD', 'index'].map(async (name) => {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', name], { cwd: external });
      return path.resolve(external, stdout.trim());
    }));
    await Promise.all([external, path.join(external, 'seed.txt'), ...gitAdminPaths].map((p) => utimes(p, when, when)));
    try {
      const pruned = await new WorktreeManager(repoRoot).prune();
      expect(pruned).not.toContain(path.basename(external));
      expect(await exists(external), 'unmanaged worktree is untouched').toBe(true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }, 60_000);

  it('(b) keeps an orphan dir whose mtime probe reads unknown/zero, with a warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { WorktreeManager } = await import('./manager');

    // A raw (non-git, no-meta) packet dir → falls to the F39 orphan sweep.
    // mtime epoch-0 → probeMtimeMs() returns null (unknown age).
    const orphanPath = path.join(base, 'packet-mtime-unknown');
    await mkdir(orphanPath, { recursive: true });
    await writeFile(path.join(orphanPath, 'work.txt'), 'agent work\n', 'utf-8');
    await utimes(orphanPath, new Date(0), new Date(0));

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-mtime-unknown');
    expect(await exists(orphanPath), 'unknown-mtime orphan survives').toBe(true);
    expect(
      warnSpy.mock.calls.some(([msg]) =>
        typeof msg === 'string'
        && msg.includes('packet-mtime-unknown')
        && msg.includes('mtime probe failed/unknown'),
      ),
      'warned about the skipped unknown-mtime orphan',
    ).toBe(true);
  }, 60_000);

  it('(c) aborts with [] and touches no disk when the lane registry import fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/lane/registry', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/lib/lane/registry')>(),
      listLanes: () => { throw new Error('registry boom (simulated import/read failure)'); },
    }));
    vi.resetModules();

    const staleA = await addWorktree('packet-registry-fail-a');
    const staleB = await addWorktree('packet-registry-fail-b');

    const { WorktreeManager } = await import('./manager');
    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).toEqual([]);
    expect(await exists(staleA), 'worktree untouched on registry failure').toBe(true);
    expect(await exists(staleB), 'worktree untouched on registry failure').toBe(true);
    expect(errorSpy.mock.calls.some(([message]) => (
      typeof message === 'string'
      && message.includes('PRUNE ABORTED — lane registry unavailable')
    ))).toBe(true);
  }, 60_000);

  it('(d) keeps a worktree with a live process cwd`d inside (fail closed)', async () => {
    const { WorktreeManager } = await import('./manager');

    const livePath = await addWorktree('packet-live-worker');

    // Spawn a real child whose cwd is inside the worktree — the live-worker
    // signature. The shared cwd snapshot detects it even though the path is not argv.
    const child = spawn('sleep', ['60'], { cwd: livePath, stdio: 'ignore', detached: false });
    bornProcs.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let it register

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-live-worker');
    expect(await exists(livePath), 'worktree with a live process survives').toBe(true);
  }, 60_000);

  it('prunes a stale worktree merely watched by a backend whose cwd is outside it', async () => {
    const { WorktreeManager } = await import('./manager');
    const watchedPath = await addWorktree('packet-backend-watch-only');
    const watchedFile = path.join(watchedPath, 'seed.txt');
    const child = spawn(process.execPath, [
      '-e',
      `const fs=require('node:fs');fs.openSync(${JSON.stringify(watchedFile)},'r');setInterval(()=>{},1000);`,
    ], { cwd: repoRoot, stdio: 'ignore', detached: false });
    bornProcs.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).toContain('packet-backend-watch-only');
    expect(await exists(watchedPath), 'watch-only worktree is prunable').toBe(false);
  }, 60_000);

  it('manager cleanup retains a live worktree even with a legacy override until the process exits', async () => {
    const livePath = await addWorktree('packet-live-cleanup-seam');
    const detach = vi.fn(async () => {});
    vi.doMock('@/lib/workspace/dependency-materializer', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/lib/workspace/dependency-materializer')>(),
      detachDependencyMaterialization: detach,
    }));
    vi.resetModules();
    const { withWorktreeMetaTransaction } = await import('./metadata-store');
    const identity = await lstat(livePath);
    await withWorktreeMetaTransaction(repoRoot, async (transaction) => {
      const entry = (await transaction.readAll())['packet-live-cleanup-seam']!;
      await transaction.save(entry.id, {
        ...entry,
        dependencyRecipeKey: 'a'.repeat(64),
        dependencyMaterialization: {
          mode: 'image',
          status: 'mounted',
          installCommand: 'npm ci --ignore-scripts',
          recipeKey: 'a'.repeat(64),
          leaseId: 'live-cleanup-lease',
          generation: 'live-cleanup-generation',
          workspaceDevice: identity.dev,
          workspaceInode: identity.ino,
        },
      });
    });
    const child = spawn('sleep', ['60'], { cwd: livePath, stdio: 'ignore', detached: false });
    bornProcs.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const { WorktreeManager } = await import('./manager');
    const mgr = new WorktreeManager(repoRoot);
    await expect(mgr.cleanup('packet-live-cleanup-seam', { force: true })).resolves.toBe(false);
    expect(await exists(livePath), 'live worktree survives ordinary cleanup').toBe(true);
    expect(detach).not.toHaveBeenCalled();

    await expect(mgr.cleanup('packet-live-cleanup-seam', {
      force: true,
      overrideLiveGuard: true,
    })).resolves.toBe(false);
    expect(await exists(livePath), 'retirement process authority retains a live workspace').toBe(true);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await expect(mgr.cleanup('packet-live-cleanup-seam', { force: true })).resolves.toBe(true);
    expect(await exists(livePath), 'quiescent standalone workspace can be retired').toBe(false);
  }, 60_000);

  it('manager cleanup preserves a same-name replacement introduced at retirement', async () => {
    const originalPath = await addWorktree('packet-cleanup-replacement');
    const admittedPath = `${originalPath}-admitted`;
    vi.doMock('@/lib/workspace/exact-managed-directory-retirement', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/workspace/exact-managed-directory-retirement')>();
      return {
        ...actual,
        retireExactManagedDirectory: async (
          input: Parameters<typeof actual.retireExactManagedDirectory>[0],
        ) => {
          await rename(originalPath, admittedPath);
          await git(['clone', '--local', repoRoot, originalPath], repoRoot);
          await writeFile(path.join(originalPath, 'replacement-sentinel'), 'preserve\n');
          return actual.retireExactManagedDirectory(input);
        },
      };
    });
    vi.resetModules();
    const { WorktreeManager } = await import('./manager');

    await expect(new WorktreeManager(repoRoot).cleanup(
      'packet-cleanup-replacement', { force: true },
    )).resolves.toBe(false);

    expect(await exists(path.join(originalPath, 'replacement-sentinel'))).toBe(true);
    expect(await exists(admittedPath)).toBe(true);
  }, 60_000);

  it('manager cleanup refuses an identity-less persisted row without adopting its occupant', async () => {
    const originalPath = await addWorktree('packet-identity-less');
    const admittedPath = `${originalPath}-admitted`;
    const { withWorktreeMetaTransaction } = await import('./metadata-store');
    await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save('packet-identity-less', {
      id: 'packet-identity-less',
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: 'identity-less',
      branchName: 'worktree/codex/packet-identity-less',
      status: 'ready',
      isolationKind: 'git-worktree',
    }));
    await rename(originalPath, admittedPath);
    await git(['clone', '--local', repoRoot, originalPath], repoRoot);
    await writeFile(path.join(originalPath, 'replacement-sentinel'), 'preserve\n');
    const { WorktreeManager } = await import('./manager');

    await expect(new WorktreeManager(repoRoot).cleanup(
      'packet-identity-less', { force: true },
    )).resolves.toBe(false);

    expect(await exists(path.join(originalPath, 'replacement-sentinel'))).toBe(true);
    expect(await exists(admittedPath)).toBe(true);
  }, 60_000);

  it('manager cleanup fails closed on corrupt authoritative metadata', async () => {
    const target = path.join(base, 'packet-corrupt-primary');
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel'), 'preserve\n');
    const { resolveWorktreeRootLayout } = await import('./root-layout');
    const primaryBase = resolveWorktreeRootLayout(repoRoot).primaryBase;
    await mkdir(primaryBase, { recursive: true });
    await writeFile(path.join(primaryBase, '.meta.json'), '{broken');
    const { WorktreeManager } = await import('./manager');

    await expect(new WorktreeManager(repoRoot).cleanup(
      'packet-corrupt-primary', { force: true },
    )).resolves.toBe(false);

    expect(await exists(path.join(target, 'sentinel'))).toBe(true);
  }, 60_000);

  it('manager cleanup does not trust crafted repository-local legacy metadata', async () => {
    const target = path.join(base, 'packet-crafted-legacy');
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel'), 'preserve\n');
    await writeFile(path.join(base, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        'packet-crafted-legacy': {
          id: 'packet-crafted-legacy',
          agentType: 'codex',
          baseBranch: 'attacker-branch',
          createdAt: Date.now(),
          claudeManaged: false,
          taskName: 'crafted',
          status: 'ready',
          isolationKind: 'apfs-cow-clone',
        },
      },
    }));
    const { WorktreeManager } = await import('./manager');

    await expect(new WorktreeManager(repoRoot).cleanup(
      'packet-crafted-legacy', { force: true },
    )).resolves.toBe(false);

    expect(await exists(path.join(target, 'sentinel'))).toBe(true);
  }, 60_000);

  it('periodic retirement sweep preserves a replacement managed base', async () => {
    const { resolveWorktreeRootLayout } = await import('./root-layout');
    const { captureWorktreeMaterializationIdentity } = await import('./materialization-identity');
    const { withWorktreeMetaTransaction } = await import('./metadata-store');
    const primaryBase = resolveWorktreeRootLayout(repoRoot).primaryBase;
    const anchorPath = path.join(primaryBase, 'packet-sweep-anchor');
    await mkdir(anchorPath, { recursive: true });
    const anchorIdentity = await captureWorktreeMaterializationIdentity(anchorPath);
    const anchorParentIdentity = await captureWorktreeMaterializationIdentity(primaryBase);
    await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save('packet-sweep-anchor', {
      id: 'packet-sweep-anchor',
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: 'sweep anchor',
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity: anchorIdentity,
      materializationParentIdentity: anchorParentIdentity,
    }));
    const replacementBase = `${primaryBase}-replacement`;
    const admittedBase = `${primaryBase}-admitted`;
    await mkdir(replacementBase);
    await writeFile(path.join(replacementBase, 'sentinel'), 'preserve\n');
    vi.doMock('@/lib/workspace/exact-managed-directory-retirement', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/workspace/exact-managed-directory-retirement')>();
      return {
        ...actual,
        finishPendingExactManagedDirectoryRetirements: async (
          ...args: Parameters<typeof actual.finishPendingExactManagedDirectoryRetirements>
        ) => {
          if (path.resolve(args[1]) === path.resolve(primaryBase)) {
            await rename(primaryBase, admittedBase);
            await rename(replacementBase, primaryBase);
          }
          return actual.finishPendingExactManagedDirectoryRetirements(...args);
        },
      };
    });
    vi.resetModules();
    const { WorktreeManager } = await import('./manager');

    await expect(new WorktreeManager(repoRoot).prune()).resolves.toEqual([]);

    expect(await exists(path.join(primaryBase, 'sentinel'))).toBe(true);
    expect(await exists(path.join(admittedBase, 'packet-sweep-anchor'))).toBe(true);
  }, 60_000);

  it('periodic prune ignores a forged retirement receipt targeting a live same-head worktree', async () => {
    const victimPath = await addWorktree('packet-forged-retirement', 0);
    const { captureWorktreeMaterializationIdentity } = await import('./materialization-identity');
    const victimIdentity = await captureWorktreeMaterializationIdentity(victimPath);
    const parentIdentity = await captureWorktreeMaterializationIdentity(base);
    const forgedReceiptPath = path.join(
      base,
      `.o8-retire-receipt-${'c'.repeat(64)}.json`,
    );
    await writeFile(forgedReceiptPath, JSON.stringify({
      version: 1,
      repositoryPath: repoRoot,
      worktreeId: 'packet-forged-retirement',
      directoryPath: victimPath,
      sourcePath: victimPath,
      retiredPath: path.join(base, '.o8-retired-managed-forged'),
      identity: victimIdentity,
      sourceIdentity: victimIdentity,
      parentIdentity,
    }));

    await expect(new (await import('./manager')).WorktreeManager(repoRoot).prune())
      .resolves.toEqual([]);

    expect(await exists(path.join(victimPath, 'seed.txt'))).toBe(true);
    expect(await exists(forgedReceiptPath)).toBe(true);
  }, 60_000);

  it('canonicalizes a symlinked lane worktree path before active-lane membership checks', async () => {
    const { WorktreeManager } = await import('./manager');
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const protectedPath = await addWorktree('packet-path-alias');
    const aliasRoot = repoRoot.startsWith('/private/var/')
      ? repoRoot.replace(/^\/private/, '')
      : `${repoRoot}-alias`;
    if (aliasRoot === `${repoRoot}-alias`) {
      await symlink(repoRoot, aliasRoot, 'dir');
      pathAliases.push(aliasRoot);
    }
    expect(await realpath(aliasRoot)).toBe(repoRoot);

    const lane = createLane({
      repoPath: aliasRoot,
      branch: 'worktree/codex/packet-path-alias',
      baseBranch: 'main',
      runtime: 'codex',
      worktreePath: path.join(aliasRoot, WORKTREE_DIR_NAME, 'packet-path-alias'),
    });
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'operator_review_required');

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-path-alias');
    expect(await exists(protectedPath), 'aliased non-terminal lane protects the real path').toBe(true);
  }, 60_000);
});
