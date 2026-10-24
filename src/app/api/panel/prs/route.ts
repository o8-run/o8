export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { ensureGitHubPullRequests, normalizeRepoSlug, resolveRepoSlug } from '@/lib/github-broker';
import { fetchPullRequestListPage } from '@/lib/github-broker/pull-request-list';
import type { PullRequestListState, PullRequestListSort } from '@/lib/github-broker/pull-request-list.types';

const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || '';
const execFileAsync = promisify(execFile);

async function transientRepoSlug(repoPath: string | null): Promise<string | null> {
  if (!repoPath?.trim()) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf-8', windowsHide: true, timeout: 2_500, maxBuffer: 128 * 1024 },
    );
    return normalizeRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get('repoPath');
  const repo = repoPath
    ? await transientRepoSlug(repoPath)
    : await resolveRepoSlug(searchParams.get('repo'), '') || DEFAULT_REPO;

  if (!repo) {
    return NextResponse.json({ prs: [], repo: null, unavailable: true });
  }

  if (searchParams.get('view') === 'list') {
    const state = searchParams.get('state') ?? 'open';
    const page = Number(searchParams.get('page') ?? 1);
    const sort = searchParams.get('sort') ?? 'updated';
    if (!['open', 'closed', 'all'].includes(state) || !['updated', 'oldest', 'newest'].includes(sort) || !Number.isSafeInteger(page) || page < 1) {
      return NextResponse.json({ error: 'Choose a valid pull request state and page.' }, { status: 400 });
    }
    try {
      return NextResponse.json(await fetchPullRequestListPage(repo, state as PullRequestListState, page, request.signal, sort as PullRequestListSort));
    } catch {
      return NextResponse.json({ error: 'Pull requests could not be loaded. Check your GitHub connection in Settings, then retry.' }, { status: 502 });
    }
  }

  const result = searchParams.get('fresh') === '1' ? await ensureGitHubPullRequests(repo, { fresh: true }) : await ensureGitHubPullRequests(repo);
  return NextResponse.json({
    prs: result.prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      statusCheckRollup: pr.statusCheckRollup,
      reviewDecision: pr.reviewDecision,
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    })),
    repo,
    error: result.error,
    stale: result.stale,
    lastSuccessfulAt: result.lastSuccessfulAt,
    retryAt: result.retryAt,
  });
}
