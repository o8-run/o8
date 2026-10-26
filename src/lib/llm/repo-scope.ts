import 'server-only';

import path from 'node:path';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { findRepoByLocalPath, listRepos } from '@/lib/repos/registry';
import { confineToRoots } from '@/lib/fs/safe-path';

/**
 * True if `absPath` is equal to, or nested inside, ANY registered repo root
 * (normalized — no `..` escape). Used to confine a dispatched worker's file
 * access to real repos so it cannot escape its worktree to ~/.zshrc etc.
 * (SECURITY_AUDIT_2026-07-02 §HIGH-6). The operator is not constrained by this.
 */
export async function isPathInRegisteredRepo(absPath: string): Promise<boolean> {
  const repos = await listRepos().catch(() => [] as RepoRegistryEntry[]);
  const roots = repos.map((r) => r.localPath).filter((p): p is string => Boolean(p));
  return confineToRoots(absPath, roots) !== null;
}

export const LLM_REPO_PATH_HEADER = 'x-cortex-repo-path';

export function getDefaultLlmRepoRoot() {
  return process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
}

export async function resolveRegisteredRepoScope(requestedPath?: string | null): Promise<{
  repoRoot: string | null;
  repo: RepoRegistryEntry | null;
}> {
  if (!requestedPath?.trim()) {
    return { repoRoot: null, repo: null };
  }

  const normalized = path.resolve(requestedPath);
  const repo = await findRepoByLocalPath(normalized).catch(() => null);
  if (!repo) {
    return { repoRoot: null, repo: null };
  }

  return {
    repoRoot: repo.localPath,
    repo,
  };
}

export async function resolveRepoScopeFromHeaders(headers: Headers): Promise<{
  repoRoot: string | null;
  repo: RepoRegistryEntry | null;
  usedDefault: boolean;
}> {
  const requestedPath = headers.get(LLM_REPO_PATH_HEADER)?.trim();
  if (!requestedPath) {
    return {
      repoRoot: getDefaultLlmRepoRoot(),
      repo: null,
      usedDefault: true,
    };
  }

  const scoped = await resolveRegisteredRepoScope(requestedPath);
  return {
    ...scoped,
    usedDefault: false,
  };
}
