import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { captureGitHubAccount, captureGitHubInstallationAuthorization, GitHubAccountChangedError, GitHubManagedUnavailableError, requireGitHubAccount } from '@/lib/github-broker/auth';
import { GitHubOrgNotCoveredError } from '@/lib/github/org-access';
import { GitHubRequestDeferredError } from '@/lib/github-broker/request-budget';
import { MobileIssueReadError, projectIssueDetail, projectIssueList } from '@/lib/mobile/project-issues';
import { listRepos } from '@/lib/repos/registry';
import { remoteRepositoryIdentity } from '@/lib/repos/remote-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function repoSlug(remote: string | null | undefined) {
  const identity = remoteRepositoryIdentity(remote);
  const match = /^github\.com\/([\w-]+)\/([\w.-]+)$/.exec(identity);
  return match && match[2] !== '.' && match[2] !== '..' ? match[1] + '/' + match[2] : null;
}
function positive(value: string, digits: number) {
  return value.length <= digits && /^[1-9]\d*$/.test(value);
}
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status });

export async function GET(request: Request) {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') return error('Paired device or operator required.', principal === 'anonymous' ? 401 : 403);
  const account = captureGitHubAccount();
  const search = new URL(request.url).searchParams;
  try {
    const projects = await listRepos();
    const project = projects.find(item => item.localPath === search.get('repoPath'));
    if (!project) return error('Project unavailable.', 404);
    const expected = search.get('expectedRepo')?.toLowerCase();
    const part = search.get('part');
    if (part === 'resolve' && expected) {
      const destination = repoSlug(project.remoteUrl) === expected ? project
        : projects.find(item => repoSlug(item.remoteUrl) === expected);
      if (!destination) return error('GitHub project unavailable on this computer.', 404);
      return NextResponse.json({ repo: expected, repoPath: destination.localPath }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (part) return error('Unknown issue view.', 400);
    const repo = repoSlug(project.remoteUrl);
    if (!repo) return error('Project has no GitHub repository.', 404);
    if (expected !== undefined && expected !== repo) return error('The selected project repository changed.', 409);
    const number = search.get('number');
    const page = search.get('page') ?? '1';
    const cursor = search.get('cursor');
    const state = search.get('state') ?? 'open';
    const query = search.get('query') ?? '';
    if ((number !== null && !positive(number, 9)) || !positive(page, 6) ||
        (cursor !== null && (!number || !positive(cursor, 6))) || !['open', 'closed', 'all'].includes(state) || query.length > 256) {
      return error('Invalid issue, filter or page.', 400);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
    const authorization = await captureGitHubInstallationAuthorization(repo, account, signal);
    const source = { repo, authorization, signal };
    const read = number === null ? projectIssueList(source, state, Number(page), query)
      : projectIssueDetail(source, project.localPath, Number(number), cursor === null ? null : Number(cursor));
    const result = await read.finally(() => requireGitHubAccount(account));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof MobileIssueReadError) return error(cause.message, cause.status);
    if (cause instanceof GitHubAccountChangedError) return error('GitHub account changed. Refresh this project.', 409);
    if (cause instanceof GitHubManagedUnavailableError) return error('Connect GitHub on this computer to read issues.', 403);
    if (cause instanceof GitHubOrgNotCoveredError) return error('GitHub access does not cover this project.', 403);
    if (cause instanceof GitHubRequestDeferredError) {
      return NextResponse.json({ error: 'GitHub rate limit reached.' }, { status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((cause.retryAt - Date.now()) / 1000))) } });
    }
    return error('Issues unavailable.', 503);
  }
}
