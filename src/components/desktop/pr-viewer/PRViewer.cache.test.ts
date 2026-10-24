// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PRViewer } from './PRViewer';

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const snapshot = (title = 'Fixture change', state = 'OPEN', number = 7) => Response.json({ pr: {
  number, title, state, body: '', author: { login: 'fixture' }, headRefName: 'feature', baseRefName: 'main',
  additions: 1, deletions: 0, changedFiles: 0, createdAt: '2026-10-01T00:00:00Z', mergedAt: null,
  closedAt: null, mergedBy: null, labels: [], reviews: [], files: [], statusCheckRollup: [],
  reviewComments: [], issueComments: [], diffStat: '', url: '',
} });
const reads = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/panel/prs/') && init?.method !== 'POST');
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function render(count = 1, repo: string | undefined = 'org/sample', number = 7, active = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(PRViewer, { key, repo, prNumber: number, active })),
  ))); await settle(); await settle();
}
async function comment(text = 'Fixture comment') {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[name="reviewComment"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle(); await settle();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot());
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one detail read across five actual PR viewers', async () => {
  await render(5); expect(host.textContent?.match(/#7 Fixture change/g)).toHaveLength(5);
  expect(reads()).toHaveLength(1);
});
it('reuses a fresh open PR snapshot on remount', async () => {
  await render(); await render(0); await render();
  expect(host.textContent).toContain('#7 Fixture change'); expect(reads()).toHaveLength(1);
});
it('refreshes a stale open snapshot on remount without adding interval polling', async () => {
  await render(); await settle(3 * 60_000); expect(reads()).toHaveLength(1);
  await render(0); fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot('Updated change'));
  await render(); expect(reads()).toHaveLength(2); expect(host.textContent).toContain('#7 Updated change');
});
it.each(['CLOSED', 'MERGED'])('reuses a retained %s snapshot past the open freshness window', async state => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot('Terminal change', state));
  await render(); await render(0); await settle(3 * 60_000); await render();
  expect(host.textContent).toContain('#7 Terminal change'); expect(reads()).toHaveLength(1);
  expect(host.querySelector('input[name="reviewComment"]')).toBeNull();
});
it('isolates repository and PR number changes from delayed replies', async () => {
  let release!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/repos' ? Promise.resolve(Response.json({ repos: [] }))
    : url.includes('org%2Fsample') ? new Promise<Response>(resolve => { release = () => resolve(snapshot()); })
    : Promise.resolve(snapshot('Other change', 'OPEN', 9)));
  await render(); await render(1, 'org/other', 9);
  expect(host.textContent).toContain('#9 Other change');
  await act(async () => release()); await settle();
  expect(host.textContent).not.toContain('#7 Fixture change');
  expect(reads().map(([url]) => url)).toEqual(['/api/panel/prs/7?repo=org%2Fsample', '/api/panel/prs/9?repo=org%2Fother']);
});
it('retains the known viewer snapshot after a failed refresh', async () => {
  await render(); fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('#7 Fixture change');
  expect(host.textContent).not.toContain('Failed to load PR');
});
it('retries an initial failed read through the actual Retry button', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] })
    : new Response('unavailable', { status: 503 }));
  await render(); expect(host.textContent).toContain('Failed to load PR');
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot());
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
  await act(async () => retry.click()); await settle(); await settle();
  expect(host.textContent).toContain('#7 Fixture change'); expect(reads()).toHaveLength(2);
});
it('refreshes a fresh snapshot after a comment and updates every observer', async () => {
  await render(2);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'commented' }) : url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot('After comment'));
  await comment();
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe('/api/panel/prs/7');
  expect(JSON.parse(writes()[0][1].body)).toEqual({ action: 'comment', repo: 'org/sample', comment: 'Fixture comment' });
  expect(host.textContent?.match(/#7 After comment/g)).toHaveLength(2); expect(reads()).toHaveLength(2);
});
it('keeps a delayed post-action refresh in its original repository cache', async () => {
  await render(); let finishWrite!: () => void;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finishWrite = () => resolve(Response.json({ action: 'commented' })); })
    : Promise.resolve(url === '/api/panel/repos' ? Response.json({ repos: [] })
      : url.includes('org%2Fother') ? snapshot('Other change') : snapshot('After old comment')));
  await comment(); await render(1, 'org/other');
  await act(async () => finishWrite()); await settle(); await settle();
  expect(host.textContent).toContain('#7 Other change'); expect(host.textContent).not.toContain('After old comment');
  expect(reads().at(-1)?.[0]).toBe('/api/panel/prs/7?repo=org%2Fsample');
  await render(1, 'org/sample'); expect(host.textContent).toContain('#7 After old comment');
  expect(reads()).toHaveLength(3);
});
it('prevents an older refresh from overwriting a post-action snapshot', async () => {
  await render(); let release!: () => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release = () => resolve(snapshot('Old refresh')); }));
  let pending!: Promise<void>;
  await act(async () => { pending = client.invalidateQueries(); });
  const oldRead = reads().at(-1);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'commented' }) : snapshot('After comment'));
  await comment(); expect(host.textContent).toContain('#7 After comment');
  expect(oldRead?.[1]?.signal.aborted).toBe(true);
  await act(async () => { release(); await pending; }); await settle();
  expect(host.textContent).toContain('#7 After comment'); expect(host.textContent).not.toContain('Old refresh');
});
it('keeps the default repository separate from an explicit repository', async () => {
  await render();
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(PRViewer, { prNumber: 7 }))));
  await settle(); await settle(); expect(reads()).toHaveLength(2);
  expect(reads().at(-1)?.[0]).toBe('/api/panel/prs/7');
});
it('does not refresh after a refused action', async () => {
  await render(); fetchMock.mockImplementation(async () => Response.json({ error: 'Fixture refusal' }, { status: 409 }));
  await comment(); expect(host.textContent).toContain('Fixture refusal');
  expect(host.textContent).toContain('#7 Fixture change'); expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(1);
});
it('preserves the write acknowledgment when its refresh fails and retries on remount', async () => {
  await render();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'commented' }) : new Response('unavailable', { status: 503 }));
  await comment(); expect(host.textContent).toContain('Comment posted');
  expect(host.textContent).toContain('#7 Fixture change'); expect(host.textContent).toContain('refresh failed');
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot('Recovered after comment'));
  await render(0); await render(); expect(host.textContent).toContain('#7 Recovered after comment');
  expect(reads()).toHaveLength(3); expect(writes()).toHaveLength(1);
});

it('polls only the selected checks view and stops on hide, overview, or terminal state', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await render(); await settle(30_000); expect(reads()).toHaveLength(1);
  const select = async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes(label))!.click()); await settle(); };
  await select('Checks'); await settle(30_000); expect(reads()).toHaveLength(2);
  hidden.mockReturnValue(true); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await settle(60_000); expect(reads()).toHaveLength(2);
  hidden.mockReturnValue(false); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await select('Overview'); await settle(60_000); expect(reads()).toHaveLength(2);
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot('Merged change', 'MERGED'));
  await select('Checks'); await settle(30_000); expect(reads()).toHaveLength(3);
  await settle(180_000); expect(reads()).toHaveLength(3);
});

it('delivers the post-action refresh during a shared repository hold', async () => {
  await render(); client.setQueryData(['gh-quota', 'org/sample'], Date.now() + 600_000);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'commented' }) : snapshot('Manual held refresh'));
  await comment();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('Manual held refresh');
});

it('shares the selected review-thread read across simultaneous full viewers', async () => {
  fetchMock.mockImplementation(async (url: string) => url.includes('/review/threads?') ? Response.json({ threads: [] })
    : url === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot());
  await render(2);
  await act(async () => { for (const button of host.querySelectorAll('button')) if (button.textContent?.startsWith('Threads')) button.click(); });
  await settle(); await settle();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/review/threads?'))).toHaveLength(1);
});

it('stops checks polling while the Canvas keeps the PR tab mounted but inactive', async () => {
  await render();
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Checks'))!.click());
  await settle(30_000); expect(reads()).toHaveLength(2);
  await render(1, 'org/sample', 7, false); await settle(120_000); expect(reads()).toHaveLength(2);
  await render(); await settle(); const before = reads().length;
  await settle(30_000); expect(reads()).toHaveLength(before + 1);
});
