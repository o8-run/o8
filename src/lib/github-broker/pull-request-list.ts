import 'server-only';

import { githubInstallationFetch } from './auth';
import type { PullRequestListPage, PullRequestListState, PullRequestListSort } from './pull-request-list.types';

interface GitHubListPull {
  number: number;
  node_id: string;
  title: string;
  user: { login: string; avatar_url: string } | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  draft?: boolean;
  head: { ref: string; repo?: { full_name: string } | null };
  base: { ref: string };
  updated_at: string;
  created_at: string;
  html_url: string;
  labels: Array<{ name: string }>;
}

interface PullStats {
  number: number;
  additions: number;
  deletions: number;
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string } | null } | null> } | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}

const STATS_QUERY = `query PullRequestListStats($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      number additions deletions
      reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

/** List pages stay lightweight; the detail panel loads only the selected PR. */
export async function fetchPullRequestListPage(repo: string, state: PullRequestListState, page: number, signal?: AbortSignal, sort: PullRequestListSort = 'updated', fresh = false): Promise<PullRequestListPage> {
  const params = new URLSearchParams({ state, page: String(page), per_page: '100', sort: sort === 'newest' ? 'created' : 'updated', direction: sort === 'oldest' ? 'asc' : 'desc' });
  const path = `/repos/${repo}/pulls?${params}`;
  const timeout = AbortSignal.timeout(15_000);
  const init = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(fresh ? { cache: 'reload' as const } : {}) };
  // Public repositories can be read without connecting an account. Private
  // repositories continue to use the existing GitHub connection and broker.
  const { response, anonymous } = await githubInstallationFetch(repo, path, init, { share: true });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error('Pull requests are unavailable. Check this repository’s GitHub connection in Settings, then retry.');
    }
    throw new Error('Pull requests could not be loaded from GitHub. Try again.');
  }
  const pulls = await response.json() as GitHubListPull[];
  const stats = new Map<number, PullStats>();
  if (pulls.length > 0 && !anonymous) {
    try {
      const result = await githubInstallationFetch(repo, '/graphql', {
        ...init, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: STATS_QUERY, variables: { ids: pulls.map((pull) => pull.node_id) } }),
      });
      if (result.response.ok) {
        const payload = await result.response.json() as { data?: { nodes?: Array<PullStats | null> } };
        for (const node of payload.data?.nodes ?? []) if (node) stats.set(node.number, node);
      }
    } catch { /* Keep the list usable when optional summary data is unavailable. */ }
  }
  return {
    repo,
    statsUnavailable: stats.size < pulls.length,
    nextPage: /rel="next"/.test(response.headers.get('link') ?? '') ? page + 1 : null,
    prs: pulls.map((pull) => {
      const summary = stats.get(pull.number);
      const checksState = summary?.commits.nodes[0]?.commit.statusCheckRollup?.state;
      return {
      number: pull.number, title: pull.title, author: pull.user?.login ?? 'Unknown author',
      avatarUrl: pull.user?.avatar_url ?? null, additions: summary?.additions ?? null, deletions: summary?.deletions ?? null,
      checks: checksState === 'SUCCESS' ? 'success' : checksState === 'FAILURE' || checksState === 'ERROR' ? 'failure' : checksState === 'PENDING' || checksState === 'EXPECTED' ? 'pending' : null,
      requestedReviewers: summary ? (summary.reviewRequests?.nodes ?? []).flatMap((request) => request?.requestedReviewer?.login ? [request.requestedReviewer.login] : []) : null,
      state: pull.merged_at ? 'merged' : pull.state, draft: pull.draft ?? false,
      headRefName: pull.head.ref, baseRefName: pull.base.ref, updatedAt: pull.updated_at,
      headRepoFullName: pull.head.repo?.full_name ?? null,
      url: pull.html_url, labels: pull.labels.map((label) => label.name),
      createdAt: pull.created_at,
    }; }),
  };
}
