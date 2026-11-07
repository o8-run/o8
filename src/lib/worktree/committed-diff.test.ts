import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as string[][]);

vi.mock('@/lib/providers/child-process', async () => {
  const { execFile } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await vi.importActual<typeof import('node:util')>('node:util');
  const run = promisify(execFile) as unknown as (...call: unknown[]) => Promise<unknown>;
  const tracked = Object.assign(() => undefined, {
    [promisify.custom]: (file: string, args: string[], options: unknown) => {
      spawned.push(args);
      return run(file, args, options);
    },
  });
  // committedDiff runs only read-only git (rev-parse, diff), so it uses the read-only boundary.
  return { execFileReadOnly: tracked };
});

import { committedDiff } from './committed-diff';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('committedDiff', () => {
  let repo: string;

  beforeEach(() => {
    spawned.length = 0;
    repo = mkdtempSync(join(tmpdir(), 'committed-diff-'));
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-qb', 'work');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'work');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const diffRuns = () => spawned.filter((args) => args[0] === 'diff').length;

  it('runs the diff once while both commits stay put', async () => {
    expect((await committedDiff(repo, 'main', '--name-only')).trim()).toBe('b.txt');
    const before = diffRuns();
    expect((await committedDiff(repo, 'main', '--name-only')).trim()).toBe('b.txt');
    expect(diffRuns()).toBe(before);
  });

  it('sees a new commit on HEAD', async () => {
    await committedDiff(repo, 'main', '--name-only');
    const before = diffRuns();
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'more');
    expect((await committedDiff(repo, 'main', '--name-only')).trim().split('\n')).toEqual(['b.txt', 'c.txt']);
    expect(diffRuns()).toBe(before + 1);
  });

  it('keeps each flag apart and surfaces an unknown base', async () => {
    expect(await committedDiff(repo, 'main', '--shortstat')).toContain('1 file changed');
    await expect(committedDiff(repo, 'no-such-base', '--shortstat')).rejects.toBeDefined();
  });
});
