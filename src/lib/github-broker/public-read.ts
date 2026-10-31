import 'server-only';
import { sharedConditionalGitHubRead } from './conditional-read';
import { assertGitHubRequestBudget, githubCredentialScope, observeGitHubRequestBudget, type GitHubReadPriority } from './request-budget';
import { isSecondaryGitHubLimit } from './rate-limit-response';
import { GitHubOrgNotCoveredError, publicGitHubDecision, rememberPublicGitHubDecision } from './repo-access';
import { withGitHubAbort } from './abort';

class UncachedPublicResponse extends Error {
  constructor(readonly response: Response) { super('GitHub public read was refused.'); }
}

export async function publicGitHubRead(repo: string, path: string, apiBaseUrl: string, decisionKey: string, init?: RequestInit, priority: GitHubReadPriority = 'interactive', maxAgeMs = 120_000) {
  if (publicGitHubDecision(decisionKey)?.denied) throw new GitHubOrgNotCoveredError();
  // All anonymous reads on a host share the same IP quota, across repositories
  // and managed credentials. Only public answers enter this cache scope.
  const scope = githubCredentialScope(apiBaseUrl, 0, 'anonymous');
  const dispatch = async (target: string, signal: AbortSignal, etag?: string) => {
    assertGitHubRequestBudget(scope, 'core', priority);
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('if-none-match');
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('User-Agent', 'o8-github-broker');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (etag) headers.set('If-None-Match', etag);
    const result = await withGitHubAbort(signal, () => fetch(`${apiBaseUrl}${target}`, { ...init, signal, headers, cache: 'no-store' }));
    observeGitHubRequestBudget(scope, 'core', result, Date.now(), await withGitHubAbort(signal, () => isSecondaryGitHubLimit(result)));
    if (result.status === 403 || result.status === 429) assertGitHubRequestBudget(scope, 'core', 'interactive');
    return result;
  };
  const response = await sharedConditionalGitHubRead(JSON.stringify([scope, repo.toLowerCase(), path]), async (etag, signal) => {
    const result = await dispatch(path, signal, etag);
    if (result.status === 404) {
      // A missing PR, deleted commit or disabled feature does not make the
      // repository private. Confirm the repository before caching denial.
      const repoPath = `/repos/${repo}`;
      const metadata = path === repoPath ? result : await dispatch(repoPath, signal);
      if (metadata !== result) void metadata.body?.cancel().catch(() => {});
      if (metadata.ok) rememberPublicGitHubDecision(decisionKey, false);
      if (metadata.status === 404) {
        void result.body?.cancel().catch(() => {});
        rememberPublicGitHubDecision(decisionKey, true);
        throw new GitHubOrgNotCoveredError();
      }
    }
    if (!result.ok && result.status !== 304) throw new UncachedPublicResponse(result);
    if (result.ok || result.status === 304) rememberPublicGitHubDecision(decisionKey, false);
    return result;
  }, { maxAgeMs, signal: init?.signal }).catch(error => {
    if (error instanceof UncachedPublicResponse) return error.response.clone();
    throw error;
  });
  // A shared cached answer also establishes public access for this credential.
  if (response.ok) rememberPublicGitHubDecision(decisionKey, false);
  return { response, scope };
}
