import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GET } from '@/app/api/review/workspace/route';

let folder: string;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

const changes = async (workspace: string, fresh: boolean) => {
  const url = new URL('http://localhost/api/review/workspace');
  url.searchParams.set('workspace', workspace);
  url.searchParams.set('changesOnly', '1');
  if (fresh) url.searchParams.set('fresh', '1');
  const body = await (await GET(new Request(url))).json();
  return (body.changedFiles as { path: string; staged?: boolean; unstaged?: boolean }[])
    .map(({ path, staged, unstaged }) => ({ path, staged, unstaged }));
};

it('fresh=1 reads the staged and unstaged files Git has now, not the cached snapshot', async () => {
  folder = mkdtempSync(join(tmpdir(), 'o8-review-fresh-'));
  execFileSync('git', ['init', '-q', folder]);
  writeFileSync(join(folder, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', folder, 'add', '.']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
  expect(await changes(folder, false)).toEqual([]);
  writeFileSync(join(folder, 'staged.txt'), 'staged\n');
  writeFileSync(join(folder, 'unstaged.txt'), 'unstaged\n');
  execFileSync('git', ['-C', folder, 'add', 'staged.txt']);
  // The cached snapshot still says the tree is clean.
  expect(await changes(folder, false)).toEqual([]);
  const fresh = await changes(folder, true);
  expect(fresh.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'staged.txt', staged: true, unstaged: false },
    { path: 'unstaged.txt', staged: false, unstaged: true },
  ]);
});
