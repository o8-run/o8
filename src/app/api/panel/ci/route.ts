export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { fetchGitHubWorkflowRuns, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached } from '@/lib/github/cache';
import { GitHubRequestDeferredError } from '@/lib/github-broker/request-budget';
import { canReadGitHubSnapshot, GitHubOrgNotCoveredError } from '@/lib/github-broker/repo-access';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', runs: [] }, { status: 400 });
  }

  // Match the shared two-minute list policy; explicit refresh bypasses it.
  const cacheKey = `ci:${repo}`;
  const cached = searchParams.get('fresh') === '1' || !canReadGitHubSnapshot(repo) ? null : getCached<unknown[]>(cacheKey, 120_000);
  if (cached) {
    return NextResponse.json({ runs: cached, repo });
  }

  try {
    const runs = await fetchGitHubWorkflowRuns(repo, 15, searchParams.get('fresh') === '1');
    setCached(cacheKey, runs);
    return NextResponse.json({ runs, repo });
  } catch (err) {
    if (err instanceof GitHubOrgNotCoveredError) return NextResponse.json({ code: err.code, error: err.message, runs: [], repo }, { status: 422 });
    if (err instanceof GitHubRequestDeferredError) {
      return NextResponse.json({ error: err.message, runs: [], repo }, {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000))) },
      });
    }
    console.error('[panel-ci] Read failed:', err);
    const message = 'Unable to read CI runs.';
    return NextResponse.json({ error: message, runs: [], repo }, { status: 200 });
  }
}
