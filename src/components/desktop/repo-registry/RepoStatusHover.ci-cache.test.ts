// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { CIViewer } from '../canvas/CanvasCIViewer';
import { RepoStatusHover, type RepoStatusHoverProps } from './RepoStatusHover';

const repoA = 'example/alpha';
const repoB = 'example/beta';
const props: RepoStatusHoverProps = {
  repo: { id: 'fixture', name: 'Fixture', localPath: '/workspace/fixture', remoteUrl: `https://github.com/${repoA}`,
    defaultBranch: 'main', addedAt: '', lastOpenedAt: null, storagePressureParkingDisabled: false,
    setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
      buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' } },
  anchorRect: new DOMRect(20, 20, 200, 40), agents: [], githubSlug: repoA,
};
const run = (conclusion = 'failure') => ({ databaseId: 7, displayTitle: 'Shared run', event: 'push', headBranch: 'feature',
  status: 'completed', conclusion, createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:01:00Z',
  workflowName: 'Build', url: 'https://example.invalid/run' });
const payload = (repo = repoA, conclusion = 'failure') => ({ repo, runs: [run(conclusion)] });
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let reply: (repo: string, init?: RequestInit) => Response | Promise<Response>;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const reads = () => fetchMock.mock.calls.filter(([url]) => new URL(url, 'https://fixture.invalid').pathname === '/api/panel/ci');
const values = () => [...document.querySelectorAll('div')].filter(node => node.textContent === 'CI').map(node => node.nextElementSibling?.textContent);
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(entries: Partial<RepoStatusHoverProps>[] = [{}], canvas = false) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...entries.map((entry, key) => createElement(RepoStatusHover, { ...props, ...entry, key })),
    canvas ? createElement(CIViewer, { repo: repoA, key: 'canvas' }) : null,
  ))); await settle(); await settle();
}
async function retry() {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Retry CI status"]');
  expect(button).not.toBeNull(); await act(async () => button!.click()); await settle(); await settle();
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reply = repo => Response.json(payload(repo));
  fetchMock = vi.fn(async (input, init) => {
    const url = new URL(input, 'https://fixture.invalid');
    if (url.pathname === '/api/panel/ci') return reply(url.searchParams.get('repo')!, init);
    if (url.pathname === '/api/panel/prs') return Response.json({ prs: [] });
    if (url.pathname === '/api/panel/repo-status') return Response.json({ branch: 'feature' });
    throw new Error(`Unexpected fixture read: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one pending CI-list read across five actual status hovers', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(Array(5).fill({})); expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(Response.json(payload()))); await settle();
  expect(values()).toHaveLength(5); expect(values().every(value => value?.startsWith('Failing'))).toBe(true);
});
it('shares the same list and freshness with the real Canvas CI viewer', async () => {
  await render(Array(3).fill({}), true); expect(reads()).toHaveLength(1);
  expect(host.textContent).toContain('Shared run'); expect(values().every(value => value?.startsWith('Failing'))).toBe(true);
  await render([], true); await render([{}], true); expect(reads()).toHaveLength(1);
});
it('reuses a fresh snapshot after close, remount and repository casing changes', async () => {
  await render(); await render([{ anchorRect: null }]); await render();
  await render([]); await render([{ githubSlug: ' EXAMPLE/ALPHA ' }]);
  expect(reads()).toHaveLength(1); expect(values()[0]).toMatch(/^Failing/);
});
it('suppresses closed and no-remote reads, then reads when the hover opens', async () => {
  await render([{ anchorRect: null }, { githubSlug: null }]); expect(reads()).toHaveLength(0); expect(values()).toEqual(['No remote']);
  await render(); expect(reads()).toHaveLength(1); expect(values()[0]).toMatch(/^Failing/);
});
it.each([false, true])('uses the shared refresh interval while hidden=%s and stops when closed', async hidden => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  const started = Date.now(); await render(); const interval = hidden ? 300_000 : 120_000;
  reply = repo => Response.json(payload(repo, 'success'));
  await settle(interval - 1 - (Date.now() - started)); expect(reads()).toHaveLength(1);
  await settle(3); await settle(); expect(reads()).toHaveLength(2); expect(values()[0]).toMatch(/^Passing/);
  await render([{ anchorRect: null }]); await settle(600_000); expect(reads()).toHaveLength(2);
});
it.each(['http', 'network', 'json', 'api', 'shape'])('retains the known CI status and age after %s refresh failure, then retries', async failure => {
  await render(); reply = () => {
    if (failure === 'network') throw new Error('Fixture offline');
    return failure === 'http' ? new Response(null, { status: 429 }) : failure === 'json' ? new Response('invalid-json')
      : failure === 'api' ? Response.json({ error: 'Unavailable', runs: [] }) : Response.json({ runs: {} });
  };
  await settle(120_000); await settle(); expect(reads()).toHaveLength(2);
  expect(values()[0]).toMatch(/^Failing/); expect(document.body.textContent).toContain('Last known CI status');
  expect(document.body.textContent).toContain('2m ago'); expect(values()[0]).not.toContain('No runs');
  reply = repo => Response.json(payload(repo, 'success')); await retry();
  expect(values()[0]).toMatch(/^Passing/); expect(document.body.textContent).not.toContain('Last known CI status'); expect(reads()).toHaveLength(3);
});
it.each(['http', 'api', 'shape'])('offers initial %s recovery without claiming there are no runs', async failure => {
  reply = () => failure === 'http' ? new Response(null, { status: 503 }) : Response.json(failure === 'api' ? { error: 'Unavailable', runs: [] } : { runs: null });
  await render(); expect(values()[0]).toContain('CI unavailable'); expect(values()[0]).not.toContain('No runs');
  reply = repo => Response.json(payload(repo)); await retry(); expect(values()[0]).toMatch(/^Failing/); expect(reads()).toHaveLength(2);
});
it('accepts an authoritative successful empty list', async () => {
  await render(); reply = repo => Response.json({ repo, runs: [] });
  await settle(120_000); await settle(); expect(reads()).toHaveLength(2); expect(values()).toEqual(['No runs']);
});
it('hides retained CI status when organization access is uncovered', async () => {
  await render(); expect(values()[0]).toMatch(/^Failing/);
  reply = () => Response.json({ code: 'github_org_not_covered', error: "GitHub sign-in doesn't cover organization repos yet" }, { status: 422 });
  await settle(120_000); await settle();
  expect(values()[0]).toMatch(/^CI unavailable/);
  expect(values()[0]).not.toContain('Failing');
  expect(host.textContent).not.toContain('Last known CI status');
});
it('isolates repository switches and ignores obsolete late results', async () => {
  await render(); const pending = deferred(); reply = repo => repo === repoB ? pending.promise : Response.json(payload(repo));
  await render([{ githubSlug: repoB }]); expect(values()[0]).not.toContain('Failing');
  await render(); await act(async () => pending.resolve(Response.json(payload(repoB, 'success')))); await settle();
  expect(values()[0]).toMatch(/^Failing/); expect(reads()).toHaveLength(2);
});
it('aborts only after the last observer closes and ignores the late result', async () => {
  const pending = deferred(); reply = () => pending.promise; await render([{}, {}]);
  expect(reads()).toHaveLength(1); const signal = reads()[0][1]?.signal;
  await render([{ anchorRect: null }, {}]); expect(signal?.aborted).toBe(false);
  await render([{ anchorRect: null }, { anchorRect: null }]); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(payload(repoA, 'success')))); await settle();
  reply = repo => Response.json(payload(repo)); await render(); expect(values()[0]).toMatch(/^Failing/); expect(reads()).toHaveLength(2);
});
it.each(['seconds', 'date', 'reset'])('honors a %s quota deadline across reopen and recovers automatically', async kind => {
  await render();
  reply = () => new Response(null, { status: kind === 'date' ? 403 : 429, headers: kind === 'reset'
    ? { 'x-ratelimit-reset': String((Date.now() + 300_000) / 1000) }
    : { 'retry-after': kind === 'date' ? new Date(Date.now() + 300_000).toUTCString() : '300' } });
  await settle(120_000); await settle(); expect(reads()).toHaveLength(2); expect(values()[0]).toMatch(/^Failing/);
  await render([{ anchorRect: null }]); await render([]); await render(); expect(reads()).toHaveLength(2);
  reply = repo => Response.json(payload(repo, 'success'));
  await settle(299_000); expect(reads()).toHaveLength(2);
  await settle(1100); await settle(); expect(reads()).toHaveLength(3); expect(values()[0]).toMatch(/^Passing/);
});
