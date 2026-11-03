/**
 * Live-process guard for worktree pruning (#1585).
 *
 * The invariant the whole worktree-prune fix hangs on: **a worktree that
 * contains a running process is NEVER prunable.** On 2026-07-18 o8's own
 * pruner `rm -rf`'d the worktrees of four LIVE Codex workers mid-turn — every
 * rollout recorded `turn_aborted / reason: "interrupted"` in the same second
 * because their cwd was deleted out from under them. Nothing checked whether a
 * process was still living in the directory before the destructive step.
 *
 * `hasLiveProcessInside(dir)` answers "does any live process have its cwd under
 * `dir`?" by filtering one machine-wide `lsof -d cwd` snapshot. This avoids a
 * recursive filesystem walk for every candidate while still excluding backend
 * watcher file descriptors. A real worker is spawned with cwd=<worktree>, which
 * this detects even when the path is absent from argv.
 *
 * Fail CLOSED: any probe error — timeout, missing `lsof`, permission, a
 * nonsense path — is treated as "live" so the caller KEEPS the worktree. We
 * would rather leak a stale directory than abort a live worker's turn.
 */
import path from 'node:path';
import { unreadableCwdReason } from '@/lib/runtime/process-open-files-snapshot';
import {
  readProcessCwdSnapshot,
  processCwdRowsInside,
  type ProcessCwdSnapshot,
} from '@/lib/runtime/process-cwd-snapshot';

export type LiveProcessProbeResult =
  | { status: 'clear' }
  | { status: 'live'; pids: string[] }
  | { status: 'inconclusive'; reason: string };

export interface LiveProcessProbeOptions {
  /** Test/fleet seam for a single machine-wide cwd capture. */
  snapshot?: ProcessCwdSnapshot;
  readSnapshot?: () => Promise<ProcessCwdSnapshot>;
}

/**
 * True when any live process has an open file (or cwd) inside `dirPath`.
 *
 * Fail-closed contract: returns `true` on ANY uncertainty (probe error,
 * timeout, missing binary, nonsense path) so the worktree is preserved.
 * Returns `false` only when `lsof` cleanly reports nothing open under the tree.
 */
export async function probeLiveProcessInside(
  dirPath: string,
  options: LiveProcessProbeOptions = {},
): Promise<LiveProcessProbeResult> {
  const target = path.resolve(dirPath);
  // A blank or root target cannot be bounded safely — refuse and fail closed.
  if (!target || target === '/' || target === path.parse(target).root) {
    return { status: 'inconclusive', reason: `unsafe probe target ${JSON.stringify(target)}` };
  }

  const snapshot = options.snapshot
    ?? await (options.readSnapshot?.() ?? readProcessCwdSnapshot());
  if (snapshot.status !== 'ready') {
    return { status: 'inconclusive', reason: snapshot.reason };
  }
  const reason = unreadableCwdReason(snapshot.rows);
  if (reason) return { status: 'inconclusive', reason };
  const pids = processCwdRowsInside(snapshot, target)
    .map((row) => String(row.pid));
  return pids.length > 0 ? { status: 'live', pids } : { status: 'clear' };
}

export async function hasLiveProcessInside(
  dirPath: string,
  options: LiveProcessProbeOptions = {},
): Promise<boolean> {
  return (await probeLiveProcessInside(dirPath, options)).status !== 'clear';
}

/**
 * Final deletion-seam guard. Returns true only after a clean lsof result, or
 * when a caller explicitly certifies that it already confirmed the session's
 * process exited. Live and inconclusive probes are both refused loudly.
 */
export async function allowWorktreeRemoval(
  dirPath: string,
  options: { logPrefix: string; overrideLiveGuard?: true },
): Promise<boolean> {
  return (await checkWorktreeRemoval(dirPath, options)).allowed;
}

/**
 * Same decision as `allowWorktreeRemoval`, plus which kind of refusal it was,
 * so a caller can record why a worktree was kept (#2493).
 */
export async function checkWorktreeRemoval(
  dirPath: string,
  options: { logPrefix: string; overrideLiveGuard?: true },
): Promise<{ allowed: true } | { allowed: false; refusal: 'live' | 'inconclusive' }> {
  if (options.overrideLiveGuard === true) {
    console.warn(`[${options.logPrefix}] LIVE-PROCESS GUARD OVERRIDDEN for ${dirPath} — caller confirmed the session process exited`);
    return { allowed: true };
  }

  // The machine cwd snapshot is cached for up to 15s so high-frequency callers
  // do not each pay for an `lsof` (#1853). This seam is not one of them: it
  // makes an irreversible decision, and a snapshot taken before a process
  // exited reports it as still live, so a legitimate removal is refused. Force
  // a fresh read here and leave every other caller on the cache.
  const probe = await probeLiveProcessInside(dirPath, {
    readSnapshot: () => readProcessCwdSnapshot({ forceRefresh: true }),
  });
  if (probe.status === 'clear') return { allowed: true };
  if (probe.status === 'live') {
    console.error(`[${options.logPrefix}] REFUSED worktree removal for ${dirPath} — live process found (pid ${probe.pids.join(', ')})`);
    return { allowed: false, refusal: 'live' };
  }
  console.error(`[${options.logPrefix}] REFUSED worktree removal for ${dirPath} — live-process probe inconclusive: ${probe.reason}`);
  return { allowed: false, refusal: 'inconclusive' };
}
