import { gitDirectories } from '@/lib/git/ref-stamp';
import { mayHaveGitRepositoryContext } from '@/lib/git/repository-context';

// Each sweep runs every 30 s. Fetching every repository's base on each one was
// ~8 network fetches a minute at rest; merges made outside o8 are still found
// within this window. O8_ANCESTRY_FETCH_INTERVAL_MS overrides it (tests use 0).
const DEFAULT_BASE_FETCH_INTERVAL_MS = 5 * 60_000;
const lastBaseFetchAt = new Map<string, number>();

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
  let repository = gitDirectories(repoPath)?.commonDir ?? repoPath;
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
  const last = lastBaseFetchAt.get(key);
  if (last !== undefined && now - last < baseFetchIntervalMs()) return true;
  lastBaseFetchAt.set(key, now);
  if (lastBaseFetchAt.size > 500) lastBaseFetchAt.delete(lastBaseFetchAt.keys().next().value!);
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`], {
      timeout: 20_000,
    });
  } catch {
    // Best effort only. The proof step below must still verify readable refs.
  }
  return true;
}
