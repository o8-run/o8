import 'server-only';

import { githubInstallationFetch } from './auth';
import { getGitHubAppConfig } from './env';
import type { GitHubReadPriority } from './request-budget';
import { GitHubReadScopeChangedError } from './read-scope';

interface Check {
  name: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
}

interface Entry {
  etag?: string;
  checks?: Check[];
  pending?: Promise<Check[]>;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 32;

/** Call after fresh PR metadata authorizes this installation and head. */
export function readPullRequestChecks(repo: string, head: string, installationId?: number, priority: GitHubReadPriority = 'interactive', authorizedScope?: string): Promise<Check[]> {
  const host = getGitHubAppConfig()?.apiBaseUrl ?? 'https://api.github.com';
  const key = authorizedScope && installationId ? JSON.stringify([authorizedScope, host, repo.toLowerCase(), installationId, head]) : null;
  const entry = (key ? entries.get(key) : undefined) ?? {};
  if (entry.pending) return entry.pending;
  if (key) {
    // Refresh insertion order so the least recently used entry is evicted.
    entries.delete(key);
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    entries.set(key, entry);
  }

  // No TTL shortcut: check runs can change while the commit SHA stays the same.
  // This shared read owns its deadline; one panel cannot abort another's read.
  const pending = githubInstallationFetch(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=100`, {
    signal: AbortSignal.timeout(18_000),
    headers: entry.etag ? { 'If-None-Match': entry.etag } : undefined,
  }, { priority }).then(async ({ response, installation, scope, anonymous }) => {
    if (authorizedScope && scope !== authorizedScope) { void response.body?.cancel().catch(() => {}); throw new GitHubReadScopeChangedError('GitHub authorization changed while reading pull request checks. Retry.', anonymous); }
    if (installationId && installation?.id !== installationId) {
      void response.body?.cancel().catch(() => {});
      throw new Error('GitHub installation changed while reading pull request checks. Retry.');
    }
    if (response.status === 304 && entry.etag && entry.checks) return entry.checks;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Pull request checks could not be read (${response.status}). Retry.`);
    }
    const payload = await response.json() as {
      check_runs?: Array<{ name?: string | null; status?: string | null; conclusion?: string | null; html_url?: string | null }>;
    };
    if (!Array.isArray(payload.check_runs)) throw new Error('Pull request checks response is invalid. Retry.');
    const checks = payload.check_runs.filter((check) => Boolean(check.name)).map((check) => ({
      name: check.name!, status: check.status ?? null, conclusion: check.conclusion ?? null, url: check.html_url ?? null,
    }));
    entry.etag = response.headers.get('etag') ?? undefined;
    entry.checks = checks;
    return checks;
  }).catch((error: unknown) => {
    // Refusals and aborted reads cannot be used as fresh answers on retry.
    if (key && entries.get(key) === entry) entries.delete(key);
    throw error;
  }).finally(() => { entry.pending = undefined; });
  entry.pending = pending;
  return pending;
}
