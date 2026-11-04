/**
 * Cheap, file-only git context for sidebar rows: owner/repo from the repo's
 * `origin` (or first) remote, current branch and linked checkout identity. Reads .git
 * files directly (no git subprocess) and caches briefly per path, so listing
 * many threads stays fast. Folder-only repos fall back to the folder name.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface ThreadGitContext {
  /** `owner/repo` when a remote is parseable, else the folder name. */
  repoSlug: string | null;
  /** True when repoSlug came from a git remote. */
  repoSlugFromRemote: boolean;
  /** Current branch of the worktree; null when detached or not a git repo. */
  branch: string | null;
  /** The cwd belongs to a linked checkout, independently of its branch. */
  isWorktree: boolean;
  /** Linked checkout root, including when the cwd is a subdirectory. */
  worktreePath: string | null;
}

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: ThreadGitContext }>();

function read(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function findGitDir(start: string): { gitDir: string; commonDir: string; root: string } | null {
  let dir = resolve(start);
  // A deleted cwd must not inherit the checkout of its nearest existing parent.
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  for (;;) {
    const dotGit = join(dir, '.git');
    let stat;
    try { stat = statSync(dotGit); } catch { stat = null; }
    if (stat?.isDirectory()) return { gitDir: dotGit, commonDir: dotGit, root: dir };
    if (stat?.isFile()) {
      const pointer = read(dotGit)?.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
      if (!pointer) return null;
      const gitDir = resolve(dir, pointer);
      const common = read(join(gitDir, 'commondir'))?.trim();
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir, root: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parses https, ssh and scp-like remotes into `owner/repo`. */
export function remoteSlug(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const match = trimmed.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/](.+)$/i);
  const parts = match?.[1].split('/').filter(Boolean) ?? [];
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function remoteUrl(config: string): string | null {
  const remotes: Array<[string, string]> = [];
  let current: string | null = null;
  for (const line of config.split('\n')) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]/);
    if (section) { current = section[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const url = current ? line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1] : undefined;
    if (current && url) remotes.push([current, url]);
  }
  return (remotes.find(([name]) => name === 'origin') ?? remotes[0])?.[1] ?? null;
}

export function threadGitContext(repoPath: string | null | undefined, now = Date.now()): ThreadGitContext {
  if (!repoPath) return { repoSlug: null, repoSlugFromRemote: false, branch: null, isWorktree: false, worktreePath: null };
  const hit = cache.get(repoPath);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const folder = basename(resolve(repoPath)) || null;
  const dirs = findGitDir(repoPath);
  let value: ThreadGitContext = { repoSlug: folder, repoSlugFromRemote: false, branch: null, isWorktree: false, worktreePath: null };
  if (dirs) {
    const head = read(join(dirs.gitDir, 'HEAD'))?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)?.[1] ?? null;
    const url = remoteUrl(read(join(dirs.commonDir, 'config')) ?? '');
    const slug = url ? remoteSlug(url) : null;
    const isWorktree = dirs.gitDir !== dirs.commonDir;
    value = { repoSlug: slug ?? folder, repoSlugFromRemote: slug != null, branch: head,
      isWorktree, worktreePath: isWorktree ? dirs.root : null };
  }
  cache.set(repoPath, { at: now, value });
  return value;
}

export function clearThreadGitContextCache(): void { cache.clear(); }
