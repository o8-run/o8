/**
 * Regression guard for the idle-burn fix.
 *
 * `list()` used to compute `diskUsageBytes` unconditionally, which shells out to
 * `du -sk` — a recursive stat of every inode under the worktree (measured at
 * 189ms for one 38MB worktree). The ws-server's conflict scan calls `list()`
 * every 5 seconds, so an idle o8 was recursively walking every worktree on disk
 * twelve times a minute. With 11 worktrees present that was ~2.1s of pure disk
 * walk per 5s tick — before counting the git probes.
 *
 * Exactly one caller reads the field (`getActiveWorktreeSummary`), so disk usage
 * is now opt-in. These tests drive the REAL `list()` against a REAL git repo
 * (no mocks) and assert the observable contract, so that re-adding an
 * unconditional `getDiskUsage()` call fails the suite instead of silently
 * putting the disk walk back on the 5-second timer.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorktreeManager } from './manager';
import { captureWorktreeMaterializationIdentity } from './materialization-identity';
import { withWorktreeMetaTransaction } from './metadata-store';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR_NAME = '.cortex-worktrees';
const WT_ID = 'wt-cost-probe';

let repoRoot: string;
let worktreePath: string;

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

beforeAll(async () => {
  repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-wt-cost-')));

  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf-8');
  await git(['add', 'seed.txt'], repoRoot);
  await git(['commit', '-m', 'seed'], repoRoot);

  // A real git worktree under the dir the manager scans.
  const base = path.join(repoRoot, WORKTREE_DIR_NAME);
  await mkdir(base, { recursive: true });
  worktreePath = path.join(base, WT_ID);
  await git(['worktree', 'add', worktreePath, '-b', `worktree/codex/${WT_ID}`], repoRoot);

  // Give it real bytes so a `du` would return something non-zero, and COMMIT it
  // so the dirty-file probes below are exercising a tracked file (git diff never
  // reports untracked paths).
  await writeFile(path.join(worktreePath, 'payload.txt'), 'x'.repeat(64 * 1024), 'utf-8');
  await git(['add', 'payload.txt'], worktreePath);
  await git(['commit', '-m', 'payload'], worktreePath);

  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(base);
  await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save(WT_ID, {
    id: WT_ID,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: 'cost probe',
    branchName: `worktree/codex/${WT_ID}`,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
}, 60_000);

afterAll(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

describe('WorktreeManager.list() disk-usage cost', () => {
  it('does NOT walk the disk by default — this is what keeps it off the 5s conflict scan', async () => {
    const worktrees = await new WorktreeManager(repoRoot).list();

    const probe = worktrees.find((w) => w.id === WT_ID);
    expect(probe, 'the seeded worktree should be listed').toBeDefined();

    // If someone re-adds an unconditional getDiskUsage() to list(), this flips
    // non-zero and the 5-second recursive `du` is back on the idle path.
    expect(probe!.diskUsageBytes).toBe(0);
  }, 60_000);

  it('walks the disk only when the caller explicitly asks for bytes', async () => {
    const worktrees = await new WorktreeManager(repoRoot).list({ withDiskUsage: true });

    const probe = worktrees.find((w) => w.id === WT_ID);
    expect(probe).toBeDefined();
    // 64KB payload + a git checkout — comfortably non-zero.
    expect(probe!.diskUsageBytes).toBeGreaterThan(0);
  }, 60_000);
});

describe('WorktreeManager.getDirtyFiles() semantics after parallelizing the probes', () => {
  it('still returns the UNION of unstaged, staged, and committed-vs-base changes', async () => {
    const mgr = new WorktreeManager(repoRoot);

    // 1. committed on the branch, vs base
    await writeFile(path.join(worktreePath, 'committed.txt'), 'c\n', 'utf-8');
    await git(['add', 'committed.txt'], worktreePath);
    await git(['commit', '-m', 'committed change'], worktreePath);

    // 2. staged but not committed
    await writeFile(path.join(worktreePath, 'staged.txt'), 's\n', 'utf-8');
    await git(['add', 'staged.txt'], worktreePath);

    // 3. unstaged edit to a tracked file
    await writeFile(path.join(worktreePath, 'payload.txt'), 'mutated\n', 'utf-8');

    const dirty = await mgr.getDirtyFiles(worktreePath, 'main');

    expect(dirty).toContain('committed.txt');
    expect(dirty).toContain('staged.txt');
    expect(dirty).toContain('payload.txt');
  }, 60_000);

  it('catches a file staged and then reverted in the working tree', async () => {
    // This case is WHY the three probes were parallelized rather than collapsed
    // into a single `git diff --name-only HEAD`: here the index differs from
    // HEAD but the working tree does NOT, so `git diff HEAD` reports nothing
    // and the file would silently stop counting as dirty.
    const mgr = new WorktreeManager(repoRoot);

    await writeFile(path.join(worktreePath, 'revert-me.txt'), 'original\n', 'utf-8');
    await git(['add', 'revert-me.txt'], worktreePath);
    await git(['commit', '-m', 'add revert-me'], worktreePath);

    // Stage a change, then put the working tree back to the committed content.
    await writeFile(path.join(worktreePath, 'revert-me.txt'), 'staged-change\n', 'utf-8');
    await git(['add', 'revert-me.txt'], worktreePath);
    await writeFile(path.join(worktreePath, 'revert-me.txt'), 'original\n', 'utf-8');

    const dirty = await mgr.getDirtyFiles(worktreePath, 'main');

    expect(dirty).toContain('revert-me.txt');
  }, 60_000);

  it('reports a staged rename by its new path, as the staged diff did', async () => {
    const mgr = new WorktreeManager(repoRoot);

    await writeFile(path.join(worktreePath, 'rename-me.txt'), 'rename fixture\n'.repeat(8), 'utf-8');
    await git(['add', 'rename-me.txt'], worktreePath);
    await git(['commit', '-m', 'add rename-me'], worktreePath);
    await git(['mv', 'rename-me.txt', 'renamed.txt'], worktreePath);

    const dirty = await mgr.getDirtyFiles(worktreePath);

    expect(dirty).toContain('renamed.txt');
    expect(dirty).not.toContain('rename-me.txt');
  }, 60_000);
});
