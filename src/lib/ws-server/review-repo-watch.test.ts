import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createReviewRepoWatch } from './review-repo-watch';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-watch-')));
  folders.push(path);
  return path;
}

it.runIf(process.platform === 'darwin')('marks a watched repository dirty on an edit and not on noise', async () => {
  const repo = folder();
  mkdirSync(join(repo, 'node_modules'));
  const dirty = vi.fn();
  const watch = createReviewRepoWatch({ markDirty: dirty, worktreeBases: () => [] });
  watch.ensure([repo]);
  expect(watch.watches(repo)).toBe(true);
  // FSEvents can report events from just before the watch began; let them pass.
  await new Promise(resolve => setTimeout(resolve, 300));
  dirty.mockClear();

  writeFileSync(join(repo, 'node_modules', 'noise.js'), 'x');
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(dirty).not.toHaveBeenCalled();

  writeFileSync(join(repo, 'edit.ts'), 'export {}\n');
  await vi.waitFor(() => expect(dirty).toHaveBeenCalledWith(repo), { timeout: 5_000 });
});

it('counts worktrees under a watched base and skips missing folders and other platforms', () => {
  const base = folder();
  const missing = join(folder(), 'gone');
  const watch = createReviewRepoWatch({ markDirty: vi.fn(), worktreeBases: () => [base] });
  expect(watch.watches(join(base, 'packet-one'))).toBe(true);
  expect(watch.watches(`${base}-sibling/packet`)).toBe(false);
  watch.ensure([missing]);
  expect(watch.watches(missing)).toBe(false);

  const linux = createReviewRepoWatch({ markDirty: vi.fn(), worktreeBases: () => [], platform: 'linux' });
  const repo = folder();
  linux.ensure([repo]);
  expect(linux.watches(repo)).toBe(false);
});
