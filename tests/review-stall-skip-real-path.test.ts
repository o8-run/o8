/**
 * The review stall pass is skipped while nothing it reads has changed: the
 * reviewing lanes and their lane events, the review queue, a reviewing lane's
 * approvals, its HEAD and its branch and base refs. Other lanes do not count.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

const passes = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/lane/review-stall-reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/review-stall-reconcile')>();
  return {
    ...actual,
    reconcileReviewStalls: async () => {
      passes.count += 1;
      return actual.reconcileReviewStalls();
    },
  };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-skip-data-'));
const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-skip-repo-'));
writeFileSync(join(dataDir, 'ws-token'), 'review-stall-skip-token-0123456789\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb } = await import('@/lib/db');
const { createApproval } = await import('@/lib/approvals/store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { runReviewRecoveryPass } = await import('@/lib/lane/review-drain-recovery');

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}

function commit(message: string): void {
  writeFileSync(join(repoDir, `${message}.txt`), message);
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

it('skips the stall pass until a lane, its approvals, the queue, its HEAD or its refs change', async () => {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  commit('base');
  const lane = createLane({
    repoPath: repoDir, worktreePath: repoDir, branch: 'main', baseBranch: 'main',
    runtime: 'codex', label: 'stall skip fixture', packetId: 'pkt-stall-skip', sessionKey: 'test-runtime:stall-skip',
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'fixture');

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // The pass is due every 30 s.
    const tick = async () => { vi.setSystemTime(Date.now() + 31_000); await runReviewRecoveryPass(); };
    await tick();
    expect(passes.count).toBe(1);
    await tick();
    await tick();
    expect(passes.count).toBe(1);

    // A commit in the lane's worktree moves its HEAD.
    commit('next');
    await tick();
    expect(passes.count).toBe(2);
    await tick();
    expect(passes.count).toBe(2);

    // An approval for the lane.
    createApproval({
      source: 'runtime', runtime: 'codex', agent: 'reviewer', sessionKey: 'test-runtime:stall-skip',
      title: 'Review', description: 'Review', summary: 'Review', risk: 'low',
      args: { laneId: lane.id }, laneId: lane.id, packetId: 'pkt-stall-skip',
    } as Parameters<typeof createApproval>[0]);
    await tick();
    expect(passes.count).toBe(3);

    // A lane event.
    recordLaneEvent(lane.id, 'agent_report', 'system', {});
    await tick();
    expect(passes.count).toBe(4);
    await tick();
    expect(passes.count).toBe(4);

    // Another lane's events and updates are not read by the pass.
    const other = createLane({
      repoPath: repoDir, worktreePath: repoDir, branch: 'other', baseBranch: 'main',
      runtime: 'codex', label: 'idle neighbour', packetId: 'pkt-stall-other', sessionKey: 'test-runtime:stall-other',
    });
    await tick();
    const afterCreate = passes.count;
    recordLaneEvent(other.id, 'close_timing', 'system', { totalMs: 1 });
    setLaneStatus(other.id, 'idle', 'system', 'fixture');
    recordLaneEvent(other.id, 'close_timing', 'system', { totalMs: 2 });
    await tick();
    await tick();
    expect(passes.count).toBe(afterCreate);

    // A lane that starts awaiting review is read.
    setLaneStatus(other.id, 'reviewing', 'system', 'fixture');
    await tick();
    expect(passes.count).toBe(afterCreate + 1);
    setLaneStatus(other.id, 'idle', 'system', 'fixture');
    await tick();
    expect(passes.count).toBe(afterCreate + 2);

    // No timer: ten minutes with nothing changed is still skipped.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await runReviewRecoveryPass();
    expect(passes.count).toBe(afterCreate + 2);

    // A fetch moves origin's copy of the base, without touching this worktree's HEAD.
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await tick();
    expect(passes.count).toBe(afterCreate + 3);
    await tick();
    expect(passes.count).toBe(afterCreate + 3);
  } finally {
    vi.useRealTimers();
  }
});
