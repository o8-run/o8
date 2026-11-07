import { resolveGitBinary } from '@/lib/git/binary';
import { execFileReadOnly } from '@/lib/providers/child-process';
import { promisify } from 'node:util';

// Only `git rev-parse` and `git diff` here: credential-less reads, so they run on the read-only
// boundary and never take the provider-store lock (part of the /api/review/last-turn read chain).
const execFileAsync = promisify(execFileReadOnly);
const KEPT_DIFFS = 256;
const TIMEOUT_MS = 5000;

type DiffFlag = '--name-only' | '--shortstat';

const diffs = new Map<string, Promise<string>>();

/**
 * `git diff <flag> <base>...HEAD`, reused until either commit moves. The output
 * depends only on the two commits, and the worktree scan asks every few seconds,
 * so a far-behind base must not cost a full diff each pass.
 */
export async function committedDiff(worktreePath: string, baseBranch: string, flag: DiffFlag): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), ['rev-parse', baseBranch, 'HEAD'], {
    windowsHide: true,
    cwd: worktreePath,
    timeout: TIMEOUT_MS,
  });
  const key = `${flag} ${stdout.trim().split('\n').join(' ')}`;
  const known = diffs.get(key);
  if (known) return known;
  const pending = execFileAsync(resolveGitBinary(), ['diff', flag, `${baseBranch}...HEAD`], {
    windowsHide: true,
    cwd: worktreePath,
    timeout: TIMEOUT_MS,
  }).then((result) => String(result.stdout));
  diffs.set(key, pending);
  pending.catch(() => diffs.delete(key));
  if (diffs.size > KEPT_DIFFS) diffs.delete(diffs.keys().next().value as string);
  return pending;
}
