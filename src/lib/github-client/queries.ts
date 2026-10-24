/**
 * Shared client cache for GitHub-backed lists (#3460).
 *
 * Every surface that shows a repository's pull requests or issues reads the
 * same TanStack Query entry, so N cards or badges for one repository cost one
 * request. The server already keeps a two-minute snapshot per repository
 * (`src/lib/github-broker/sync.ts`); this layer stops each component from
 * paying its own round trip and from showing a different snapshot of the
 * same pull request.
 *
 * Refresh policy:
 *   - a list is fresh for 2 minutes;
 *   - it refreshes every 2 minutes while the window is visible and every
 *     5 minutes while it is hidden or in the tray;
 *   - a manual refresh cancels any background fetch in flight and asks the
 *     server to bypass its snapshot where the route supports it;
 *   - a failed or rate-limited refresh keeps the last data on screen
 *     (TanStack keeps `data` on error; the route reports `stale`).
 */

import type { QueryClient } from '@tanstack/react-query';

import { assertGithubRead, assertGithubScope, githubSnapshotDeadline, recordGithubQuota, GITHUB_LIST_FRESH_MS, githubRefreshInterval, githubReadOnMount } from './refresh-policy';
export { GITHUB_LIST_FRESH_MS, GITHUB_VISIBLE_REFRESH_MS, GITHUB_HIDDEN_REFRESH_MS, githubRefreshInterval } from './refresh-policy';
const GITHUB_LIST_GC_MS = 10 * 60_000;

export type GithubListKind = 'prs' | 'issues';

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  author: string | null;
  headRefName: string;
  baseRefName: string;
  state: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  statusCheckRollup?: unknown;
  reviewDecision?: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  labels: unknown[];
  state: string;
  author: string | null;
  assignees?: unknown[];
  comments?: number;
  body?: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface GithubListMeta {
  repo: string | null;
  error?: string | null;
  stale?: boolean;
  unavailable?: boolean;
  lastSuccessfulAt?: string | null;
}

export interface GithubPullRequestList extends GithubListMeta {
  prs: GithubPullRequestSummary[];
}

export interface GithubIssueList extends GithubListMeta {
  issues: GithubIssueSummary[];
}

/** Repository slugs are case-insensitive on GitHub, so the key is too. */
export function githubListQueryKey(repo: string, kind: GithubListKind, repoPath?: string | null): string[] {
  const key = ['gh', repo.trim().toLowerCase(), kind];
  // A display name can resolve to different remotes in different checkouts.
  return repoPath ? [...key, 'checkout', repoPath] : key;
}

/** Reject malformed row shapes before they can replace a retained snapshot or reach renderers. */
export function validGithubListRow(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const value = row as Record<string, unknown>;
  if (['title', 'displayTitle', 'message', 'date'].some(key => value[key] != null && typeof value[key] !== 'string')) return false;
  if (value.labels != null && !Array.isArray(value.labels)) return false;
  return ['assignees', 'statusCheckRollup'].every(key => value[key] == null
    || (Array.isArray(value[key]) && value[key].every((entry: unknown) => entry != null && (typeof entry === 'string' || typeof entry === 'object'))));
}

async function getJson<T>(url: string, kind: GithubListKind, signal?: AbortSignal, headers?: HeadersInit, client?: QueryClient, scope = '', manual = false): Promise<T> {
  assertGithubScope(client, scope, manual);
  const response = await fetch(url, { signal, ...(headers ? { headers } : {}) });
  assertGithubRead(response, client, scope);
  const data = await response.json();
  // A successful HTTP status alone must not replace a usable cached list.
  // Stale broker snapshots (including their error metadata) remain usable.
  if (data === null || typeof data !== 'object' || !Array.isArray(data[kind]) || !data[kind].every(validGithubListRow)) {
    throw new Error(`${url} returned an invalid ${kind} list`);
  }
  if (data.error && data.stale !== true) throw new Error('GitHub list could not be refreshed.');
  const retryAt = githubSnapshotDeadline(data);
  if (retryAt > Date.now()) recordGithubQuota(client, scope, retryAt);
  return data as T;
}

function listUrl(repo: string, kind: GithubListKind, fresh: boolean, repoPath?: string | null): string {
  const query = `repo=${encodeURIComponent(repo.trim())}${fresh ? '&fresh=1' : ''}${repoPath ? `&repoPath=${encodeURIComponent(repoPath)}` : ''}`;
  return kind === 'prs' ? `/api/panel/prs?${query}` : `/api/panel/issues?${query}`;
}

export interface ListQueryOptions {
  headers?: HeadersInit;
  beforeRead?: () => void;
  manual?: boolean;
  isHidden?: () => boolean;
  repoPath?: string | null;
}

function listQuery<T>(repo: string, kind: GithubListKind, { isHidden, repoPath, headers, beforeRead }: ListQueryOptions = {}) {
  return {
    queryKey: githubListQueryKey(repo, kind, repoPath),
    queryFn: ({ signal, client }: { signal?: AbortSignal; client?: QueryClient }) => { beforeRead?.(); return getJson<T>(listUrl(repo, kind, false, repoPath), kind, signal, headers, client, repo); },
    staleTime: GITHUB_LIST_FRESH_MS,
    gcTime: GITHUB_LIST_GC_MS,
    refetchInterval: githubRefreshInterval(isHidden),
    refetchOnMount: githubReadOnMount,
    retry: false as const,
    // A hidden desktop window still refreshes, on the slower interval above.
    refetchIntervalInBackground: true,
  };
}

export function pullRequestListQuery(repo: string, options?: ListQueryOptions) {
  return listQuery<GithubPullRequestList>(repo, 'prs', options);
}

export function issueListQuery(repo: string, options?: ListQueryOptions) {
  return listQuery<GithubIssueList>(repo, 'issues', options);
}

/**
 * A user-triggered refresh. It cancels a background fetch in flight so the
 * click is never answered by an older request, and asks the server to skip
 * its snapshot (`fresh=1` is honored by both list routes).
 */
export async function refreshGithubList(
  queryClient: QueryClient,
  repo: string,
  kind: GithubListKind,
  repoPath?: string | null,
  headers?: HeadersInit,
  beforeRead?: () => void,
): Promise<GithubPullRequestList | GithubIssueList> {
  beforeRead?.();
  const queryKey = githubListQueryKey(repo, kind, repoPath);
  await queryClient.cancelQueries({ queryKey, exact: true });
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => { beforeRead?.(); return getJson<GithubPullRequestList | GithubIssueList>(listUrl(repo, kind, true, repoPath), kind, signal, headers, queryClient, repo, true); },
    staleTime: 0,
  });
}
