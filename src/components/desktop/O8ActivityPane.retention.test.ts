// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: false }) }));
vi.mock('@/lib/operator/use-pr-link-destination', () => ({ usePrLinkDestinationFlag: () => 'app' }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock('./orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('./thoughts/mission-panel/useDirectiveProposals', () => ({
  useDirectiveProposals: () => ({ proposals: [], loading: false, error: null, accept: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('./o8-panel/O8DirectiveProposalDrawer', () => ({
  O8DirectiveProposalDrawer: () => null,
  hydrateProposalPrefs: () => {},
  markProposalsSeen: () => {},
  PROPOSALS_OPEN_KEY: 'test-proposals-open',
}));
vi.mock('./o8-panel/O8ActivityMissionControls', () => ({ O8ActivityMissionControls: () => null }));
vi.mock('./o8-panel/O8ActivityPacketRow', () => ({ O8ActivityPacketRow: () => null }));
vi.mock('./o8-panel/O8ProblemDossiers', () => ({ O8ProblemDossiers: () => null }));
vi.mock('./pr-panel/PrPanel', () => ({ PrPanel: () => null }));

import { O8ActivityPane } from './O8ActivityPane';

import type { RepoRegistryEntry } from '@/lib/repos/types';

const first: RepoRegistryEntry = { defaultBranch: 'main', addedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, storagePressureParkingDisabled: false, setup: { envMode: 'copy', envFiles: [], installCommand: null, installOnCreateWorkspace: false, buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' }, id: 'first', name: 'widgets', localPath: '/fixture/first', remoteUrl: 'https://github.com/Example/Widgets' };
const second = { ...first, id: 'second', name: 'other', localPath: '/fixture/second', remoteUrl: 'https://github.com/example/other' };
const checkout = { ...first, id: 'checkout', localPath: '/fixture/checkout' };
const registry = [first, second, checkout];
const streams = ['commits', 'prs', 'issues', 'ci'] as const;
type Stream = typeof streams[number];
type Failure = 'http' | 'json' | 'network' | 'api' | 'shape';
const titles = { commits: 'Commit', prs: 'Pull', issues: 'Issue', ci: 'Check' };
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let revision: number;
let failure: { stream: Stream; kind: Failure; repo?: string } | null;
let empty: boolean;
let localHistory: boolean;
let localFailed: boolean;
let pending: ((input: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
let requests: { url: string; signal?: AbortSignal | null }[];

function response(stream: Stream, repo: string, rev = revision) {
  const title = `${titles[stream]} ${repo} v${rev}`;
  const createdAt = '2026-10-20T10:00:00Z';
  if (stream === 'commits') return Response.json({ commits: empty ? [] : [{ hash: `${repo.includes('other') ? 'b' : 'a'}${rev.toString(16).padStart(6, '0')}`, message: title, date: createdAt }] });
  if (stream === 'prs') return Response.json({ prs: empty ? [] : [{ number: 7, title, state: 'OPEN', createdAt }] });
  if (stream === 'issues') return Response.json({ issues: empty ? [] : [{ number: 8, title, state: 'OPEN', createdAt }] });
  return Response.json({ runs: empty ? [] : [{ databaseId: 9, displayTitle: title, status: 'completed', conclusion: 'success', createdAt }] });
}

async function render(repo = first, allRepos = false) {
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(O8ActivityPane, { repoPath: repo.localPath, registeredRepos: allRepos ? [first, second] : registry, allRepos }))));
}
async function refresh() {
  await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
}
async function retry() {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Retry');
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function expectRevision(repo: string, rev: number, except?: Stream) {
  for (const stream of streams) if (stream !== except) expect(host.textContent).toContain(`${titles[stream]} ${repo} v${rev}`);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  revision = 1;
  failure = null;
  empty = false;
  localHistory = false;
  localFailed = false;
  pending = undefined;
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, signal: init?.signal });
    const held = pending?.(url, init);
    if (held) return held;
    const parsed = new URL(url, 'http://fixture.invalid');
    if (parsed.searchParams.has('workspace')) return localFailed
      ? Response.json({ error: 'This folder is no longer available' }, { status: 404 })
      : Response.json({ commits: localHistory ? [{ shortSha: 'cabcabc', subject: 'Local-only history', date: '2026-10-20T10:00:00Z' }] : [] });
    const stream = streams.find(s => parsed.pathname === `/api/panel/${s}`);
    if (!stream) return Response.json({ repos: [] });
    const repo = parsed.searchParams.get('repo')!;
    if (failure?.stream === stream && (!failure.repo || failure.repo === repo)) {
      if (failure.kind === 'network') throw new Error('offline');
      if (failure.kind === 'http') return Response.json({}, { status: 503 });
      if (failure.kind === 'json') return new Response('invalid-json');
      if (failure.kind === 'api') return Response.json({ ...await response(stream, repo).json(), error: 'temporarily unavailable' });
      return Response.json({ [stream === 'ci' ? 'runs' : stream]: {} });
    }
    return response(stream, repo);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('O8 Activity retained remote streams through the mounted pane', () => {
  for (const stream of streams) {
    it.each<Failure>(['http', 'json', 'network', 'api', 'shape'])(`${stream}: retains known rows on %s failure and accepts other streams and Retry`, async kind => {
      await render();
      expectRevision('Example/Widgets', 1);
      revision = 2;
      failure = { stream, kind };
      await refresh();
      expect(host.textContent).toContain(`${titles[stream]} Example/Widgets v1`);
      expectRevision('Example/Widgets', 2, stream);
      expect(host.textContent).toContain('GitHub sync delayed');
      failure = null;
      await retry();
      expectRevision('Example/Widgets', 2);
      expect(host.textContent).not.toContain('GitHub sync delayed');
    });
  }

  it('replaces retained rows with successful empty results', async () => {
    await render();
    empty = true;
    await refresh();
    for (const stream of streams) expect(host.textContent).not.toContain(`${titles[stream]} Example/Widgets v1`);
    expect(host.textContent).toContain('No activity yet');
    expect(host.textContent).not.toContain('GitHub sync delayed');
  });

  it('shows recovery on an initial failure without fabricating empty success', async () => {
    failure = { stream: 'prs', kind: 'http' };
    await render();
    expectRevision('Example/Widgets', 1, 'prs');
    expect(host.textContent).toContain('GitHub sync delayed');
    failure = null;
    await retry();
    expectRevision('Example/Widgets', 1);
  });

  it('isolates repositories and restores a previous scope only after its failed refresh', async () => {
    await render();
    revision = 2;
    failure = { stream: 'prs', kind: 'http' };
    await render(second);
    expect(host.textContent).not.toContain('Example/Widgets v1');
    expect(host.textContent).not.toContain('Pull example/other');
    expectRevision('example/other', 2, 'prs');
    await render();
    expect(host.textContent).toContain('Pull Example/Widgets v1');
    expect(host.textContent).not.toContain('example/other v2');
  });

  it('shares remote snapshots across checkouts while keeping local folder reads isolated', async () => {
    await render();
    revision = 2;
    await render(checkout);
    expectRevision('Example/Widgets', 1);
    failure = { stream: 'prs', kind: 'http' };
    revision = 3;
    await render();
    expect(host.textContent).toContain('Pull Example/Widgets v1');
    await render(checkout);
    expect(host.textContent).toContain('Pull Example/Widgets v1');
  });

  it('retains failures per repository in all-repository aggregation', async () => {
    await render(first, true);
    revision = 2;
    failure = { stream: 'prs', kind: 'json', repo: 'Example/Widgets' };
    await refresh();
    expect(host.textContent).toContain('Pull Example/Widgets v1');
    expectRevision('Example/Widgets', 2, 'prs');
    expectRevision('example/other', 2);
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it('never reuses local fallback commits after folder validation fails', async () => {
    empty = true;
    localHistory = true;
    await render();
    expect(host.textContent).toContain('Local-only history');
    failure = { stream: 'commits', kind: 'http' };
    localFailed = true;
    await refresh();
    expect(host.textContent).not.toContain('Local-only history');
    expect(host.textContent).toContain('This folder is no longer available');
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it('retains remote history while still surfacing a folder validation failure', async () => {
    await render();
    failure = { stream: 'commits', kind: 'http' };
    localFailed = true;
    await refresh();
    expect(host.textContent).toContain('Commit Example/Widgets v1');
    expect(host.textContent).toContain('This folder is no longer available');
    expect(host.textContent).toContain('GitHub sync delayed');
  });

  it('ignores a superseded shared read without cancelling it for other observers', async () => {
    let release!: (r: Response) => void;
    pending = url => url.includes('/prs?repo=Example%2FWidgets') ? new Promise(resolve => { release = resolve; }) : undefined;
    await render();
    const old = requests.find(r => r.url.includes('/prs?repo=Example%2FWidgets'))!;
    pending = undefined;
    revision = 2;
    await render(second);
    expect(old.signal?.aborted).toBe(false);
    await act(async () => release(response('prs', 'Example/Widgets', 1)));
    expectRevision('example/other', 2);
    expect(host.textContent).not.toContain('Example/Widgets v1');
    failure = { stream: 'prs', kind: 'http' };
    await render();
    expect(host.textContent).toContain('Pull Example/Widgets v1');
  });

  it('collapses overlapping events into one trailing refresh', async () => {
    await render();
    let release!: (r: Response) => void;
    pending = url => url.includes('/prs?') ? new Promise(resolve => { release = resolve; }) : undefined;
    await refresh();
    await refresh();
    await refresh();
    expect(requests.filter(r => r.url.includes('/prs?'))).toHaveLength(2);
    pending = undefined;
    revision = 2;
    await act(async () => release(response('prs', 'Example/Widgets', 1)));
    expect(requests.filter(r => r.url.includes('/prs?'))).toHaveLength(3);
    expectRevision('Example/Widgets', 2);
  });
});
