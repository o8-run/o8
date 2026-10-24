// @vitest-environment jsdom
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryClient } from '@/lib/query/client';
import type { PrDetail } from './types';
import { PrPanel } from './PrPanel';

vi.mock('../artifacts/useArtifacts', () => ({ useArtifacts: () => ({ artifacts: [] }) }));

function detail(number: number, title = `Change ${number}`): PrDetail {
  return { number, title, body: '', state: 'open', author: 'author', headRefName: 'work', baseRefName: 'main', additions: 27, deletions: 4, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, statusCheckRollup: [], url: `https://github.com/example/repo/pull/${number}`, files: [], reviewComments: [], issueComments: [] };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}
let client: QueryClient;
const provide = (child: ReactNode) => createElement(QueryClientProvider, { client }, child);
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
const settleTimeline = () => act(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  else await new Promise(resolve => setTimeout(resolve, 0));
});
const render = async (prNumber: number, repoSlug = 'example/repo', active = true) => { await act(async () => root.render(provide(createElement(PrPanel, { prNumber, repoSlug, onClose, active })))); await settleTimeline(); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  client = getQueryClient(); client.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  onClose = vi.fn(); fetchMock = vi.fn(); vi.stubGlobal('fetch', (url: string, init?: RequestInit) => String(url).startsWith('/api/orchestrator/pull-request-context') ? Promise.resolve(Response.json({ ok: true, result: { links: [], nextCursor: null } })) : fetchMock(url, init));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); vi.unstubAllGlobals(); });

describe('pull request selection', () => {
  it('uses the loaded files for the same breakdown in the header and Changes without another request', async () => {
    const files = [{ path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2, patch: '' }, { path: 'tests/b.ts', status: 'modified', additions: 4, deletions: 0, patch: '' }];
    fetchMock.mockResolvedValue(Response.json({ pr: { ...detail(9805), files, changedFiles: 2, additions: 14, deletions: 2 } }));
    await render(9805);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change breakdown: 14 additions, 2 deletions"]')!.click());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Tests');
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][id$="-changes"]')!.click());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-pr-changes-toolbar] [aria-label="Change breakdown: 14 additions, 2 deletions"]')!.click());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Tests');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const changesTab = host.querySelector<HTMLButtonElement>('[role="tab"][id$="-changes"]')!;
    await act(async () => { changesTab.focus(); changesTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    const readsAfterTabChange = fetchMock.mock.calls.length;
    await act(async () => host.querySelector<HTMLButtonElement>('header [aria-label="Change breakdown: 14 additions, 2 deletions"]')!.click());
    await render(9805, 'example/repo', false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(readsAfterTabChange);
  });

  it('backs off a quota refusal while retaining the current view and labels scheduled reads as background', async () => {
    vi.useFakeTimers();
    try {
      const current = { ...detail(9801), statusCheckRollup: [{ name: 'test', status: 'in_progress' }] };
      fetchMock.mockResolvedValueOnce(Response.json({ pr: current })).mockResolvedValueOnce(Response.json({ error: 'GitHub refresh is paused.' }, { status: 429, headers: { 'retry-after': '120' } })).mockResolvedValue(Response.json({ pr: current }));
      await render(9801);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const checks = host.querySelector<HTMLButtonElement>('[role="tab"][id$="-checks"]')!;
      await act(async () => checks.click());
      expect(checks.getAttribute('aria-selected')).toBe('true');
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('&poll=1');
      await settleTimeline();
      expect(host.textContent).toContain('Change 9801'); expect(host.textContent).toContain('GitHub refresh is paused.');
      await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(31_000)); expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('does not poll a hidden document and refreshes on return', async () => {
    vi.useFakeTimers(); const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      fetchMock.mockImplementation(async () => Response.json({ pr: detail(9802) }));
      await render(9802); visibility.mockReturnValue('hidden');
      await act(async () => vi.advanceTimersByTimeAsync(120_000)); expect(fetchMock).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { visibility.mockRestore(); vi.useRealTimers(); }
  });
  it('keeps collapsed rows clean and retains diff layout and folder state while the tree navigates within Changes', async () => {
    const files = [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }, { path: 'tests/b.ts', status: 'modified', additions: 1, deletions: 1, patch: '' }];
    fetchMock.mockImplementation(async (url: string) => Response.json({ pr: { ...detail(Number(url.match(/prs\/(\d+)/)?.[1])), files, changedFiles: 2 } }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const jump = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: jump });
    const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
    await render(9701); await click('[role="tab"][id$="-changes"]');
    expect(Array.from(host.querySelectorAll<HTMLElement>('[data-pr-file-row]')).every((row) => !row.style.borderBottom)).toBe(true);
    await click('[aria-label="Split diff"]');
    await click('[aria-label="Changed file tree"]');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Changed file tree"]')!;
    expect(host.querySelector('nav[aria-label="Changed files"]')).not.toBeNull();
    const folder = host.querySelector<HTMLDetailsElement>('details')!;
    await act(async () => { folder.open = false; folder.dispatchEvent(new Event('toggle', { bubbles: true })); });
    await act(async () => host.querySelector('summary')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger); expect(onClose).not.toHaveBeenCalled();
    await click('[aria-label="Changed file tree"]');
    expect(host.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    await click('[data-pr-tree-file="tests/b.ts"]');
    expect(host.querySelector('[data-pr-file="tests/b.ts"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('[data-pr-file="tests/b.ts"]')); expect(jump).toHaveBeenCalled();
    expect(host.querySelector<HTMLElement>('[data-pr-file-row][data-open="true"]')?.style.borderBottom).toContain('solid');
    await render(9702); await render(9701);
    expect(host.querySelector('[aria-label="Split diff"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-pr-file="tests/b.ts"]')?.getAttribute('aria-expanded')).toBe('true');
    await click('[aria-label="Changed file tree"]'); expect(host.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method !== 'POST')).toBe(true);
  });

  it('leaves hidden details idle and resumes the same view when the panel becomes visible', async () => {
    fetchMock.mockResolvedValue(Response.json({ pr: detail(9301) }));
    await render(9301, 'example/repo', false);
    expect(fetchMock).not.toHaveBeenCalled();
    await render(9301);
    expect(host.textContent).toContain('Change 9301');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent === 'Reviews')!.click());
    const reads = fetchMock.mock.calls.length;
    await render(9301, 'example/repo', false);
    expect(fetchMock).toHaveBeenCalledTimes(reads);
    await render(9301);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Reviews');
    expect(fetchMock).toHaveBeenCalledTimes(reads);
  });
  it('joins an in-flight selection read, reuses a warm result and recovers an aborted refresh in place', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    await render(9401); await render(9401, 'example/repo', false); await render(9401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(Response.json({ pr: detail(9401) })));
    await settleTimeline();
    await render(9402, 'example/repo', false); await render(9401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => client.invalidateQueries({ queryKey: ['gh', 'example/repo', 'pr-panel'], refetchType: 'none' }));
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError')).mockResolvedValueOnce(Response.json({ pr: detail(9401) }));
    await render(9401, 'example/repo', false); await render(9401);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('interrupted. Retry.');
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!.click());
    await settleTimeline();
    expect(host.textContent).toContain('Change 9401');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('opens the composer Brain with the selected PR context without adding a second right-panel Brain', async () => {
    fetchMock.mockResolvedValue(Response.json({ pr: detail(9501) }));
    const receive = vi.fn(); window.addEventListener('o8:open-composer-brain', receive);
    try {
      await act(async () => root.render(provide(createElement(PrPanel, { prNumber: 9501, repoSlug: 'example/repo', repoPath: '/workspace/repo', onClose }))));
      await settleTimeline();
      expect(host.querySelector('[data-pr-brain-chat]')).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pull request actions"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Ask Brain')!.click());
      expect(receive).toHaveBeenCalledOnce();
      const request = (receive.mock.calls[0][0] as CustomEvent).detail;
      expect(request.repoPath).toBe('/workspace/repo'); expect(JSON.parse(request.context).number).toBe(9501);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/cortex/ask'))).toBe(false);
    } finally { window.removeEventListener('o8:open-composer-brain', receive); }
  });
  it('retains a separate comment draft and mode through PR switching without posting', async () => {
    fetchMock.mockImplementation(async (url: string) => Response.json({ pr: detail(Number(url.match(/prs\/(\d+)/)?.[1])) }));
    const show = async (prNumber: number, repoSlug = 'example/repo') => { await act(async () => root.render(provide(createElement(PrPanel, { prNumber, repoSlug, repoPath: '/workspace/repo', onClose })))); await settleTimeline(); };
    const type = async (selector: string, text: string) => act(async () => { const input = host.querySelector<HTMLTextAreaElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await show(9601);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pull request actions"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Write a comment')!.click());
    await type('[data-pr-comment="9601"]', 'Keep the comment draft');
    await show(9602); expect(host.querySelector('[data-pr-comment="9602"]')).toBeNull();
    await show(9601); expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment="9601"]')?.value).toBe('Keep the comment draft');
    await act(async () => root.render(null)); await show(9601);
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment="9601"]')?.value).toBe('Keep the comment draft');
    expect(host.querySelector('[aria-label="Switch to Brain"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Collapse comment composer"]')!.click());
    expect(host.querySelector('[data-pr-question]')).toBeNull();
    await show(9601, 'example/other'); expect(host.querySelector('[data-pr-comment="9601"]')).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method !== 'POST')).toBe(true);
  });
  it('loads timeline only on opening, ignores late activity for another PR, and retries the selected activity', async () => {
    const pending = deferred(); let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const number = Number(url.match(/prs\/(\d+)/)?.[1]);
      if (!url.includes('/timeline')) return Response.json({ pr: detail(number) });
      if (number === 9101) return pending.promise;
      attempts++;
      return attempts === 1 ? Response.json({ error: 'Activity interrupted' }, { status: 502 }) : Response.json({ events: [{ id: 'comment:1', kind: 'commented', actor: 'reviewer', avatarUrl: null, title: 'commented', at: '2026-10-07T12:00:00Z', body: 'Selected discussion', url: 'https://github.com/example/repo/pull/9102#issuecomment-1' }], nextPage: null });
    });
    await render(9101);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/timeline'))).toBe(false);
    const clickTimeline = async () => { await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent === 'Timeline')!.click()); await settleTimeline(); };
    await clickTimeline();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading activity for PR #9101');
    await render(9102);
    await act(async () => pending.resolve(Response.json({ events: [{ id: 'comment:old', kind: 'commented', actor: 'previous', avatarUrl: null, title: 'commented', at: '', body: 'Previous discussion', url: 'https://github.com/example/repo/pull/9101' }], nextPage: null })));
    await settleTimeline();
    expect(host.textContent).not.toContain('Previous discussion');
    await clickTimeline();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Activity interrupted');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Retry activity')!.click());
    await settleTimeline();
    expect(host.querySelector('[aria-label="Pull request timeline"]')?.textContent).toContain('Selected discussion');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('repo=example%2Frepo');
  });

  it('keeps activity pagination scoped and removes duplicates when loading another page', async () => {
    const event = { id: 'comment:1', kind: 'commented', actor: 'reviewer', avatarUrl: null, title: 'commented', at: '', body: 'First comment', url: 'https://github.com/example/repo/pull/9201' };
    fetchMock.mockImplementation(async (url: string) => !url.includes('/timeline') ? Response.json({ pr: detail(9201) }) : url.includes('page=2') ? Response.json({ events: [event, { ...event, id: 'comment:2', body: 'Second comment' }], nextPage: null }) : Response.json({ events: [event], nextPage: 2 }));
    await render(9201);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent === 'Timeline')!.click());
    await settleTimeline();
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Load more activity')!.click());
    await settleTimeline();
    expect(host.querySelectorAll('[aria-label="Pull request timeline"] li')).toHaveLength(3);
    expect((host.textContent || '').match(/First comment/g)).toHaveLength(1);
    expect(host.textContent).toContain('Second comment');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Load more activity')).toBe(false);
  });
  it('replaces the previous PR immediately with a named, closeable loading state', async () => {
    const pending = deferred();
    fetchMock.mockResolvedValueOnce(Response.json({ pr: detail(1, 'Previous change') })).mockReturnValueOnce(pending.promise);
    await render(1);
    expect(host.textContent).toContain('Previous change');
    await render(3384);
    expect(host.textContent).not.toContain('Previous change');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading PR #3384…');
    expect(host.querySelector('[data-pr-detail]')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close pull request"]')!.click());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(Response.json({ pr: detail(3384, 'Incoming change') })));
    await settleTimeline();
    expect(host.textContent).toContain('Incoming change');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('ignores late results for another selection, scopes cache by repo, and reuses the matching snapshot', async () => {
    const first = deferred(); const second = deferred(); const otherRepo = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(otherRepo.promise)
      .mockResolvedValueOnce(Response.json({ pr: detail(1, 'First change') }));
    await render(1); await render(2);
    await act(async () => second.resolve(Response.json({ pr: detail(2, 'Second change') })));
    await settleTimeline();
    await act(async () => first.resolve(Response.json({ pr: detail(1, 'First change') })));
    await settleTimeline();
    expect(host.textContent).toContain('Second change');
    expect(host.textContent).not.toContain('First change');
    await render(2, 'example/other');
    expect(host.textContent).not.toContain('Second change');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('#2');
    await act(async () => otherRepo.resolve(Response.json({ pr: detail(2, 'Other repository') })));
    await settleTimeline();
    expect(host.textContent).toContain('Other repository');
    await render(1);
    expect(host.textContent).toContain('First change');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('retries a failed read in place without carrying the error into the next PR', async () => {
    const retry = deferred(); const next = deferred();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Connection interrupted' }, { status: 502 }))
      .mockReturnValueOnce(retry.promise).mockReturnValueOnce(next.promise);
    await render(3);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Connection interrupted');
    const retryButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!;
    await act(async () => retryButton.click());
    await settleTimeline();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('#3');
    await render(4);
    await act(async () => retry.resolve(Response.json({ pr: detail(3) })));
    expect(host.textContent).not.toContain('Change 3');
    await act(async () => next.resolve(Response.json({ pr: detail(4) })));
    await settleTimeline();
    expect(host.textContent).toContain('Change 4');
  });

  it('renders the full description, resolves safe links, and opens referenced changed files', async () => {
    const pr = { ...detail(3601), body: '# Mechanism\n\nRead [the guide](docs/guide.md).\n\nChange `src/app.ts` and `README.md`.\n\n[unsafe](javascript:alert)', files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+hello' }, { path: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '+docs' }], changedFiles: 2, labels: ['ui'], requestedReviewers: ['reviewer'] };
    fetchMock.mockResolvedValue(Response.json({ pr }));
    await render(3601);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Summary');
    expect(host.querySelector('[data-pr-detail-scroll="summary"]')?.textContent).toContain('Mechanism');
    expect(Array.from(host.querySelectorAll('a')).find((a) => a.textContent === 'the guide')?.href).toBe('https://github.com/example/repo/blob/work/docs/guide.md');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.textContent).toContain('reviewer');
    expect(host.querySelector('[aria-label*="Ask o8"]')).toBeNull();
    const mention = host.querySelector<HTMLButtonElement>('[aria-label="View changes in README.md"]')!;
    await act(async () => mention.click());
    const row = host.querySelector<HTMLButtonElement>('[data-pr-file="README.md"]')!;
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Changes');
  });

  it('retains each PR tab, file expansion and scroll through selection and panel reopening', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const number = Number(url.match(/prs\/(\d+)/)?.[1]);
      return Response.json({ pr: { ...detail(number), files: [{ path: 'app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+hello' }], changedFiles: 1 } });
    });
    await render(3701);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent?.startsWith('Changes'))!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-pr-file="app.ts"]')!.click());
    const scroller = host.querySelector<HTMLElement>('[data-pr-detail-scroll="changes"]')!;
    scroller.scrollTop = 180;
    await act(async () => scroller.dispatchEvent(new Event('scroll')));
    await render(3702);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Summary');
    await render(3701);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Changes');
    expect(host.querySelector('[data-pr-file="app.ts"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector<HTMLElement>('[data-pr-detail-scroll="changes"]')!.scrollTop).toBe(180);
    await act(async () => root.unmount()); root = createRoot(host);
    await render(3701);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Changes');
    expect(host.querySelector<HTMLElement>('[data-pr-detail-scroll="changes"]')!.scrollTop).toBe(180);
    await render(3701, 'example/other');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Summary');
  });

  it('uses roving tab focus and reports failed and pending checks without counting them as passing', async () => {
    fetchMock.mockResolvedValue(Response.json({ pr: { ...detail(3801), statusCheckRollup: [{ name: 'unit', conclusion: 'failure', url: 'https://github.com/example/repo/actions/runs/1' }, { name: 'lint', conclusion: 'success' }, { name: 'build', status: 'queued' }, { name: 'optional', conclusion: 'skipped' }] } }));
    await render(3801);
    expect(host.querySelector('[aria-label="View checks: 1 failing · 1 of 4 passing"]')).not.toBeNull();
    const first = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    const active = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    expect(document.activeElement).toBe(active);
    expect(active.textContent).toContain('Timeline');
    expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    expect(document.getElementById(active.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(active.id);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="View checks:"]')!.click());
    expect(host.querySelector('[aria-label="View unit on GitHub"]')?.getAttribute('href')).toContain('/actions/runs/1');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Debug')).toBe(false);
  });
});
