import { statSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isPathReachable } from '@/lib/fs/protected-folders';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

export interface ReviewWatchTarget {
  repoPath: string;
  workspacePath: string;
  sessionKey?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Every registered repository plus each worktree its worktree store lists. */
export async function listReviewWatchTargets(rootPath: string, registeredRepoPaths: string[]): Promise<ReviewWatchTarget[]> {
  const repoPaths = new Set<string>([rootPath]);
  for (const p of registeredRepoPaths) repoPaths.add(resolve(p));

  const targets: ReviewWatchTarget[] = [];
  for (const repoPath of repoPaths) {
    // Scanning a repository behind a pending privacy prompt would block the
    // event loop; it joins the scan once the prompt is answered.
    if (!isPathReachable(repoPath)) continue;
    targets.push({ repoPath, workspacePath: repoPath });
    try {
      for (const worktreeBase of resolveWorktreeRootLayout(repoPath).bases) {
        const metaPath = resolve(worktreeBase, '.meta.json');
        if (!(await pathExists(metaPath))) continue;
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as {
          worktrees?: Record<string, { id: string; sessionKey?: string; claudeManaged?: boolean }>;
        };
        for (const worktree of Object.values(meta.worktrees ?? {})) {
          const workspacePath = worktree.claudeManaged
            ? resolve(repoPath, '.claude', 'worktrees', worktree.id)
            : resolve(worktreeBase, worktree.id);
          if (!(await pathExists(workspacePath))) continue;
          targets.push({ repoPath, workspacePath, sessionKey: worktree.sessionKey });
        }
      }
    } catch {
      // Ignore repos without a readable worktree store
    }
  }
  return targets;
}

function fileStamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * The target list changes only when the repository registry is saved or
 * something moves under a worktree base. The caller invalidates on its
 * worktree watcher events and asks for a fresh list when it cannot trust them.
 */
export function createReviewWatchTargets(input: {
  rootPath: string;
  reposFile: () => string;
  listRepoPaths: () => Promise<string[]>;
}) {
  let cached: { stamp: string; targets: ReviewWatchTarget[] } | null = null;
  let generation = 0;
  return {
    invalidate(): void {
      generation += 1;
      cached = null;
    },
    async list(fresh = false): Promise<ReviewWatchTarget[]> {
      const stamp = fileStamp(input.reposFile());
      if (!fresh && cached?.stamp === stamp) return cached.targets;
      const started = generation;
      const targets = await listReviewWatchTargets(input.rootPath, await input.listRepoPaths());
      cached = started === generation ? { stamp, targets } : null;
      return targets;
    },
  };
}
