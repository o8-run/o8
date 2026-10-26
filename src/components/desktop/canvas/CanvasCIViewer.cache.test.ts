// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CIViewer } from './CanvasCIViewer';

const repoA = 'org/alpha';
const repoB = 'org/beta';
const run = (databaseId: number, title = `Run ${databaseId}`) => ({
  databaseId, displayTitle: title, event: 'push', headBranch: 'feature', status: 'completed', conclusion: 'success',
  createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:01:00Z', workflowName: 'Build', url: 'https://example.invalid/run',
});

const list = (title = 'Known run', number = 11) => Response.json({ repo: repoA, runs: [run(number, title), run(12)] });
const detail = (number: number, repo = repoA) => Response.json({
  run: { ...run(number, `Detail ${number} ${repo}`), jobs: [], annotations: [], botComments: [] }, logs: `Logs ${number} ${repo}`,
});
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
const lists = () => fetchMock.mock.calls.filter(([url]) => new URL(String(url), 'https://fixture.invalid').pathname === '/api/panel/ci');
const details = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/ci/'));
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent !== 'Retry');
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(count = 1, repo: string | null = repoA, initialRunId?: number) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(CIViewer, { key, repo: repo ?? undefined, initialRunId })),
  )));
  await settle(); await settle();
}
async function invalidate() { await act(async () => { await client.invalidateQueries(); }); await settle(); await settle(); }
async function retry() {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
  await settle(); await settle();
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { resolve, promise };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, 'https://fixture.invalid');
    return url.pathname === '/api/panel/ci' ? list() : detail(Number(url.pathname.split('/').pop()), url.searchParams.get('repo') ?? repoA);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Canvas CI shared run-list snapshots through the real viewer', () => {
  it('shows the organization coverage state returned by the CI route', async () => {
    await render();
    fetchMock.mockImplementation(async () => Response.json({ code: 'github_org_not_covered', error: "GitHub sign-in doesn't cover organization repos yet", runs: [] }, { status: 422 }));
    await invalidate();
    expect(host.textContent).toContain("GitHub sign-in doesn't cover organization repos yet");
    expect(host.textContent).not.toContain('Known run');
  });
  it('shares one list read across five mounted viewers', async () => {
    await render(5); expect(rows()).toHaveLength(10); expect(lists()).toHaveLength(1);
    expect(host.textContent?.match(/Known run/g)).toHaveLength(5);
  });

  it('reuses a fresh snapshot on remount and canonicalizes repository casing', async () => {
    await render(); await render(0); await render(1, ' ORG/ALPHA ');
    expect(lists()).toHaveLength(1); expect(host.textContent).toContain('Known run');
  });

  it('stops polling with no viewers and refreshes a stale snapshot on remount', async () => {
    await render(); await render(0); await settle(180_000);
    expect(lists()).toHaveLength(1);
    fetchMock.mockImplementation(async () => list('Updated run'));
    await render(); expect(lists()).toHaveLength(2); expect(host.textContent).toContain('Updated run');
  });

  it.each([false, true])('uses the shared polling interval when hidden=%s', async hidden => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
    const startedAt = Date.now();
    await render(5);
    const interval = hidden ? 300_000 : 120_000;
    await settle(interval - 1 - (Date.now() - startedAt)); expect(lists()).toHaveLength(1);
    fetchMock.mockImplementation(async () => list('Polled run'));
    await settle(1); await settle(1);
    expect(lists()).toHaveLength(2); expect(host.textContent?.match(/Polled run/g)).toHaveLength(5);
  });

  it.each(['http', 'api', 'json', 'shape'] as const)('retains known rows and their age after a failed %s refresh, then retries', async failure => {
    await render(2);
    fetchMock.mockImplementation(async () => failure === 'http' ? new Response(null, { status: 429 })
      : failure === 'api' ? Response.json({ error: 'Unavailable', runs: [] })
        : failure === 'json' ? new Response('not JSON') : Response.json({ runs: null }));
    await settle(60_000); await invalidate();
    expect(host.textContent?.match(/Known run/g)).toHaveLength(2);
    expect(host.textContent).toContain('Showing last successful CI runs');
    expect(host.textContent).toContain('1m ago');
    fetchMock.mockImplementation(async () => list('Recovered run'));
    await retry();
    expect(host.textContent?.match(/Recovered run/g)).toHaveLength(2);
    expect(host.textContent).not.toContain('Showing last successful CI runs');
    expect(lists()).toHaveLength(3);
  });

  it('offers Retry after an initial failure without claiming the repository has no runs', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await render(); expect(host.textContent).toContain('Unable to load CI runs');
    expect(host.textContent).not.toContain('No workflow runs found');
    fetchMock.mockImplementation(async () => list()); await retry();
    expect(host.textContent).toContain('Known run'); expect(lists()).toHaveLength(2);
  });

  it('accepts an authoritative successful empty list', async () => {
    await render(); fetchMock.mockImplementation(async () => Response.json({ repo: repoA, runs: [] }));
    await invalidate(); expect(host.textContent).toContain('No workflow runs found');
    expect(host.textContent).not.toContain('Known run');
  });

  it('keeps the default repository lookup separate from explicit repository snapshots', async () => {
    await render(2, null); expect(lists()).toHaveLength(1); expect(lists()[0][0]).toBe('/api/panel/ci');
    await render(2, repoA); expect(lists()).toHaveLength(2);
  });

  it('aborts the previous repository list and ignores its late reply', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    await render(); const previous = lists()[0][1]?.signal;
    fetchMock.mockImplementation(async () => list('Other repository run', 21));
    await render(1, repoB); expect(host.textContent).toContain('Other repository run');
    expect(previous?.aborted).toBe(true);
    await act(async () => pending.resolve(list('Late old repository run'))); await settle();
    expect(host.textContent).not.toContain('Late old repository run');
  });

  it('selects a new initial run without refetching the fresh list', async () => {
    await render(1, repoA, 11); expect(host.textContent).toContain(`Detail 11 ${repoA}`);
    await render(1, repoA, 12); expect(host.textContent).toContain(`Detail 12 ${repoA}`);
    expect(lists()).toHaveLength(1);
    expect(details().map(([url]) => url)).toEqual(['/api/panel/ci/11?repo=org%2Falpha', '/api/panel/ci/12?repo=org%2Falpha']);
  });

  it('preserves the selected run, detail and list scroll during background refresh', async () => {
    await render(1, repoA, 11);
    await act(async () => rows()[1].click());
    await settle();
    expect(host.textContent).toContain(`Detail 12 ${repoA}`);
    const scroller = rows()[0].parentElement!; scroller.scrollTop = 140;
    const detailCount = details().length;
    await settle(120_000); await settle();
    expect(lists()).toHaveLength(2); expect(details()).toHaveLength(detailCount);
    expect(host.textContent).toContain(`Detail 12 ${repoA}`); expect(scroller.scrollTop).toBe(140);
  });

  it('clears a selected old-repository run rather than requesting it from the new repository', async () => {
    await render(); await act(async () => rows()[0].click());
    await settle();
    expect(host.textContent).toContain(`Logs 11 ${repoA}`);
    fetchMock.mockImplementation(async input => String(input).startsWith('/api/panel/ci?') ? list('Other repository run', 21) : detail(11, repoB));
    await render(1, repoB);
    expect(host.textContent).not.toContain('Logs 11');
    expect(host.textContent).toContain('Select a run to view details'); expect(details()).toHaveLength(1);
  });

  it('aborts superseded detail reads and never restores old logs after the new detail fails', async () => {
    await render(1, repoA, 11);
    const pending = deferred();
    fetchMock.mockImplementation(async input => String(input).startsWith('/api/panel/ci?') ? list() : pending.promise);
    await act(async () => rows()[1].click());
    await settle();
    const signal = details().at(-1)![1]?.signal;
    fetchMock.mockImplementation(async input => String(input).startsWith('/api/panel/ci?') ? list('Other run', 21) : new Response(null, { status: 503 }));
    await render(1, repoB, 21);
    expect(signal?.aborted).toBe(true);
    expect(host.textContent).not.toContain(`Logs 11 ${repoA}`);
    await act(async () => pending.resolve(detail(12))); await settle();
    expect(host.textContent).not.toContain(`Logs 12 ${repoA}`);
    expect(host.textContent).toContain('Unable to load run details');
  });

  it('keeps a shared request alive until its last viewer unmounts', async () => {
    const pending = deferred(); fetchMock.mockImplementation(() => pending.promise);
    await render(2); const signal = lists()[0][1]?.signal;
    await render(1); expect(signal?.aborted).toBe(false);
    await render(0); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(list()));
  });

  it('lets Retry cancel an older background read without losing the newer result', async () => {
    await render();
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await invalidate();
    const pending = deferred(); fetchMock.mockImplementationOnce(() => pending.promise);
    let background!: Promise<void>;
    await act(async () => { background = client.invalidateQueries(); });
    const signal = lists().at(-1)![1]?.signal;
    fetchMock.mockImplementation(async () => list('Newer retry result'));
    await retry(); expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(list('Superseded background result')); await background; });
    await settle(); expect(host.textContent).toContain('Newer retry result');
    expect(host.textContent).not.toContain('Superseded background result');
  });

  it('does not show previous detail while the same run number loads in another repository', async () => {
    await render(1, repoA, 11); expect(host.textContent).toContain(`Logs 11 ${repoA}`);
    const pending = deferred();
    fetchMock.mockImplementation(async input => String(input).startsWith('/api/panel/ci?') ? list('Other run') : pending.promise);
    await render(1, repoB, 11);
    expect(host.textContent).toContain('Loading run details');
    expect(host.textContent).not.toContain(`Logs 11 ${repoA}`);
    await act(async () => pending.resolve(detail(11, repoB)));
    await settle();
    expect(host.textContent).toContain(`Logs 11 ${repoB}`);
  });

  it('clears selection when a successful refresh removes the selected run', async () => {
    await render(1, repoA, 11);
    fetchMock.mockImplementation(async () => Response.json({ repo: repoA, runs: [run(12)] }));
    await invalidate();
    expect(host.textContent).not.toContain(`Logs 11 ${repoA}`);
    expect(host.textContent).toContain('Select a run to view details');
  });
});


describe('CI run-list quota deadlines through the real viewer', () => {
  const cases: Array<{ label: string; status: number; headers: () => HeadersInit; delay: number }> = [
    { label: 'numeric', status: 429, headers: () => ({ 'retry-after': '360' }), delay: 360_000 },
    { label: 'HTTP-date', status: 403, headers: () => ({ 'retry-after': new Date(Date.now() + 360_000).toUTCString() }), delay: 360_000 },
    { label: 'reset', status: 403, headers: () => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() / 1000 + 360) }), delay: 360_000 },
    { label: 'later reset', status: 429, headers: () => ({ 'retry-after': '10', 'x-ratelimit-reset': String(Date.now() / 1000 + 360) }), delay: 360_000 },
    { label: 'missing', status: 429, headers: () => ({}), delay: 60_000 },
    { label: 'invalid', status: 429, headers: () => ({ 'retry-after': 'invalid' }), delay: 60_000 },
  ];

  it.each(cases)('shares the $label pause across remounts and recovers mounted viewers at expiry', async ({ status, headers, delay }) => {
    const deadline = Date.now() + delay;
    fetchMock.mockImplementation(async () => new Response(null, { status, headers: headers() }));
    await render(); expect(lists()).toHaveLength(1); expect(host.textContent).toContain('Unable to load CI runs');
    await render(0); await settle(deadline - Date.now() - 1000); await render(3);
    expect(lists()).toHaveLength(1); await invalidate(); expect(lists()).toHaveLength(1);
    fetchMock.mockImplementation(async () => list('Recovered run'));
    await settle(1100); await settle();
    expect(lists()).toHaveLength(2); expect(host.textContent?.match(/Recovered run/g)).toHaveLength(3);
  });

  it('keeps known rows, age, selected detail and scroll while visible polling is paused', async () => {
    await render(1, repoA, 11); const scroller = rows()[0].parentElement!; scroller.scrollTop = 140;
    const detailCount = details().length;
    fetchMock.mockImplementation(async input => String(input).startsWith('/api/panel/ci?')
      ? new Response(null, { status: 429, headers: { 'retry-after': '360' } }) : detail(11));
    await settle(60_000);
    await act(async () => { await client.invalidateQueries({ queryKey: ['gh', repoA, 'ci'], exact: true }); });
    await settle(); await settle();
    expect(host.textContent).toContain('Showing last successful CI runs'); expect(host.textContent).toContain('1m ago');
    await settle(300_000); expect(lists()).toHaveLength(2); expect(host.textContent).toContain('Known run');
    expect(host.textContent).toContain(`Logs 11 ${repoA}`); expect(details()).toHaveLength(detailCount); expect(scroller.scrollTop).toBe(140);
    fetchMock.mockImplementation(async () => list('Recovered run'));
    await settle(60_100); await settle();
    expect(lists()).toHaveLength(3); expect(host.textContent).toContain('Recovered run');
    expect(host.textContent).not.toContain('Showing last successful CI runs');
  });

  it('suppresses hidden polling during a pause and resumes afterwards', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fetchMock.mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '360' } }));
    await render(3); await settle(300_000); expect(lists()).toHaveLength(1);
    fetchMock.mockImplementation(async () => list('Recovered run'));
    await settle(60_100); await settle(); expect(lists()).toHaveLength(2); expect(host.textContent?.match(/Recovered run/g)).toHaveLength(3);
  });

  it('does not use the normal immediate retry policy for a quota refusal', async () => {
    client.setDefaultOptions({ queries: { retry: 1 } });
    fetchMock.mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }));
    await render(); await settle(5000);
    expect(lists()).toHaveLength(1); expect(host.textContent).toContain('Unable to load CI runs');
  });

  it('keeps the configured retry policy for ordinary failures', async () => {
    client.setDefaultOptions({ queries: { retry: 1 } });
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await render(); await settle(1100); await settle();
    expect(lists()).toHaveLength(2); expect(host.textContent).toContain('Known run');
  });

  it('lets explicit Retry bypass the pause and clears the timer after success', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }));
    await render(); fetchMock.mockImplementation(async () => list('Manual run')); await retry();
    expect(host.textContent).toContain('Manual run'); expect(lists()).toHaveLength(2);
    await settle(91_000); expect(lists()).toHaveLength(2);
  });

  it('keeps repository pauses independent and does no work after the last viewer closes', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }));
    await render(); fetchMock.mockImplementation(async () => list('Other run'));
    await render(1, repoB); expect(host.textContent).toContain('Other run'); expect(lists()).toHaveLength(2);
    await render(); expect(lists()).toHaveLength(2); expect(host.textContent).toContain('Unable to load CI runs');
    await render(0); await settle(91_000); expect(lists()).toHaveLength(2);
    await render(); expect(lists()).toHaveLength(3); expect(host.textContent).toContain('Other run');
  });

  it('does not defer an ordinary 403 carrying nonexhausted quota metadata', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 403, headers: {
      'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Date.now() / 1000 + 90),
    } }));
    await render(); await render(0); fetchMock.mockImplementation(async () => list()); await render();
    expect(lists()).toHaveLength(2); expect(host.textContent).toContain('Known run');
  });
});
