import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ installationId: 86700 }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({
  readManagedGithubToken: () => ({ token: 'issue-detail-fixture', installationId: state.installationId, accountLogin: 'example' }),
}));
vi.mock('@/lib/github-broker/repo', () => ({
  DEFAULT_GITHUB_REPO: 'example/default',
  resolveRepoSlug: async (repo: string | null, fallback: string) => repo ?? fallback,
  normalizeRepoSlug: (repo: string) => repo,
}));

import { GET } from './route';

const now = Date.parse('2026-10-23T12:30:00.250Z');
const read = (repo = 'example/issue', number = '7') => GET(new NextRequest(`http://fixture.invalid/api/panel/issues/${number}?repo=${repo}`), {
  params: Promise.resolve({ number }),
});
const success = () => Response.json({ number: 7, title: 'Known issue', body: 'Known body', state: 'open',
  labels: [{ name: 'bug', color: 'abcdef' }], user: { login: 'fixture' }, comments: 2,
  html_url: 'https://github.com/example/issue/issues/7',
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); state.installationId++; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([1, 120])('preserves the real broker primary-limit reset of %i seconds as 429 with positive Retry-After', async seconds => {
  const upstream = vi.fn(async () => Response.json({ message: 'Fixture primary limit' }, { status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + seconds) },
  }));
  vi.stubGlobal('fetch', upstream);
  const response = await read();
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe(String(seconds));
  expect(await response.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.', repo: 'example/issue' });
  expect(upstream).toHaveBeenCalledTimes(1);
});

it.each([403, 429])('rounds up the real broker retry window from upstream %i', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture secondary limit' }, {
    status, headers: { 'retry-after': '90.25' },
  })));
  const response = await read(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('91');
  expect(await response.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.', repo: 'example/issue' });
});

it('preserves an HTTP-date deadline from the real broker', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture secondary limit' }, {
    status: 429, headers: { 'retry-after': new Date(now + 90_000).toUTCString() },
  })));
  const response = await read(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('90');
});

it('keeps repeated reads paused without upstream work and recovers after the deadline', async () => {
  const upstream = vi.fn(async () => Response.json({ message: 'Fixture quota' }, { status: 429, headers: { 'retry-after': '90' } }));
  vi.stubGlobal('fetch', upstream);
  expect((await read()).status).toBe(429); expect(upstream).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 30_000);
  const paused = await read('example/other'); expect(paused.status).toBe(429); expect(paused.headers.get('retry-after')).toBe('60');
  expect(await paused.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.', repo: 'example/other' });
  expect(upstream).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 90_001); upstream.mockImplementation(async () => success());
  const recovered = await read(); expect(recovered.status).toBe(200); expect(recovered.headers.get('retry-after')).toBeNull();
  expect(await recovered.json()).toMatchObject({ repo: 'example/issue', issue: { number: 7, title: 'Known issue', labels: [{ name: 'bug', color: 'abcdef' }] } });
  expect(upstream).toHaveBeenCalledTimes(4); // The refused read, then the issue, comments and timeline.
});

it('keeps ordinary permission refusals on the existing error contract without a quota header', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture permission refusal' }, { status: 403 })));
  const response = await read(); expect(response.status).toBe(404); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('Fixture permission refusal'), repo: 'example/issue' });
});

it('keeps transport failures on the existing error contract without inventing a pause', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fixture transport unavailable'); }));
  const response = await read(); expect(response.status).toBe(404); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toEqual({ error: 'Fixture transport unavailable', repo: 'example/issue' });
});

it('rejects invalid selection before upstream reads and preserves successful issue detail', async () => {
  const upstream = vi.fn(async () => success()); vi.stubGlobal('fetch', upstream);
  expect((await read('example/issue', 'invalid')).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  const response = await read(); expect(response.status).toBe(200); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toMatchObject({ repo: 'example/issue', issue: { number: 7, title: 'Known issue', body: 'Known body' } });
  expect(upstream).toHaveBeenCalledTimes(3); // The issue, comments and timeline.
});

it('carries comments and linked pull requests, and still opens when they cannot be read', async () => {
  const upstream = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/comments')) {
      return Response.json([{ id: 1, body: 'A reply', user: { login: 'reader' }, created_at: '2026-10-23T00:00:00Z' }]);
    }
    if (path.endsWith('/timeline')) {
      return Response.json([{ event: 'cross-referenced', source: { issue: {
        number: 12, title: 'The fix', state: 'closed', html_url: 'https://github.com/example/issue/pull/12',
        pull_request: { merged_at: '2026-10-23T01:00:00Z' },
      } } }, { event: 'labeled' }]);
    }
    return success();
  });
  vi.stubGlobal('fetch', upstream);
  const { issue } = await (await read()).json();
  expect(issue.discussion).toMatchObject([{ author: 'reader', body: 'A reply' }]);
  expect(issue.linked).toEqual([{
    kind: 'pull', number: 12, title: 'The fix', state: 'merged',
    url: 'https://github.com/example/issue/pull/12', repo: 'example/issue',
  }]);
  expect(issue.discussionIncomplete).toBe(false);

  upstream.mockImplementation(async (input: RequestInfo | URL) => (
    new URL(String(input)).pathname.endsWith('/7') ? success() : new Response('{}', { status: 502 })
  ));
  const partial = await read();
  expect(partial.status).toBe(200);
  expect((await partial.json()).issue).toMatchObject({ discussion: [], linked: [], discussionIncomplete: true });
});
