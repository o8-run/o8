import { assertGithubRead, assertGithubScope, githubReadOnMount } from '@/lib/github-client/refresh-policy';
import { validPrStackObservation } from '@/lib/github-client/pr-stack';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { GITHUB_LIST_FRESH_MS } from '@/lib/github-client';
import { normalizePRDetail } from './shared';
import type { PRDetail } from './types';

export function prViewerDetailQuery(repo: string | undefined, number: number, manual = false) {
  const slug = repo?.trim() || null;
  return queryOptions({
    // Viewer snapshots include normalized comments/files; keep their shape
    // separate from the compact PR panel's existing snapshot cache.
    queryKey: ['gh', slug?.toLowerCase() ?? null, 'pr-viewer', number],
    queryFn: async ({ signal, client }): Promise<PRDetail> => {
      const repoParam = slug ? `?repo=${encodeURIComponent(slug)}` : '';
      assertGithubScope(client, slug ?? '', manual);
      const response = await fetch(`/api/panel/prs/${number}${repoParam}`, { signal });
      assertGithubRead(response, client, slug ?? '');
      const data = await response.json() as { pr: PRDetail };
      if (data.pr.stack !== undefined && !validPrStackObservation(data.pr.stack, number)) throw new Error('Invalid pull request stack response.');
      return normalizePRDetail(data.pr);
    },
    staleTime: query => ['CLOSED', 'MERGED'].includes(query.state.data?.state?.toUpperCase() ?? '')
      ? Infinity : GITHUB_LIST_FRESH_MS,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnMount: githubReadOnMount,
    // Only the selected checks section supplies a fast interval.
    refetchInterval: false,
  });
}

export async function refreshPrViewerDetail(client: QueryClient, repo: string | undefined, number: number) {
  const options = prViewerDetailQuery(repo, number, true);
  // A write/Retry must start a new read rather than join a pre-write request.
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  await client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
  return client.fetchQuery({ ...options, staleTime: 0 });
}
