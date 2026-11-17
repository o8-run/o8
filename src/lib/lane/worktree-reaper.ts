import { withWsHealthHandler } from '@/lib/ws-server/handler-activity';
import { resolveGitBinary } from '@/lib/git/binary';
/**
 * Stale-worktree reaper.
 *
 * Periodically scans lanes and auto-archives them when:
 *   1. `reviewing` lane whose worktree directory no longer exists on disk
 *      AND the review has been stale for 2h+ (orphaned review), OR
 *   2. Any active lane whose branch tip is already reachable from the
 *      base branch (merged externally — cherry-picks, outside merges), OR
 *   3. `idle` / `paused` lane that has no diff against its base branch and
 *      hasn't seen activity in 8h+ (abandoned scratch — nothing to review,
 *      no one is watching). Skipped when a pending approval is attached.
 *
 * `archiveLane()` handles the downstream worktree + branch cleanup when the
 * worktreePath is still set, so we just flip the lane via the same code
 * path used by the lane command bus. Anything already cleaned up on disk
 * is a no-op.
 *
 * Lives on its own interval rather than bolting onto `supervisorTick`
 * because it walks *all* lanes, not just watched agents.
 */

import { execFile } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { appendEvent, archiveLane, getLane, updateLane } from '@/lib/lane/registry';
import { withAutomaticWorkspaceReconciliation, workspaceAllowsAutomaticReconciliation } from '@/lib/workspace/automatic-reconciliation-guard';
import type { GitHubPullRequestSnapshot } from '@/lib/github-broker/store';
import type { Lane } from '@/lib/lane/types';
import { runBoundedWorktreeMaintenance } from './bounded-worktree-maintenance';

const execFileAsync = promisify(execFile);

const REAPER_INTERVAL_MS = 5 * 60_000;              // 5 minutes
const STALE_REVIEW_THRESHOLD_MS = 2 * 60 * 60_000;  // 2 hours
const ABANDONED_IDLE_THRESHOLD_MS = 8 * 60 * 60_000; // 8 hours
const MAX_TARGETED_PR_REFRESHES_PER_TICK = 5;

// Packet-backed ancestry reconciliation belongs to merged-by-ancestry.ts,
// which reads both packet and lane state before deciding that work is settled.
// This reaper only sees the lane row, so a freshly created branch that still
// equals its base is indistinguishable from a branch whose work was merged.
// Restrict the legacy lane-only path to settled states and never race a live
// packet's launch, worker, review, or refix cycle.
const LANE_ONLY_ANCESTRY_REAPABLE_STATUSES = new Set<Lane['status']>([
  'idle',
  'paused',
  'reviewing',
  'failed',
]);

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let initialReaperTimer: ReturnType<typeof setTimeout> | null = null;

interface MergedCleanResolution {
  mergedClean: boolean | null;
  reason: string;
  reviewedHeadSha?: string;
  reviewedTree?: string;
  comparisonRef?: string;
  comparisonTree?: string;
}

async function branchIsMergedIntoBase(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    // `git merge-base --is-ancestor <branch> <base>` exits 0 when the branch
    // tip is already reachable from base, 1 when it isn't. Anything else
    // (missing ref, bad repo) throws and we fall through to "not merged".
    await execFileAsync(
      resolveGitBinary(),
      ['merge-base', '--is-ancestor', branch, baseBranch],
      { windowsHide: true, cwd: repoPath, timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function worktreeHasNoDiffAgainstBase(
  worktreeCwd: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    // `git diff --quiet <base>...HEAD` exits 0 when there are no differences,
    // 1 when there are. Any other non-zero code (missing ref, detached
    // state) also throws; we conservatively return false so we never archive
    // a lane we can't reason about.
    await execFileAsync(
      resolveGitBinary(),
      ['diff', '--quiet', `${baseBranch}...HEAD`],
      { windowsHide: true, cwd: worktreeCwd, timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function readTreeHash(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveGitBinary(),
      ['rev-parse', `${ref}^{tree}`],
      { windowsHide: true, cwd: repoPath, timeout: 5_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function firstReadableTree(
  repoPath: string,
  refs: Array<string | null | undefined>,
): Promise<{ ref: string; tree: string } | null> {
  const seen = new Set<string>();
  for (const ref of refs) {
    const trimmed = ref?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const tree = await readTreeHash(repoPath, trimmed);
    if (tree) return { ref: trimmed, tree };
  }
  return null;
}

async function resolvePrMergedClean(
  lane: Lane,
  pull: GitHubPullRequestSnapshot,
): Promise<MergedCleanResolution> {
  const { latestRecordedReviewedHeadSha } = await import('@/lib/lane/review-head-integrity');
  const reviewedHeadSha = latestRecordedReviewedHeadSha(lane);
  if (!reviewedHeadSha) {
    return { mergedClean: null, reason: 'missing-reviewed-head' };
  }

  const reviewedTree = await readTreeHash(lane.repoPath, reviewedHeadSha);
  if (!reviewedTree) {
    return { mergedClean: null, reason: 'missing-reviewed-tree', reviewedHeadSha };
  }

  // The exact semantic of "merged clean" is: the PR HEAD tree at merge equals
  // the reviewed tree. Compare the head tree FIRST — it is usually still
  // readable right after merge, before branch pruning. Comparing against the
  // base branch first produced systematic FALSE NEGATIVES: any other PR landing
  // on main between the merge and the reaper tick moves the base tree even
  // though the operator merged the agent's diff untouched.
  const headTree = await firstReadableTree(lane.repoPath, [
    pull.headRefName,
    lane.branch,
    pull.headRefName ? `origin/${pull.headRefName}` : null,
    lane.branch ? `origin/${lane.branch}` : null,
  ]);
  if (headTree) {
    return {
      mergedClean: headTree.tree === reviewedTree,
      reason: headTree.tree === reviewedTree
        ? 'pr-head-tree-matches-reviewed-head'
        : 'pr-head-tree-differs-from-reviewed-head',
      reviewedHeadSha,
      reviewedTree,
      comparisonRef: headTree.ref,
      comparisonTree: headTree.tree,
    };
  }

  // Head refs pruned — fall back to the base tree. A MATCH is still conclusive
  // (the squash landed exactly the reviewed tree and nothing else moved), but a
  // MISMATCH is indeterminate, not "touched": base drift after merge is the
  // expected state of a busy repo.
  const baseTree = await firstReadableTree(lane.repoPath, [
    pull.baseRefName,
    lane.baseBranch,
    pull.baseRefName ? `origin/${pull.baseRefName}` : null,
    lane.baseBranch ? `origin/${lane.baseBranch}` : null,
  ]);
  if (baseTree?.tree === reviewedTree) {
    return {
      mergedClean: true,
      reason: 'merged-tree-matches-reviewed-head',
      reviewedHeadSha,
      reviewedTree,
      comparisonRef: baseTree.ref,
      comparisonTree: baseTree.tree,
    };
  }

  if (baseTree) {
    return {
      mergedClean: null,
      reason: 'base-tree-moved-head-unreadable',
      reviewedHeadSha,
      reviewedTree,
      comparisonRef: baseTree.ref,
      comparisonTree: baseTree.tree,
    };
  }

  return { mergedClean: null, reason: 'missing-merged-tree', reviewedHeadSha, reviewedTree };
}

async function stampPrMergedClean(
  lane: Lane,
  pull: GitHubPullRequestSnapshot,
): Promise<MergedCleanResolution> {
  const resolution = await resolvePrMergedClean(lane, pull);
  if (resolution.mergedClean === null) {
    return resolution;
  }
  const { markOutcomeMerged } = await import('@/lib/orchestrator/context-relay');
  await markOutcomeMerged({
    laneId: lane.id,
    packetId: lane.packetId,
    mergedClean: resolution.mergedClean,
  });
  return resolution;
}

function repoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = remoteUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

async function resolveRepoFullName(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveGitBinary(),
      ['remote', 'get-url', 'origin'],
      { windowsHide: true, cwd: repoPath, timeout: 5_000 },
    );
    return repoSlugFromRemoteUrl(stdout);
  } catch {
    return null;
  }
}

async function archiveMergedPullRequestLane(
  lane: Lane,
  repoFullName: string,
  pull: GitHubPullRequestSnapshot,
  match: 'prNumber' | 'headRefName',
): Promise<boolean> {
  const { recordPullRequestMergeReceipt } = await import('./pull-request-merge-receipt');
  await recordPullRequestMergeReceipt(lane, pull);
  const mergedClean = await stampPrMergedClean(lane, pull);
  const { releaseMergedPullRequestPacket } = await import('@/lib/orchestrator/automatic-release');
  const release = await releaseMergedPullRequestPacket(lane, pull, () => {
    console.log(`[worktree-reaper] ${lane.id} PR #${pull.number} merged at ${pull.mergedAt} — archiving`);
    archiveLane(lane.id, 'system');
    appendEvent(lane.id, 'pr_merged_reconciled', 'system', {
      repoFullName,
      prNumber: pull.number,
      mergedAt: pull.mergedAt,
      match,
      mergedClean: mergedClean.mergedClean,
      mergedCleanReason: mergedClean.reason,
      reviewedHeadSha: mergedClean.reviewedHeadSha ?? null,
      comparisonRef: mergedClean.comparisonRef ?? null,
    });
  });
  return release !== 'held';
}

function stampLanePullRequestNumber(lane: Lane, pull: GitHubPullRequestSnapshot): void {
  if (pull.number > 0 && lane.prNumber !== pull.number) {
    updateLane(lane.id, { prNumber: pull.number }, 'system');
  }
}

async function reconcileMergedPullRequest(
  lane: Lane,
  allowTargetedRefresh: boolean,
): Promise<{ archived: boolean; refreshed: boolean }> {
  if (lane.status !== 'reviewing') {
    return { archived: false, refreshed: false };
  }

  const repoFullName = await resolveRepoFullName(lane.repoPath);
  if (!repoFullName) {
    return { archived: false, refreshed: false };
  }

  const { getGitHubPullRequestByHead, getGitHubPullRequestByNumber } = await import('@/lib/github-broker/store');
  const prNumber = Number.isInteger(lane.prNumber) && (lane.prNumber ?? 0) > 0
    ? lane.prNumber
    : null;

  if (prNumber !== null) {
    let pull = getGitHubPullRequestByNumber(repoFullName, prNumber);
    if (pull?.mergedAt) {
      const archived = await archiveMergedPullRequestLane(lane, repoFullName, pull, 'prNumber');
      if (archived || (pull.headSha && pull.mergeCommit)) return { archived, refreshed: false };
    }

    if (allowTargetedRefresh) {
      const { ensureGitHubPullRequest } = await import('@/lib/github-broker/sync');
      const refreshed = await ensureGitHubPullRequest(repoFullName, prNumber);
      if (refreshed.error) console.warn(`[worktree-reaper] ${lane.id} PR #${prNumber} refresh failed: ${refreshed.error}`);
      pull = refreshed.pr;
      if (pull?.mergedAt) {
        return { archived: await archiveMergedPullRequestLane(lane, repoFullName, pull, 'prNumber'), refreshed: true };
      }
      return { archived: false, refreshed: true };
    }

    return { archived: false, refreshed: false };
  }

  const legacyPull = getGitHubPullRequestByHead(repoFullName, lane.branch);
  if (legacyPull) {
    stampLanePullRequestNumber(lane, legacyPull);
    if (legacyPull.mergedAt) {
      const archived = await archiveMergedPullRequestLane(lane, repoFullName, legacyPull, 'headRefName');
      if (archived || (legacyPull.headSha && legacyPull.mergeCommit)) return { archived, refreshed: false };
    }
    if (!legacyPull.mergedAt) return { archived: false, refreshed: false };
  }

  if (allowTargetedRefresh) {
    const { ensureGitHubPullRequestByHead } = await import('@/lib/github-broker/sync');
    const refreshed = await ensureGitHubPullRequestByHead(repoFullName, lane.branch);
    if (refreshed.error) console.warn(`[worktree-reaper] ${lane.id} PR refresh for ${lane.branch} failed: ${refreshed.error}`);
    const pull = refreshed.pr;
    if (pull) {
      stampLanePullRequestNumber(lane, pull);
      if (pull.mergedAt) {
        return { archived: await archiveMergedPullRequestLane(lane, repoFullName, pull, 'headRefName'), refreshed: true };
      }
    }
    return { archived: false, refreshed: true };
  }

  return { archived: false, refreshed: false };
}

async function laneHasPendingApproval(laneId: string): Promise<boolean> {
  try {
    const { listApprovalsForContext } = await import('@/lib/approvals/store');
    const approvals = listApprovalsForContext({ laneId });
    return approvals.some((approval) => approval.status === 'pending');
  } catch {
    // If the approvals store is unavailable for any reason, be conservative
    // and treat it as "pending approval present" so we don't archive a lane
    // the operator is actively reviewing.
    return true;
  }
}

async function reconcileWorktreeLane(lane: Lane): Promise<void> {
  if (!workspaceAllowsAutomaticReconciliation(lane.packetId)) return;
  await withAutomaticWorkspaceReconciliation(lane.packetId, async () => {
    const current = getLane(lane.id);
    if (!current || current.packetId !== lane.packetId) return false;
    await reconcileEligibleWorktreeLane(current);
    return true;
  });
}

async function reconcileEligibleWorktreeLane(lane: Lane): Promise<void> {
  const lanes = [lane];
  const now = Date.now();
  let remainingTargetedPrRefreshes = MAX_TARGETED_PR_REFRESHES_PER_TICK;

  for (const lane of lanes) {
    const updatedAtMs = Date.parse(lane.updatedAt);
    const ageMs = Number.isFinite(updatedAtMs) ? now - updatedAtMs : 0;

    const prReconciliation = await reconcileMergedPullRequest(lane, remainingTargetedPrRefreshes > 0);
    if (prReconciliation.refreshed) remainingTargetedPrRefreshes -= 1;
    if (prReconciliation.archived) continue;

    // Case 1: reviewing lane whose worktree vanished on disk.
    // Only trigger after 2h to give legitimate reviews room to breathe.
    if (
      lane.status === 'reviewing'
      && lane.worktreePath
      && !existsSync(lane.worktreePath)
      && ageMs > STALE_REVIEW_THRESHOLD_MS
    ) {
      console.log(`[worktree-reaper] ${lane.id} worktree missing on disk (${Math.round(ageMs / 60_000)}m stale) — archiving`);
      archiveLane(lane.id, 'system');
      continue;
    }

    // Case 2: a packetless, settled branch tip is already merged into base
    // (common when the operator cherry-picks onto main manually). Packet-backed
    // lanes are handled by the packet-aware merged-by-ancestry reconciler. A
    // live packet branch intentionally equals the base until its first commit,
    // so ancestry alone is not proof that its work has landed.
    if (
      !lane.packetId
      && LANE_ONLY_ANCESTRY_REAPABLE_STATUSES.has(lane.status)
      && lane.branch
      && lane.baseBranch
      && lane.branch !== lane.baseBranch
    ) {
      const merged = await branchIsMergedIntoBase(
        lane.repoPath,
        lane.branch,
        lane.baseBranch,
      );
      if (merged) {
        console.log(`[worktree-reaper] ${lane.id} branch ${lane.branch} already in ${lane.baseBranch} — archiving`);
        archiveLane(lane.id, 'system');
        continue;
      }
    }

    // Case 3: idle / paused lane with nothing to review. If the worktree has
    // no diff against its base branch AND the lane hasn't seen activity in
    // 8h+, treat it as abandoned and retire it. Skips lanes with pending
    // approvals so in-flight review work never disappears.
    const isEligibleForIdleReap = (lane.status === 'idle' || lane.status === 'paused')
      && ageMs > ABANDONED_IDLE_THRESHOLD_MS;
    if (isEligibleForIdleReap && lane.worktreePath && existsSync(lane.worktreePath) && lane.baseBranch) {
      const approvalPending = await laneHasPendingApproval(lane.id);
      if (approvalPending) continue;

      const noDiff = await worktreeHasNoDiffAgainstBase(lane.worktreePath, lane.baseBranch);
      if (noDiff) {
        console.log(`[worktree-reaper] ${lane.id} idle ${Math.round(ageMs / 3_600_000)}h with no diff against ${lane.baseBranch} — archiving`);
        archiveLane(lane.id, 'system');
      }
    }
  }
}

export async function runWorktreeReaperTick(): Promise<void> {
  await runWorktreeMaintenanceTick();
}

/** Startup, completion and interval callers share one bounded, durable scheduler. */
export async function runWorktreeMaintenanceTick(primaryRepoPath = process.cwd()): Promise<void> {
  const result = await withWsHealthHandler('worktree-reaper', () => runBoundedWorktreeMaintenance(reconcileWorktreeLane, { primaryRepoPath }));
  if (result.removed > 0 || result.held > 0 || result.registryHold) {
    console.log(
      `[worktree-reaper] candidates=${result.candidates} removed=${result.removed} held=${result.held} `
      + `metadataBytes=${result.readBytes}`,
    );
  }
}

export function startWorktreeReaper(): void {
  if (reaperTimer) return;

  initialReaperTimer = setTimeout(() => {
    initialReaperTimer = null;
    void runWorktreeMaintenanceTick().catch((err) => {
      console.error('[worktree-reaper] initial tick failed:', err);
    });
  }, 30_000);

  reaperTimer = setInterval(() => {
    void runWorktreeMaintenanceTick().catch((err) => {
      console.error('[worktree-reaper] tick failed:', err);
    });
  }, REAPER_INTERVAL_MS);

  console.log(`[worktree-reaper] started (interval ${REAPER_INTERVAL_MS}ms, stale review ${STALE_REVIEW_THRESHOLD_MS}ms, idle ${ABANDONED_IDLE_THRESHOLD_MS}ms)`);
}

export function stopWorktreeReaper(): void {
  if (initialReaperTimer) {
    clearTimeout(initialReaperTimer);
    initialReaperTimer = null;
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
    console.log('[worktree-reaper] stopped');
  }
}
