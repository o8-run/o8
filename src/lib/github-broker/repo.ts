import 'server-only';

import { listRepos } from '@/lib/repos/registry';

export const DEFAULT_GITHUB_REPO = process.env.CORTEX_IDE_REVIEW_REPO || process.env.GITHUB_REPO || '';

export function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export async function resolveRepoSlug(repoLike: string | null, fallback = DEFAULT_GITHUB_REPO) {
  if (!repoLike) return fallback;
  if (/^[\w.-]+\/[\w.-]+$/.test(repoLike)) return repoLike;

  const registered = await listRepos().catch(() => []);
  const normalizedTarget = repoLike.toLowerCase();
  for (const entry of registered) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (!slug) continue;
    if (slug.toLowerCase() === normalizedTarget) return slug;
    if (slug.split('/')[1]?.toLowerCase() === normalizedTarget) return slug;
    if (entry.name.toLowerCase() === normalizedTarget) return slug;
    if (entry.localPath.toLowerCase() === normalizedTarget) return slug;
  }

  return fallback;
}

/** Connected GitHub repository identities and their local scope paths. */
export async function registeredGitHubRepos() {
  const bySlug = new Map<string, string[]>();
  for (const entry of await listRepos()) {
    const slug = normalizeRepoSlug(entry.remoteUrl)?.toLowerCase();
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), entry.localPath]);
  }
  return bySlug;
}
