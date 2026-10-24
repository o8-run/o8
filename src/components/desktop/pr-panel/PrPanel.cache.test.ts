// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryClient } from '@/lib/query/client';
import { invalidateSWR } from '@/lib/panel/fetch-cache';
import { GITHUB_LIST_FRESH_MS } from '@/lib/github-client';
import { PrPanel } from './PrPanel';
import { PrCommentComposer } from './PrCommentComposer';
import type { PrDetail } from './types';

vi.mock('../artifacts/useArtifacts', () => ({ useArtifacts: () => ({ artifacts: [] }) }));

const detail = (number = 7, title = 'Known change'): PrDetail => ({ number, title, body: '', state: 'open', author: 'author', headRefName: 'work', baseRefName: 'main', headSha: 'a'.repeat(40), additions: 0, deletions: 0, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, statusCheckRollup: [], url: `https://github.com/org/sample/pull/${number}`, files: [], reviewComments: [], issueComments: [] });
const response = (number = 7, title = 'Known change') => Response.json({ pr: detail(number, title) });
function deferred() { let resolve!: (r: Response) => void; const promise = new Promise<Response>(finish => { resolve = finish; }); return { promise, resolve }; }
type Selection = { repo?: string | null; number?: number; active?: boolean };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
async function render(selections: Selection[] = [{ repo: 'Org/Sample' }], composer?: Selection) {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, ...selections.map((selection, index) => createElement(PrPanel, { key: index, prNumber: selection.number ?? 7, repoSlug: selection.repo, active: selection.active ?? true, onClose: () => {} })), composer ? createElement(PrCommentComposer, { detail: detail(composer.number ?? 7), repoSlug: composer.repo, draft: 'Posted comment', onDraftChange: () => {}, onCollapse: () => {} }) : null)));
  await flush();
}
async function refresh() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pull request actions"]')!.click());
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent === 'Refresh')!.click());
  await flush();
}
async function retry() {
  await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Retry')!.click());
  await flush();
}
const reads = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST');
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); invalidateSWR('pr-detail'); client = getQueryClient(); client.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); invalidateSWR('pr-detail'); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('compact PR detail snapshots through PrPanel', () => {
  it('exposes the failed-check repair flow through the live compact panel', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ pr: { ...detail(), statusCheckRollup: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] } }));
    await render();
    const checks = host.querySelector<HTMLButtonElement>('[role="tab"][id$="-checks"]');
    expect(checks).not.toBeNull(); await act(async () => checks!.click());
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"][id$="-checks-panel"]');
    expect(panel?.hidden).toBe(false);
    const fix = [...panel!.querySelectorAll('button')].find(button => button.textContent === 'Fix failing checks');
    expect(fix).toBeDefined();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, headSha: 'a'.repeat(40), checks: [{ key: '1', name: 'Tests' }] }));
    await act(async () => fix!.click());
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/panel/prs/7/repair?repo=Org%2FSample');
    expect(panel?.textContent).toContain('Select failed checks');
  });

  it('does not use the fast checks cadence while another PR view is selected', async () => {
    fetchMock.mockImplementation(async () => Response.json({ pr: { ...detail(), statusCheckRollup: [{ name: 'Tests', status: 'in_progress' }] } }));
    await render();
    const summary = host.querySelector<HTMLButtonElement>('[role=tab][id$="-summary"]')!;
    await act(async () => summary.click()); expect(summary.getAttribute('aria-selected')).toBe('true');
    await act(async () => vi.advanceTimersByTimeAsync(30_000)); await flush();
    expect(reads()).toHaveLength(1);
  });

  it.each(['closed', 'merged'])('loads a %s PR once while retained and mounted', async state => {
    fetchMock.mockImplementation(async () => Response.json({ pr: { ...detail(), state } }));
    await render(); await act(async () => vi.advanceTimersByTimeAsync(600_000)); await flush();
    expect(reads()).toHaveLength(1);
    await render([]); await render(); expect(reads()).toHaveLength(1);
  });

  it('joins concurrent aliases while preserving the original request spelling', async () => {
    const held = deferred(); fetchMock.mockReturnValue(held.promise);
    await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }]); expect(reads()).toHaveLength(1);
    expect(reads()[0][0]).toBe('/api/panel/prs/7?repo=Org%2FSample');
    await act(async () => held.resolve(response())); await flush(); expect(host.textContent?.match(/Known change/g)).toHaveLength(2);
  });

  it('reuses the shared warm window through remounts and repository aliases', async () => {
    await render(); await render([]); await act(async () => vi.advanceTimersByTimeAsync(90_000));
    await render([{ repo: 'org/sample' }]); expect(reads()).toHaveLength(1); expect(host.textContent).toContain('Known change');
  });

  it('refreshes after shared freshness expires', async () => {
    await render(); await render([]); await act(async () => vi.advanceTimersByTimeAsync(GITHUB_LIST_FRESH_MS + 1));
    fetchMock.mockResolvedValue(response(7, 'Fresh change')); await render();
    expect(reads()).toHaveLength(2); expect(host.textContent).toContain('Fresh change');
  });

  it.each(['http', 'json', 'network', 'api', 'shape', 'identity', 'repo', 'state', 'row'])('retains the selected detail after %s failure and recovers with Retry', async kind => {
    await render();
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(kind === 'http' ? Response.json({}, { status: 503 })
      : kind === 'json' ? new Response('invalid-json')
      : kind === 'api' ? Response.json({ error: 'Unavailable', pr: detail(7, 'Invalid API change') })
      : kind === 'identity' ? response(9, 'Wrong PR')
      : kind === 'repo' ? Response.json({ pr: { ...detail(7, 'Wrong repository'), resolvedRepo: 'org/other' } })
      : kind === 'state' ? Response.json({ pr: { ...detail(), state: 'unknown' } })
      : kind === 'row' ? Response.json({ pr: { ...detail(), files: [null] } })
      : Response.json({ pr: { ...detail(), files: {} } }));
    await refresh(); expect(host.textContent).toContain('Known change'); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    fetchMock.mockResolvedValue(response(7, 'Recovered change')); await retry();
    expect(host.textContent).toContain('Recovered change'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('retries an initial invalid response without rendering an invented PR', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unavailable', pr: null })); await render();
    expect(host.textContent).toContain('PR #7'); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await retry(); expect(host.textContent).toContain('Known change');
  });

  it.each([{ repo: 'org/other', number: 7 }, { repo: 'Org/Sample', number: 8 }, { repo: null, number: 7 }])('isolates a new selection: %j', async selection => {
    await render(); const held = deferred(); fetchMock.mockReturnValueOnce(held.promise); await render([selection]);
    expect(host.textContent).not.toContain('Known change'); expect(host.textContent).toContain(`Loading PR #${selection.number}`);
    await act(async () => held.resolve(response(selection.number, 'Other selection'))); await flush(); expect(host.textContent).toContain('Other selection');
    await render(); expect(host.textContent).toContain('Known change'); expect(host.textContent).not.toContain('Other selection');
  });

  it('cancels abandoned reads and discards late replies rather than seeding obsolete detail', async () => {
    const held = deferred(); fetchMock.mockReturnValueOnce(held.promise); await render();
    const oldSignal = reads()[0][1].signal as AbortSignal;
    fetchMock.mockResolvedValue(response(8, 'Other selection')); await render([{ repo: 'Org/Sample', number: 8 }]); expect(oldSignal.aborted).toBe(true);
    await act(async () => held.resolve(response(7, 'Obsolete change'))); await flush(); expect(host.textContent).not.toContain('Obsolete change');
    fetchMock.mockResolvedValue(response(7, 'Current change')); await render(); expect(host.textContent).toContain('Current change'); expect(reads()).toHaveLength(3);
  });

  it('keeps one shared read alive while another alias observer remains', async () => {
    const held = deferred(); fetchMock.mockReturnValue(held.promise); await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }]);
    const signal = reads()[0][1].signal as AbortSignal;
    await render([{ repo: 'org/sample' }]); expect(signal.aborted).toBe(false); expect(reads()).toHaveLength(1);
    await act(async () => held.resolve(response())); await flush(); expect(host.textContent).toContain('Known change');
  });

  it('keeps inactive details idle and uses warm data on reactivation', async () => {
    await render([{ repo: 'Org/Sample', active: false }]); expect(reads()).toHaveLength(0);
    await render(); await render([{ repo: 'Org/Sample', active: false }]); await render(); expect(reads()).toHaveLength(1);
  });

  it('preserves fast running-check polling and background request labels without duplicate alias reads', async () => {
    fetchMock.mockImplementation(async () => Response.json({ pr: { ...detail(), statusCheckRollup: [{ name: 'test', status: 'in_progress' }] } }));
    await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[role=tab][id$="-checks"]')!.click(); });
    await act(async () => vi.advanceTimersByTimeAsync(30_000)); await flush();
    expect(reads()).toHaveLength(2); expect(reads()[1][0]).toContain('&poll=1');
  });

  it('keeps the summary on the two-minute poll interval', async () => {
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][id$="-summary"]')!.click()); await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(reads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(90_000)); await flush(); expect(reads()).toHaveLength(2); expect(reads()[1][0]).toContain('&poll=1');
  });

  it('does not read while the document is hidden and refreshes on return', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get'); await render(); visibility.mockReturnValue('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(120_000)); expect(reads()).toHaveLength(1);
    visibility.mockReturnValue('visible'); await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await flush(); expect(reads()).toHaveLength(2);
  });

  it('retains known checks and respects quota backoff before the next scheduled read', async () => {
    fetchMock.mockImplementation(async () => Response.json({ pr: { ...detail(), statusCheckRollup: [{ name: 'test', status: 'in_progress' }] } }));
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][id$="-checks"]')!.click()); fetchMock.mockResolvedValueOnce(Response.json({ error: 'GitHub refresh is paused.' }, { status: 429, headers: { 'retry-after': '120' } }));
    await act(async () => vi.advanceTimersByTimeAsync(30_000)); await flush(); expect(reads()).toHaveLength(2);
    expect(host.textContent).toContain('Known change'); expect(host.textContent).toContain('GitHub refresh is paused.');
    await act(async () => vi.advanceTimersByTimeAsync(90_000)); expect(reads()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(31_000)); await flush(); expect(reads()).toHaveLength(3);
  });

  it('invalidates inactive details after a confirmed comment across repository aliases', async () => {
    await render(); await render([], { repo: 'org/sample' }); fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    fetchMock.mockResolvedValue(response(7, 'After comment')); await render(); expect(host.textContent).toContain('After comment');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); expect(reads()).toHaveLength(2);
  });

  it('supersedes a pre-comment read and does not repeat the confirmed write', async () => {
    await render([{ repo: 'Org/Sample' }], { repo: 'Org/Sample' }); const held = deferred(); let firstRead = true;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(Response.json({ ok: true }));
      if (firstRead) { firstRead = false; return held.promise; }
      return Promise.resolve(response(7, 'After comment'));
    });
    await refresh(); const oldSignal = reads().at(-1)![1].signal as AbortSignal;
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    expect(oldSignal.aborted).toBe(true); expect(host.textContent).toContain('After comment');
    await act(async () => held.resolve(response(7, 'Before comment'))); await flush(); expect(host.textContent).not.toContain('Before comment');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});


it('invalidates a default-scope snapshot only when its resolved repository matches the confirmed write', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ pr: { ...detail(), resolvedRepo: 'org/sample' } }));
  await render([{ repo: null }]); await render([], { repo: 'org/sample' });
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
  fetchMock.mockResolvedValue(Response.json({ pr: { ...detail(7, 'Default after comment'), resolvedRepo: 'org/sample' } }));
  await render([{ repo: null }]); expect(host.textContent).toContain('Default after comment'); expect(reads()).toHaveLength(2);
});

it('keeps checks polling fast through a refresh and slows it when leaving checks', async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][id$="-checks"]')!.click());
  fetchMock.mockImplementation(async () => Response.json({ pr: { ...detail(), statusCheckRollup: [{ name: 'test', status: 'in_progress' }] } }));
  await refresh();
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); await flush(); expect(reads()).toHaveLength(3);
  fetchMock.mockResolvedValue(response()); await refresh();
  await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][id$="-summary"]')!.click());
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(reads()).toHaveLength(4);
  await act(async () => vi.advanceTimersByTimeAsync(90_000)); await flush(); expect(reads()).toHaveLength(5);
});
