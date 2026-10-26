import { drainPullRequestStackRefresh } from '@/lib/github-broker/pull-request-stack-refresh';
import { hasGitHubBrokerAccess } from '@/lib/github-broker/auth';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import {
  ensureGitHubIssues,
  ensureGitHubPullRequests,
} from '@/lib/github-broker/sync';
import { listRepos } from '@/lib/repos/registry';
import { githubOrgAccessCode } from '@/lib/github-broker/repo-access';

const uncoveredRepos = new Set<string>();
function reportError(repo: string, resource: string, message: string) {
  if (githubOrgAccessCode(message)) {
    const key = repo.toLowerCase();
    if (uncoveredRepos.has(key)) return;
    uncoveredRepos.add(key);
  }
  console.warn(`[github-broker] Supervisor ${resource} sync failed for ${repo}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runGitHubBrokerSyncSweep(): Promise<void> {
  if (!hasGitHubBrokerAccess()) return;
  await drainPullRequestStackRefresh();

  let repos: Awaited<ReturnType<typeof listRepos>>;
  try {
    repos = await listRepos();
  } catch (error) {
    console.warn(`[github-broker] Supervisor sync could not list connected repos: ${errorMessage(error)}`);
    return;
  }

  for (const repo of repos) {
    const repoFullName = normalizeRepoSlug(repo.remoteUrl);
    if (!repoFullName) continue;

    try {
      const result = await ensureGitHubIssues(repoFullName);
      if (result.error) {
        reportError(repoFullName, 'issue', result.error);
      } else uncoveredRepos.delete(repoFullName.toLowerCase());
    } catch (error) {
      reportError(repoFullName, 'issue', errorMessage(error));
    }

    try {
      const result = await ensureGitHubPullRequests(repoFullName);
      if (result.error) {
        reportError(repoFullName, 'pull request', result.error);
      }
    } catch (error) {
      reportError(repoFullName, 'pull request', errorMessage(error));
    }
  }
}
