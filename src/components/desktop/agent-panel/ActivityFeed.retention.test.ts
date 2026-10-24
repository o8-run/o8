// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { ActivityFeed } from './ActivityFeed';
import { useBranchPr } from '../useBranchPr';

const streams = ['issues', 'prs', 'ci', 'commits'] as const;
type Stream = typeof streams[number];
const repoA = 'example/alpha';
const repoB = 'example/beta';
const date = '2026-10-22T12:00:00Z';
const payload = (stream: Stream, tag: string) => {
  switch (stream) {
    case 'issues': return { issues: [{ number: 1, title: `${tag} issue`, state: 'OPEN', createdAt: date, labels: [] }] };
    case 'prs': return { prs: [{ number: 2, title: `${tag} pull`, state: 'OPEN', createdAt: date, headRefName: 'feature', additions: 7 }] };
    case 'ci': return { runs: [{ databaseId: 3, displayTitle: `${tag} check`, createdAt: date, conclusion: 'success' }] };
    case 'commits': return { commits: [{ hash: 'abc123', message: `${tag} commit`, date }] };
  }
};
const empty = (stream: Stream) => ({ [stream === 'ci' ? 'runs' : stream]: [] });
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let registered: string[];
let reply: (stream: Stream, repo: string, init?: RequestInit) => Response | Promise<Response>;
const render = async (activeRepo: string | null = repoA, refreshKey = 0) => {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(ActivityFeed, { events: [], commits: [], agents: [], activeRepo, refreshKey }))));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const refresh = async () => {
  await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url) !== '/api/panel/repos');
const expectRows = (tag: string) => {
  for (const title of ['issue', 'pull', 'check', 'commit']) expect(host.textContent).toContain(`${tag} ${title}`);
};
const selectFilter = (label: string) => act(async () => {
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
});
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:30:00Z'));
  registered = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reply = (stream, repo) => Response.json(payload(stream, repo));
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel/repos') return Promise.resolve(Response.json({ repos: registered.map((repo) => ({ remoteUrl: `https://github.com/${repo}.git` })) }));
    const url = new URL(input, 'http://localhost');
    const stream = url.pathname.split('/').pop() as Stream;
    if (!streams.includes(stream)) throw new Error(`Unexpected read: ${input}`);
    return Promise.resolve(reply(stream, url.searchParams.get('repo')!, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ActivityFeed retained stream snapshots', () => {
  it('shares repository lists with five actual branch-marker consumers', async () => {
    function BranchMarker() { const pr = useBranchPr(repoA, 'feature'); return createElement('span', {}, `Branch PR ${pr?.number}`); }
    await act(async () => root.render(createElement(QueryClientProvider, { client },
      createElement(ActivityFeed, { events: [], commits: [], agents: [], activeRepo: repoA }),
      ...Array.from({ length: 5 }, (_, key) => createElement(BranchMarker, { key })))));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(host.textContent?.match(/Branch PR 2/g)).toHaveLength(5);
    expect(reads().filter(([url]) => String(url).includes('/prs?'))).toHaveLength(1);
    expect(reads()).toHaveLength(4);
  });

  it('refreshes visible activity every two minutes and switches to five when hidden', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(reads()).toHaveLength(8);
    hidden.mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
    expect(reads()).toHaveLength(8);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(reads()).toHaveLength(12);
  });

  it('renders all four real streams and preserves filtering', async () => {
    await render(); expectRows(repoA);
    await selectFilter('Issues 1');
    expect(host.textContent).toContain(`${repoA} issue`);
    expect(host.textContent).not.toContain(`${repoA} pull`);
    await selectFilter('All'); expectRows(repoA);
  });

  it.each([403, 429])('retains rows through a %i response, lifecycle and fallback backoff, then recovers', async (status) => {
    await render();
    reply = () => new Response(null, { status, headers: { 'retry-after': '600' } });
    await refresh(); expectRows(repoA);
    expect(host.textContent).toContain('GitHub API paused');
    const before = reads().length;
    await refresh();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expectRows(repoA); expect(reads()).toHaveLength(before);
    reply = (stream) => Response.json(payload(stream, 'recovered'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    await refresh();
    expectRows('recovered');
    expect(host.textContent).not.toContain('GitHub API paused');
  });

  it('retains failed streams while publishing successful partial results', async () => {
    await render();
    reply = (stream) => stream === 'issues' || stream === 'ci'
      ? new Response(null, { status: 503 }) : Response.json(payload(stream, 'fresh'));
    await refresh();
    expect(host.textContent).toContain(`${repoA} issue`);
    expect(host.textContent).toContain(`${repoA} check`);
    expect(host.textContent).toContain('fresh pull');
    expect(host.textContent).toContain('fresh commit');
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it.each(['network', 'json', 'payload'] as const)('isolates a %s failure to its stream', async (failure) => {
    await render();
    reply = (stream) => {
      if (stream !== 'issues') return Response.json(payload(stream, 'fresh'));
      if (failure === 'network') return Promise.reject(new Error('offline'));
      if (failure === 'json') return new Response('not json');
      return Response.json({ error: 'temporarily unavailable' });
    };
    await refresh();
    expect(host.textContent).toContain(`${repoA} issue`);
    expect(host.textContent).toContain('fresh pull');
    expect(host.textContent).toContain('fresh check');
    expect(host.textContent).toContain('fresh commit');
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it('accepts successful empty streams after failures', async () => {
    await render();
    reply = () => new Response(null, { status: 503 });
    await refresh(); expectRows(repoA);
    reply = (stream) => Response.json(stream === 'issues' ? empty(stream) : payload(stream, 'fresh'));
    await refresh();
    expect(host.textContent).not.toContain(`${repoA} issue`);
    expect(host.querySelector('[aria-label="Issues"]')).not.toBeNull();
    expect(host.textContent).toContain('fresh pull');
  });

  it('publishes successful streams from a rate-limited batch and retains them during the pause', async () => {
    await render();
    reply = (stream) => stream === 'issues' ? new Response(null, { status: 429 }) : Response.json(payload(stream, 'fresh'));
    await refresh();
    expect(host.textContent).toContain(`${repoA} issue`);
    for (const title of ['pull', 'check', 'commit']) expect(host.textContent).toContain(`fresh ${title}`);
    const before = reads().length;
    await refresh(); expect(reads()).toHaveLength(before);
    for (const title of ['pull', 'check', 'commit']) expect(host.textContent).toContain(`fresh ${title}`);
  });

  it('does not manufacture rows for an initially failed stream', async () => {
    reply = (stream) => stream === 'issues' ? new Response(null, { status: 503 }) : Response.json(payload(stream, 'fresh'));
    await render();
    expect(host.querySelector('[aria-label="Issues"]')).not.toBeNull();
    expect(host.textContent).toContain('fresh pull');
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it('uses the reset header and does not resume before its deadline', async () => {
    await render();
    const reset = Math.floor(Date.now() / 1000) + 120;
    reply = () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': String(reset) } });
    await refresh();
    const before = reads().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
    await refresh(); expect(reads()).toHaveLength(before); expectRows(repoA);
    reply = (stream) => Response.json(payload(stream, 'recovered'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => {});
    if (!host.textContent?.includes('recovered issue')) await refresh();
    expectRows('recovered');
  });

  it.each([
    { name: 'long HTTP-date', status: 403, seconds: 900, retry: 'date' },
    { name: 'short HTTP-date', status: 429, seconds: 90, retry: 'date' },
    { name: 'later reset than numeric retry', status: 429, seconds: 180, retry: '60', reset: 180 },
    { name: 'later reset than HTTP-date', status: 403, seconds: 180, retry: 'date', retrySeconds: 60, reset: 180 },
    { name: 'later numeric retry than reset', status: 429, seconds: 180, retry: '180', reset: 60 },
    { name: 'short reset', status: 429, seconds: 30, reset: 30 },
    { name: 'malformed headers fallback', status: 429, seconds: 60, retry: 'invalid', reset: NaN },
    { name: 'exhausted quota with expired headers', status: 403, seconds: 60, retry: 'expired', reset: -60, remaining: '0' },
    { name: 'capped numeric retry', status: 429, seconds: 86_400, retry: '172800' },
    { name: 'capped HTTP-date retry', status: 403, seconds: 86_400, retry: 'date', retrySeconds: 172_800 },
    { name: 'capped quota reset', status: 403, seconds: 86_400, reset: 172_800, remaining: '0' },
  ])('honors $name across automatic lifecycle and fallback polling', async ({ status, seconds, retry, retrySeconds, reset, remaining }) => {
    await render(); const now = Date.now();
    const headers: Record<string, string> = {};
    if (retry) headers['retry-after'] = retry === 'date' ? new Date(now + (retrySeconds ?? seconds) * 1000).toUTCString()
      : retry === 'expired' ? new Date(now - 60_000).toUTCString() : retry;
    if (reset !== undefined) headers['x-ratelimit-reset'] = String(now / 1000 + reset);
    if (remaining !== undefined) headers['x-ratelimit-remaining'] = remaining;
    reply = () => new Response(null, { status, headers });
    await refresh(); expectRows(repoA); expect(host.textContent).toContain('GitHub API paused');
    const before = reads().length;
    reply = stream => Response.json(payload(stream, 'deadline recovery'));
    await act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000 - 1); });
    await refresh();
    expect(reads()).toHaveLength(before); expectRows(repoA);
    expect(host.textContent).toContain('GitHub API paused');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await refresh();
    expect(reads().length).toBeGreaterThanOrEqual(before + 4);
    expect(reads().length).toBeLessThanOrEqual(before + 8);
    expectRows('deadline recovery');
    expect(host.textContent).not.toContain('GitHub API paused');
  });

  it.each(['permission', 'reset without exhaustion', 'expired retry'] as const)(
    'keeps a %s 403 retryable without a quota pause', async (kind) => {
      await render();
      const headers: Record<string, string> = kind === 'reset without exhaustion'
        ? { 'x-ratelimit-reset': String(Date.now() / 1000 + 3600), 'x-ratelimit-remaining': '5' }
        : kind === 'expired retry' ? { 'retry-after': new Date(Date.now() - 60_000).toUTCString() } : {};
      reply = stream => stream === 'issues' ? new Response(null, { status: 403, headers })
        : Response.json(payload(stream, 'fresh'));
      await refresh();
      expect(host.textContent).toContain(`${repoA} issue`);
      for (const title of ['pull', 'check', 'commit']) expect(host.textContent).toContain(`fresh ${title}`);
      expect(host.textContent).toContain('GitHub sync delayed');
      expect(host.textContent).not.toContain('GitHub API paused');
      const before = reads().length;
      reply = stream => Response.json(payload(stream, 'permission recovery'));
      await render(repoA, 1);
      expect(reads()).toHaveLength(before + 4);
      expectRows('permission recovery');
    },
  );

  it('hides the old scope while loading and ignores its late rate-limit response', async () => {
    await render();
    const late = deferred();
    reply = (stream, repo) => repo === repoA ? late.promise : Response.json(payload(stream, repo));
    await refresh();
    const oldReads = reads().slice(-4);
    const next = deferred();
    reply = () => next.promise.then((response) => response.clone());
    await render(repoB);
    expect(host.textContent).not.toContain(`${repoA} issue`);
    await act(async () => { late.resolve(new Response(null, { status: 429, headers: { 'retry-after': '600' } })); });
    await act(async () => { next.resolve(Response.json({ issues: [], prs: [], runs: [], commits: [] })); });
    reply = (stream) => Response.json(payload(stream, repoB));
    await refresh(); expectRows(repoB);
    expect(host.textContent).not.toContain(`${repoA} issue`);
    expect(oldReads.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('ignores a superseded refresh even if the transport completes after abort', async () => {
    await render();
    const late = deferred();
    reply = () => late.promise.then((response) => response.clone());
    await refresh();
    reply = (stream) => Response.json(payload(stream, 'newest'));
    await refresh(); expectRows('newest');
    await act(async () => { late.resolve(Response.json({ issues: [], prs: [], runs: [], commits: [] })); });
    expectRows('newest');
  });

  it('keeps cached repositories isolated during all-repository partial failures and scope switches', async () => {
    registered = [repoA, repoB];
    await render(null); expectRows(repoA); expectRows(repoB);
    expect(host.textContent).toContain(`[alpha] ${repoA} commit`);
    reply = (stream, repo) => repo === repoA ? new Response(null, { status: 503 }) : Response.json(payload(stream, 'fresh beta'));
    await refresh(); expectRows(repoA); expectRows('fresh beta');
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
    await act(async () => {
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'alphaalpha')!.click();
    });
    expectRows(repoA);
    expect(host.textContent).not.toContain('[alpha]');
    expect(host.textContent).not.toContain('fresh beta issue');
    reply = () => new Response(null, { status: 429 });
    await refresh();
    const before = reads().length;
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
    await act(async () => {
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'GitHubregistered')!.click();
    });
    expect(reads()).toHaveLength(before);
    expectRows(repoA); expectRows('fresh beta');
    expect(host.textContent).toContain(`[alpha] ${repoA} commit`);
    expect(host.textContent).not.toContain('[alpha] [alpha]');
  });

  it('refreshes on refreshKey and aborts outstanding reads on unmount', async () => {
    await render();
    const before = reads().length;
    await render(repoA, 1); expect(reads()).toHaveLength(before + 4);
    const pending = deferred(); reply = () => pending.promise;
    await refresh();
    const outstanding = reads().slice(-4);
    await act(async () => root.unmount());
    expect(outstanding.every(([, init]) => init?.signal?.aborted)).toBe(true);
    root = createRoot(host);
    await act(async () => { pending.resolve(Response.json({})); });
  });
});

it('delivers an explicit refresh during a quota hold instead of dropping the click', async () => {
  await render(); reply = () => new Response(null, { status: 429, headers: { 'retry-after': '600' } });
  await refresh(); const before = reads().length;
  reply = stream => Response.json(payload(stream, 'manual recovery'));
  await render(repoA, 1);
  expect(reads()).toHaveLength(before + 4); expectRows('manual recovery');
  for (const [url] of reads().slice(before)) expect(String(url)).toContain('fresh=1');
});

it.each([null, { number: 2, title: 'Invalid replacement', statusCheckRollup: {} }])('retains Activity rows after a malformed shared PR row %j', async row => {
  await render(); reply = stream => stream === 'prs' ? Response.json({ prs: [row] }) : Response.json(payload(stream, repoA));
  await refresh(); expectRows(repoA); expect(host.textContent).toContain('GitHub sync delayed');
});
