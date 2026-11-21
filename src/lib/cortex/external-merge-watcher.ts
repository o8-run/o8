/**
 * #841 — External merge ingestion for living specs.
 *
 * The internal o8 merge path (`approveAndMergePacket` → `dispatchPacketMerge`)
 * already calls `appendDirectiveTrailer` on success, but most real merges
 * happen outside o8 — `gh pr merge`, the GitHub web UI, a teammate's CLI.
 * Those paths bypass the trailer entirely, so directive history goes dark
 * the moment a user touches anything outside this app.
 *
 * This watcher closes that gap by polling each registered repo's git log
 * for new merge commits on the default branch and replaying them through
 * `appendDirectiveTrailer`. It runs:
 *   - Once on boot (kicked by /api/panel/status, mirroring decay/proposer).
 *   - Every 5 min thereafter, while the server is up.
 *
 * Idempotency:
 *   - State persisted at <data-dir>/external-merge-state.json — last seen
 *     SHA per repo. New ticks scan only commits newer than the cursor.
 *   - `appendDirectiveTrailer` itself drops exact-line duplicates (see the
 *     `trailerLines.includes(newLine)` short-circuit there), so even if the
 *     state file is wiped or the same SHA arrives via internal+external
 *     paths the trailer never doubles up.
 *
 * Cost shape:
 *   - First run on a cold cursor scans up to MAX_COMMITS_FIRST_RUN merges.
 *   - Unchanged files-backed branch tips skip Git entirely. New or uncertain
 *     tips use `git log` and stop at the cursor.
 */

import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '@/lib/data-dir-migration';
import { appendDirectiveTrailer } from '@/lib/cortex/directive-merges';
import { listRepos } from '@/lib/repos/registry';
import { readPollBranchTip } from '@/lib/git/poll-branch-tip';
import { recurring } from '@/lib/background-work/ledger';

const execFileAsync = promisify(execFile);

/** Tick cadence for the steady-state poll. */
const TICK_INTERVAL_MS = 5 * 60_000;

/** Max merges to backfill on a cold cursor (no prior state). */
const MAX_COMMITS_FIRST_RUN = 50;

/** Max merges to walk when we have a cursor (catches up to a few ticks of merges). */
const MAX_COMMITS_INCREMENTAL = 50;

const STATE_FILE = 'external-merge-state.json';

const SUBJECT_TRAILING_REF_RE = /\s*\(#(\d+)\)\s*$/;
const LEADING_MERGE_REF_RE = /^Merge\s+#(\d+)\s+/i;

interface WatcherState {
  version: 1;
  /** Map of repo localPath → last seen merge SHA. */
  cursors: Record<string, string>;
}

interface ParsedMerge {
  sha: string;
  date: string;
  title: string;
  issueNumber: number | null;
  /** #843 — Full commit message (subject + body) so `Spec-Update:` lines reach `appendDirectiveTrailer`. */
  commitMessage: string;
}

function logInfo(msg: string, ...rest: unknown[]) {
  console.log(`[external-merge-watcher] ${msg}`, ...rest);
}

function logWarn(msg: string, ...rest: unknown[]) {
  console.warn(`[external-merge-watcher] ${msg}`, ...rest);
}

function statePath(): string {
  return join(getDataDir(), STATE_FILE);
}

function readState(): WatcherState {
  try {
    const path = statePath();
    if (!existsSync(path)) return { version: 1, cursors: {} };
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    if (!parsed || parsed.version !== 1 || !parsed.cursors || typeof parsed.cursors !== 'object') {
      return { version: 1, cursors: {} };
    }
    return { version: 1, cursors: { ...parsed.cursors } };
  } catch (error) {
    logWarn('failed to read state, starting fresh:', error instanceof Error ? error.message : error);
    return { version: 1, cursors: {} };
  }
}

function writeState(state: WatcherState): void {
  try {
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (error) {
    logWarn('failed to write state:', error instanceof Error ? error.message : error);
  }
}

/**
 * Resolve the branch we should poll. Prefers `origin/<defaultBranch>` so we
 * pick up merges that landed via squash-merge on the remote and were pulled,
 * but falls back to the local branch when no remote exists.
 */
async function resolvePollRef(repoPath: string, defaultBranch: string): Promise<string> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`], {
      windowsHide: true,
      timeout: 5_000,
    });
    return `refs/remotes/origin/${defaultBranch}`;
  } catch {
    return `refs/heads/${defaultBranch}`;
  }
}

/**
 * Read merge commits newest-first up to `limit`. We use `--first-parent` to
 * ignore side-branch merges that don't represent landings on the default
 * branch. NUL-separated fields keep multi-line subjects parseable.
 */
async function readRecentMerges(
  repoPath: string,
  ref: string,
  limit: number,
): Promise<ParsedMerge[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'log',
        '--first-parent',
        ref,
        `--max-count=${limit}`,
        // Use the byte 0x1e (record separator) between commits and 0x00 between fields.
        // `%B` is the full commit message (subject + body) — needed so `Spec-Update:`
        // lines (#843) can be parsed by `appendDirectiveTrailer`.
        '--format=%H%x00%cI%x00%s%x00%B%x1e',
      ],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
    );

    const records = stdout.split('\x1e').map((r) => r.trim()).filter(Boolean);
    const merges: ParsedMerge[] = [];
    for (const record of records) {
      const parts = record.split('\x00');
      if (parts.length < 3) continue;
      const [sha, isoDate, subject, body] = parts;
      if (!sha || !isoDate || !subject) continue;
      merges.push(parseMerge(sha, isoDate, subject, body ?? ''));
    }
    return merges;
  } catch (error) {
    logWarn(
      `git log failed for ${repoPath} (ref=${ref}):`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Strip a trailing `(#N)` (or leading `Merge #N`) ref off the subject so
 * `appendDirectiveTrailer` renders the trailer with the format
 * `<title> (#N)` once instead of duplicating the issue number.
 */
function parseMerge(sha: string, isoDate: string, subject: string, body: string): ParsedMerge {
  const trailing = SUBJECT_TRAILING_REF_RE.exec(subject);
  if (trailing) {
    const number = Number.parseInt(trailing[1], 10);
    return {
      sha,
      date: isoDate.slice(0, 10),
      title: subject.replace(SUBJECT_TRAILING_REF_RE, '').trim(),
      issueNumber: Number.isFinite(number) ? number : null,
      commitMessage: body,
    };
  }

  const leading = LEADING_MERGE_REF_RE.exec(subject);
  if (leading) {
    const number = Number.parseInt(leading[1], 10);
    return {
      sha,
      date: isoDate.slice(0, 10),
      title: subject.replace(LEADING_MERGE_REF_RE, '').trim(),
      issueNumber: Number.isFinite(number) ? number : null,
      commitMessage: body,
    };
  }

  return {
    sha,
    date: isoDate.slice(0, 10),
    title: subject.trim(),
    issueNumber: null,
    commitMessage: body,
  };
}

/**
 * Run one ingestion pass across every registered repo. Exported for the
 * boot hook + the recurring tick. Never throws — per-repo failures are
 * logged and skipped.
 */
export async function ingestExternalMerges(): Promise<{
  scannedRepos: number;
  newCommits: number;
  updatedDirectives: number;
}> {
  const summary = { scannedRepos: 0, newCommits: 0, updatedDirectives: 0 };

  let repos;
  try {
    repos = await listRepos();
  } catch (error) {
    logWarn('listRepos failed:', error instanceof Error ? error.message : error);
    return summary;
  }

  if (repos.length === 0) return summary;

  const state = readState();
  let stateChanged = false;

  for (const repo of repos) {
    summary.scannedRepos += 1;
    const repoPath = repo.localPath;
    if (!repoPath || !existsSync(repoPath)) continue;

    try {
      const cursor = state.cursors[repoPath];
      const branch = repo.defaultBranch || 'main';
      if (cursor && await readPollBranchTip(repoPath, branch) === cursor) continue;
      const ref = await resolvePollRef(repoPath, branch);
      const limit = cursor ? MAX_COMMITS_INCREMENTAL : MAX_COMMITS_FIRST_RUN;
      const recent = await readRecentMerges(repoPath, ref, limit);
      if (recent.length === 0) continue;

      // recent is newest-first. Walk backwards (oldest of the new batch first)
      // so trailers append in chronological order — matches the format the
      // internal merge path produces.
      const newOnes: ParsedMerge[] = [];
      for (const merge of recent) {
        if (cursor && merge.sha === cursor) break;
        newOnes.push(merge);
      }
      newOnes.reverse();

      // First-run guard: if we had no cursor, treat the entire scan as a
      // backfill. Without this, every fresh install would dump the trailer
      // for every old merge into every directive on the first poll. We
      // record the newest SHA as the cursor and skip writing trailers.
      // Steady-state runs (cursor present) always replay the new batch.
      if (!cursor) {
        state.cursors[repoPath] = recent[0].sha;
        stateChanged = true;
        logInfo(
          `seeded cursor for ${repoPath} at ${recent[0].sha.slice(0, 7)} (${recent.length} historical merges skipped)`,
        );
        continue;
      }

      if (newOnes.length === 0) continue;

      let updatedHere = 0;
      for (const merge of newOnes) {
        try {
          const updated = appendDirectiveTrailer({
            repoPath,
            entry: {
              date: merge.date,
              status: 'merged',
              title: merge.title,
              issueNumber: merge.issueNumber,
            },
            // #843 — Forward the full commit message so any
            // `Spec-Update: <name>` lines target a single directive.
            commitMessage: merge.commitMessage,
          });
          updatedHere += updated.length;
        } catch (error) {
          logWarn(
            `appendDirectiveTrailer threw for ${repoPath} ${merge.sha.slice(0, 7)}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      summary.newCommits += newOnes.length;
      summary.updatedDirectives += updatedHere;
      state.cursors[repoPath] = recent[0].sha;
      stateChanged = true;

      if (newOnes.length > 0) {
        logInfo(
          `ingested ${newOnes.length} merge${newOnes.length === 1 ? '' : 's'} from ${repoPath} → updated ${updatedHere} directive trailer${updatedHere === 1 ? '' : 's'}`,
        );
      }
    } catch (error) {
      logWarn(
        `ingestion failed for ${repoPath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (stateChanged) writeState(state);
  return summary;
}

let bootHookFired = false;
let tickHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Idempotent boot trigger. Mirrors `ensureDecayBootHook` in
 * `src/lib/cortex/decay.ts`. First call schedules a recurring 5 min tick
 * and fires an immediate sweep on the next microtask. Subsequent calls are
 * no-ops.
 */
export function ensureExternalMergeBootHook(): void {
  if (bootHookFired) return;
  bootHookFired = true;

  setImmediate(() => {
    void ingestExternalMerges().catch((err: unknown) => {
      logWarn('boot sweep threw:', err);
    });
  });

  if (tickHandle) return;
  tickHandle = recurring('external-merge-watcher', () => {
    void ingestExternalMerges().catch((err: unknown) => {
      logWarn('tick sweep threw:', err);
    });
  }, TICK_INTERVAL_MS);
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}
