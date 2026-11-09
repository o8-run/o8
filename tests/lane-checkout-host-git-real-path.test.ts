import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// A lane's worker can write its checkout's own Git state, even in the worker
// sandbox. o8 then commits there on the lane's behalf, outside the sandbox:
// only onto the lane's branch, and never through a link the worker planted.
const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-lane-host-git-')));
process.env.CORTEX_IDE_DATA_DIR = join(root, 'data');
process.env.O8_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { autoCommitCompletionWorktree } = await import('@/lib/supervisor/completion-verification');
const { LaneGitMetadataError } = await import('@/lib/lane/lane-git');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=o8 test',
  '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(name: string) {
  const repo = join(root, `${name}-repo`);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'o8 test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const lane = join(root, `${name}-lane`);
  const branch = `inline/${name}`;
  git(repo, 'worktree', 'add', '-q', '-b', branch, lane, 'main');
  const common = join(repo, '.git');
  const admin = git(lane, 'rev-parse', '--path-format=absolute', '--git-dir');
  writeFileSync(join(lane, 'work.txt'), 'worker\n');
  return { repo, lane, branch, common, admin, main: git(repo, 'rev-parse', 'refs/heads/main') };
}

describe('host commits in a lane checkout', () => {
  it('commits the work onto the lane branch', async () => {
    const f = fixture('control');
    await expect(autoCommitCompletionWorktree(f.lane, f.repo, 'worker change', f.branch)).resolves.toBe(true);
    expect(git(f.repo, 'log', '-1', '--format=%s', f.branch)).toBe('worker change [via-o8]');
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
  });

  it('refuses when the worker pointed HEAD at another branch', async () => {
    const f = fixture('head-moved');
    writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/main\n');
    await expect(autoCommitCompletionWorktree(f.lane, f.repo, 'worker change', f.branch)).rejects.toBeInstanceOf(LaneGitMetadataError);
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
  });

  it("refuses when the lane branch's reflog is a link", async () => {
    const f = fixture('reflog-link');
    const config = readFileSync(join(f.common, 'config'), 'utf8');
    const reflog = join(f.common, 'logs', 'refs', 'heads', 'inline', 'reflog-link');
    rmSync(reflog);
    symlinkSync(join(f.common, 'config'), reflog);
    await expect(autoCommitCompletionWorktree(f.lane, f.repo, 'worker change', f.branch)).rejects.toBeInstanceOf(LaneGitMetadataError);
    expect(readFileSync(join(f.common, 'config'), 'utf8')).toBe(config);
  });

  it('refuses when a file in the checkout state is a link', async () => {
    const f = fixture('state-link');
    const target = join(root, 'outside.txt');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, join(f.admin, 'COMMIT_EDITMSG'));
    await expect(autoCommitCompletionWorktree(f.lane, f.repo, 'worker change', f.branch)).rejects.toBeInstanceOf(LaneGitMetadataError);
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
  });

  it('refuses when the lane branch ref is a link to another branch', async () => {
    const f = fixture('ref-link');
    const ref = join(f.common, 'refs', 'heads', 'inline', 'ref-link');
    rmSync(ref);
    symlinkSync('../main', ref);
    await expect(autoCommitCompletionWorktree(f.lane, f.repo, 'worker change', f.branch)).rejects.toBeInstanceOf(LaneGitMetadataError);
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
  });
});
