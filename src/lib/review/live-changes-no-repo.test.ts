import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/providers/child-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/child-process')>();
  return {
    ...actual,
    execFile: ((...args: Parameters<typeof actual.execFile>) => {
      spawned.count++;
      return actual.execFile(...args);
    }) as typeof actual.execFile,
  };
});

const { getLiveReviewChangeSet } = await import('./live-changes');
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  spawned.count = 0;
});

it('reads a folder outside any repository as empty without starting git', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'o8-live-review-plain-')));
  folders.push(folder);
  writeFileSync(join(folder, 'notes.txt'), 'not in a repository\n');

  for (let pass = 0; pass < 3; pass++) {
    const changes = await getLiveReviewChangeSet(folder);
    expect(changes).toMatchObject({ workspacePath: folder, changedFiles: [], additions: 0, deletions: 0, files: 0 });
  }
  expect(spawned.count).toBe(0);
});

it('reads a deleted folder as empty without starting git', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'o8-live-review-gone-')));
  rmSync(folder, { recursive: true, force: true });
  expect(await getLiveReviewChangeSet(folder)).toMatchObject({ changedFiles: [], files: 0 });
  expect(spawned.count).toBe(0);
});
