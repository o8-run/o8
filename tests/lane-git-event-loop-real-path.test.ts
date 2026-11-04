/**
 * #3565: `laneGit` checks the lane's Git administration with host Git reads
 * before it runs the command. Those reads ran synchronously, so every lane Git
 * call held the server's event loop for their whole duration, and a launch made
 * dozens of them. A `git` shim on PATH makes those reads slow, as on a loaded
 * machine; the event loop must keep turning while `laneGit` waits on them.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { LaneGitMetadataError, laneGit, laneGitSync } from '@/lib/lane/lane-git';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-lane-git-loop-')));
const repoPath = join(root, 'repo');
const worktreePath = join(root, 'lane');
const realGit = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

mkdirSync(repoPath);
git(repoPath, 'init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'notes.txt'), 'one\n');
git(repoPath, 'add', 'notes.txt');
git(repoPath, '-c', 'user.name=o8', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'base');
git(repoPath, 'worktree', 'add', '-q', '-b', 'lane', worktreePath);
writeFileSync(join(worktreePath, 'notes.txt'), 'two\n');

// Slow only the checks' reads, so the command itself stays fast.
const bin = join(root, 'bin');
const configFailure = join(root, 'fail-config');
mkdirSync(bin);
writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in
  *" --git-common-dir "*|*" config "*)
    [ -f '${configFailure}' ] && case " $* " in *" config "*) exit 3 ;; esac
    sleep 0.3 ;;
esac
exec '${realGit}' "$@"
`);
chmodSync(join(bin, 'git'), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

/** The longest stretch, in ms, in which a 10 ms timer could not run while `work` was pending. */
async function longestStall(work: () => Promise<unknown>) {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return Math.max(longest, performance.now() - last);
}

describe('lane Git checks off the event loop (#3565)', () => {
  it('keeps the event loop turning while laneGit checks the lane, with the same output as laneGitSync', async () => {
    let output = '';
    const stall = await longestStall(async () => {
      output = String((await laneGit(worktreePath, repoPath, ['status', '--porcelain'])).stdout);
    });
    expect(output.trim()).toBe('M notes.txt');
    expect(laneGitSync(worktreePath, repoPath, ['status', '--porcelain']).trim()).toBe('M notes.txt');
    // Three slowed reads of 300 ms each; held synchronously they block for 900 ms or more.
    expect(stall).toBeLessThan(250);
  }, 30_000);

  it('fails the call when a check read fails, as laneGitSync does', async () => {
    // Exit 1 means "no matching config"; any other failure must stop the command.
    // Control the shim on disk; ambient test variables are intentionally not inherited.
    writeFileSync(configFailure, '');
    try {
      await expect(laneGit(worktreePath, repoPath, ['status', '--porcelain'])).rejects.toMatchObject({ status: 3 });
      expect(() => laneGitSync(worktreePath, repoPath, ['status', '--porcelain'])).toThrow(expect.objectContaining({ status: 3 }));
    } finally {
      rmSync(configFailure);
    }
  }, 30_000);

  it('still refuses a lane whose .git pointer names another worktree', async () => {
    const other = join(root, 'other');
    git(repoPath, 'worktree', 'add', '-q', '-b', 'other', other);
    const pointer = join(worktreePath, '.git');
    const original = execFileSync('cat', [pointer], { encoding: 'utf8' });
    writeFileSync(pointer, execFileSync('cat', [join(other, '.git')], { encoding: 'utf8' }));
    try {
      await expect(laneGit(worktreePath, repoPath, ['status', '--porcelain'])).rejects.toBeInstanceOf(LaneGitMetadataError);
      expect(() => laneGitSync(worktreePath, repoPath, ['status', '--porcelain'])).toThrow(LaneGitMetadataError);
    } finally {
      writeFileSync(pointer, original);
    }
  }, 30_000);
});
