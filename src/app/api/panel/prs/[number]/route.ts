import { readPullRequestStack } from '@/lib/github-broker/pull-request-stack';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  closeGitHubPullRequest,
  updateGitHubPullRequestMode,
  commentOnGitHubPullRequest,
  fetchGitHubPullRequestComments,
  fetchGitHubPullRequestDetail,
  mergeGitHubPullRequest,
  reviewGitHubPullRequest,
  resolveRepoSlug,
} from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import { getCachedRepoReadiness } from '@/lib/repos/readiness';
import { deriveWorkflowStage } from '@/lib/workflows/status';
import { GitHubRequestDeferredError } from '@/lib/github-broker/request-budget';
import { beginPrWatchRead, recordPrWatchSnapshot } from '@/lib/github-broker/pr-watch';
import { waitForPrRemarkWrites } from '@/lib/github-broker/pr-watch-writes';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const readOrder = beginPrWatchRead();
    const priority = searchParams.get('poll') === '1' ? 'background' : 'interactive';
    const comments = fetchGitHubPullRequestComments(repo, prNum, priority);
    const [pr, commentsData] = await Promise.all([
      fetchGitHubPullRequestDetail(repo, prNum, comments.then((data) => [...data.reviews].reverse().find((review) => review.state && review.state !== 'COMMENTED')?.state ?? null).catch(() => null), priority),
      comments,
    ]);
    const localRepo = (await listRepos().catch(() => []))
      .find((entry) => normalizeRepoSlug(entry.remoteUrl) === repo) ?? null;
    const { githubScope, githubIdentity, ...publicPr } = pr;
    const stack = await readPullRequestStack(repo, prNum, githubScope, { identity: githubIdentity, priority });
    if (githubScope && commentsData.githubScope !== githubScope) throw new Error('GitHub authorization changed during the read.');
    await waitForPrRemarkWrites(repo, prNum);
    const watch = githubScope ? recordPrWatchSnapshot({ scope: githubScope, repo, number: prNum, head: pr.headSha, state: pr.mergedAt ? 'merged' : pr.state,
      checks: [...pr.statusCheckRollup].sort((a, b) => a.name.localeCompare(b.name)), checksUnavailable: pr.checksUnavailable,
      comments: [...commentsData.comments.map(comment => ({ ...comment, kind: 'inline' as const })), ...commentsData.issueComments.map(comment => ({ id: comment.id, author: comment.user, body: comment.body })),
        ...commentsData.reviews.filter(review => review.state === 'COMMENTED').map(review => ({ ...review, kind: 'reviews' as const }))],
      reviews: commentsData.reviews.filter(review => review.state !== 'COMMENTED'), discussionIncomplete: commentsData.discussionIncomplete, repoPath: localRepo?.localPath, readOrder }) : undefined;
    if (watch?.superseded) return NextResponse.json({ error: 'A newer pull request read completed. Refresh to see it.' }, { status: 409 });
    // Reading a PR must not start workspace setup/Git probes. Safety-sensitive
    // workspace actions still obtain exact readiness at their own entry point.
    const readiness = localRepo ? getCachedRepoReadiness(localRepo) ?? null : null;
    const failedChecks = (pr.statusCheckRollup ?? []).filter((check) => check.conclusion && check.conclusion.toLowerCase() !== 'success').length;
    const pendingChecks = (pr.statusCheckRollup ?? []).filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length;
    const requestedChanges = (commentsData.reviews ?? []).filter((review) => review.state?.toLowerCase() === 'changes_requested').length;
    const workflowStage = deriveWorkflowStage({
      prState: pr.state,
      failedChecks,
      pendingChecks,
      requestedChanges,
      readinessState: readiness?.state ?? null,
    });

    const diffStat = pr.files
      .map((file) => `${file.path} | +${file.additions} -${file.deletions}`)
      .join('\n');

    return NextResponse.json({
      pr: {
        ...publicPr,
        stack,
        watch,
        discussionIncomplete: commentsData.discussionIncomplete,
        resolvedRepo: repo,
        readiness,
        workflowStage,
        reviewComments: commentsData.comments,
        issueComments: commentsData.issueComments,
        diffStat,
      },
    });
  } catch (error) {
    if (error instanceof GitHubRequestDeferredError) return NextResponse.json({ error: error.message }, { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))) } });
    return NextResponse.json({ error: 'Pull request could not be read. Check the connection or GitHub access and retry.' }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  let body: { action: string; repo?: string; comment?: string; mergeMethod?: 'squash' | 'merge' | 'rebase'; commitSha?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || typeof body.action !== 'string' || (body.comment !== undefined && typeof body.comment !== 'string') || (body.repo !== undefined && typeof body.repo !== 'string') || (body.commitSha !== undefined && (typeof body.commitSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.commitSha)))) {
    return NextResponse.json({ error: 'Invalid action body' }, { status: 400 });
  }

  const repo = await resolveRepoSlug(body.repo ?? null, DEFAULT_GITHUB_REPO);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  const { action } = body;
  const comment = body.comment?.trim();

  try {
    if (action === 'approve') {
      await reviewGitHubPullRequest(repo, prNum, { event: 'APPROVE', body: comment, commitSha: body.commitSha });
      return NextResponse.json({ ok: true, action: 'approved' });
    }

    if (action === 'request-changes') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment required for requesting changes' }, { status: 400 });
      }
      await reviewGitHubPullRequest(repo, prNum, { event: 'REQUEST_CHANGES', body: comment, commitSha: body.commitSha });
      return NextResponse.json({ ok: true, action: 'changes_requested' });
    }

    if (action === 'review-comment') {
      if (!comment) return NextResponse.json({ error: 'Review comment required' }, { status: 400 });
      await reviewGitHubPullRequest(repo, prNum, { event: 'COMMENT', body: comment, commitSha: body.commitSha });
      return NextResponse.json({ ok: true, action: 'reviewed' });
    }

    if (action === 'close-with-comment') {
      if (!comment) return NextResponse.json({ error: 'Comment body required' }, { status: 400 });
      await commentOnGitHubPullRequest(repo, prNum, comment);
      try {
        await closeGitHubPullRequest(repo, prNum);
        return NextResponse.json({ ok: true, action: 'closed_with_comment' });
      } catch {
        // A retry must close only; the comment has already been posted.
        return NextResponse.json({ ok: false, commentPosted: true, error: 'Comment posted. Closing could not be confirmed.' }, { status: 502 });
      }
    }

    if (action === 'comment') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment body required' }, { status: 400 });
      }
      await commentOnGitHubPullRequest(repo, prNum, comment);
      return NextResponse.json({ ok: true, action: 'commented' });
    }

    if (action === 'merge') {
      if (!body.commitSha || !['merge', 'squash', 'rebase'].includes(body.mergeMethod || '')) return NextResponse.json({ error: 'A reviewed commit and merge method are required' }, { status: 400 });
      await mergeGitHubPullRequest(repo, prNum, {
        deleteBranch: false,
        mergeMethod: body.mergeMethod,
        expectedHeadSha: body.commitSha,
      });
      return NextResponse.json({ ok: true, action: 'merged' });
    }

    if (action === 'draft' || action === 'ready' || action === 'enable-auto-merge' || action === 'disable-auto-merge') {
      if (!body.commitSha || (action === 'enable-auto-merge' && !['merge', 'squash', 'rebase'].includes(body.mergeMethod || ''))) return NextResponse.json({ error: 'A reviewed commit and merge method are required' }, { status: 400 });
      await updateGitHubPullRequestMode(repo, prNum, action, { expectedHeadSha: body.commitSha, mergeMethod: body.mergeMethod });
      return NextResponse.json({ ok: true, action });
    }

    if (action === 'close') {
      await closeGitHubPullRequest(repo, prNum);
      return NextResponse.json({ ok: true, action: 'closed' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
