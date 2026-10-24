import { assertGithubRead, GithubReadDeferredError as PrCountDeferredError } from '@/lib/github-client/refresh-policy';
import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const options = {
  ...pullRequestListQuery(''),
  // A parameterless read resolves the server's default repository. Keep its
  // count separate from explicit lists and disabled empty-repository queries.
  queryKey: ['gh', null, 'diagnostics-pr-count'],
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<{ count: number }> => {
    const response = await fetch('/api/panel/prs', { cache: 'no-store', signal });
    assertGithubRead(response);
    if (!response.ok) throw new Error(`PR count request failed (${response.status})`);
    const data: unknown = await response.json();
    if (!isObject(data) || data.error || data.unavailable || !Array.isArray(data.prs)
      || !data.prs.every((pr: unknown) => isObject(pr) && (pr.state == null || typeof pr.state === 'string'))) {
      throw new Error('PR count is unavailable');
    }
    return { count: data.prs.filter(pr => !pr.state || String(pr.state).toUpperCase() === 'OPEN').length };
  },
  retry: false as const,
};

export function useDiagnosticsPrCount() {
  const client = useQueryClient();
  const hidden = useGithubWindowHidden();
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    ...options,
    refetchInterval: hidden ? 300_000 : 120_000,
    enabled: entry => !(entry.state.error instanceof PrCountDeferredError
      && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
  });
  const retry = useCallback(async () => {
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.fetchQuery({ ...options, staleTime: 0 });
    } catch {
      // Keep the previous count while the query exposes the failed read.
    }
  }, [client]);
  useEffect(() => {
    if (!query.isError) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [query.isError]);
  return {
    count: query.data?.count ?? null,
    error: query.isFetching ? null : query.error?.message ?? null,
    isFetching: query.isFetching,
    ageSeconds: Math.max(0, Math.floor((Math.max(now, query.errorUpdatedAt) - query.dataUpdatedAt) / 1000)),
    retry,
  };
}
