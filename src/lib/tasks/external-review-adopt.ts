import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { githubInstallationFetch } from '@/lib/github-broker/auth';
import { getSqlite } from '@/lib/db';
import { reserveExternalReview } from './external-review-store';
import { ExternalReviewError } from './external-review-error';

export async function adoptExternalReview(input: { repoPath: string; pullRequest: string | number; intendedOutcome?: string }) {
  if (!input.repoPath.trim()) throw new ExternalReviewError('Select a registered repository.', 400);
  if (input.intendedOutcome !== undefined && input.intendedOutcome.length > 2000) throw new ExternalReviewError('Intended outcome is too long.', 400);
  const repoPath = await realpath(input.repoPath).catch(() => resolve(input.repoPath));
  const repo = await findRepoByLocalPath(repoPath);
  if (!repo) throw new ExternalReviewError('Select a registered repository.', 409);
  const remote = repo.remoteUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
  if (!remote) throw new ExternalReviewError('The registered repository must have a GitHub origin.', 409);
  const url = typeof input.pullRequest === 'string' ? input.pullRequest.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/) : null;
  if (url && url[1].toLowerCase() !== remote.toLowerCase()) throw new ExternalReviewError('The PR belongs to another repository.', 400);
  const decimal = url?.[2] ?? input.pullRequest;
  if (typeof decimal === 'string' && !/^[1-9]\d*$/.test(decimal)) throw new ExternalReviewError('Use a PR number or a GitHub pull request URL.', 400);
  const number = Number(decimal);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ExternalReviewError('Use a PR number or a GitHub pull request URL.', 400);
  // Capture the pointer before the network read. A delayed response cannot overwrite
  // a revision adopted by another request while this one was fetching GitHub.
  const basis = getSqlite().prepare('SELECT repository_id, current_revision_id FROM external_pr_review_tasks WHERE repo_id = ? AND pr_number = ?')
    .all(repo.id, number) as Array<{ repository_id: string; current_revision_id: string }>;
  let pr;
  try {
    const { response } = await githubInstallationFetch(remote, `/repos/${remote}/pulls/${number}`);
    if (!response.ok) throw new Error('Upstream failure');
    pr = await response.json();
  } catch { throw new ExternalReviewError('GitHub PR identity is unavailable. Try again.', 502); }
  if (pr?.number !== number || typeof pr.base?.repo?.full_name !== 'string' || pr.base.repo.full_name.toLowerCase() !== remote.toLowerCase()
    || !Number.isSafeInteger(pr.base?.repo?.id) || pr.base.repo.id <= 0 || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')
    || !/^[a-f0-9]{40}$/.test(pr.base?.sha ?? '') || typeof pr.base?.ref !== 'string' || !pr.base.ref
    || !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean' || typeof pr.draft !== 'boolean') {
    throw new ExternalReviewError('GitHub returned incomplete PR identity. Try again.', 502);
  }
  if (pr.merged) throw new ExternalReviewError('This PR is already merged. Adopt an open PR.', 409);
  if (pr.state !== 'open') throw new ExternalReviewError('This PR is closed. Adopt an open PR.', 409);
  return reserveExternalReview({ repoId: repo.id, repoPath: repo.localPath, repositoryId: String(pr.base.repo.id), pullRequest: number,
    url: `https://github.com/${pr.base.repo.full_name}/pull/${number}`, headSha: pr.head.sha, baseSha: pr.base.sha, baseRef: pr.base.ref,
    draft: pr.draft, intendedOutcome: input.intendedOutcome === undefined ? undefined : input.intendedOutcome.trim() || null,
    expectedRevisionId: basis.find(row => row.repository_id === String(pr.base.repo.id))?.current_revision_id ?? null });
}
