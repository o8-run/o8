export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { DEFAULT_GITHUB_REPO, fetchGitHubPullRequestComments, resolveRepoSlug } from '@/lib/github-broker';
import { resolveGitLabProject } from '@/lib/git-providers/detect';
import { gitlabProvider } from '@/lib/git-providers/gitlab';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const { searchParams } = new URL(request.url);
  const gitlab = resolveGitLabProject(searchParams.get('repo'));
  const repo = gitlab ? gitlab.slug : await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const prNumber = parseInt(number, 10);

  if (isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  try {
    const data = gitlab ? await gitlabProvider.readDiscussion(repo, prNumber) : await fetchGitHubPullRequestComments(repo, prNumber);
    return NextResponse.json({ comments: data.comments, reviews: data.reviews, prNumber, repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, comments: [], reviews: [] }, { status: 200 });
  }
}
