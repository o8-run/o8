import { NextRequest, NextResponse } from 'next/server';
import { fetchGitHubPullRequestDetail } from '@/lib/github-broker';
import { readPullRequestStack } from '@/lib/github-broker/pull-request-stack';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get('repo') ?? '';
  const number = Number(request.nextUrl.searchParams.get('number'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) {
    return NextResponse.json({ error: 'A repository and positive PR number are required.' }, { status: 400 });
  }
  try {
    const detail = await fetchGitHubPullRequestDetail(repo, number);
    return NextResponse.json({ repo, number, stack: await readPullRequestStack(repo, number, detail.githubScope, { identity: detail.githubIdentity }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Pull request stack could not be read. Check GitHub access and retry.' }, { status: 502 });
  }
}
