import { assertGithubRead, githubRefreshInterval } from '@/lib/github-client/refresh-policy';
import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { useCallback, useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { PullRequestListPage, PullRequestListSort, PullRequestListState } from '@/lib/github-broker/pull-request-list.types';
import { pullRequestListQuery } from '@/lib/github-client';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';

function pageQuery(repoPath: string, state: PullRequestListState, sort: PullRequestListSort, fresh = false) {
  return {
    // Inherit the common list policy, replacing its compact shape and request.
    ...pullRequestListQuery(''),
    queryKey: ['gh', 'repository-pr-pages', repoPath, state, sort],
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }): Promise<PullRequestListPage> => {
      const params = new URLSearchParams({ repoPath, view: 'list', state, sort, page: String(pageParam) });
      if (fresh) params.set('fresh', '1');
      const response = await ipcFetch(`/api/panel/prs?${params}`, { signal });
      assertGithubRead(response);
      const result = await response.json() as PullRequestListPage;
      if (!response.ok || result.error || !Array.isArray(result.prs)) {
        throw new Error(result.error || 'Pull requests could not be loaded. Try again.');
      }
      return result;
    },
    getNextPageParam: (last: PullRequestListPage) => last.nextPage ?? undefined,
  };
}

export function useRepositoryPullRequests(repoPath: string | null, state: PullRequestListState, sort: PullRequestListSort, active: boolean) {
  const client = useQueryClient();
  const hidden = useGithubWindowHidden();
  const options = useMemo(() => pageQuery(repoPath ?? '', state, sort), [repoPath, state, sort]);
  const query = useInfiniteQuery({
    ...options,
    refetchInterval: githubRefreshInterval(() => hidden),
    enabled: Boolean(active && repoPath),
    // The final active observer releases its in-flight request on leaving.
    subscribed: Boolean(active && repoPath),
  });
  const data = useMemo(() => {
    if (!query.data) return null;
    const pages = query.data.pages;
    const seen = new Set<number>();
    const prs = pages.flatMap(page => page.prs).filter(pr => {
      if (seen.has(pr.number)) return false;
      seen.add(pr.number); return true;
    });
    return { ...pages[pages.length - 1], prs, statsUnavailable: pages.some(page => page.statsUnavailable) };
  }, [query.data]);

  const refresh = useCallback(async () => {
    if (!repoPath || !active) return;
    const queryKey = options.queryKey;
    await client.cancelQueries({ queryKey, exact: true });
    await client.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
    // Concurrent views share this read after the older request is canceled.
    try {
      await client.fetchInfiniteQuery({ ...pageQuery(repoPath, state, sort, true), staleTime: 0 });
    } catch { /* The observer retains rows and exposes the failed refresh. */ }
  }, [client, options.queryKey, repoPath, state, sort, active]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const changed = (event as CustomEvent<{ repo: string }>).detail;
      if (!changed?.repo || changed.repo !== data?.repo) return;
      // Invalidate inactive state/sort variants too; they read on activation.
      void client.invalidateQueries({ queryKey: options.queryKey.slice(0, 3), refetchType: 'none' }).then(refresh);
    };
    window.addEventListener('o8:pr-updated', onUpdated);
    return () => window.removeEventListener('o8:pr-updated', onUpdated);
  }, [client, data?.repo, options.queryKey, refresh]);

  return {
    data,
    loading: active && query.isFetching,
    error: query.isError ? query.error.message : null,
    refresh,
    retry: () => query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : refresh(),
    loadMore: () => query.fetchNextPage({ cancelRefetch: false }),
  };
}
