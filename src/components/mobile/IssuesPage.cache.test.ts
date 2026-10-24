// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ colors: { text: '#111', textSecondary: '#555', cardBg: '#fff' } }) }));
import IssuesPage from './IssuesPage';
import { PRReviewSheet } from './PRReviewSheet';
import { fetchMobileDiff } from '@/lib/mobile/diff-fetch';
import { getMobileGithubContext } from '@/lib/mobile/github-cache';
let root: Root; let host: HTMLDivElement; let fetchMock: ReturnType<typeof vi.fn>;
let failed: boolean;
async function render(count = 1, refreshSignal = 0) {
  await act(async () => root.render(createElement('div', {}, ...Array.from({ length: count }, (_, key) =>
    createElement(IssuesPage, { key, hideHeader: true, onBack() {}, refreshSignal })))));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('o8:mobile-ws-token', 'fixture-mobile-a');
  getMobileGithubContext().client.clear();
  sessionStorage.setItem('o8:registered-repos', JSON.stringify(['example/fixture']));
  failed = false;
  fetchMock = vi.fn(async (url: string) => url === '/api/panel/repos'
    ? Response.json({ repos: [{ remoteUrl: 'https://github.com/example/fixture.git' }] })
    : failed ? new Response(null, { status: 429, headers: { 'retry-after': '600' } })
    : Response.json(url.includes('/issues?') ? { issues: [{ number: 1, title: 'Known mobile issue', state: 'OPEN', labels: [] }] }
      : { prs: [{ number: 2, title: 'Known mobile PR', state: 'OPEN' }] }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });
it('shares one list read per repository across simultaneous mobile list views', async () => {
  await render(2);
  expect(host.textContent).toContain('Known mobile issue');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/issues?'))).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/prs?'))).toHaveLength(1);
});
it('keeps known mobile rows and their age after a rate-limited manual refresh', async () => {
  await render(); failed = true; await render(1, 1);
  expect(host.textContent).toContain('Known mobile issue');
  expect(host.textContent).toMatch(/saved|updated/i);
});
it('never reuses a previous mobile credential cache after the credential changes', async () => {
  await render(); expect(host.textContent).toContain('Known mobile issue');
  localStorage.setItem('o8:mobile-ws-token', 'fixture-mobile-b'); failed = true;
  await render(1, 1);
  expect(host.textContent).not.toContain('Known mobile issue');
  const last = fetchMock.mock.calls.filter(([url]) => String(url).includes('/issues?')).at(-1);
  expect(new Headers(last?.[1]?.headers).get('Authorization')).toBe('Bearer fixture-mobile-b');
});

it('rotates a mounted list without a parent render and never dispatches the old credential', async () => {
  await render();
  const start = fetchMock.mock.calls.length;
  localStorage.setItem('o8:mobile-ws-token', 'fixture-mobile-b'); failed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(host.textContent).not.toContain('Known mobile issue');
  const requests = fetchMock.mock.calls.slice(start).filter(([url]) => String(url).includes('/issues?'));
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) expect(new Headers(request[1]?.headers).get('Authorization')).toBe('Bearer fixture-mobile-b');
});

it('shares selected mobile review and diff reads within the mobile principal', async () => {
  fetchMock.mockImplementation(async (url: string) => Response.json(url.includes('/prs/')
    ? { pr: { files: [], additions: 0, deletions: 0, changedFiles: 0 } }
    : { number: 2, title: 'Review fixture', body: '', state: 'OPEN', author: 'fixture', branch: 'feature', baseBranch: 'main', files: [], checksStatus: 'unknown', mergeable: false, additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, url: '' }));
  await act(async () => root.render(createElement('div', {}, ...[1, 2].map(key => createElement(PRReviewSheet,
    { key, open: true, repoPath: 'example/fixture', prNumber: 2, onClose() {}, onViewDiff() {} })))));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(host.textContent).toContain('Review fixture');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/pr?'))).toHaveLength(1);
  await Promise.all([fetchMobileDiff({ kind: 'pr', repo: 'example/fixture', number: 2 }), fetchMobileDiff({ kind: 'pr', repo: 'example/fixture', number: 2 })]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/prs/'))).toHaveLength(1);
});
