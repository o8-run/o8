// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LinkedPullRequests } from '../desktop/pr-panel/LinkedPullRequests';
import { PrPanel } from '../desktop/pr-panel/PrPanel';
import { ConversationPullRequests } from './ConversationPullRequests';
import { MobileDiffViewer } from '../mobile/MobileDiffViewer';
import { OPEN_PR_CONVERSATION } from './PullRequestConversations';
import type { PullRequestContextLink } from '@/lib/orchestrator/pull-request-context';
import type { RepoRegistryEntry } from '@/lib/repos/types';
vi.mock('../desktop/artifacts/useArtifacts', () => ({ useArtifacts: () => ({ artifacts: [] }) }));
let host: HTMLDivElement; let root: Root; let client: QueryClient; let links: PullRequestContextLink[];
let fetchMock: ReturnType<typeof vi.fn>;
const link = (id: number, kind: PullRequestContextLink['kind']): PullRequestContextLink => ({
  id, host: 'github.com', repositoryId: 12, pullRequestId: 45, number: 7, threadId: 'thoughts-owned', threadTitle: 'Archived discussion', threadAvailable: true,
  repositoryFullName: 'example/repo', url: 'https://github.com/example/repo/pull/7', kind, source: kind === 'delivery' ? 'packet' : 'operator',
  packetId: kind === 'delivery' ? 'pkt-owned' : null, laneId: kind === 'delivery' ? 'lane-owned' : null, createdAt: '2026-01-01',
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); client = new QueryClient(); links = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('pull-request-context') || url.includes('conversation-pr-context')) {
      const params = new URL(url, 'http://localhost').searchParams;
      if (params.has('resolve')) return Response.json({ ok: true, result: { identity: { host: 'github.com', repositoryId: 12, pullRequestId: 45, number: 7 } } });
      if (init?.method === 'POST') { const input = JSON.parse(String(init.body)); const entry = { ...link(1, input.kind), ...input }; links.push(entry); return Response.json({ ok: true, result: { link: entry, created: true } }); }
      if (init?.method === 'DELETE') { const input = JSON.parse(String(init.body)); links = links.filter(link => link.kind !== input.kind); return Response.json({ ok: true, result: { removed: true } }); }
      return Response.json({ ok: true, result: { links: params.get('threadId') === 'thoughts-other' ? [] : links, nextCursor: null } });
    }
    if (url.includes('/api/panel/prs/')) return Response.json({ pr: { number: 7, title: 'Related change', resolvedRepo: 'example/repo', url: 'https://github.com/example/repo/pull/7', createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, body: '', state: 'open', author: 'fixture', headRefName: 'work', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 0, statusCheckRollup: [], reviewComments: [], issueComments: [], files: [] } });
    return Response.json({ repo: 'example/repo', prs: [], nextPage: null });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async (child: React.ReactNode) => { await act(async () => root.render(createElement(QueryClientProvider, { client }, child))); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
it('uses the real desktop conversation entry to add an import, restore it, and unlink only that role', async () => {
  const render = () => mount(createElement(LinkedPullRequests, { context: 'thread:thoughts-owned', tabId: 'tab-one', repoPath: '/repo', repos: [{ id: 'repo', localPath: '/repo', remoteUrl: 'https://github.com/example/repo.git' }] as RepoRegistryEntry[], active: true }));
  await render();
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#7'); input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = host.querySelector('select')!; select.value = 'import'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(links).toHaveLength(1); expect(links[0].kind).toBe('import');
  links.push(link(2, 'delivery'));
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.textContent).toContain('Primary delivery · pkt-owned');
  expect(host.querySelectorAll('[aria-label^="Unlink"]')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="Unlink import"]')!.click());
  expect(links.map(link => link.kind)).toEqual(['delivery']);
  await mount(createElement(ConversationPullRequests, { threadId: 'thoughts-other' }));
  expect(host.textContent).not.toContain('example/repo #7');
  expect(fetchMock.mock.calls.every(([url]) => /\/api\/(?:panel\/prs\/7|orchestrator\/pull-request-context)/.test(url))).toBe(true);
});
it('shows the same association roles on mobile with no edit controls or mutation requests', async () => {
  links = [link(1, 'context'), link(2, 'review'), link(3, 'import'), link(4, 'delivery')];
  await mount(createElement(ConversationPullRequests, { threadId: 'thoughts-owned', readOnly: true }));
  for (const kind of ['context', 'review', 'import', 'Primary delivery']) expect(host.textContent).toContain(kind);
  expect(host.querySelector('form')).toBeNull(); expect(host.querySelector('button')).toBeNull();
  expect(fetchMock.mock.calls).toHaveLength(1); expect(fetchMock.mock.calls[0][0]).toContain('/api/mobile/conversation-pr-context?threadId=thoughts-owned');
});
it('opens the archived conversation from the real PR panel and preserves reverse navigation on mobile', async () => {
  links = [link(1, 'context'), link(2, 'delivery')];
  const open = vi.fn(); window.addEventListener(OPEN_PR_CONVERSATION, open);
  try {
    await mount(createElement(PrPanel, { prNumber: 7, repoSlug: 'example/repo', onClose: () => {} }));
    expect(host.querySelectorAll('[aria-label="Linked conversations"] button')).toHaveLength(1);
    await act(async () => button('Archived discussion · context, delivery').click());
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ threadId: 'thoughts-owned', title: 'Archived discussion' });
    await mount(createElement(MobileDiffViewer, { source: { kind: 'pr', repo: 'example/repo', number: 7 }, open: true, title: 'Related PR', onClose: () => {} }));
    await act(async () => button('Archived discussion · context, delivery').click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/mobile/conversation-pr-context?repo=example%2Frepo&number=7'))).toBe(true);
  } finally { window.removeEventListener(OPEN_PR_CONVERSATION, open); }
});
it('does not attach a verified PR after switching conversations while its read is pending', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementationOnce(async () => Response.json({ ok: true, result: { links: [], nextCursor: null } }));
  await mount(createElement(ConversationPullRequests, { threadId: 'thoughts-owned' }));
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await act(async () => { const input = host.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/example/repo/pull/7'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await mount(createElement(ConversationPullRequests, { threadId: 'thoughts-other' }));
  await act(async () => finish(Response.json({ pr: { number: 7, resolvedRepo: 'example/repo' } })));
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('recovers editing when a pending identity read is aborted by hiding and reactivating the same conversation', async () => {
  let finish!: (value: Response) => void;
  const render = (active: boolean) => mount(createElement(ConversationPullRequests, { threadId: 'thoughts-owned', active }));
  await render(true);
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await act(async () => { const input = host.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/example/repo/pull/7'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await render(false);
  await act(async () => finish(Response.json({ ok: true, result: { identity: { host: 'github.com', repositoryId: 12, pullRequestId: 45, number: 7 } } })));
  await render(true);
  expect(host.querySelector('input')!.disabled).toBe(false);
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(links).toHaveLength(1);
});
