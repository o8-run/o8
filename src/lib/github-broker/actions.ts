import 'server-only';

import { githubInstallationFetch, type GitHubInstallationAuthorization } from './auth';
import { GitHubRequestDeferredError } from './request-budget';
import { upsertGitHubIssue } from './store';
import { recordOwnPrRemark } from './pr-watch';
import { beginPrRemarkWrite } from './pr-watch-writes';

/** A definitive issue POST refusal; unlike a lost response, no issue was admitted. */
export class GitHubIssueCreationRefusedError extends Error {
  constructor(message: string, readonly retryAt?: number) { super(message); }
}

function buildGitHubError(response: Response, bodyText: string) {
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const parts = [`GitHub request failed (${response.status})`];
  if (bodyText) parts.push(bodyText.trim());
  if (remaining) parts.push(`remaining=${remaining}`);
  if (retryAfter) parts.push(`retryAfter=${retryAfter}s`);
  if (reset) parts.push(`resetAt=${new Date(Number(reset) * 1000).toISOString()}`);
  return new Error(parts.join(' · '));
}

async function parseGitHubJson<T>(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, text);
  }
  return JSON.parse(text) as T;
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt: string | null;
  url: string;
}

export async function fetchGitHubLabels(repoFullName: string, limit = 50) {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/labels?per_page=${Math.min(Math.max(limit, 1), 100)}`,
  );

  const labels = await parseGitHubJson<Array<{ name?: string | null }>>(response);
  return labels
    .map((label) => label.name?.trim() ?? '')
    .filter(Boolean);
}

export async function createGitHubIssue(
  repoFullName: string,
  input: { title: string; body?: string; labels?: string[] },
  authorization?: GitHubInstallationAuthorization,
) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      body: input.body ?? '',
      labels: input.labels ?? [],
    }),
  }, { authorization }).catch(error => {
    // A budget refusal is either before dispatch or follows a definite 403/429.
    // Neither admitted an issue; it must not become an outcome-unknown receipt.
    if (error instanceof GitHubRequestDeferredError) throw new GitHubIssueCreationRefusedError(error.message, error.retryAt);
    throw error;
  });
  if (response.status >= 400 && response.status < 500) {
    throw new GitHubIssueCreationRefusedError(buildGitHubError(response, await response.text().catch(() => '')).message);
  }

  const issue = await parseGitHubJson<{
    id: number;
    number: number;
    title?: string | null;
    state?: string | null;
    body?: string | null;
    html_url: string;
    created_at?: string | null;
    updated_at?: string | null;
    closed_at?: string | null;
    comments?: number | null;
    user?: { login?: string | null } | null;
    assignees?: Array<{ login?: string | null }> | null;
    labels?: Array<{ name?: string | null; color?: string | null }> | null;
  }>(response);

  upsertGitHubIssue({
    issueId: issue.id,
    repoFullName,
    number: issue.number,
    title: issue.title ?? input.title,
    state: issue.state ?? 'open',
    author: issue.user?.login ? { login: issue.user.login } : null,
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login ? { login: assignee.login } : null)
      .filter((assignee): assignee is { login: string } => Boolean(assignee)),
    labels: (issue.labels ?? [])
      .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
      .filter((label): label is { name: string; color: string } => Boolean(label)),
    comments: issue.comments ?? 0,
    body: issue.body ?? input.body ?? '',
    url: issue.html_url,
    createdAt: issue.created_at ?? '',
    updatedAt: issue.updated_at ?? issue.created_at ?? '',
    closedAt: issue.closed_at ?? null,
  });

  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title ?? input.title,
  };
}

export async function commentOnGitHubIssue(repoFullName: string, issueNumber: number, body: string) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  return parseGitHubJson<{ html_url?: string | null }>(response);
}

export async function addLabelsToGitHubIssue(repoFullName: string, issueNumber: number, labels: string[]) {
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  if (normalized.length === 0) return [];

  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: normalized }),
  });

  return parseGitHubJson<Array<{ name?: string | null }>>(response);
}

export async function findGitHubPullRequestByHead(repoFullName: string, branch: string) {
  const owner = repoFullName.split('/')[0] ?? '';
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
  );

  const pulls = await parseGitHubJson<Array<{
    number?: number | null;
    title?: string | null;
    html_url?: string | null;
    state?: string | null;
  }>>(response);

  const match = pulls[0];
  if (!match?.number) return null;
  return {
    number: match.number,
    title: match.title ?? '',
    url: match.html_url ?? '',
    state: match.state ?? 'open',
  };
}

export async function createGitHubPullRequest(
  repoFullName: string,
  input: { head: string; base?: string; title: string; body?: string; draft?: boolean },
) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body ?? '',
      draft: input.draft ?? false,
    }),
  });

  const pull = await parseGitHubJson<{
    number: number;
    html_url: string;
  }>(response);

  return {
    number: pull.number,
    url: pull.html_url,
  };
}

export async function reviewGitHubPullRequest(
  repoFullName: string,
  prNumber: number,
  input: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string; commitSha?: string },
) {
  const finish = beginPrRemarkWrite(repoFullName, prNumber);
  try {
  const { response, scope } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: input.event,
      ...(input.commitSha ? { commit_id: input.commitSha } : {}),
      body: input.body ?? '',
    }),
    signal: AbortSignal.timeout(18_000),
  });

  const review = await parseGitHubJson<{ id?: number; html_url?: string | null }>(response);
  try { recordOwnPrRemark(scope, repoFullName, prNumber, 'reviews', review.id); } catch { /* Posting succeeded even if local watch bookkeeping failed. */ }
  return review;
  } finally { finish(); }
}

export async function commentOnGitHubPullRequest(repoFullName: string, prNumber: number, body: string) {
  const finish = beginPrRemarkWrite(repoFullName, prNumber);
  try {
  const { response, scope } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/issues/${prNumber}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), signal: AbortSignal.timeout(18_000) });
  const comment = await parseGitHubJson<{ id?: number; html_url?: string | null }>(response);
  try { recordOwnPrRemark(scope, repoFullName, prNumber, 'comments', comment.id); } catch { /* Keep the confirmed posting result authoritative. */ }
  return comment;
  } finally { finish(); }
}

export async function getGitHubPullRequestHeadRef(repoFullName: string, prNumber: number) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`);
  const pull = await parseGitHubJson<{
    title?: string | null;
    node_id?: string;
    state?: string;
    draft?: boolean;
    head?: {
      ref?: string | null;
      sha?: string;
      repo?: { full_name?: string | null } | null;
    } | null;
  }>(response);
  return {
    ref: pull.head?.ref ?? null,
    headRepoFullName: pull.head?.repo?.full_name ?? repoFullName,
    title: pull.title ?? null,
    sha: pull.head?.sha ?? '',
    nodeId: pull.node_id ?? '',
    state: pull.state ?? '',
    draft: Boolean(pull.draft),
  };
}

export async function mergeGitHubPullRequest(
  repoFullName: string,
  prNumber: number,
  options?: { deleteBranch?: boolean; mergeMethod?: 'squash' | 'merge' | 'rebase'; expectedHeadSha?: string; beforePublish?: () => Promise<void> },
) {
  const head = await getGitHubPullRequestHeadRef(repoFullName, prNumber);
  const mergeMethod = options?.mergeMethod ?? 'squash';
  // Squash merges through o8 stamp the [via-o8] attribution marker in the
  // commit title — the public changelog sync forwards it and o8.run renders
  // the "via o8" pill (product-builds-the-product proof). The worktree-side
  // merge path stamps the same marker; PR-mode merges were the silent gap.
  const commitTitle = mergeMethod === 'squash' && head.title && !head.title.includes('[via-o8]')
    ? `${head.title} (#${prNumber}) [via-o8]`
    : undefined;
  await options?.beforePublish?.();
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: mergeMethod, ...(options?.expectedHeadSha ? { sha: options.expectedHeadSha } : {}), ...(commitTitle ? { commit_title: commitTitle } : {}) }),
  });
  const merged = await parseGitHubJson<{ merged?: boolean; sha?: string | null }>(response);
  if (merged.merged !== true) throw new Error('GitHub did not confirm a merge.');

  if (options?.deleteBranch && merged.merged && head.ref && head.headRepoFullName === repoFullName) {
    const deleteResponse = await githubInstallationFetch(
      repoFullName,
      `/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(head.ref)}`,
      { method: 'DELETE' },
    );
    if (![204, 404].includes(deleteResponse.response.status)) {
      await parseGitHubJson(deleteResponse.response);
    }
  }

  return merged;
}

export async function closeGitHubPullRequest(repoFullName: string, prNumber: number) {
  const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  return parseGitHubJson<{ state?: string | null }>(response);
}

export async function fetchGitHubPullRequestSummaries(
  repoFullName: string,
  options?: { states?: Array<'open' | 'closed'>; limitPerState?: number },
) {
  const states = options?.states?.length ? options.states : ['open'];
  const limitPerState = Math.min(Math.max(options?.limitPerState ?? 20, 1), 50);
  const results: GitHubPullRequestSummary[] = [];

  for (const state of states) {
    const { response } = await githubInstallationFetch(
      repoFullName,
      `/repos/${repoFullName}/pulls?state=${state}&per_page=${limitPerState}&sort=updated&direction=desc`,
    );

    const pulls = await parseGitHubJson<Array<{
      number?: number | null;
      title?: string | null;
      state?: string | null;
      user?: { login?: string | null } | null;
      head?: { ref?: string | null } | null;
      base?: { ref?: string | null } | null;
      created_at?: string | null;
      merged_at?: string | null;
      html_url?: string | null;
    }>>(response);

    const detailed = await Promise.all(
      pulls
        .filter((pull): pull is NonNullable<typeof pull> & { number: number } => Number.isFinite(pull.number))
        .map(async (pull) => {
          const detailResponse = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${pull.number}`);
          const detail = await parseGitHubJson<{
            additions?: number | null;
            deletions?: number | null;
            changed_files?: number | null;
            merged_at?: string | null;
            html_url?: string | null;
          }>(detailResponse.response);

          return {
            number: pull.number,
            title: pull.title ?? '',
            state: pull.state ?? state,
            author: pull.user?.login ? { login: pull.user.login } : null,
            headRefName: pull.head?.ref ?? '',
            baseRefName: pull.base?.ref ?? '',
            additions: detail.additions ?? 0,
            deletions: detail.deletions ?? 0,
            changedFiles: detail.changed_files ?? 0,
            createdAt: pull.created_at ?? '',
            mergedAt: detail.merged_at ?? pull.merged_at ?? null,
            url: detail.html_url ?? pull.html_url ?? '',
          } as GitHubPullRequestSummary;
        }),
    );

    results.push(...detailed);
  }

  return results;
}
