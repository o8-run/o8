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

const repo = { defaultBranch: 'main', addedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, storagePressureParkingDisabled: false, setup: { envMode: 'copy' as const, envFiles: [], installCommand: null, installOnCreateWorkspace: false, buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' as const }, id: 'widgets', name: 'widgets', localPath: '/fixture/widgets', remoteUrl: 'https://github.com/example/widgets' };
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let requests: string[];
let revision: number;

async function render(active = true) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(O8ActivityPane, { active, repoSlug: 'example/widgets', registeredRepos: [repo] })));
  });
}

async function signal(events: unknown) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('o8:realtime', { detail: { channel: 'realtime', event: 'batch', data: { events } } }));
  });
}

const history = { channel: 'history', event: 'history.snapshot', stream: 'session:codex-owned:fixture', seq: 1, data: { sessionKey: 'codex-owned:fixture', entries: [], replace: true } };
const count = (kind: string) => requests.filter(url => url.startsWith(`/api/panel/${kind}?`)).length;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  revision = 1;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('/api/panel/prs?')) return Response.json({ prs: [{ number: 7, title: `Retain input revision ${revision}`, state: 'OPEN', headRefName: 'fix/recovery', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }] });
    if (url.startsWith('/api/panel/issues?')) return Response.json({ issues: [] });
    if (url.startsWith('/api/panel/ci?')) return Response.json({ runs: [] });
    if (url.startsWith('/api/panel/commits?')) return Response.json({ commits: [{ hash: 'abcd123', message: 'Retain input', date: '2026-10-20T10:00:00Z' }] });
    return Response.json({});
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Activity realtime refresh boundary', () => {
  it('keeps the real feed while transcript-only batches make no additional list reads', async () => {
    await render();
    expect(host.textContent).toContain('Retain input revision 1');
    expect(['prs', 'issues', 'ci', 'commits'].map(count)).toEqual([1, 1, 1, 2]);
    expect(requests.filter(url => url.startsWith('/api/panel/commits?repo='))).toHaveLength(1);
    expect(requests.filter(url => url.startsWith('/api/panel/commits?workspace='))).toHaveLength(1);
    const initialRequests = [...requests];
    for (let seq = 1; seq <= 10; seq++) await signal([{ ...history, seq }]);
    expect(requests).toEqual(initialRequests);
    expect(['prs', 'issues', 'ci', 'commits'].map(count)).toEqual([1, 1, 1, 2]);
    expect(host.textContent).toContain('Retain input revision 1');
  });

  it.each(['review', 'inbox', 'mutation', 'runtime'])('refreshes a mixed history/%s batch immediately', async channel => {
    await render();
    revision = 2;
    await signal([history, { channel, event: `${channel}.snapshot` }]);
    expect(count('prs')).toBe(2);
    expect(host.textContent).toContain('Retain input revision 2');
  });

  it.each([null, [], [null], [{ channel: 'history', event: 'unknown' }]])('keeps conservative refresh for an unrecognized batch: %j', async events => {
    await render();
    revision = 2;
    await signal(events);
    expect(count('prs')).toBe(2);
    expect(host.textContent).toContain('Retain input revision 2');
  });

  it('keeps lifecycle refresh and reuses the fresh snapshot on reactivation', async () => {
    await render();
    revision = 2;
    await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    expect(host.textContent).toContain('Retain input revision 2');
    await render(false);
    revision = 3;
    await signal([{ channel: 'review', event: 'review.snapshot' }]);
    expect(count('prs')).toBe(2);
    await render();
    expect(count('prs')).toBe(2);
    expect(host.textContent).toContain('Retain input revision 2');
  });

  it('uses the shared two-minute visible missed-event fallback', async () => {
    vi.useFakeTimers();
    await render();
    revision = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(count('prs')).toBe(2);
    expect(host.textContent).toContain('Retain input revision 2');
  });
});
