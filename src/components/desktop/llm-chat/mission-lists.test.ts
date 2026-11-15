// @vitest-environment jsdom
import { act, createElement, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatSurface } from './ChatSurface';
import { useHistoryAndMission } from './useHistoryAndMission';
import { MISSION_DISMISSED_STORAGE_KEY, type PreferredRepoContext } from './shared';

// Animation is peripheral to list consumption and action dispatch.
vi.mock('framer-motion', async original => ({ ...await original<typeof import('framer-motion')>(),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) => createElement('div', { style }, children) },
}));

const preferred: PreferredRepoContext = { name: 'Fixture', localPath: '/workspace/fixture', remoteUrl: 'https://github.com/org/sample' };
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let history: unknown[];
const send = vi.fn(async (_text?: string) => {});
const openHistory = vi.fn();
const noop = () => {};
const reads = (kind: 'issues' | 'prs') => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`/api/panel/${kind}?`));
const list = (kind: 'issues' | 'prs', count = kind === 'issues' ? 2 : 1) => Response.json({ repo: 'org/sample', [kind]: Array.from({ length: count }, (_, i) => ({ number: i + 1, state: 'OPEN' })) });

function Mission({ repo = preferred, empty = true, index = 0 }: { repo?: PreferredRepoContext; empty?: boolean; index?: number }) {
  const inputRef = useRef<HTMLTextAreaElement>(null), scrollRef = useRef<HTMLDivElement>(null);
  const mission = useHistoryAndMission({ historyOpen: false, input: '', inputRef, isEmpty: empty,
    preferredRepo: repo, queuedContextCards: [], sendMessage: send, tabId: `new-${index}`, onOpenHistoryChat: openHistory });
  // eslint-disable-next-line react-hooks/refs -- the ref object is passed through as a prop, never read during render
  return createElement(ChatSurface, {
    activeThinking: null, activeToolCalls: [], followUps: [], followUpsLoading: false, inputRef,
    isEmpty: empty, isStreaming: false, isUserScrolledUp: false, messages: [], missionCard: mission.missionCard,
    model: { id: 'fixture', label: 'Fixture assistant', provider: 'local', backend: 'api', color: '', description: '' },
    onApplyToFile: noop, onClearFollowUps: noop, onDeleteMessage: noop, onEditMessage: noop, onFollowUpSelect: noop,
    onForkMessage: noop, onMissionAction: mission.handleMissionAction, onNewConversation: noop,
    onRetryMessage: noop, onScrollToBottom: noop, onSuggestedPromptSelect: noop, onToggleHistory: noop,
    persistMissionDismissal: mission.persistMissionDismissal, scrollRef,
    shouldShowMissionCard: mission.shouldShowMissionCard, shouldShowSuggestedPrompts: mission.shouldShowSuggestedPrompts,
    showTypingIndicator: false, streamContent: '',
  });
}
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function render(count = 1, repo = preferred, empty = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, i) => createElement(Mission, { key: i, index: i, repo, empty })),
  ))); await settle(); await settle();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  history = []; send.mockClear(); openHistory.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string) => url.startsWith('/api/panel/issues?') ? list('issues')
    : url.startsWith('/api/panel/prs?') ? list('prs')
    : Response.json(url === '/api/panel/repos' ? { repos: [] } : { conversations: history }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one issue and PR list read across five actual mission cards', async () => {
  await render(5);
  expect(host.textContent?.match(/Fixture has 2 open issues and 1 pending PR\./g)).toHaveLength(5);
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 1, prs: 1 });
});
it('reuses fresh lists when an empty chat remounts', async () => {
  await render(); await render(0); await render();
  expect(host.textContent).toContain('Fixture has 2 open issues and 1 pending PR.');
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 1, prs: 1 });
});
it('does not fetch repository lists for a nonempty chat or a repository without a remote', async () => {
  await render(1, preferred, false); await render(1, { name: 'Local', localPath: '/workspace/local' });
  expect(reads('issues')).toHaveLength(0); expect(reads('prs')).toHaveLength(0);
  expect(host.textContent).toContain('Explain codebase');
});
it('keeps the new repository mission after delayed old-repository replies', async () => {
  const release: Array<() => void> = [];
  fetchMock.mockImplementation((url: string) => url.startsWith('/api/panel/issues?') || url.startsWith('/api/panel/prs?')
    ? url.includes(encodeURIComponent('org/sample')) ? new Promise<Response>(resolve => { release.push(() => resolve(list(url.includes('/issues?') ? 'issues' : 'prs'))); })
      : Promise.resolve(list(url.includes('/issues?') ? 'issues' : 'prs', 3))
    : Promise.resolve(Response.json({ conversations: [], repos: [] })));
  await render(); await render(1, { ...preferred, name: 'Other', remoteUrl: 'https://github.com/org/other' });
  expect(host.textContent).toContain('Other has 3 open issues and 3 pending PRs.');
  await act(async () => release.forEach(done => done())); await settle();
  expect(host.textContent).not.toContain('Fixture has');
});
it('dispatches a clicked mission action and persists dismissal', async () => {
  await render();
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.includes('Review PRs'))!;
  await act(async () => button.click());
  expect(send).toHaveBeenCalledWith('Review the open pull requests in org/sample. Summarize what is pending and tell me which PR needs attention first.');
  expect(localStorage.getItem(MISSION_DISMISSED_STORAGE_KEY)).toBe('1');
  expect(host.querySelector('[aria-label="Dismiss mission card"]')).toBeNull();
});
it('updates visible cards at two minutes and stops polling when the chat becomes nonempty', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await render();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/issues?') ? list('issues', 3)
    : url.startsWith('/api/panel/prs?') ? list('prs', 4) : Response.json({ conversations: [], repos: [] }));
  await settle(2 * 60_000 + 1); await settle();
  expect(host.textContent).toContain('Fixture has 3 open issues and 4 pending PRs.');
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 2, prs: 2 });
  await render(1, preferred, false); await settle(5 * 60_000);
  expect(host.querySelector('[aria-label="Dismiss mission card"]')).toBeNull();
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 2, prs: 2 });
});
it('uses the shared five-minute interval while the window is hidden', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await render(); await settle(2 * 60_000 + 1);
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 1, prs: 1 });
  await settle(3 * 60_000);
  expect({ issues: reads('issues').length, prs: reads('prs').length }).toEqual({ issues: 2, prs: 2 });
});
it('retains the known mission counts after rate-limited background reads', async () => {
  await render(); fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(host.textContent).toContain('Fixture has 2 open issues and 1 pending PR.');
  expect(host.textContent).toContain('Triage issues'); expect(host.textContent).toContain('Review PRs');
});
it('keeps a successful list usable when the other initial list fails', async () => {
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/issues?') ? new Response('unavailable', { status: 503 })
    : url.startsWith('/api/panel/prs?') ? list('prs') : Response.json({ conversations: [], repos: [] }));
  await render();
  expect(host.textContent).toContain('Fixture has 1 pending PR waiting for review.');
  expect(host.textContent).toContain('Review PRs'); expect(host.textContent).not.toContain('Triage issues');
});
it('waits for the initial lists before showing a generic codebase action', async () => {
  let release!: () => void;
  fetchMock.mockImplementation((url: string) => url.startsWith('/api/panel/issues?')
    ? new Promise<Response>(resolve => { release = () => resolve(list('issues')); })
    : Promise.resolve(url.startsWith('/api/panel/prs?') ? list('prs') : Response.json({ conversations: [], repos: [] })));
  await render();
  expect(host.textContent).not.toContain('Explain codebase'); expect(host.querySelector('[aria-label="Dismiss mission card"]')).toBeNull();
  await act(async () => release()); await settle();
  expect(host.textContent).toContain('Fixture has 2 open issues and 1 pending PR.');
});
it('preserves the saved-thread action and its repository context', async () => {
  history = [{ tabId: 'saved', title: 'Saved work', messageCount: 3, repoName: 'Fixture', repoPath: preferred.localPath,
    repoBranch: 'feature', remoteUrl: preferred.remoteUrl, modifiedAt: '2026-01-01T00:00:00Z' }];
  await render(); expect(host.textContent).toContain('Pick up where you left off');
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.includes('Resume thread'))!;
  await act(async () => button.click());
  expect(openHistory).toHaveBeenCalledWith('saved', 'Saved work', {
    name: 'Fixture', localPath: preferred.localPath, branch: 'feature', remoteUrl: preferred.remoteUrl,
  });
  expect(send).not.toHaveBeenCalled();
});
