import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ installationId: 84000 }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({
  readManagedGithubToken: () => ({ token: 'ci-detail-fixture', installationId: state.installationId, accountLogin: 'example' }),
}));
vi.mock('@/lib/github-broker/repo', () => ({
  DEFAULT_GITHUB_REPO: 'example/default',
  resolveRepoSlug: async (repo: string | null, fallback: string) => repo ?? fallback,
  normalizeRepoSlug: (repo: string) => repo,
}));

import { GET } from './route';

const now = Date.parse('2026-10-22T12:30:00.250Z');
const request = (repo = 'example/ci', id = '11') => GET(new Request(`http://fixture.invalid/api/panel/ci/${id}?repo=${repo}`), {
  params: Promise.resolve({ id }),
});
const success = (input: string | URL | Request) => String(input).includes('/jobs?')
  ? Response.json({ jobs: [] })
  : Response.json({ id: 11, display_title: 'Fixture run', status: 'completed', conclusion: 'success', pull_requests: [] });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); state.installationId++;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('preserves the real broker primary-limit reset as 429 and a rounded-up Retry-After', async () => {
  const reset = Math.floor(now / 1000) + 120;
  const upstream = vi.fn(async () => Response.json({ message: 'Fixture primary rate limit' }, {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  }));
  vi.stubGlobal('fetch', upstream);
  const response = await request();
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('120');
  expect(await response.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.' });
  expect(upstream).toHaveBeenCalledTimes(2);
});

it.each([403, 429])('preserves a %i retry window from the real broker as a positive whole-second delay', async status => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/jobs?')
    ? Response.json({ jobs: [] }) : Response.json({ message: 'Fixture secondary rate limit' }, {
      status, headers: { 'retry-after': '90.25' },
    })));
  const response = await request();
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('91');
  expect(await response.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.' });
});

it('preserves an HTTP-date retry window', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/jobs?')
    ? Response.json({ jobs: [] }) : Response.json({ message: 'Fixture secondary rate limit' }, {
      status: 429, headers: { 'retry-after': new Date(now + 90_000).toUTCString() },
    })));
  const response = await request(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('90');
});

it('keeps repeated reads paused without upstream work and recovers after the reset deadline', async () => {
  const reset = Math.floor(now / 1000) + 120;
  const upstream = vi.fn(async (_input: string | URL | Request) => Response.json({ message: 'Fixture quota' }, {
    status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  }));
  vi.stubGlobal('fetch', upstream);
  expect((await request()).status).toBe(429); const before = upstream.mock.calls.length;
  vi.setSystemTime(now + 30_000);
  const paused = await request('example/another-repo');
  expect(paused.status).toBe(429); expect(paused.headers.get('retry-after')).toBe('90');
  expect(upstream).toHaveBeenCalledTimes(before);
  vi.setSystemTime(now + 120_001); upstream.mockImplementation(async input => success(input));
  const recovered = await request(); expect(recovered.status).toBe(200); expect(recovered.headers.get('retry-after')).toBeNull();
  expect(await recovered.json()).toMatchObject({ repo: 'example/ci', run: { databaseId: 11, displayTitle: 'Fixture run' } });
  expect(upstream).toHaveBeenCalledTimes(before + 2);
});

it('keeps ordinary permission refusals as failures without a quota retry header', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture permission refusal' }, { status: 403 })));
  const response = await request(); expect(response.status).toBe(500); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('Fixture permission refusal') });
});

it('keeps transport failures as errors without inventing a quota pause', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fixture transport unavailable'); }));
  const response = await request(); expect(response.status).toBe(500); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toEqual({ error: 'Fixture transport unavailable' });
});

it('returns successful run detail and rejects an invalid selection before upstream reads', async () => {
  const upstream = vi.fn(async (input: string | URL | Request) => success(input)); vi.stubGlobal('fetch', upstream);
  const invalid = await request('example/ci', 'invalid'); expect(invalid.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  const response = await request(); expect(response.status).toBe(200); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toMatchObject({ repo: 'example/ci', run: { databaseId: 11 } });
});
