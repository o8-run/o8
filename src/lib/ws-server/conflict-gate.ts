import { SELF_REQUEST_HEADERS } from '@/lib/background-work/idle-gate';

/**
 * Gate for the ws-server's worktree conflict scan.
 *
 * The scan used to run the full worktree probe every 5 seconds regardless of
 * whether anything had changed, then throw the result away when the hash
 * matched — which, on an idle app, is every single time. On the operator's Intel
 * box that was ~519ms of git subprocesses per tick (~10% of a core, forever) to
 * re-derive an answer nobody asked for.
 *
 * The probe is now event-driven: it runs when a watcher says something could
 * actually have changed. This module holds the two decisions that make that
 * safe, as pure functions, so they can be tested directly rather than being
 * buried inside a 6,000-line server module.
 *
 * The invariant that matters: **we may run the probe when nothing changed
 * (merely wasteful), but we must never SKIP it when something did (a missed
 * merge conflict).** Every branch below is written to fail toward scanning.
 */

/**
 * Paths whose churn says nothing about whether a worktree is dirty. An
 * `npm install` inside a worktree must not re-arm the probe.
 */
export const WORKTREE_NOISE_RE =
  /(^|\/)(node_modules|\.next|target|dist|build|\.git|\.turbo|coverage)(\/|$)/;

/**
 * Is this filesystem event irrelevant to whether a worktree is dirty?
 *
 * `fs.watch` may hand us a null filename (the platform coalesced the event and
 * lost the path). We cannot prove that is noise, so we treat it as real — fail
 * safe, never fail silent.
 */
export function isWorktreeNoise(filename: string | null | undefined): boolean {
  if (!filename) return false;
  return WORKTREE_NOISE_RE.test(filename);
}

export interface ConflictGateState {
  /** Are the fs watchers live? If not, we have no change signal at all. */
  watchersActive: boolean;
  /** Has a watcher fired since the last completed probe? */
  dirty: boolean;
  /** Time since the last full probe. */
  msSinceFullScan: number;
  /** Force a probe at least this often, whatever the watchers say. */
  safetyNetMs: number;
}

/**
 * Should the expensive worktree probe run on this tick?
 */
export function shouldRunConflictScan(state: ConflictGateState): boolean {
  // No watchers means no change signal, so we cannot know. Poll exactly as the
  // server always did — this path must never be worse than the old behaviour.
  if (!state.watchersActive) return true;

  // A watcher fired: something moved.
  if (state.dirty) return true;

  // Belt and braces. Even with watchers live, a dropped or unwatched event must
  // not strand the conflict report forever.
  return state.msSinceFullScan >= state.safetyNetMs;
}

/**
 * Headers for the scan's request to this server. It is the server asking
 * itself, so it is marked as background and never keeps the idle gate awake.
 */
export function conflictScanRequestHeaders(token: string): Record<string, string> {
  return { 'Cache-Control': 'no-cache', Authorization: `Bearer ${token}`, ...SELF_REQUEST_HEADERS };
}
