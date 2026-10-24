import type { QueryClient } from '@tanstack/react-query';
import { GITHUB_LIST_FRESH_MS, assertGithubRead, assertGithubScope, githubReadOnMount } from './refresh-policy';
import type { ListQueryOptions } from './queries';

/** Items load on selection; only an explicitly open checks view may add polling. */
export function githubItemQuery<T>(repo: string, kind: string, number: number, url: string, options?: ListQueryOptions) {
  return {
    queryKey: ['gh', repo.trim().toLowerCase(), kind, number],
    queryFn: async ({ signal, client }: { signal: AbortSignal; client?: QueryClient }): Promise<T> => {
      options?.beforeRead?.();
      assertGithubScope(client, repo, options?.manual);
      const response = await fetch(url, { signal, ...(options?.headers ? { headers: options.headers } : {}) });
      assertGithubRead(response, client, repo);
      const data = await response.json();
      if (!data || typeof data !== 'object' || data.error) throw new Error('GitHub item could not be read.');
      return data as T;
    },
    staleTime: GITHUB_LIST_FRESH_MS,
    gcTime: 600_000,
    retry: false as const,
    refetchOnMount: githubReadOnMount,
    refetchInterval: false as const,
  };
}
