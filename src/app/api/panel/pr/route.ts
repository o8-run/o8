import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { DEFAULT_GITHUB_REPO, fetchGitHubPullRequestDetail, resolveRepoSlug } from '@/lib/github-broker';
import { readPullRequestStack } from '@/lib/github-broker/pull-request-stack';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const number = searchParams.get('number');

  if (!repo || !number) {
    return viewerJson({ error: 'repo and number required' }, { status: 400 });
  }

  try {
    const data = await fetchGitHubPullRequestDetail(repo, parseInt(number, 10));
    const stack = await readPullRequestStack(repo, data.number, data.githubScope, { identity: data.githubIdentity });

    const checksStatus = (() => {
      const checks = data.statusCheckRollup || [];
      if (checks.length === 0) return 'unknown';
      const failed = checks.some((c) => (c.conclusion ?? '').toUpperCase() === 'FAILURE');
      const pending = checks.some((c) => (c.status ?? '').toUpperCase() !== 'COMPLETED' && !c.conclusion);
      if (failed) return 'failure';
      if (pending) return 'pending';
      return 'success';
    })();

    return viewerJson({
      number: data.number,
      title: data.title,
      body: data.body || '',
      author: data.author || 'unknown',
      branch: data.headRefName,
      baseBranch: data.baseRefName,
      state: data.state,
      mergeable: data.mergeable,
      additions: data.additions || 0,
      deletions: data.deletions || 0,
      changedFiles: data.changedFiles || 0,
      checksStatus,
      reviewDecision: data.reviewDecision || null,
      files: (data.files || []).map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      })),
      url: data.url,
      stack,
    });
  } catch (err) {
    return viewerJson(
      { error: err instanceof Error ? err.message : 'Failed to fetch PR' },
      { status: 500 },
    );
  }
}
