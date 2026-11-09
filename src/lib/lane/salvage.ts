/**
 * Shared salvage routine (Recovery layer v2, 2026-07-08).
 *
 * #1282 — a worker that FINISHED its edits but died (or went silent) BEFORE
 * reporting completion leaves complete, correct work sitting UNCOMMITTED in its
 * worktree, because the pre-review auto-commit never ran. Both dead-owner ticks
 * must save that work rather than strand it as a failure:
 *   - the reaper (`reaper.ts`) salvages a `running` lane whose owner died and
 *     routes it to `reviewing`;
 *   - the silent-exit detector (`silent-exit-detector.ts`) salvages a lane whose
 *     session went away and routes it to `reviewing` after verification.
 *
 * The "commit the crashed worker's work" step lived inline in BOTH ticks. This
 * module is the single definition — a regression here silently loses real work,
 * so it lives in exactly one place.
 */

/**
 * Commit any uncommitted completion output in a crashed worker's worktree.
 * Thin, deliberate wrapper over `autoCommitCompletionWorktree` so the load-
 * bearing #1282 commit has ONE call site both ticks reach. Returns whether
 * anything real was committed (o8-injected artifacts alone → false). Propagates
 * git failures to the caller, which decides how to route the lane.
 */
export async function commitCrashedWorkerWork(
  worktreePath: string,
  repoPath: string,
  label: string | null | undefined,
  branch: string | null | undefined,
): Promise<boolean> {
  const { autoCommitCompletionWorktree } = await import('@/lib/supervisor/completion-verification');
  return autoCommitCompletionWorktree(worktreePath, repoPath, label, branch);
}

export interface RunningLaneSalvage {
  /** Whether the salvage step auto-committed uncommitted completion work. */
  autoCommitted: boolean;
  /** Whether reviewable output exists (auto-committed something OR a diff vs base). */
  reviewable: boolean;
}

/**
 * The reaper's #1282 salvage kernel: given a dead `running` lane's worktree,
 * commit its completion work and decide whether reviewable output exists. The
 * CALLER performs the lane transition (→ `reviewing` when reviewable, else its
 * fallback). `preCommitted` short-circuits the commit when worktree-preservation
 * already auto-committed (so we never double-commit).
 */
export async function decideRunningLaneSalvage(
  worktreePath: string,
  baseRef: string,
  repoPath: string,
  options: { label?: string | null; branch?: string | null; preCommitted?: boolean } = {},
): Promise<RunningLaneSalvage> {
  const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
  const autoCommitted = options.preCommitted ?? await commitCrashedWorkerWork(worktreePath, repoPath, options.label, options.branch);
  const reviewable = autoCommitted || (await hasReviewableCompletionDiff(worktreePath, baseRef, repoPath));
  return { autoCommitted, reviewable };
}
