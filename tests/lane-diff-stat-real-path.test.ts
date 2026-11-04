import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

// A finished roster row reads its worktree chip and diff stat from the same
// lane read the roster's Clean up control uses: GET /api/lanes?active=false.
const root = mkdtempSync(path.join(tmpdir(), 'o8-lane-diff-stat-'));
const data = path.join(root, 'data');
mkdirSync(data);
const token = 'lane-diff-stat-fixture-token';
writeFileSync(path.join(data, 'ws-token'), token);
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
const { closeDb } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const lanesRoute = await import('@/app/api/lanes/route');

const repo = path.join(root, 'repo');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});

function seed() {
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(repo, 'b.txt'), 'keep\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const worktree = path.join(root, 'wt-done');
  git(repo, 'worktree', 'add', '-q', '-b', 'o8/roster-done', worktree);
  // Committed: one line changed in a.txt and a new file of two lines.
  writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(path.join(worktree, 'c.txt'), 'new\nfile\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'work');
  // Uncommitted tracked edit: b.txt gains a line.
  writeFileSync(path.join(worktree, 'b.txt'), 'keep\nmore\n');
  return worktree;
}

async function read(query: string) {
  const response = await lanesRoute.GET(new NextRequest(`http://localhost/api/lanes?${query}`, {
    headers: { authorization: 'Bearer ' + token },
  }));
  expect(response.status).toBe(200);
  return (await response.json()) as { lanes: Array<Record<string, unknown>> };
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('lane diff stat through GET /api/lanes', () => {
  it('adds the finished worktree diff stat only for the lanes a roster names', async () => {
    const worktree = seed();
    const done = createLane({ repoPath: repo, worktreePath: worktree, branch: 'o8/roster-done',
      baseBranch: 'main', runtime: 'codex', packetId: 'packet-done', ownership: 'managed' });
    setLaneStatus(done.id, 'completed');
    const other = createLane({ repoPath: repo, branch: 'o8/other',
      baseBranch: 'main', runtime: 'codex', packetId: 'packet-other', ownership: 'managed' });
    setLaneStatus(other.id, 'completed');

    const ordinary = await read('active=false');
    expect(ordinary.lanes.find((lane) => lane.id === done.id)).not.toHaveProperty('diffStat');

    const named = await read(`active=false&diffStat=${done.id},${other.id}`);
    const lane = named.lanes.find((entry) => entry.id === done.id);
    expect(lane).toMatchObject({
      packetId: 'packet-done',
      branch: 'o8/roster-done',
      worktreePath: worktree,
      // a.txt +1 -1, c.txt +2, b.txt +1 uncommitted.
      diffStat: { files: 3, insertions: 4, deletions: 1 },
    });
    expect(typeof lane?.createdAt).toBe('string');
    // A lane whose worktree is gone has no stat to read.
    expect(named.lanes.find((entry) => entry.id === other.id)).toHaveProperty('diffStat', null);
  }, 30_000);
});
