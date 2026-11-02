import 'server-only';

import { githubInstallationFetch } from './auth';
import { readPullRequestFiles } from './pull-request-files';
import { readPullRequestChecks } from './pull-request-checks';
import { GitHubRequestDeferredError, type GitHubReadPriority } from './request-budget';
import { GitHubReadScopeChangedError } from './read-scope';

async function parseGithubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `GitHub request failed (${response.status})`);
  }
  return JSON.parse(text) as T;
}

const ISSUE_DISCUSSION_PAGE = 100;

// The issue still opens when its comments or references cannot be read.
async function readIssueDiscussion(repoFullName: string, issueNumber: number, commentCount: number) {
  const read = async <T>(path: string) => {
    const { response } = await githubInstallationFetch(repoFullName, path);
    return parseGithubJson<T>(response);
  };
  const base = `/repos/${repoFullName}/issues/${issueNumber}`;
  const [comments, timeline] = await Promise.allSettled([
    read<Array<{
      id: number;
      body?: string | null;
      user?: { login?: string | null } | null;
      created_at?: string;
      html_url?: string;
    }>>(`${base}/comments?per_page=${ISSUE_DISCUSSION_PAGE}`),
    read<Array<{
      event?: string;
      source?: { issue?: {
        number: number;
        title?: string;
        state?: string;
        html_url?: string;
        repository?: { full_name?: string };
        pull_request?: { merged_at?: string | null };
      } };
    }>>(`${base}/timeline?per_page=${ISSUE_DISCUSSION_PAGE}`),
  ]);
  const linked = new Map<string, {
    kind: 'pull' | 'issue';
    number: number;
    title: string;
    state: string;
    url: string;
    repo: string;
  }>();
  const events = timeline.status === 'fulfilled' && Array.isArray(timeline.value) ? timeline.value : null;
  const replies = comments.status === 'fulfilled' && Array.isArray(comments.value) ? comments.value : null;
  for (const event of events ?? []) {
    const source = event.event === 'cross-referenced' ? event.source?.issue : undefined;
    if (!source?.html_url) continue;
    linked.set(source.html_url, {
      kind: source.pull_request ? 'pull' : 'issue',
      number: source.number,
      title: source.title ?? '',
      state: source.pull_request?.merged_at ? 'merged' : source.state ?? 'open',
      url: source.html_url,
      repo: source.repository?.full_name ?? repoFullName,
    });
  }
  return {
    discussion: (replies ?? []).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at ?? '',
      url: comment.html_url ?? '',
    })),
    linked: [...linked.values()],
    discussionIncomplete: !replies || !events || commentCount > ISSUE_DISCUSSION_PAGE,
  };
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
    ...await readIssueDiscussion(repoFullName, issueNumber, issue.comments ?? 0),
  };
}

export async function fetchGitHubPullRequestDetail(repoFullName: string, prNumber: number, suppliedReviewDecision?: Promise<string | null>, priority: GitHubReadPriority = 'interactive') {
  try {
    return await readPullRequestDetailAttempt(repoFullName, prNumber, suppliedReviewDecision, priority);
  } catch (error) {
    if (!(error instanceof GitHubReadScopeChangedError) || !error.anonymous) throw error;
    // Discard every first-attempt result, including any supplied review decision.
    // The second attempt must establish anonymous authority from fresh metadata.
    return readPullRequestDetailAttempt(repoFullName, prNumber, undefined, priority, true);
  }
}

async function readPullRequestDetailAttempt(repoFullName: string, prNumber: number, suppliedReviewDecision: Promise<string | null> | undefined, priority: GitHubReadPriority, requireAnonymous = false) {
  const { response, installation, scope, anonymous } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`, { signal: AbortSignal.timeout(18_000) }, { priority, share: true });
  if (requireAnonymous && !anonymous) {
    void response.body?.cancel().catch(() => {});
    throw new Error('GitHub authorization changed before the anonymous pull request retry. Retry.');
  }
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
    head?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null } | null;
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
    ? readPullRequestChecks(repoFullName, pr.head.sha, installation?.id, priority, scope).catch(error => { if (error instanceof GitHubRequestDeferredError || error instanceof GitHubReadScopeChangedError) throw error; checksUnavailable = true; return []; })
    : Promise.resolve([]);

  const reviewsPromise = suppliedReviewDecision ?? githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`, { signal: AbortSignal.timeout(18_000) })
    .then(({ response: reviewsResponse, scope: reviewsScope, anonymous: reviewsAnonymous }) => {
      if (scope && reviewsScope !== scope) {
        void reviewsResponse.body?.cancel().catch(() => {});
        throw new GitHubReadScopeChangedError('GitHub authorization changed while reading pull request reviews. Retry.', reviewsAnonymous);
      }
      return parseGithubJson<Array<{ state?: string | null }>>(reviewsResponse);
    })
    .then((reviews) => [...reviews].reverse().find((review) => review.state && review.state !== 'COMMENTED')?.state ?? null)
    .catch(error => { if (error instanceof GitHubReadScopeChangedError) throw error; return null; });

  const reads = [filesPromise, checksPromise, reviewsPromise] as const;
  // Drain the entire attempt before retrying; no old response may join the retry.
  const settled = await Promise.allSettled(reads);
  const scopeChanges = settled.filter(result => result.status === 'rejected' && result.reason instanceof GitHubReadScopeChangedError);
  const changed = scopeChanges.find(result => result.status === 'rejected' && !result.reason.anonymous) ?? scopeChanges[0];
  if (changed?.status === 'rejected') throw changed.reason;
  const [files, statusCheckRollup, reviewDecision] = await Promise.all(reads);

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
    headRepoFullName: pr.head?.repo?.full_name ?? null,
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
    reviewsIncomplete: /rel="next"/.test(reviewsResponse.response.headers.get('link') ?? ''),
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
