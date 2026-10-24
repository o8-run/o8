import 'server-only';

import { githubInstallationFetch } from './auth';
import { readPullRequestFiles } from './pull-request-files';
import { readPullRequestChecks } from './pull-request-checks';
import { GitHubRequestDeferredError, type GitHubReadPriority } from './request-budget';

async function parseGithubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `GitHub request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGitHubIssueDetail(repoFullName: string, issueNumber: number) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${issueNumber}`);
  const issue = await parseGithubJson<{
    number: number;
    title: string;
    body?: string | null;
    state: string;
    labels?: Array<{ name?: string | null; color?: string | null }>;
    user?: { login?: string | null } | null;
    assignees?: Array<{ login?: string | null }>;
    created_at?: string;
    comments?: number;
    html_url?: string;
  }>(response);

  return {
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: issue.state ?? 'open',
    labels: (issue.labels ?? [])
      .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
      .filter((label): label is { name: string; color: string } => Boolean(label)),
    author: issue.user?.login ?? 'unknown',
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login ?? '')
      .filter(Boolean),
    createdAt: issue.created_at ?? '',
    comments: issue.comments ?? 0,
    url: issue.html_url ?? '',
  };
}

export async function fetchGitHubPullRequestDetail(repoFullName: string, prNumber: number, suppliedReviewDecision?: Promise<string | null>, priority: GitHubReadPriority = 'interactive') {
  const { response, installation, scope } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`, { signal: AbortSignal.timeout(18_000) }, { priority, share: true });
  const pr = await parseGithubJson<{
    id?: number;
    number: number;
    title: string;
    body?: string | null;
    state: string;
    html_url: string;
    created_at: string;
    updated_at: string;
    closed_at?: string | null;
    merged_at?: string | null;
    user?: { login?: string | null; avatar_url?: string | null } | null;
    labels?: Array<{ name?: string | null }>;
    requested_reviewers?: Array<{ login?: string | null }>;
    head?: { ref?: string | null; sha?: string | null } | null;
    base?: { ref?: string | null; sha?: string | null; repo?: { id?: number; allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean } } | null;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    draft?: boolean;
    auto_merge?: unknown;
    mergeable?: boolean | null;
  }>(response);

  // Once the head SHA is known these reads are independent. A large diff must
  // not delay starting the checks and reviews requests.
  const filesPromise = readPullRequestFiles(repoFullName, prNumber, installation?.id, pr.head?.sha, pr.base?.sha, priority, scope);

  let checksUnavailable = false;
  const checksPromise = pr.head?.sha
    ? readPullRequestChecks(repoFullName, pr.head.sha, installation?.id, priority, scope).catch(error => { if (error instanceof GitHubRequestDeferredError || (error instanceof Error && error.message.includes('authorization changed'))) throw error; checksUnavailable = true; return []; })
    : Promise.resolve([]);

  const reviewsPromise = suppliedReviewDecision ?? githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`, { signal: AbortSignal.timeout(18_000) })
    .then(({ response: reviewsResponse }) => parseGithubJson<Array<{ state?: string | null }>>(reviewsResponse))
    .then((reviews) => [...reviews].reverse().find((review) => review.state && review.state !== 'COMMENTED')?.state ?? null)
    .catch(() => null);

  const [files, statusCheckRollup, reviewDecision] = await Promise.all([filesPromise, checksPromise, reviewsPromise]);

  return {
    githubScope: scope,
    ...(Number.isSafeInteger(pr.id) && Number(pr.id) > 0 && Number.isSafeInteger(pr.base?.repo?.id) && Number(pr.base?.repo?.id) > 0
      ? { githubIdentity: { repositoryId: pr.base!.repo!.id!, pullRequestId: pr.id! } } : {}),
    checksUnavailable,
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    state: pr.state ?? 'open',
    author: pr.user?.login ?? 'unknown',
    avatarUrl: pr.user?.avatar_url ?? null,
    labels: (pr.labels ?? []).flatMap((label) => label.name ? [label.name] : []),
    requestedReviewers: (pr.requested_reviewers ?? []).flatMap((reviewer) => reviewer.login ? [reviewer.login] : []),
    headRefName: pr.head?.ref ?? '',
    baseRefName: pr.base?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    baseSha: pr.base?.sha ?? '',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    draft: Boolean(pr.draft),
    autoMergeEnabled: Boolean(pr.auto_merge),
    allowedMergeMethods: (['merge', 'squash', 'rebase'] as const).filter((method) => pr.base?.repo?.[method === 'merge' ? 'allow_merge_commit' : method === 'squash' ? 'allow_squash_merge' : 'allow_rebase_merge'] !== false),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
    mergeable: Boolean(pr.mergeable),
    reviewDecision,
    statusCheckRollup,
    url: pr.html_url,
    files: files.map((file) => ({
      path: file.filename,
      ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
      status: file.status ?? 'modified',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch: file.patch ?? null,
    })),
  };
}

export async function fetchGitHubPullRequestComments(repoFullName: string, prNumber: number, priority: GitHubReadPriority = 'interactive') {
  const [reviewCommentsResponse, reviewsResponse, issueCommentsResponse] = await Promise.all([
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`, { signal: AbortSignal.timeout(18_000) }, { priority, share: true }),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`, { signal: AbortSignal.timeout(18_000) }, { priority, share: true }),
    githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`, { signal: AbortSignal.timeout(18_000) }, { priority, share: true }),
  ]);

  const [reviewComments, reviews, issueComments] = await Promise.all([
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      path?: string | null;
      line?: number | null;
      side?: string | null;
      created_at?: string | null;
      diff_hunk?: string | null;
      in_reply_to_id?: number | null;
      user?: { login?: string | null } | null;
    }>>(reviewCommentsResponse.response),
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      state?: string | null;
      submitted_at?: string | null;
      user?: { login?: string | null } | null;
    }>>(reviewsResponse.response),
    parseGithubJson<Array<{
      id: number;
      body?: string | null;
      created_at?: string | null;
      user?: { login?: string | null } | null;
    }>>(issueCommentsResponse.response),
  ]);

  return {
    githubScope: [reviewCommentsResponse.scope, reviewsResponse.scope, issueCommentsResponse.scope].every(scope => scope === reviewCommentsResponse.scope) ? reviewCommentsResponse.scope : null,
    discussionIncomplete: [reviewCommentsResponse, reviewsResponse, issueCommentsResponse].some(({ response }) => /rel="next"/.test(response.headers.get('link') ?? '')),
    comments: reviewComments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      path: comment.path ?? '',
      line: comment.line ?? null,
      side: comment.side ?? '',
      createdAt: comment.created_at ?? '',
      state: '',
      diffHunk: comment.diff_hunk ?? '',
      inReplyTo: comment.in_reply_to_id ?? null,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      author: review.user?.login ?? 'unknown',
      body: review.body ?? '',
      state: review.state ?? '',
      submittedAt: review.submitted_at ?? '',
    })),
    issueComments: issueComments.map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      user: comment.user?.login ?? 'unknown',
      created_at: comment.created_at ?? '',
    })),
  };
}
