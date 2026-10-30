// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { GET } from '@/app/api/panel/commits/route';
import { O8ActivityPane } from '@/components/desktop/O8ActivityPane';

vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: false }) }));
vi.mock('@/lib/operator/use-pr-link-destination', () => ({ usePrLinkDestinationFlag: () => 'panel' }));
vi.mock('@/components/desktop/orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('@/components/desktop/thoughts/mission-panel/useDirectiveProposals', () => ({ useDirectiveProposals: () => ({ proposals: [], pendingProposalId: null, handleAccept: vi.fn(), handleDismiss: vi.fn() }) }));
vi.mock('@/components/desktop/o8-panel/O8ProblemDossiers', () => ({ O8ProblemDossiers: () => null }));
vi.mock('@/components/desktop/pr-panel/PrPanel', () => ({ PrPanel: () => null }));

const fixtures = mkdtempSync(join(os.tmpdir(), 'o8-activity-folder-'));
const plain = join(fixtures, 'plain-folder');
const empty = join(fixtures, 'empty-repo');
const local = join(fixtures, 'local-history');
mkdirSync(plain);
for (const dir of [empty, local]) execFileSync('git', ['init', '-q', '--initial-branch=main', dir]);
const git = (...args: string[]) => execFileSync('git', args, { cwd: local, encoding: 'utf8' });
git('config', 'user.name', 'Activity fixture');
git('config', 'user.email', 'activity@example.test');
git('commit', '--allow-empty', '-q', '-m', 'Local activity survives navigation');
writeFileSync(join(local, 'unsent-work.txt'), 'Preserve this local work.');

function entry(localPath: string, remoteUrl: string | null = null): RepoRegistryEntry {
  return { id: localPath, localPath, name: localPath.split('/').pop()!, remoteUrl,
    defaultBranch: 'main', isGitRepo: localPath !== plain, addedAt: new Date().toISOString(),
    lastOpenedAt: null, storagePressureParkingDisabled: false,
    setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
      buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
      workspaceIsolationPreference: 'auto' } };
}
const repos = [entry(plain), entry(empty), entry(local), entry(join(fixtures, 'other'), 'https://github.com/example/other.git')];
let host: HTMLDivElement; let root: Root;
let client: QueryClient;
let requests: string[];
let failLocal = false;
let remoteHistory = false;
let malformedRemote = false;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear(); requests = []; failLocal = false; remoteHistory = false; malformedRemote = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://127.0.0.1'); requests.push(url.pathname + url.search);
    if (url.pathname === '/api/panel/commits' && url.searchParams.has('workspace')) {
      if (failLocal) throw new Error('Fixture transport interrupted');
      return GET(new NextRequest(url));
    }
    if (malformedRemote && url.searchParams.has('repo')) return new Response('Invalid remote response');
    if (remoteHistory && url.pathname === '/api/panel/commits') return Response.json({ commits: [{ hash: 'abcdef123', message: 'Remote history remains available', date: new Date().toISOString() }] });
    if (url.pathname === '/api/panel/repos') return Response.json({ repos: [] });
    return Response.json({ commits: [], prs: [], issues: [], runs: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

async function settle() {
  for (let i = 0; i < 100 && host.textContent?.includes('Loading activity'); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}
async function show(repoPath: string) {
  await act(async () => root.render(pane({ repoPath, registeredRepos: repos })));
  await settle();
}
function pane(props: ComponentProps<typeof O8ActivityPane>) {
  return createElement(QueryClientProvider, { client }, createElement(O8ActivityPane, props));
}
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().replace(/\s*\d+$/, "") === label);
  expect(button, `Expected visible ${label}`).toBeDefined();
  await act(async () => button!.click()); await settle();
};

describe('Activity selected-folder real path', () => {
  it('keeps a non-Git folder selected and never substitutes another registered remote', async () => {
    await show(plain);
    expect(host.textContent).toContain('This folder is not a Git repository');
    expect(host.textContent).not.toContain('No commits yet');
    expect(host.textContent).not.toContain('Attach a repo');
    expect(requests.some((url) => url.includes('repo=example%2Fother'))).toBe(false);
    expect(host.querySelector('[title="Switch repository"]')?.textContent).toContain('plain-folder');
  });

  it('distinguishes an empty Git repository from a missing folder', async () => {
    await show(empty);
    expect(host.textContent).toContain('No commits yet in empty-repo');
    await show(join(fixtures, 'missing-folder'));
    expect(host.textContent).toContain('This folder is no longer available');
    expect(host.textContent).not.toContain('No commits yet');
  });

  it('shows real local history without a remote through filters and reentry', async () => {
    await show(local);
    expect(host.textContent).toContain('Local activity survives navigation');
    await click('PRs');
    expect(host.textContent).toContain('Connect GitHub');
    await click('Commits');
    expect(host.textContent).toContain('Local activity survives navigation');
    await show(plain); await show(local);
    expect(host.textContent).toContain('Local activity survives navigation');
    expect(git('status', '--porcelain')).toContain('unsent-work.txt');
    expect(requests.filter((url) => /\?repo=/.test(url))).toEqual([]);
  });

  it('keeps failed reads explicit and retries the same selected folder', async () => {
    failLocal = true; await show(local);
    expect(host.textContent).toContain('Could not load local commit activity');
    failLocal = false; await click('Retry');
    expect(host.textContent).toContain('Local activity survives navigation');
    expect(host.querySelector('[title="Switch repository"]')?.textContent).toContain('local-history');
  });

  it('keeps local errors and Retry visible beside valid remote history', async () => {
    remoteHistory = true;
    const selected = entry(plain, 'https://github.com/example/selected.git');
    await act(async () => root.render(pane({ repoPath: plain, registeredRepos: [selected] })));
    await settle();
    expect(host.textContent).toContain('Remote history remains available');
    expect(host.textContent).toContain('This folder is not a Git repository');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(true);
  });

  it('keeps healthy local history when one All-repos remote returns malformed data', async () => {
    malformedRemote = true;
    await act(async () => root.render(pane({ allRepos: true, registeredRepos: repos })));
    await settle();
    expect(host.textContent).toContain('Local activity survives navigation');
    expect(host.textContent).toContain('Some folders could not be read');
  });

  it('does not report a failed Git executable as an empty successful history', async () => {
    const previous = process.env.PATH;
    process.env.PATH = join(fixtures, 'no-executables');
    try {
      const response = await GET(new NextRequest(`http://127.0.0.1/api/panel/commits?workspace=${encodeURIComponent(local)}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ workspaceState: 'git_error', code: 'REVIEW_GIT_UNAVAILABLE' });
    } finally { process.env.PATH = previous; }
  });
});
