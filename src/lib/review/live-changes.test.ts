import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLiveReviewChangeSet } from './live-changes';

let workspace: string;

function git(...args: string[]) {
  execFileSync('git', [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.test', '-c', `core.hooksPath=${workspace}`, ...args,
  ], { cwd: workspace, timeout: 5_000 });
}

describe('live review changes from a Git workspace', () => {
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'o8-live-review-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(workspace, '.gitignore'), 'generated/\n');
    writeFileSync(join(workspace, 'tracked.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reuses the snapshot after writes under an ignored directory', async () => {
    writeFileSync(join(workspace, 'tracked.txt'), 'base\nchanged\n');
    const first = await getLiveReviewChangeSet(workspace);
    expect(first.changedFiles).toEqual([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified', additions: 1 }),
    ]);

    mkdirSync(join(workspace, 'generated'));
    writeFileSync(join(workspace, 'generated', 'artifact'), 'ignored\n');

    expect(await getLiveReviewChangeSet(workspace)).toBe(first);
  });

  it('sees new untracked files and additional edits to a file that is already dirty', async () => {
    const tracked = join(workspace, 'tracked.txt');
    writeFileSync(tracked, 'base\nfirst\n');
    const first = await getLiveReviewChangeSet(workspace);
    expect(first.additions).toBe(1);

    const time = statSync(tracked).mtime;
    writeFileSync(tracked, 'base\nfirst\nsecond\n');
    utimesSync(tracked, time, time);
    writeFileSync(join(workspace, 'draft.txt'), 'new path\n');
    const updated = await getLiveReviewChangeSet(workspace);
    expect(updated.additions).toBe(2);
    expect(updated.changedFiles).toEqual([
      expect.objectContaining({ path: 'draft.txt', status: 'untracked' }),
      expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
    ]);

    git('add', 'tracked.txt');
    expect((await getLiveReviewChangeSet(workspace)).changedFiles).toEqual(updated.changedFiles);
  });
});
