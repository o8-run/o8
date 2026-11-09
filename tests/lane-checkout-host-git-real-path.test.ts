import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
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

const { autoCommitCompletionWorktree, commitLaneWork } = await import('@/lib/supervisor/completion-verification');
const { LaneGitMetadataError } = await import('@/lib/lane/lane-git');
const { commitDirtyWorktree, readLaneBranchSha } = await import('@/lib/lane/worktree-merge-git');

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
    expect(git(f.lane, 'status', '--porcelain')).toBe('');
  });

  it('commits onto the lane branch and leaves the checkout state alone, whatever its HEAD names', async () => {
    const f = fixture('head-unread');
    const headLog = readFileSync(join(f.admin, 'logs', 'HEAD'), 'utf8');
    writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/main\n');
    await expect(commitLaneWork(f.lane, f.repo, f.branch, 'worker change')).resolves.toBe(true);
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
    expect(git(f.repo, 'show', `${f.branch}:work.txt`)).toBe('worker');
    expect(existsSync(join(f.admin, 'COMMIT_EDITMSG'))).toBe(false);
    expect(readFileSync(join(f.admin, 'logs', 'HEAD'), 'utf8')).toBe(headLog);
  });

  it('commits a merge snapshot onto the lane branch, whatever the checkout HEAD names', async () => {
    const f = fixture('merge-head');
    writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/main\n');
    await commitDirtyWorktree(f.lane, f.repo, f.branch, 'merge snapshot');
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
    expect(git(f.repo, 'log', '-1', '--format=%s', f.branch)).toBe('merge snapshot');
    await expect(readLaneBranchSha(f.lane, f.repo, f.branch)).resolves.toBe(git(f.repo, 'rev-parse', f.branch));
  });

  it('leaves no commit directory behind, and removes ones an exit abandoned', async () => {
    const commitDirectories = join(root, 'data', 'lane-git');
    const f = fixture('no-accumulation');
    await expect(commitLaneWork(f.lane, f.repo, f.branch, 'worker change')).resolves.toBe(true);
    await expect(commitLaneWork(f.lane, f.repo, f.branch, 'nothing left')).resolves.toBe(false);
    writeFileSync(join(f.lane, 'work.txt'), 'again\n');
    const lock = join(f.common, 'refs', 'heads', 'inline', 'no-accumulation.lock');
    writeFileSync(lock, '');
    await expect(commitDirtyWorktree(f.lane, f.repo, f.branch, 'locked branch')).rejects.toThrow();
    rmSync(lock);
    expect(readdirSync(commitDirectories)).toEqual([]);

    const abandoned = join(commitDirectories, 'commit-abandoned');
    const live = join(commitDirectories, 'commit-live');
    mkdirSync(abandoned);
    mkdirSync(live);
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(abandoned, hoursAgo, hoursAgo);
    await expect(commitLaneWork(f.lane, f.repo, f.branch, 'worker change')).resolves.toBe(true);
    expect(readdirSync(commitDirectories)).toEqual(['commit-live']);
  });

  it('never commits onto another branch while the worker keeps moving HEAD', async () => {
    const f = fixture('head-race');
    const head = join(f.admin, 'HEAD');
    const flipper = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const [head, ...refs] = process.argv.slice(1);
      for (let i = 0; ; i++) {
        fs.writeFileSync(head + '.next', 'ref: ' + refs[i % 2] + '\\n');
        fs.renameSync(head + '.next', head);
      }`, head, 'refs/heads/main', `refs/heads/${f.branch}`], { stdio: 'ignore' });
    let committed = 0;
    try {
      for (let round = 0; round < 30; round++) {
        writeFileSync(join(f.lane, 'work.txt'), `round ${round}\n`);
        try {
          if (await autoCommitCompletionWorktree(f.lane, f.repo, `round ${round}`, f.branch)) committed++;
        } catch {
          // Refused. What matters is where the commits that did land went.
        }
      }
    } finally {
      flipper.kill('SIGKILL');
    }
    expect(git(f.repo, 'rev-parse', 'refs/heads/main')).toBe(f.main);
    expect(committed).toBeGreaterThan(0);
    expect(Number(git(f.repo, 'rev-list', '--count', `main..${f.branch}`))).toBe(committed);
  }, 60_000);

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
