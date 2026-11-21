import { existsSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { isWorktreeNoise } from './conflict-gate';

/**
 * Watches registered repositories' own working trees for the review poll.
 * Without a watcher the poll can only find their unstaged edits by scanning
 * every repository each minute; with one, an edit marks that repository dirty
 * and the next 10 s poll scans just it. macOS only: FSEvents watches a tree at
 * its root, while a recursive watch elsewhere walks it, node_modules included.
 * A watcher error drops the repository back into the minute's full scan.
 */
export function createReviewRepoWatch(input: {
  markDirty: (repoPath: string) => void;
  /** Worktree bases already watched for conflicts; their worktrees count as watched. */
  worktreeBases: () => Iterable<string>;
  platform?: NodeJS.Platform;
}) {
  const watched = new Set<string>();
  return {
    ensure(repoPaths: string[]): void {
      if ((input.platform ?? process.platform) !== 'darwin') return;
      for (const repoPath of repoPaths.map((path) => resolve(path))) {
        if (watched.has(repoPath) || !existsSync(repoPath)) continue;
        try {
          watch(repoPath, { recursive: true }, (_event, filename) => {
            if (isWorktreeNoise(filename)) return;
            input.markDirty(repoPath);
          }).on('error', (err) => {
            console.warn(`[ws-server] review watcher error for ${repoPath}, reverting to the full scan:`, err);
            watched.delete(repoPath);
          }).unref();
          watched.add(repoPath);
        } catch (err) {
          console.warn(`[ws-server] could not watch ${repoPath} for review changes; the full scan covers it:`, err);
        }
      }
    },
    /** True when a watcher reports this review target's edits, so the full scan can skip it. */
    watches(workspacePath: string): boolean {
      if (watched.has(workspacePath)) return true;
      for (const base of input.worktreeBases()) {
        if (workspacePath.startsWith(`${base}/`)) return true;
      }
      return false;
    },
  };
}
