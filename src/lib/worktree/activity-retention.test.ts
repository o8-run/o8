import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CHANGED_PATH_PROBES, worktreeActivityMtimeMs } from './activity';

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, {
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

async function exists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function ageWorktree(worktreePath: string, ageMs: number) {
  const when = new Date(Date.now() - ageMs);
  const adminPaths = await Promise.all(['HEAD', 'index'].map(async (name) => {
    const { stdout } = await git(['rev-parse', '--git-path', name], worktreePath);
    return path.resolve(worktreePath, stdout.trim());
  }));
  await Promise.all([
    utimes(worktreePath, when, when),
    ...adminPaths.map((adminPath) => utimes(adminPath, when, when).catch(() => {})),
  ]);
}

afterEach(async () => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
  delete process.env.CORTEX_IDE_DATA_DIR;
});

describe('worktree activity probe bound', () => {
  it('stats the leading changed paths and stops at the cap', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-activity-cap-')));
    const paths = Array.from({ length: MAX_CHANGED_PATH_PROBES + 1 }, (_, index) => `file-${index}.txt`);
    await Promise.all(paths.map((name) => writeFile(path.join(root, name), 'x')));
    const past = new Date('2020-01-01T00:00:00Z');
    await Promise.all(paths.map((name) => utimes(path.join(root, name), past, past)));
    await utimes(root, past, past);
    const newest = new Date('2030-01-01T00:00:00Z');

    await utimes(path.join(root, paths.at(-1)!), newest, newest);
    await expect(worktreeActivityMtimeMs({ worktreePath: root, changedPaths: paths })).resolves.toBe(past.getTime());

    await utimes(path.join(root, paths[0]!), newest, newest);
    await expect(worktreeActivityMtimeMs({ worktreePath: root, changedPaths: paths })).resolves.toBe(newest.getTime());
    await rm(root, { recursive: true, force: true });
  });
});

describe('WorktreeManager retention activity truth (#1586)', () => {
  it('ranks a committed file edit as newer than a worktree with a newer root mtime', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-activity-repo-')));
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-activity-data-')));
    cleanupPaths.push(repoRoot, dataDir);
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    await writeFile(
      path.join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ worktreeMaxCount: 1, worktreeMaxTotalGb: 0 }, null, 2)}\n`,
      'utf8',
    );

    await git(['init', '-b', 'main'], repoRoot);
    await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', 'seed.txt'], repoRoot);
    await git(['commit', '-m', 'seed'], repoRoot);

    const legacyBase = path.join(repoRoot, '.cortex-worktrees');
    await mkdir(legacyBase, { recursive: true });
    const editedPath = path.join(legacyBase, 'packet-recent-edit');
    const untouchedPath = path.join(legacyBase, 'packet-newer-root');
    await git(['worktree', 'add', editedPath, '-b', 'worktree/codex/recent-edit'], repoRoot);
    await git(['worktree', 'add', untouchedPath, '-b', 'worktree/codex/newer-root'], repoRoot);
    const { captureWorktreeMaterializationIdentity } = await import('./materialization-identity');
    const { withWorktreeMetaTransaction } = await import('./metadata-store');
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(legacyBase);
    await withWorktreeMetaTransaction(repoRoot, async (transaction) => {
      await transaction.save('packet-recent-edit', {
        id: 'packet-recent-edit',
        agentType: 'codex',
        baseBranch: 'main',
        createdAt: Date.now() - 60 * 60_000,
        claudeManaged: false,
        taskName: 'recent edit',
        branchName: 'worktree/codex/recent-edit',
        status: 'ready',
        isolationKind: 'git-worktree',
        materializationIdentity: await captureWorktreeMaterializationIdentity(editedPath),
        materializationParentIdentity,
      });
      await transaction.save('packet-newer-root', {
        id: 'packet-newer-root',
        agentType: 'codex',
        baseBranch: 'main',
        createdAt: Date.now() - 30 * 60_000,
        claudeManaged: false,
        taskName: 'newer root',
        branchName: 'worktree/codex/newer-root',
        status: 'ready',
        isolationKind: 'git-worktree',
        materializationIdentity: await captureWorktreeMaterializationIdentity(untouchedPath),
        materializationParentIdentity,
      });
    });
    await ageWorktree(editedPath, 60 * 60_000);
    await ageWorktree(untouchedPath, 30 * 60_000);

    // Editing an existing file leaves the worktree root mtime old. The commit's
    // HEAD and file mtimes are the truthful recent-activity signals.
    await writeFile(path.join(editedPath, 'seed.txt'), 'recent work\n', 'utf8');
    await git(['add', 'seed.txt'], editedPath);
    await git(['commit', '-m', 'recent work'], editedPath);

    const { WorktreeManager } = await import('./manager');
    const pruned = await new WorktreeManager(repoRoot).prune();

    expect(pruned).toContain('packet-newer-root');
    expect(pruned).not.toContain('packet-recent-edit');
    expect(await exists(editedPath), 'recently committed worktree survives').toBe(true);
    expect(await exists(untouchedPath), 'older effective activity is reclaimed').toBe(false);
  }, 60_000);
});
