import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ installationId: 84900 }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({
  readManagedGithubToken: () => ({ token: 'ci-list-fixture', installationId: state.installationId, accountLogin: 'example' }),
}));
vi.mock('@/lib/github-broker/repo', () => ({
  DEFAULT_GITHUB_REPO: 'example/default',
  resolveRepoSlug: async (repo: string | null, fallback: string) => repo ?? fallback,
  normalizeRepoSlug: (repo: string) => repo,
}));

import { invalidate } from '@/lib/github/cache';
import { GET } from './route';

const now = Date.parse('2026-10-22T12:30:00.250Z');
const read = (repo = 'example/list') => GET(new Request(`http://fixture.invalid/api/panel/ci?repo=${repo}`));
const success = () => Response.json({ workflow_runs: [{ id: 11, display_title: 'Known run', status: 'completed', conclusion: 'success' }] });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); state.installationId++;
  invalidate('ci:example/'); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { invalidate('ci:example/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('preserves the primary-limit deadline through the real broker and GET', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture quota' }, { status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 120) },
  })));
  const response = await read();
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('120');
  expect(await response.json()).toEqual({ error: 'GitHub asked o8 to wait before refreshing.', runs: [], repo: 'example/list' });
});

it.each([403, 429])('rounds up the broker retry delay from an upstream %i', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture quota' }, { status, headers: { 'retry-after': '90.25' } })));
  const response = await read(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('91');
});

it('preserves an HTTP-date deadline', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture quota' }, { status: 429,
    headers: { 'retry-after': new Date(now + 90_000).toUTCString() },
  })));
  const response = await read(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('90');
});

it('refuses repeated reads without upstream work, then recovers after the deadline', async () => {
  const upstream = vi.fn(async () => Response.json({ message: 'Fixture quota' }, { status: 429, headers: { 'retry-after': '90' } }));
  vi.stubGlobal('fetch', upstream);
  expect((await read()).status).toBe(429); expect(upstream).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 30_000);
  const paused = await read(); expect(paused.status).toBe(429); expect(paused.headers.get('retry-after')).toBe('60');
  expect(upstream).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 90_001); upstream.mockImplementation(async () => success());
  const recovered = await read(); expect(recovered.status).toBe(200); expect(recovered.headers.get('retry-after')).toBeNull();
  expect(await recovered.json()).toMatchObject({ runs: [{ databaseId: 11, displayTitle: 'Known run' }] });
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('keeps an ordinary permission refusal on the existing error contract without a pause', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Fixture permission refusal' }, { status: 403 })));
  const response = await read(); expect(response.status).toBe(200); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toEqual({ error: 'Unable to read CI runs.', runs: [], repo: 'example/list' });
});

it('keeps a transport failure on the existing error contract', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Fixture unavailable'); }));
  const response = await read(); expect(response.status).toBe(200); expect(response.headers.get('retry-after')).toBeNull();
  expect(await response.json()).toMatchObject({ error: 'Unable to read CI runs.', runs: [] });
});

it('rejects invalid selection and preserves successful cached lists without more upstream reads', async () => {
  const upstream = vi.fn(async () => success()); vi.stubGlobal('fetch', upstream);
  expect((await read('invalid')).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  const first = await read(); const cached = await read(); expect(first.status).toBe(200); expect(cached.status).toBe(200);
  expect(await cached.json()).toEqual(await first.json()); expect(upstream).toHaveBeenCalledTimes(1);
});
