import { join } from 'node:path';
import { fileStamp, gitDirectories } from '@/lib/git/ref-stamp';
import { mayHaveGitRepositoryContext } from '@/lib/git/repository-context';

// Each sweep runs every 30 s. Fetching every repository's base on each one was
// ~8 network fetches a minute at rest; merges made outside o8 are still found
// within this window. O8_ANCESTRY_FETCH_INTERVAL_MS overrides it (tests use 0).
const DEFAULT_BASE_FETCH_INTERVAL_MS = 5 * 60_000;
// A fetch that leaves the base where it was doubles the wait before the next
// one, up to eight intervals (40 minutes by default). Changes to a lane's own
// refs need no fetch: the sweep's per-lane fingerprint re-checks that lane on
// the next pass. When another process fetches the base meanwhile (an editor, a
// terminal, another lane), that counts as fresh and this sweep does not repeat it.
const MAX_UNCHANGED_DOUBLINGS = 3;
interface BaseFetchState { at: number; unchanged: number; origin: string }
const baseFetches = new Map<string, BaseFetchState>();

/** Changes whenever origin's copy of the base is rewritten, by any process. */
function originBaseStamp(commonDir: string | null, baseBranch: string): string | null {
  if (!commonDir) return null;
  return `${fileStamp(join(commonDir, 'packed-refs'))}|${fileStamp(join(commonDir, 'refs/remotes/origin', baseBranch))}`;
}

function baseFetchIntervalMs(): number {
  const raw = process.env.O8_ANCESTRY_FETCH_INTERVAL_MS;
  const value = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BASE_FETCH_INTERVAL_MS;
}

export async function refreshAncestryOriginBase(
  repoPath: string,
  baseBranch: string,
  refreshed: Set<string>,
  git: (cwd: string, args: string[], options: { timeout: number }) => Promise<string>,
): Promise<boolean> {
  // Worktrees share their repository's refs, so one fetch per repository and
  // base serves every candidate in the same sweep.
  const commonDir = gitDirectories(repoPath)?.commonDir ?? null;
  let repository = commonDir ?? repoPath;
  if (repository === repoPath) {
    if (!await mayHaveGitRepositoryContext(repoPath)) return false;
    try {
      repository = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3_000 });
    } catch {
      // An unreadable repository keys on its own path; the fetch below fails too.
    }
  }
  const key = `${repository}\0${baseBranch}`;
  if (refreshed.has(key)) return true;
  refreshed.add(key);
  const now = Date.now();
  const before = originBaseStamp(commonDir, baseBranch);
  const last = baseFetches.get(key);
  const remember = (state: BaseFetchState) => {
    baseFetches.delete(key);
    baseFetches.set(key, state);
    if (baseFetches.size > 500) baseFetches.delete(baseFetches.keys().next().value!);
  };
  if (last !== undefined && before !== null && before !== last.origin) {
    // Someone else fetched the base since this sweep last did.
    remember({ at: now, unchanged: 0, origin: before });
    return true;
  }
  if (last !== undefined
    && now - last.at < baseFetchIntervalMs() * 2 ** Math.min(last.unchanged, MAX_UNCHANGED_DOUBLINGS)) return true;
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`], {
      timeout: 20_000,
    });
  } catch {
    // Best effort only. The proof step below must still verify readable refs.
  }
  const after = originBaseStamp(commonDir, baseBranch);
  // Unknown layouts (no readable git directory) never back off.
  const moved = after === null || after !== before;
  remember({ at: now, unchanged: moved || last === undefined ? 0 : last.unchanged + 1, origin: after ?? '' });
  return true;
}
