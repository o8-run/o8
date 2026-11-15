import 'server-only';

import { githubInstallationFetch, captureGitHubAccount, requireGitHubAccount } from './auth';
import { getGitHubPullRequestHeadRef } from './actions';

export type PullRequestMetaAction = 'draft' | 'ready' | 'enable-auto-merge' | 'disable-auto-merge';

/** Resolve the node from this repository and PR; never accept an arbitrary client node ID. */
export async function updateGitHubPullRequestMode(repo: string, number: number, action: PullRequestMetaAction, options: { expectedHeadSha?: string; mergeMethod?: 'merge' | 'squash' | 'rebase'; expectedMergeGate?: string; principal?: string; beforePublish?: () => Promise<void> } = {}) {
  if (action === 'enable-auto-merge') {
    const { publishGitHubPullRequest } = await import('./publication');
    return publishGitHubPullRequest(repo, number, action, options);
  }
  const account = captureGitHubAccount();
  const head = await getGitHubPullRequestHeadRef(repo, number);
  if (!head.nodeId || head.state !== 'open') throw new Error('This pull request is no longer open.');
  if (options.expectedHeadSha && options.expectedHeadSha !== head.sha) throw new Error('The pull request changed. Refresh before continuing.');
  const mutation = action === 'draft' ? 'convertPullRequestToDraft' : action === 'ready' ? 'markPullRequestReadyForReview' : 'disablePullRequestAutoMerge';
  const inputType = action === 'draft' ? 'ConvertPullRequestToDraftInput' : action === 'ready' ? 'MarkPullRequestReadyForReviewInput' : 'DisablePullRequestAutoMergeInput';
  const input = {
    pullRequestId: head.nodeId,
  };
  const { response } = await githubInstallationFetch(repo, '/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `mutation UpdatePullRequest($input: ${inputType}!) { ${mutation}(input: $input) { pullRequest { id } } }`, variables: { input } }),
  });
  const payload = await response.json() as { errors?: unknown[]; data?: Record<string, { pullRequest?: { id?: string } }> };
  if (!response.ok || payload.errors?.length || payload.data?.[mutation]?.pullRequest?.id !== head.nodeId) throw new Error('GitHub did not confirm this action. Check repository permissions and rules.');
  if (action === 'disable-auto-merge') {
    requireGitHubAccount(account);
    const { recordGitHubAutoMergeDisabled } = await import('./publication');
    recordGitHubAutoMergeDisabled(account.apiBaseUrl, repo, number);
  }
}
