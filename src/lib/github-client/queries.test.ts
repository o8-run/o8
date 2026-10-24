// @vitest-environment jsdom
/**
 * Shared GitHub list cache (#3460), driven through a real TanStack
 * QueryClient with the same options the hooks pass to `useQuery`.
 */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_HIDDEN_REFRESH_MS,
  GITHUB_LIST_FRESH_MS,
  GITHUB_VISIBLE_REFRESH_MS,
  githubListQueryKey,
  githubRefreshInterval,
  issueListQuery,
  pullRequestListQuery,
  refreshGithubList,
} from './queries';

function listResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => listResponse({ repo: 'o/r', prs: [], issues: [], url }));
  vi.stubGlobal('fetch', fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared GitHub list cache', () => {
  it('keeps checkout lookup context in both the request and cache identity', async () => {
    await client.fetchQuery(pullRequestListQuery('sample', { repoPath: '/workspace/a' }));
    await client.fetchQuery(pullRequestListQuery('sample', { repoPath: '/workspace/b' }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/panel/prs?repo=sample&repoPath=%2Fworkspace%2Fa',
      '/api/panel/prs?repo=sample&repoPath=%2Fworkspace%2Fb',
    ]);
    await refreshGithubList(client, 'sample', 'prs', '/workspace/a');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/panel/prs?repo=sample&fresh=1&repoPath=%2Fworkspace%2Fa');
  });

  it('does not cancel another checkout lookup during an unscoped manual refresh', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const scoped = client.fetchQuery(pullRequestListQuery('sample', { repoPath: '/workspace/a' })).catch(() => null);
    await refreshGithubList(client, 'sample', 'prs');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    release(listResponse({ repo: 'owner/a', prs: [] }));
    expect(await scoped).toMatchObject({ repo: 'owner/a' });
  });

  it('serves many readers of one repository from one request', async () => {
    const readers = Array.from({ length: 10 }, (_, index) =>
      client.fetchQuery(pullRequestListQuery(index % 2 ? 'Owner/Repo' : 'owner/repo')),
    );
    await Promise.all(readers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/panel/prs?repo=owner%2Frepo');
  });

  it('keeps pull requests and issues for the same repository apart', async () => {
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    await client.fetchQuery(issueListQuery('owner/repo'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/panel/prs?repo=owner%2Frepo',
      '/api/panel/issues?repo=owner%2Frepo',
    ]);
  });

  it('reuses a list for two minutes, then fetches again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    vi.setSystemTime(Date.now() + GITHUB_LIST_FRESH_MS - 1_000);
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes every two minutes while visible and every five while hidden', () => {
    let hidden = false;
    const interval = githubRefreshInterval(() => hidden);
    expect(interval()).toBe(GITHUB_VISIBLE_REFRESH_MS);
    hidden = true;
    expect(interval()).toBe(GITHUB_HIDDEN_REFRESH_MS);
    expect(pullRequestListQuery('owner/repo').refetchIntervalInBackground).toBe(true);
  });

  it('polls a watched list on the hidden interval while the window is hidden', async () => {
    vi.useFakeTimers();
    const observer = new QueryObserver(client, pullRequestListQuery('owner/repo', { isHidden: () => true }));
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_VISIBLE_REFRESH_MS + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_HIDDEN_REFRESH_MS - GITHUB_VISIBLE_REFRESH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('lets a manual refresh cancel a background fetch and ask the server for fresh data', async () => {
    let releaseBackground: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      releaseBackground = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    fetchMock.mockImplementationOnce(async () => listResponse({ repo: 'owner/repo', issues: [{ number: 7 }] }));

    const background = client.fetchQuery(issueListQuery('owner/repo')).catch(() => null);
    await Promise.resolve();
    const manual = await refreshGithubList(client, 'owner/repo', 'issues');
    releaseBackground(listResponse({ repo: 'owner/repo', issues: [{ number: 1 }] }));
    await background;

    expect(fetchMock.mock.calls[1][0]).toBe('/api/panel/issues?repo=owner%2Frepo&fresh=1');
    expect(manual).toEqual({ repo: 'owner/repo', issues: [{ number: 7 }] });
    expect(client.getQueryData(githubListQueryKey('owner/repo', 'issues'))).toEqual(manual);
  });

  it('keeps the last list on screen when a refresh fails', async () => {
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    fetchMock.mockImplementationOnce(async () => new Response('rate limited', { status: 403 }));
    await expect(refreshGithubList(client, 'owner/repo', 'prs')).rejects.toThrow('403');
    expect(client.getQueryData(githubListQueryKey('owner/repo', 'prs'))).toMatchObject({ repo: 'o/r' });
  });

  it.each(['prs', 'issues'] as const)('retains the last %s list after a malformed manual refresh and recovers', async kind => {
    const options = kind === 'prs' ? pullRequestListQuery('owner/repo') : issueListQuery('owner/repo');
    await (kind === 'prs' ? client.fetchQuery(pullRequestListQuery('owner/repo')) : client.fetchQuery(issueListQuery('owner/repo')));
    const previous = client.getQueryData(options.queryKey);
    fetchMock.mockImplementationOnce(async () => listResponse({ [kind]: {} }));
    await expect(refreshGithubList(client, 'owner/repo', kind)).rejects.toThrow();
    expect(client.getQueryData(options.queryKey)).toBe(previous);
    expect(client.getQueryState(options.queryKey)?.status).toBe('error');
    fetchMock.mockImplementationOnce(async () => listResponse({ repo: 'owner/repo', [kind]: [] }));
    await expect(refreshGithubList(client, 'owner/repo', kind)).resolves.toEqual({ repo: 'owner/repo', [kind]: [] });
  });
});

it('never shortens a shared quota hold when a stale broker snapshot arrives later', async () => {
  const deadline = Date.now() + 600_000;
  client.setQueryData(['gh-quota', 'owner/repo'], deadline);
  fetchMock.mockImplementationOnce(async () => listResponse({ repo: 'owner/repo', issues: [], stale: true, error: 'Deferred', retryAt: deadline - 300_000 }));
  await refreshGithubList(client, 'owner/repo', 'issues');
  expect(client.getQueryData(['gh-quota', 'owner/repo'])).toBe(deadline);
});

it('keeps a long quota hold after the ordinary unobserved cache lifetime', async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementationOnce(async () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }));
  await expect(client.fetchQuery(pullRequestListQuery('owner/repo'))).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await expect(client.fetchQuery(issueListQuery('owner/repo'))).rejects.toThrow(/paused/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
