export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { ensureGitHubPullRequests, normalizeRepoSlug, resolveRepoSlug } from '@/lib/github-broker';
import type { PullRequestListState, PullRequestListSort } from '@/lib/github-broker/pull-request-list.types';
import { GitHubOrgNotCoveredError } from '@/lib/github-broker/repo-access';
import { gitLabProjectFromRemote } from '@/lib/git-providers/detect';
import { githubProvider } from '@/lib/git-providers/github';
import { gitlabProvider } from '@/lib/git-providers/gitlab';

const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || '';
const execFileAsync = promisify(execFile);

async function transientOrigin(repoPath: string | null): Promise<string | null> {
  if (!repoPath?.trim()) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf-8', windowsHide: true, timeout: 2_500, maxBuffer: 128 * 1024 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get('repoPath');
  const origin = repoPath ? await transientOrigin(repoPath) : null;
  // The project's origin host chooses the provider; GitHub stays the default.
  const gitlab = gitLabProjectFromRemote(origin);
  const repo = gitlab
    ? gitlab.slug
    : repoPath
      ? normalizeRepoSlug(origin)
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
    const provider = gitlab ? gitlabProvider : githubProvider;
    try {
      return NextResponse.json(await provider.listPullRequests(repo, { state: state as PullRequestListState, page, signal: request.signal, sort: sort as PullRequestListSort, fresh: searchParams.get('fresh') === '1' }));
    } catch (error) {
      if (error instanceof GitHubOrgNotCoveredError) return NextResponse.json({ code: error.code, error: error.message, prs: [], repo }, { status: 422 });
      return NextResponse.json({ error: `Pull requests could not be loaded. Check your ${gitlab ? 'GitLab' : 'GitHub'} connection in Settings, then retry.` }, { status: 502 });
    }
  }

  // The compact activity preview reads the GitHub sync store only.
  if (gitlab) return NextResponse.json({ prs: [], repo, unavailable: true });

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
    code: result.code,
    stale: result.stale,
    lastSuccessfulAt: result.lastSuccessfulAt,
    retryAt: result.retryAt,
  });
}
