import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

import { createReviewWatchTargets } from './review-watch-targets';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reads the worktree stores again only after an invalidation, a registry save or a fresh request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-review-targets-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const base = resolveWorktreeRootLayout(repo).bases[0]!;
  mkdirSync(join(base, 'wt-1'), { recursive: true });
  const meta = (ids: string[]) => writeFileSync(join(base, '.meta.json'), JSON.stringify({
    worktrees: Object.fromEntries(ids.map((id) => [id, { id, sessionKey: `s-${id}` }])),
  }));
  meta(['wt-1']);
  const reposFile = join(root, 'repos.json');
  writeFileSync(reposFile, '{"repos":[]}');
  const listRepoPaths = vi.fn(async () => [repo]);
  const targets = createReviewWatchTargets({ rootPath: join(root, 'server'), reposFile: () => reposFile, listRepoPaths });

  const paths = async (fresh?: boolean) => (await targets.list(fresh)).map((target) => target.workspacePath);
  for (let tick = 0; tick < 5; tick += 1) {
    expect(await paths()).toEqual([join(root, 'server'), repo, join(base, 'wt-1')]);
  }
  expect(listRepoPaths).toHaveBeenCalledTimes(1);

  // A worktree watcher event: the next pass sees the new worktree.
  mkdirSync(join(base, 'wt-2'));
  meta(['wt-1', 'wt-2']);
  targets.invalidate();
  expect(await paths()).toContain(join(base, 'wt-2'));
  expect(listRepoPaths).toHaveBeenCalledTimes(2);

  // The registry is saved: read again without any watcher event.
  writeFileSync(reposFile, '{"repos":[{"localPath":"x"}]}');
  await paths();
  expect(listRepoPaths).toHaveBeenCalledTimes(3);

  // The minute's sweep asks for a fresh list.
  await paths(true);
  await paths();
  expect(listRepoPaths).toHaveBeenCalledTimes(4);
});
