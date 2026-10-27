import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { performance } from 'node:perf_hooks';
import { fetchGitHubCommits, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached } from '@/lib/github/cache';
import { getRecentWorkspaceCommits, resolveWorkspaceRoot } from '@/lib/panel/git-commits';
import { WorkspaceReviewError } from '@/lib/review/workspace-status';

function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  const workspace = req.nextUrl.searchParams.get('workspace');
  if (workspace) {
    const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 20, 50);
    try {
      const commits = await getRecentWorkspaceCommits(workspace, limit);
      return viewerJson({
        commits,
        workspaceState: 'ready',
        workspace: resolveWorkspaceRoot(workspace),
      }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    } catch (error) {
      const code = error instanceof WorkspaceReviewError ? error.code : 'REVIEW_GIT_UNAVAILABLE';
      const states: Record<string, string> = { REVIEW_NOT_GIT: 'not_git', REVIEW_PATH_MISSING: 'missing', REVIEW_PATH_UNAVAILABLE: 'unavailable' };
      const messages: Record<string, string> = {
        REVIEW_NOT_GIT: 'This folder is not a Git repository. Choose a Git repository to see commit activity.',
        REVIEW_PATH_MISSING: 'This folder is no longer available. Choose an existing folder.',
        REVIEW_PATH_UNAVAILABLE: 'This folder cannot be read. Check its permissions or choose another folder.',
      };
      return viewerJson({
        commits: [],
        workspace: resolveWorkspaceRoot(workspace),
        workspaceState: states[code] ?? 'git_error',
        code,
        error: messages[code] ?? 'Git could not read local commit activity. Check Git and repository access, then retry.',
      }, { status: error instanceof WorkspaceReviewError ? error.status : 503, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    }
  }

  const repo = await resolveRepoSlug(req.nextUrl.searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 15, 30);

  if (!repo) {
    return viewerJson({ commits: [], repo: '', error: 'Invalid repo format' }, { status: 400, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }

  const cacheKey = `commits:${repo}:${limit}`;
  const cached = req.nextUrl.searchParams.get('fresh') === '1' ? null : getCached<unknown[]>(cacheKey, 120_000);
  if (cached) {
    return viewerJson({ commits: cached, repo }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }

  try {
    const commits = await fetchGitHubCommits(repo, limit);
    setCached(cacheKey, commits);
    return viewerJson({ commits, repo }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  } catch (error) {
    return viewerJson({ commits: [], repo, error: error instanceof Error ? error.message : 'Failed to fetch commits' }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }
}
