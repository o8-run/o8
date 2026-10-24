import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pullRequestListQuery } from '@/lib/github-client';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';
import { validPrStackObservation } from '@/lib/github-client/pr-stack';
import type { PRHoverDetail } from './types';

export interface ActivityPrHoverStatus {
  error: string | null;
  isFetching: boolean;
  ageSeconds: number | null;
  retry: () => Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDetail(value: unknown, repo: string, number: number): value is PRHoverDetail {
  return isObject(value) && !value.error && value.number === number
    && (value.repo === undefined || (typeof value.repo === 'string' && value.repo.trim().toLowerCase() === repo))
    && typeof value.mergeable === 'boolean'
    && typeof value.checksStatus === 'string' && ['success', 'failure', 'pending', 'unknown'].includes(value.checksStatus)
    && (value.reviewDecision == null || typeof value.reviewDecision === 'string')
    && (value.stack === undefined || validPrStackObservation(value.stack, number))
    && Array.isArray(value.files) && value.files.every((file: unknown) => isObject(file)
      && typeof file.path === 'string' && typeof file.status === 'string'
      && typeof file.additions === 'number' && Number.isFinite(file.additions)
      && typeof file.deletions === 'number' && Number.isFinite(file.deletions));
}

class PrHoverDeferredError extends Error {
  constructor(status: number, readonly retryAt: number) {
    super(`PR detail request paused (${status})`);
  }
}

function hoverQuery(repo: string, number: number | null) {
  const queryKey = ['gh', repo, 'activity-pr-hover', number];
  return {
    ...pullRequestListQuery(repo),
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PRHoverDetail> => {
      if (!repo || number === null) throw new Error('No pull request selected');
      const response = await fetch(`/api/panel/pr?repo=${encodeURIComponent(repo)}&number=${number}`, { signal });
      const retryAt = githubQuotaDeadline(response);
      if (retryAt !== null) throw new PrHoverDeferredError(response.status, retryAt);
      if (!response.ok) throw new Error(`PR detail request failed (${response.status})`);
      const detail: unknown = await response.json();
      if (!validDetail(detail, repo, number)) throw new Error('Invalid PR detail response');
      return {
        mergeable: detail.mergeable, checksStatus: detail.checksStatus,
        reviewDecision: detail.reviewDecision ?? null, files: detail.files, stack: detail.stack,
      };
    },
    refetchInterval: false as const,
    retry: false as const,
  };
}

/** Hover details have finite freshness, but opening a hover does not start a poller. */
export function useActivityPrHoverDetail(repo: string | null, number: number | null) {
  const queryClient = useQueryClient();
  const canonicalRepo = repo?.trim().toLowerCase() ?? '';
  const options = useMemo(() => hoverQuery(canonicalRepo, number), [canonicalRepo, number]);
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    ...options,
    enabled: (entry) => Boolean(canonicalRepo) && number !== null
      && !(entry.state.error instanceof PrHoverDeferredError && Math.max(now, entry.state.errorUpdatedAt) < entry.state.error.retryAt),
    // A refused manual refresh must recover even if its retained snapshot is still fresh.
    staleTime: entry => entry.state.error instanceof PrHoverDeferredError ? 0 : options.staleTime,
  });
  const retry = useCallback(async () => {
    if (!canonicalRepo || number === null) return;
    try {
      await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
      await queryClient.fetchQuery({ ...options, staleTime: 0 });
    } catch {
      // The query exposes the error while keeping the selected PR's snapshot.
    }
  }, [queryClient, canonicalRepo, number, options]);

  useEffect(() => {
    if (!query.isError) return;
    // Catch up immediately when reopening an error entry after time spent closed.
    const catchUp = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(catchUp); clearInterval(timer); };
  }, [query.isError]);
  const status: ActivityPrHoverStatus = {
    error: query.isFetching ? null : query.error?.message ?? null,
    isFetching: query.isFetching,
    ageSeconds: query.dataUpdatedAt ? Math.max(0, Math.floor((Math.max(now, query.errorUpdatedAt) - query.dataUpdatedAt) / 1000)) : null,
    retry,
  };
  return { detail: query.data ?? null, status };
}
