// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMobileSearchNavigation } from '../mobile/useMobileSearchNavigation';
import { OrchestratorView } from '../mobile/OrchestratorView';
vi.mock('../mobile/hooks/useOrchestratorMobile', () => ({ useOrchestratorMobile: () => ({ connectionState: 'disconnected', turnStatus: 'idle', transcript: [], transcriptLoading: false, errorNote: null, sendMessage: vi.fn(), interrupt: vi.fn(), retryQueued: vi.fn(), discardQueued: vi.fn() }) }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear();
  window.localStorage.setItem('o8:mobile:orchestrator-active-thread', 'thoughts-archived-pr');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('reads the same durable links from the live mobile conversation entry, including an archived thread outside the recent list', async () => {
  const thread = { id: 'thoughts-archived-pr', title: 'Archived PR discussion', lastMessageAt: '2026-01-01', runtime: 'codex', status: 'idle', messageCount: 0, projectId: null,
    repoPath: '/fixture', repoName: 'repo', repoBranch: 'shared', githubOwner: 'example', githubRepo: 'repo', backend: 'codex', agent: null };
  const links = ['context', 'review', 'import', 'delivery'].map((kind, index) => ({ id: index + 1, threadId: thread.id, kind, source: kind === 'delivery' ? 'packet' : 'operator', packetId: kind === 'delivery' ? 'pkt-owned' : null,
    repositoryFullName: 'example/repo', number: 7, url: 'https://github.com/example/repo/pull/7' }));
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith('/api/mobile/conversation-pr-context?threadId=')) return Response.json({ ok: true, result: { links, nextCursor: null, thread } });
    if (url === '/api/mobile/orchestrator/threads') return Response.json({ threads: [] });
    return Response.json({ values: {}, profile: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(createElement(OrchestratorView, { onBack: () => {}, hideHeader: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const collection = host.querySelector('[aria-label="Conversation pull requests"]');
  expect(collection?.textContent).toContain('example/repo #7');
  for (const label of ['context', 'review', 'import', 'Primary delivery · pkt-owned']) expect(collection?.textContent).toContain(label);
  expect(collection?.querySelector('button')).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/mobile/conversation-pr-context'))).toHaveLength(2);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('routes a PR conversation selection through the same mobile search navigation used by the live client', async () => {
  const view = vi.fn(); const tab = vi.fn();
  function Navigation() { useMobileSearchNavigation(view, tab); return null; }
  await act(async () => root.render(createElement(Navigation)));
  await act(async () => window.dispatchEvent(new CustomEvent('o8:open-pr-conversation', { detail: { threadId: 'thoughts-picked', title: 'Archived PR' } })));
  expect(window.localStorage.getItem('o8:mobile:orchestrator-active-thread')).toBe('thoughts-picked');
  expect(view).toHaveBeenCalledExactlyOnceWith('orchestrator'); expect(tab).not.toHaveBeenCalled();
});
