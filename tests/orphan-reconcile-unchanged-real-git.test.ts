import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// Count every git process the reconcile starts; the processes themselves are real.
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/providers/child-process', async (importOriginal) => {
  const { promisify } = await import('node:util');
  const actual = await importOriginal<typeof import('@/lib/providers/child-process')>();
  const original = actual.execFile as typeof actual.execFile & { [promisify.custom]: (...args: unknown[]) => Promise<unknown> };
  const execFile = ((...args: Parameters<typeof actual.execFile>) => {
    spawned.count++;
    return actual.execFile(...args);
  }) as typeof original;
  execFile[promisify.custom] = (...args: unknown[]) => {
    spawned.count++;
    return original[promisify.custom](...args);
  };
  return { ...actual, execFile };
});

const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', message]);
}

async function spawnsFor(run: () => Promise<number>): Promise<{ reconciled: number; spawns: number }> {
  spawned.count = 0;
  const reconciled = await run();
  return { reconciled, spawns: spawned.count };
}

it('skips the git probes for a gone-but-unmerged branch until a ref it read changes', async () => {
  const repo = mkdtempSync(join(os.tmpdir(), 'o8-orphan-unchanged-'));
  roots.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, 'base.txt', 'base');
  git(repo, ['checkout', '-q', '-b', 'inline/gone']);
  commit(repo, 'feature.txt', 'feature');
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'inline/gone']);

  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'inline/gone', baseBranch: 'main', runtime: 'codex', packetId: 'pkt-orphan-unchanged' });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

  const first = await spawnsFor(reconcileOrphanedWorktrees);
  expect(first).toMatchObject({ reconciled: 0 });
  expect(first.spawns).toBeGreaterThan(0);
  expect(getLane(lane.id)?.status).toBe('reviewing');

  // Nothing it read changed: no git process at all.
  expect(await spawnsFor(reconcileOrphanedWorktrees)).toEqual({ reconciled: 0, spawns: 0 });

  // The base gains a merge of the branch: the answer is recomputed and the lane completes.
  git(repo, ['branch', '-q', 'inline/gone', 'HEAD']);
  git(repo, ['checkout', '-q', 'inline/gone']);
  commit(repo, 'feature.txt', 'feature again');
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', "Merge branch 'inline/gone'", 'inline/gone']);
  git(repo, ['branch', '-q', '-D', 'inline/gone']);
  const merged = await spawnsFor(reconcileOrphanedWorktrees);
  expect(merged.reconciled).toBeGreaterThanOrEqual(1);
  expect(merged.spawns).toBeGreaterThan(0);
  expect(getLane(lane.id)?.status).toBe('completed');
});
