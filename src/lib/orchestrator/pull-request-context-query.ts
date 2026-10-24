import { ensureGitHubPullRequest } from '@/lib/github-broker/sync';
import { getGitHubPullRequestByNumber } from '@/lib/github-broker/store';
import { listPullRequestContext, PullRequestContextError, type PullRequestContextIdentity } from './pull-request-context';

export function contextThread(value: unknown): string | null {
  return typeof value === 'string' && /^thoughts-[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}
export function contextIdentity(body: Record<string, unknown>): PullRequestContextIdentity | null {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  return body.host === 'github.com' && valid(body.repositoryId) && valid(body.pullRequestId) && valid(body.number)
    ? { host: 'github.com', repositoryId: body.repositoryId, pullRequestId: body.pullRequestId, number: body.number } : null;
}
export function invalidContextQuery(): never {
  throw new PullRequestContextError('invalid_request', 'Provide a conversation or complete GitHub PR identity, with valid pagination.', 400);
}
/** Resolve a display address only from provider evidence already in the local mirror. */
export async function readPullRequestContext(params: URLSearchParams) {
  const hasThread = params.has('threadId');
  const hasRepo = params.has('repo');
  const ids = ['host', 'repositoryId', 'pullRequestId'];
  if ((hasThread && ['repo', 'number', 'resolve', ...ids].some(key => params.has(key)))
    || (hasRepo && ids.some(key => params.has(key)))) invalidContextQuery();
  let target: { threadId: string } | PullRequestContextIdentity | null;
  if (hasThread) {
    const threadId = contextThread(params.get('threadId'));
    if (!threadId) invalidContextQuery();
    target = { threadId };
  } else if (hasRepo) {
    const repo = params.get('repo')!;
    const number = Number(params.get('number'));
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) invalidContextQuery();
    let pull = getGitHubPullRequestByNumber(repo, number);
    if (params.get('refresh') === '1' || (params.get('refresh') === 'missing' && !pull?.repositoryId)) {
      const refreshed = await ensureGitHubPullRequest(repo, number);
      if (refreshed.stale || refreshed.error || !refreshed.pr) throw new PullRequestContextError('pr_read_unavailable', 'The PR identity could not be refreshed. Check GitHub access and retry.', 409);
      pull = refreshed.pr;
    }
    const providerAddress = `https://github.com/${repo}/pull/${number}`;
    target = pull?.url.toLowerCase() === providerAddress.toLowerCase() ? contextIdentity({ host: 'github.com', repositoryId: pull.repositoryId, pullRequestId: pull.pullRequestId, number }) : null;
    if (!target) throw new PullRequestContextError('pr_identity_unknown', 'Refresh this pull request before linking it; its immutable identity is not in the mirror.', 409);
    if (params.get('resolve') === '1') return { identity: target };
  } else {
    target = contextIdentity({ host: params.get('host'), repositoryId: Number(params.get('repositoryId')), pullRequestId: Number(params.get('pullRequestId')), number: Number(params.get('number')) });
    if (!target) invalidContextQuery();
  }
  return listPullRequestContext(target, {
    ...(params.has('after') ? { after: Number(params.get('after')) } : {}),
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
  });
}
