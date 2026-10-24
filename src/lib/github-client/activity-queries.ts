import { pullRequestListQuery, issueListQuery, validGithubListRow, type ListQueryOptions } from './queries';
import type { QueryClient } from '@tanstack/react-query';
import { assertGithubRead, assertGithubScope } from './refresh-policy';

export type ActivityListKind = 'issues' | 'prs' | 'ci' | 'commits';
/** Compact activity, badges and cards observe the same repository entries. */
type ActivityQuery = Omit<ReturnType<typeof pullRequestListQuery>, 'queryFn' | 'queryKey'> & { queryKey: (string | null)[]; queryFn: (context: { signal?: AbortSignal; client?: QueryClient }) => Promise<unknown> };
export function activityListQuery(repo: string, kind: ActivityListKind, options?: ListQueryOptions): ActivityQuery {
  if (kind === 'issues') return issueListQuery(repo, options);
  if (kind === 'prs') return pullRequestListQuery(repo, options);
  const field = kind === 'ci' ? 'runs' : 'commits';
  return {
    ...pullRequestListQuery(repo, options),
    queryKey: ['gh', repo.trim().toLowerCase() || null, kind],
    queryFn: async ({ signal, client }: { signal?: AbortSignal; client?: QueryClient }): Promise<Record<string, unknown>> => {
      assertGithubScope(client, repo, options?.manual);
      const response = await fetch(`/api/panel/${kind}${repo.trim() ? `?repo=${encodeURIComponent(repo.trim())}` : ''}${options?.manual ? `${repo.trim() ? '&' : '?'}fresh=1` : ''}`, { signal, ...(options?.headers ? { headers: options.headers } : {}) });
      assertGithubRead(response, client, repo);
      const data = await response.json();
      if (!data || data.error || !Array.isArray(data[field]) || !data[field].every(validGithubListRow)) throw new Error('GitHub activity could not be read.');
      return data;
    },
  };
}
