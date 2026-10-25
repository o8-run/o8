import 'server-only';

import { githubInstallationFetch } from './auth';
import { getGitHubPullRequestHeadRef } from './actions';

export type PullRequestMetaAction = 'draft' | 'ready' | 'enable-auto-merge' | 'disable-auto-merge';

/** Resolve the node from this repository and PR; never accept an arbitrary client node ID. */
export async function updateGitHubPullRequestMode(repo: string, number: number, action: PullRequestMetaAction, options: { expectedHeadSha?: string; mergeMethod?: 'merge' | 'squash' | 'rebase'; beforePublish?: () => Promise<void> } = {}) {
  const head = await getGitHubPullRequestHeadRef(repo, number);
  if (!head.nodeId || head.state !== 'open') throw new Error('This pull request is no longer open.');
  if (options.expectedHeadSha && options.expectedHeadSha !== head.sha) throw new Error('The pull request changed. Refresh before continuing.');
  const mutation = action === 'draft' ? 'convertPullRequestToDraft' : action === 'ready' ? 'markPullRequestReadyForReview' : action === 'enable-auto-merge' ? 'enablePullRequestAutoMerge' : 'disablePullRequestAutoMerge';
  const inputType = action === 'draft' ? 'ConvertPullRequestToDraftInput' : action === 'ready' ? 'MarkPullRequestReadyForReviewInput' : action === 'enable-auto-merge' ? 'EnablePullRequestAutoMergeInput' : 'DisablePullRequestAutoMergeInput';
  const input = {
    pullRequestId: head.nodeId,
    ...(action === 'enable-auto-merge' ? { expectedHeadOid: options.expectedHeadSha, mergeMethod: (options.mergeMethod || 'squash').toUpperCase() } : {}),
  };
  if (action === 'enable-auto-merge') await options.beforePublish?.();
  const { response } = await githubInstallationFetch(repo, '/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `mutation UpdatePullRequest($input: ${inputType}!) { ${mutation}(input: $input) { pullRequest { id } } }`, variables: { input } }),
  });
  const payload = await response.json() as { errors?: unknown[]; data?: Record<string, { pullRequest?: { id?: string } }> };
  if (!response.ok || payload.errors?.length || payload.data?.[mutation]?.pullRequest?.id !== head.nodeId) throw new Error('GitHub did not confirm this action. Check repository permissions and rules.');
}
