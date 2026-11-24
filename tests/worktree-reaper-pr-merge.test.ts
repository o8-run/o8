import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-pr-reaper-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
vi.resetModules();

const targetedHeadRefreshes = new Map<string, {
  number: number;
  state: 'open' | 'closed';
  closedAt?: string | null;
  mergedAt?: string | null;
}>();

vi.doMock('@/lib/github-broker/sync', () => ({
  ensureGitHubPullRequest: vi.fn(async (repoFullName: string, prNumber: number) => {
    const { getGitHubPullRequestByNumber } = await import('@/lib/github-broker/store');
    return {
      pr: getGitHubPullRequestByNumber(repoFullName, prNumber),
      error: null,
      stale: false,
    };
  }),
  ensureGitHubPullRequestByHead: vi.fn(async (repoFullName: string, headRefName: string) => {
    const pull = targetedHeadRefreshes.get(`${repoFullName}:${headRefName}`);
    if (!pull) {
      return { pr: null, error: null, stale: false };
    }

    const { getGitHubPullRequestByNumber, upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
    upsertGitHubPullRequest({
      pullRequestId: 910_000 + pull.number,
      repoFullName,
      number: pull.number,
      title: `PR ${pull.number}`,
      state: pull.state,
      author: null,
      body: '',
      headRefName,
      baseRefName: 'main',
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      reviewDecision: null,
      statusCheckRollup: [],
      url: `https://github.com/${repoFullName}/pull/${pull.number}`,
      createdAt: '2026-07-03T12:00:00.000Z',
      updatedAt: '2026-07-03T12:05:00.000Z',
      closedAt: pull.closedAt ?? null,
      mergedAt: pull.mergedAt ?? null,
    });
    return {
      pr: getGitHubPullRequestByNumber(repoFullName, pull.number),
      error: null,
      stale: false,
    };
  }),
}));

// This suite exercises reaper reconciliation and sweep selection. Keep its
// destructive seam deterministic under the full suite's process load; the
// live-process guard's real lsof behavior is covered by prune-safety tests.
vi.doMock('@/lib/worktree/live-process-guard', () => ({
  allowWorktreeRemoval: vi.fn(async () => true),
}));

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { runWorktreeReaperTick } = await import('@/lib/lane/worktree-reaper');
const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');
const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');

const REPO_FULL_NAME = 'hurttlocker/o8-reaper-pr-test';

afterAll(() => {
  closeDb();
  vi.doUnmock('@/lib/github-broker/sync');
  vi.resetModules();
});

afterEach(() => {
  targetedHeadRefreshes.clear();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-pr-reaper-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${REPO_FULL_NAME}.git`]);
  return dir;
}

async function makePacketWorktree(repoPath: string, branch: string, dirName: string) {
  const { createManagedPacketWorktree } = await import('./helpers/managed-packet-worktree');
  return createManagedPacketWorktree(repoPath, { packetId: dirName.slice('packet-'.length), branch });
}

function commitFile(cwd: string, fileName: string, body: string, message: string): string {
  writeFileSync(join(cwd, fileName), body);
  git(cwd, ['add', fileName]);
  git(cwd, ['commit', '-q', '--no-verify', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function squashBranchToMain(repoPath: string, branch: string, message: string): string {
  git(repoPath, ['merge', '--squash', branch]);
  git(repoPath, ['commit', '-q', '--no-verify', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

function insertSucceededOutcome(input: {
  laneId: string;
  packetId: string;
  repoPath: string;
  branch: string;
}): void {
  const now = new Date().toISOString();
  getSqlite().prepare(`
    INSERT INTO session_outcomes (
      id, repo_path, branch, runtime, lane_id, packet_id, outcome, summary,
      review_approved, started_at, completed_at
    ) VALUES (?, ?, ?, 'codex', ?, ?, 'succeeded', ?, 1, ?, ?)
  `).run(
    `outcome-${input.packetId}`,
    input.repoPath,
    input.branch,
    input.laneId,
    input.packetId,
    `completed ${input.packetId}`,
    now,
    now,
  );
}

function readMergedClean(packetId: string): number | null {
  const row = getSqlite().prepare(`
    SELECT merged_clean as mergedClean
    FROM session_outcomes
    WHERE packet_id = ?
  `).get(packetId) as { mergedClean: number | null } | undefined;
  return row?.mergedClean ?? null;
}

function recordApprovedReview(packetId: string, reviewedHeadSha: string): void {
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewedHeadSha,
  });
}

async function waitForPathGone(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!existsSync(targetPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(existsSync(targetPath)).toBe(false);
}

function markReviewing(laneId: string, prNumber: number | null): void {
  getSqlite().prepare(`
    UPDATE lanes
    SET status = 'reviewing', pr_number = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(prNumber, laneId);
}

function markStatus(laneId: string, status: string): void {
  getSqlite().prepare(`
    UPDATE lanes
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, laneId);
}

function mirrorPullRequest(input: {
  number: number;
  headRefName: string;
  state: 'open' | 'closed';
  closedAt?: string | null;
  mergedAt?: string | null;
}) {
  upsertGitHubPullRequest({
    pullRequestId: 900_000 + input.number,
    repoFullName: REPO_FULL_NAME,
    number: input.number,
    title: `PR ${input.number}`,
    state: input.state,
    author: null,
    body: '',
    headRefName: input.headRefName,
    baseRefName: 'main',
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: null,
    statusCheckRollup: [],
    url: `https://github.com/${REPO_FULL_NAME}/pull/${input.number}`,
    createdAt: '2026-07-03T12:00:00.000Z',
    updatedAt: '2026-07-03T12:05:00.000Z',
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
  });
}

describe('worktree reaper PR merge reconciliation', () => {
  it('archives a reviewing lane when its stamped PR mirror row is merged', { timeout: 20_000 }, async () => {
    const repoPath = makeRepo();
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, 'inline/pr-merged', 'packet-pkt-pr-merged');
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-merged',
      worktreePath,
      sessionKey,
    });
    markReviewing(lane.id, 301);
    mirrorPullRequest({
      number: 301,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:10:00.000Z',
      mergedAt: '2026-07-03T12:10:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    await waitForPathGone(worktreePath);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.prNumber).toBe(301);
    expect(event?.payload.match).toBe('prNumber');
  });

  it('stamps merged_clean when the PR squash tree matches the reviewed packet head', async () => {
    const repoPath = makeRepo();
    const packetId = 'pkt-pr-merged-clean';
    const branch = 'inline/pr-merged-clean';
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, branch, 'packet-pkt-pr-merged-clean');
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      worktreePath,
      sessionKey,
    });
    const reviewedHeadSha = commitFile(worktreePath, 'clean.txt', 'reviewed\n', 'feat: reviewed change [via-o8]');
    recordApprovedReview(packetId, reviewedHeadSha);
    insertSucceededOutcome({ laneId: lane.id, packetId, repoPath, branch });
    squashBranchToMain(repoPath, branch, 'squash reviewed change');
    markReviewing(lane.id, 307);
    mirrorPullRequest({
      number: 307,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:40:00.000Z',
      mergedAt: '2026-07-03T12:40:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    await waitForPathGone(worktreePath);
    expect(readMergedClean(packetId)).toBe(1);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.mergedClean).toBe(true);
    expect(event?.payload.reviewedHeadSha).toBe(reviewedHeadSha);
  });

  it('stamps merged_clean false when the merged PR tree moved after review', async () => {
    const repoPath = makeRepo();
    const packetId = 'pkt-pr-merged-touched';
    const branch = 'inline/pr-merged-touched';
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, branch, 'packet-pkt-pr-merged-touched');
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      worktreePath,
      sessionKey,
    });
    const reviewedHeadSha = commitFile(worktreePath, 'touched.txt', 'reviewed\n', 'feat: reviewed change [via-o8]');
    recordApprovedReview(packetId, reviewedHeadSha);
    commitFile(worktreePath, 'touched.txt', 'reviewed\noperator touch\n', 'fix: operator touch-up');
    insertSucceededOutcome({ laneId: lane.id, packetId, repoPath, branch });
    squashBranchToMain(repoPath, branch, 'squash touched change');
    markReviewing(lane.id, 308);
    mirrorPullRequest({
      number: 308,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:45:00.000Z',
      mergedAt: '2026-07-03T12:45:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    await waitForPathGone(worktreePath);
    expect(readMergedClean(packetId)).toBe(0);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.mergedClean).toBe(false);
    expect(event?.payload.mergedCleanReason).toBe('pr-head-tree-differs-from-reviewed-head');
  });

  it('stamps merged_clean true when other commits land on main after a clean squash merge', async () => {
    const repoPath = makeRepo();
    const packetId = 'pkt-pr-merged-clean-busy-main';
    const branch = 'inline/pr-merged-clean-busy-main';
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, branch, 'packet-pkt-pr-merged-clean-busy-main');
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      worktreePath,
      sessionKey,
    });
    const reviewedHeadSha = commitFile(worktreePath, 'busy.txt', 'reviewed\n', 'feat: reviewed change [via-o8]');
    recordApprovedReview(packetId, reviewedHeadSha);
    insertSucceededOutcome({ laneId: lane.id, packetId, repoPath, branch });
    squashBranchToMain(repoPath, branch, 'squash reviewed change');
    // Another PR lands on main between the merge and the reaper tick — the
    // base tree moves, but the packet's diff was merged untouched. This is the
    // false-negative case the head-tree-first ordering exists for.
    commitFile(repoPath, 'unrelated.txt', 'someone else\n', 'feat: unrelated change');
    markReviewing(lane.id, 309);
    mirrorPullRequest({
      number: 309,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:50:00.000Z',
      mergedAt: '2026-07-03T12:50:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    await waitForPathGone(worktreePath);
    expect(readMergedClean(packetId)).toBe(1);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.mergedClean).toBe(true);
    expect(event?.payload.mergedCleanReason).toBe('pr-head-tree-matches-reviewed-head');
  });

  it('preserves dirty terminal work before deleting a PR-merged packet clone', async () => {
    const repoPath = makeRepo();
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, 'inline/pr-merged-dirty', 'packet-pkt-pr-merged-dirty');
    writeFileSync(join(worktreePath, 'dirty.txt'), 'salvaged terminal work\n');
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-merged-dirty',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-merged-dirty',
      worktreePath,
      sessionKey,
    });
    markReviewing(lane.id, 304);
    mirrorPullRequest({
      number: 304,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:30:00.000Z',
      mergedAt: '2026-07-03T12:30:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    await waitForPathGone(worktreePath);
    expect(git(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/preserved/packet-pkt-pr-merged-dirty'])).toBe('');
    expect(git(repoPath, ['show', 'preserved/packet-pkt-pr-merged-dirty:dirty.txt'])).toBe('salvaged terminal work\n');
  });

  it('leaves a reviewing lane untouched when its stamped PR is closed but unmerged', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-closed-unmerged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-closed-unmerged',
    });
    markReviewing(lane.id, 302);
    mirrorPullRequest({
      number: 302,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:15:00.000Z',
      mergedAt: null,
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('reviewing');
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event).toBeUndefined();
  });

  it('asks git for the origin of an unchanged repository only once across passes', async () => {
    // Earlier cases may leave lanes in review; this pass must reach this lane each tick.
    getSqlite().prepare("UPDATE lanes SET status = 'archived' WHERE status = 'reviewing'").run();
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-open-unchanged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-open-unchanged',
    });
    markReviewing(lane.id, 303);
    mirrorPullRequest({ number: 303, headRefName: lane.branch, state: 'open', closedAt: null, mergedAt: null });
    const { ChildProcess } = await import('node:child_process');
    const prototype = ChildProcess.prototype as unknown as { spawn: (options: { args?: string[]; cwd?: string }) => unknown };
    const spawn = prototype.spawn;
    let lookups = 0;
    prototype.spawn = function counted(this: unknown, options) {
      if (options?.args?.includes('get-url') && options.cwd === repoPath) lookups += 1;
      return spawn.call(this, options);
    };
    try {
      await runWorktreeReaperTick();
      expect(lookups).toBe(1);
      await runWorktreeReaperTick();
      await runWorktreeReaperTick();
      expect(lookups).toBe(1);
      // A changed remote is read again on the next pass.
      git(repoPath, ['remote', 'set-url', 'origin', `https://github.com/${REPO_FULL_NAME}-moved.git`]);
      await runWorktreeReaperTick();
      expect(lookups).toBe(2);
    } finally {
      prototype.spawn = spawn;
    }
    expect(getLane(lane.id)?.status).toBe('reviewing');
    // Leave no reviewing lane behind to take the next tests' active slot.
    getSqlite().prepare("UPDATE lanes SET status = 'archived' WHERE id = ?").run(lane.id);
  });

  it('archives legacy reviewing lanes by merged PR head branch when prNumber is missing', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/legacy-pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-legacy-pr-merged',
    });
    markReviewing(lane.id, null);
    mirrorPullRequest({
      number: 303,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:20:00.000Z',
      mergedAt: '2026-07-03T12:20:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.prNumber).toBe(303);
    expect(event?.payload.match).toBe('headRefName');
    expect(getLane(lane.id)?.prNumber).toBe(303);
  });

  it('archives and stamps no-prNumber lanes by targeted GitHub head refresh when the mirror has no row', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/head-refresh-pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-head-refresh-pr-merged',
    });
    markReviewing(lane.id, null);
    targetedHeadRefreshes.set(`${REPO_FULL_NAME}:${lane.branch}`, {
      number: 305,
      state: 'closed',
      closedAt: '2026-07-03T12:35:00.000Z',
      mergedAt: '2026-07-03T12:35:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    expect(getLane(lane.id)?.prNumber).toBe(305);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.prNumber).toBe(305);
    expect(event?.payload.match).toBe('headRefName');
  });

  it('stamps no-prNumber lanes by targeted GitHub head refresh before the PR is merged', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/head-refresh-pr-open',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-head-refresh-pr-open',
    });
    markReviewing(lane.id, null);
    targetedHeadRefreshes.set(`${REPO_FULL_NAME}:${lane.branch}`, {
      number: 306,
      state: 'open',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(getLane(lane.id)?.prNumber).toBe(306);
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event).toBeUndefined();
  });

  it('does not archive a running packet whose new branch still equals its base', async () => {
    const repoPath = makeRepo();
    const branch = 'inline/running-before-first-commit';
    const { path: worktreePath, sessionKey } = await makePacketWorktree(repoPath, branch, 'packet-pkt-running-before-first-commit');
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-running-before-first-commit',
      worktreePath,
      sessionKey,
    });
    markStatus(lane.id, 'running');

    await runWorktreeReaperTick();

    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      worktreePath,
      sessionKey,
    });
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('startup sweep removes terminal and abandoned orphan clones while protecting recent orphans + active/context dirs', async () => {
    const repoPath = makeRepo();
    const worktreeRoot = join(repoPath, '.cortex-worktrees');
    const activePath = join(worktreeRoot, 'packet-pkt-active-sweep');
    const terminalPath = join(worktreeRoot, 'packet-pkt-terminal-sweep');
    const oldOrphanPath = join(worktreeRoot, 'packet-pkt-old-orphan-sweep');
    const recentOrphanPath = join(worktreeRoot, 'packet-pkt-recent-orphan-sweep');
    const contextPath = join(worktreeRoot, 'context');
    const scratchPath = join(worktreeRoot, 'scratch-sweep');
    mkdirSync(activePath, { recursive: true });
    mkdirSync(terminalPath, { recursive: true });
    mkdirSync(oldOrphanPath, { recursive: true });
    mkdirSync(recentOrphanPath, { recursive: true });
    mkdirSync(contextPath, { recursive: true });
    mkdirSync(scratchPath, { recursive: true });

    // The prune gate (Rock 1 item 3) protects an orphan clone that was touched
    // recently — a crash mid-write can leave uncommitted work in it (#1497). An
    // abandoned orphan (old mtime) is safe to sweep; backdate it so it reads as
    // genuinely stale rather than a live-agent tree.
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(oldOrphanPath, stale, stale);

    createLane({
      repoPath,
      branch: 'inline/active-sweep',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-active-sweep',
      worktreePath: activePath,
    });
    const terminalLane = createLane({
      repoPath,
      branch: 'inline/terminal-sweep',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-terminal-sweep',
      worktreePath: terminalPath,
    });
    markStatus(terminalLane.id, 'archived');

    const result = await sweepTerminalCortexWorktrees(repoPath);

    expect(result.removed).toBe(0);
    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(terminalPath)).toBe(true);
    expect(existsSync(oldOrphanPath)).toBe(true); // Age does not grant ownership of an unmanaged directory.
    expect(existsSync(recentOrphanPath)).toBe(true); // recent orphan → protected (#1497)
    expect(existsSync(contextPath)).toBe(true);
    expect(existsSync(scratchPath)).toBe(true);
  });
});

  it('does not invent a packet release for a lane absent from durable missions', { timeout: 20_000 }, async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-merged-release',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-merged-release',
    });
    markReviewing(lane.id, 311);
    mirrorPullRequest({
      number: 311,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-04T12:00:00.000Z',
      mergedAt: '2026-07-04T12:00:00.000Z',
    });

    // Fair bounded passes can leave this newest lane behind earlier held candidates.
    // Keep the original archival and no-invented-release assertions after one finite cycle.
    for (let pass = 0; pass < 8 && getLane(lane.id)?.status !== 'archived'; pass += 1) {
      await runWorktreeReaperTick();
    }

    expect(getLane(lane.id)?.status).toBe('archived');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().packets.some((packet) => packet.id === lane.packetId)).toBe(false);
  });
