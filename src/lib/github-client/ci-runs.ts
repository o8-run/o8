import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { activityListQuery } from './activity-queries';
import { useGithubWindowHidden } from './visibility';
import { GithubReadDeferredError as CIRunsDeferredError } from './refresh-policy';

export interface CIRun {
  databaseId: number;
  displayTitle: string;
  event: string;
  headBranch: string;
  headSha?: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  workflowName: string;
  url: string;
  pullRequests?: { number: number; url: string }[];
}

interface CIRunList {
  runs: CIRun[];
  repo: string;
}

/** Shared run-list observer; disabled hovers must not resolve the default repository. */
export function useRepoCIRuns(repo?: string, enabled = true) {
  const client = useQueryClient();
  const hidden = useGithubWindowHidden();
  const [now, setNow] = useState(() => Date.now());
  const repoScope = repo?.trim().toLowerCase() || null;
  const queryKey = ['gh', repoScope, 'ci'];
  const inheritedRetry = client.defaultQueryOptions({ queryKey }).retry ?? (typeof window === 'undefined' ? 0 : 3);
  const options = activityListQuery(repoScope ?? '', 'ci', { isHidden: () => hidden });
  const query = useQuery<CIRunList>({
    ...options,
    // The omitted repository has a distinct entry for the route's default lookup.
    queryKey,
    enabled: entry => enabled && !(entry.state.error instanceof CIRunsDeferredError
      && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
    // Keep configured ordinary-error retries, but never retry a quota refusal immediately.
    retry: (failures, error) => !(error instanceof CIRunsDeferredError) && (typeof inheritedRetry === 'function'
      ? inheritedRetry(failures, error) : inheritedRetry === true || (typeof inheritedRetry === 'number' && failures < inheritedRetry)),
    queryFn: async context => await options.queryFn(context) as CIRunList,
  });
  useEffect(() => {
    if (!enabled || !(query.error instanceof CIRunsDeferredError)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, query.error.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [enabled, query.error]);
  const refetch = useCallback(async () => {
    await client.cancelQueries({ queryKey: ['gh', repoScope, 'ci'], exact: true });
    const manual = activityListQuery(repoScope ?? '', 'ci', { manual: true });
    try { return await client.fetchQuery({ ...manual, staleTime: 0 }); } catch { return undefined; }
  }, [client, repoScope]);
  return { ...query, repoScope, refetch };
}
