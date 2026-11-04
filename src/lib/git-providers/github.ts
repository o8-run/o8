import 'server-only';

import { commentOnGitHubPullRequest, fetchGitHubPullRequestComments, mergeGitHubPullRequest } from '@/lib/github-broker';
import { fetchPullRequestListPage } from '@/lib/github-broker/pull-request-list';
import { assertPrMergeAllowed } from '@/lib/github-broker/pr-merge-gate';
import type { GitProvider } from './types';

/** GitHub behind the provider interface: a thin delegation to the existing broker. */
export const githubProvider: GitProvider = {
  kind: 'github',
  listPullRequests: (repo, query) => fetchPullRequestListPage(repo, query.state, query.page, query.signal, query.sort, query.fresh),
  readDiscussion: (repo, number) => fetchGitHubPullRequestComments(repo, number),
  comment: async (repo, number, body) => { await commentOnGitHubPullRequest(repo, number, body); },
  merge: async (repo, number, { mergeMethod, expectedHeadSha, expectedMergeGate }) => {
    await mergeGitHubPullRequest(repo, number, {
      deleteBranch: false,
      mergeMethod,
      expectedHeadSha,
      beforePublish: () => assertPrMergeAllowed(repo, number, expectedHeadSha, mergeMethod, expectedMergeGate),
    });
  },
};
