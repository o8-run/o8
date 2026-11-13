import { findRepoByLocalPath } from '@/lib/repos/registry';
import { githubInstallationFetch } from '@/lib/github-broker/auth';
import { reserveExternalReview } from './external-review-store';

export async function adoptExternalReview(input: { repoPath: string; pullRequest: string | number; intendedOutcome?: string }) {
  if (input.intendedOutcome !== undefined && input.intendedOutcome.length > 2000) throw new Error('Intended outcome is too long.');
  const repo = await findRepoByLocalPath(input.repoPath);
  if (!repo) throw new Error('Select a registered repository.');
  const remote = repo.remoteUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
  if (!remote) throw new Error('The registered repository must have a GitHub origin.');
  const url = typeof input.pullRequest === 'string' ? input.pullRequest.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/) : null;
  if (url && url[1].toLowerCase() !== remote.toLowerCase()) throw new Error('The PR belongs to another repository.');
  const number = Number(url?.[2] ?? input.pullRequest);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Use a PR number or a GitHub pull request URL.');
  const { response } = await githubInstallationFetch(remote, `/repos/${remote}/pulls/${number}`);
  if (!response.ok) throw new Error('GitHub PR identity is unavailable.');
  const pr = await response.json();
  if (pr.number !== number || pr.base?.repo?.full_name?.toLowerCase() !== remote.toLowerCase()
    || (!Number.isSafeInteger(pr.base?.repo?.id) || pr.base.repo.id <= 0) || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '') || !/^[a-f0-9]{40}$/.test(pr.base?.sha ?? '') || !pr.base?.ref) throw new Error('GitHub returned incomplete PR identity.');
  return reserveExternalReview({ repoId: repo.id, repoPath: repo.localPath, repositoryId: String(pr.base.repo.id), pullRequest: number,
    url: `https://github.com/${pr.base.repo.full_name}/pull/${number}`, headSha: pr.head.sha, baseSha: pr.base.sha, baseRef: pr.base.ref,
    intendedOutcome: input.intendedOutcome?.trim() || null });
}
