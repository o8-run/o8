// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestListItem } from '@/lib/github-broker/pull-request-list.types';
import { RepositoryPullRequests } from './RepositoryPullRequests';

const sample = (number: number, author = 'operator'): PullRequestListItem => ({ number, title: `Change ${number}`, author, avatarUrl: 'https://avatars.githubusercontent.com/u/1', additions: 27, deletions: 4, checks: 'success', requestedReviewers: ['operator'], draft: false, state: 'open', headRefName: 'feature', baseRefName: 'main', createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-07T12:00:00Z', url: `https://github.com/example/repo/pull/${number}`, labels: [number % 2 ? 'ui' : 'bug'] });
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;
const settle = async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
const render = async (active = true, repoPath = '/workspace') => {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(RepositoryPullRequests, { repoPath, active }))));
  await settle();
};
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label^="PR #"]'));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(async (input: string) => input === '/api/panel/github-status'
    ? Response.json({ authenticated: true, username: 'operator' })
    : Response.json({ repo: 'example/repo', prs: Array.from({ length: 23 }, (_, index) => sample(index + 1, index < 20 ? 'operator' : 'other')), nextPage: null }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe('workspace PR list', () => {
  it('shows branch dependencies through the layout control and preserves selection when returning', async () => {
    fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status'
      ? Response.json({ authenticated: true, username: 'operator' })
      : Response.json({ repo: 'example/repo', prs: [{ ...sample(2), headRefName: 'follow-up', baseRefName: 'foundation', headRepoFullName: 'example/repo' }, { ...sample(1), headRefName: 'foundation', headRepoFullName: 'example/repo' }], nextPage: null }));
    await render();
    await act(async () => button('Pull request layout').click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((item) => item.textContent === 'Branch stacks')!.click());
    expect(rows().map((row) => row.dataset.prNumber)).toEqual(['1', '2']);
    expect(host.textContent).toContain('Inferred dependency on #1');
    await act(async () => rows()[1].click());
    await act(async () => button('Pull request layout').click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((item) => item.textContent === 'By author')!.click());
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('data-pr-number')).toBe('2');
  });
  it('refreshes only the matching repository after a write while keeping filters, selection and scroll', async () => {
    await render();
    await act(async () => button('Pull request involvement').click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((item) => item.textContent === 'Authored')!.click());
    await act(async () => rows()[0].click());
    const selected = rows()[0].getAttribute('aria-label'); const scroller = host.querySelector('section')!.lastElementChild!; scroller.scrollTop = 150;
    const before = fetchMock.mock.calls.length;
    await act(async () => window.dispatchEvent(new CustomEvent('o8:pr-updated', { detail: { repo: 'example/other', number: 1 } })));
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await act(async () => window.dispatchEvent(new CustomEvent('o8:pr-updated', { detail: { repo: 'example/repo', number: 1 } })));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(before + 1); expect(rows()).toHaveLength(20);
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe(selected); expect(scroller.scrollTop).toBe(150);
    await render(false);
    const hidden = fetchMock.mock.calls.length;
    await act(async () => window.dispatchEvent(new CustomEvent('o8:pr-updated', { detail: { repo: 'example/repo', number: 1 } })));
    expect(fetchMock).toHaveBeenCalledTimes(hidden);
    await render(true); expect(fetchMock).toHaveBeenCalledTimes(hidden + 1); expect(scroller.scrollTop).toBe(150);
  });
  it('loads open PRs only, groups authors, displays row evidence and opens detail without moving rows or scroll', async () => {
    await render();
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/prs'))[0][0]).toContain('state=open');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(23);
    expect(host.querySelector('h2')?.textContent).toBe('Authored20');
    expect(Array.from(host.querySelectorAll('h2')).at(-1)?.textContent).toBe('Others3');
    expect(host.querySelector('time')?.textContent).toMatch(/(?:h|d|m) ago/);
    expect(host.querySelectorAll('img')).toHaveLength(23);
    expect(host.querySelector('[aria-label="27 additions, 4 deletions"]')).not.toBeNull();
    const scroller = host.querySelector('section')!.lastElementChild!;
    scroller.scrollTop = 175;
    const before = rows().map((row) => row.getAttribute('aria-label'));
    const listener = vi.fn(); window.addEventListener('o8:open-pr', listener);
    try {
      await act(async () => rows()[5].click());
      expect(listener.mock.calls[0][0].detail).toEqual({ prNumber: 6, repo: 'example/repo', repoPath: '/workspace' });
      expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual(before);
      expect(scroller.scrollTop).toBe(175);
      const count = fetchMock.mock.calls.length;
      await render(false); await render(true);
      expect(fetchMock).toHaveBeenCalledTimes(count);
      expect(scroller.scrollTop).toBe(175);
    } finally { window.removeEventListener('o8:open-pr', listener); }
  });

  it('supports personal filters, lazy closed reads, and keyboard menu return focus', async () => {
    await render();
    await act(async () => button('Pull request involvement').click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Authored');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(rows()).toHaveLength(20);
    expect(document.activeElement).toBe(button('Pull request involvement'));
    await act(async () => button('Pull request state').click());
    const closed = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((item) => item.textContent === 'Closed')!;
    await act(async () => closed.click());
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/prs')).at(-1)?.[0]).toContain('state=closed');
    await act(async () => button('Pull request state').click());
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button('Pull request state'));
  });

  it('does not fetch while hidden or let a late response replace the new repository', async () => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status'
      ? Promise.resolve(Response.json({ authenticated: true, username: 'operator' }))
      : url.includes('repoPath=%2Fold') ? new Promise<Response>((resolve) => { finishOld = resolve; })
        : Promise.resolve(Response.json({ repo: 'example/new', prs: [sample(99)], nextPage: null })));
    await render(false, '/old'); expect(fetchMock).not.toHaveBeenCalled();
    await render(true, '/old'); await render(true, '/new');
    await act(async () => finishOld(Response.json({ repo: 'example/old', prs: [sample(1)], nextPage: null })));
    expect(host.textContent).toContain('example/new');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('aria-label')).toContain('#99');
  });

  it('retains custom filters and selection, closes transient menus on leaving, and returns focus on Escape', async () => {
    await render();
    await act(async () => button('Filter pull requests').click());
    const filter = document.querySelector<HTMLElement>('[aria-label="Pull request filters"]')!;
    const label = filter.querySelector<HTMLSelectElement>('[aria-label="Label"]')!;
    await act(async () => { label.value = 'bug'; label.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(rows()).toHaveLength(11);
    await act(async () => filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(button('Filter pull requests'));
    expect(document.querySelector('[aria-label="Pull request filters"]')).toBeNull();
    await act(async () => rows()[0].click());
    const selected = rows()[0].getAttribute('aria-label');
    await act(async () => button('Sort pull requests').click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const count = fetchMock.mock.calls.length;
    await render(false); await render(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(rows()).toHaveLength(11);
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe(selected);
    expect(button('Filter pull requests').textContent).toBe('Filters1');
    await act(async () => button('Sort pull requests').click());
    const oldest = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((item) => item.textContent === 'Oldest')!;
    await act(async () => oldest.click());
    await settle();
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe(selected);
  });

  it('keeps open contributors below the owner while account lookup is unavailable', async () => {
    fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status'
      ? Response.json({ authenticated: false })
      : Response.json({ repo: 'example/repo', prs: [sample(5, 'contributor'), sample(6, 'example'), { ...sample(7, 'contributor'), state: 'closed' }], nextPage: null }));
    await render();
    expect(rows().map((row) => row.dataset.prNumber)).toEqual(['6', '5']);
    expect(Array.from(host.querySelectorAll('h2')).map((heading) => heading.textContent)).toEqual(['Repository owner1', 'Others1']);
    expect(button('Pull request state').textContent).toContain('Open');
  });

  it('shows a red failure icon only for failed checks and a distinct pending status', async () => {
    fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status'
      ? Response.json({ authenticated: true, username: 'operator' })
      : Response.json({ repo: 'example/repo', prs: [{ ...sample(1), checks: 'failure' }, { ...sample(2), checks: 'pending' }], nextPage: null }));
    await render();
    expect(host.querySelector('[aria-label="Checks failure"]')?.getAttribute('style')).toContain('var(--t-danger)');
    expect(host.querySelector('[aria-label="Checks pending"]')?.getAttribute('style')).not.toContain('var(--t-danger)');
    expect(host.querySelector('[aria-label="Checks success"]')).toBeNull();
  });
});
