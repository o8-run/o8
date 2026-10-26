import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';
import { requireBwrap } from '@/lib/runtimes/shared/owned-session/sandbox-linux';

async function bwrapUsable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  return requireBwrap().then(() => true, () => false);
}

const usable = await bwrapUsable();
const roots: string[] = [];

function tempDir(parent: string, prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(parent, prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.runIf(usable)('Linux worker sandbox confines a real child (bubblewrap)', () => {
  it('lets the worker write its worktree and nothing outside it', async () => {
    // HOME and the outside dir sit beside TMPDIR, not in it: TMPDIR is a grant.
    const home = tempDir('/tmp', 'o8-sbx-home-');
    const worktree = tempDir(os.tmpdir(), 'o8-sbx-wt-');
    const outsideTmp = tempDir('/tmp', 'o8-sbx-outside-');
    const outsideRepo = tempDir(process.cwd(), '.o8-sbx-outside-');
    execFileSync('git', ['init', '-q', worktree]);
    mkdirSync(path.join(home, '.o8'));
    writeFileSync(path.join(home, '.o8', 'ws-token'), 'operator-secret');
    const profileDir = tempDir(os.tmpdir(), 'o8-sbx-profile-');

    const script = [
      'exec 2>/dev/null',
      'echo inside > "$1/inside.txt"',
      'echo leak > "$2/outside.txt" 2>/dev/null && echo tmp-write-allowed',
      'echo leak > "$3/outside.txt" 2>/dev/null && echo repo-write-allowed',
      'echo leak > "$4/outside.txt" 2>/dev/null && echo home-write-allowed',
      'cat "$4/.o8/ws-token" 2>/dev/null && echo secret-read-allowed',
      'exit 0',
    ].join('\n');
    const prepared = await prepareWorkerSandbox({
      runId: 'run-1', profileDir, cwd: worktree, repoPath: worktree, homeDir: home,
      binary: '/bin/sh', args: ['-c', script, 'sh', worktree, outsideTmp, outsideRepo, home],
    });
    expect(prepared.profilePath).toBe(path.join(profileDir, 'run-1.bwrap'));
    const output = execFileSync(prepared.binary, prepared.args, { cwd: worktree, encoding: 'utf8' });

    expect(output).toBe('');
    expect(readFileSync(path.join(worktree, 'inside.txt'), 'utf8')).toBe('inside\n');
    for (const dir of [outsideTmp, outsideRepo, home]) expect(existsSync(path.join(dir, 'outside.txt'))).toBe(false);
  });

  it('keeps read-only packets from writing the worktree', async () => {
    const home = tempDir('/tmp', 'o8-sbx-home-');
    const worktree = tempDir(os.tmpdir(), 'o8-sbx-wt-');
    execFileSync('git', ['init', '-q', worktree]);
    const prepared = await prepareWorkerSandbox({
      runId: 'run-ro', profileDir: tempDir(os.tmpdir(), 'o8-sbx-profile-'), cwd: worktree, repoPath: worktree,
      homeDir: home, enforceReadOnly: true,
      binary: '/bin/sh', args: ['-c', 'exec 2>/dev/null; echo x > "$1/blocked.txt" && echo write-allowed; ls -a "$1" >/dev/null && echo readable', 'sh', worktree],
    });
    const output = execFileSync(prepared.binary, prepared.args, { cwd: worktree, encoding: 'utf8' });
    expect(output).toBe('readable\n');
    expect(existsSync(path.join(worktree, 'blocked.txt'))).toBe(false);
  });
});
