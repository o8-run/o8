export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';
import { ensureGitHubIssues } from '@/lib/github-broker';

const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || '';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

async function resolveRepoSlug(repoLike: string | null) {
  if (!repoLike) return DEFAULT_REPO;
  if (/^[\w.-]+\/[\w.-]+$/.test(repoLike)) return repoLike;

  const registered = await listRepos().catch(() => []);
  const normalizedTarget = repoLike.toLowerCase();
  for (const entry of registered) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (!slug) continue;
    if (slug.toLowerCase() === normalizedTarget) return slug;
    if (slug.split('/')[1]?.toLowerCase() === normalizedTarget) return slug;
    if (entry.name.toLowerCase() === normalizedTarget) return slug;
  }

  return DEFAULT_REPO;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'));

  if (!repo) {
    return NextResponse.json({ error: 'Invalid repo format', issues: [] }, { status: 400 });
  }

  const fresh = searchParams.get('fresh') === '1';
  const result = await ensureGitHubIssues(repo, { fresh });
  return NextResponse.json({
    issues: result.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      state: issue.state,
      author: issue.author,
      assignees: issue.assignees,
      comments: issue.comments,
      body: issue.body,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    })),
    repo,
    error: result.error,
    stale: result.stale,
    lastSuccessfulAt: result.lastSuccessfulAt,
    retryAt: result.retryAt,
  });
}
