import 'server-only';
import { githubInstallationFetch } from './auth';
import type { GitHubReadPriority } from './request-budget';
import { GitHubReadScopeChangedError } from './read-scope';

export interface PullRequestFile {
  filename: string; previous_filename?: string; additions?: number; deletions?: number; status?: string; patch?: string;
}
const entries = new Map<string, { at: number; promise: Promise<PullRequestFile[]> }>();

/** Called only after a successful, fresh, authorized PR metadata read. */
export function readPullRequestFiles(repo: string, number: number, installationId?: number, head?: string | null, base?: string | null, priority: GitHubReadPriority = 'interactive', authorizedScope?: string): Promise<PullRequestFile[]> {
  const key = authorizedScope && installationId && head && base ? JSON.stringify([authorizedScope, repo, number, installationId, head, base]) : null;
  const existing = key ? entries.get(key) : undefined;
  if (existing && Date.now() - existing.at < 60_000) return existing.promise;
  const promise = githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}/files?per_page=100`, { signal: AbortSignal.timeout(18_000) }, { priority })
    .then(async ({ response, scope, installation, anonymous }) => {
      if ((authorizedScope && scope !== authorizedScope) || (installationId && installation?.id !== installationId)) { void response.body?.cancel().catch(() => {}); throw new GitHubReadScopeChangedError('GitHub authorization changed while reading pull request files. Retry.', anonymous); }
      if (!response.ok) throw new Error(`Pull request changes could not be read (${response.status}). Retry.`);
      return response.json() as Promise<PullRequestFile[]>;
    });
  if (key) {
    if (entries.size >= 16 && !entries.has(key)) entries.delete(entries.keys().next().value!);
    entries.set(key, { at: Date.now(), promise });
    // A failed/aborted read must not poison later retries or evict a newer read.
    void promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
  }
  return promise;
}
