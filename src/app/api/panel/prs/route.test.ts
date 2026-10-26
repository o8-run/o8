import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureGitHubPullRequests } = vi.hoisted(() => ({
  ensureGitHubPullRequests: vi.fn(async () => ({
    prs: [],
    error: null,
    stale: false,
  })),
}));
const { fetchPullRequestListPage } = vi.hoisted(() => ({ fetchPullRequestListPage: vi.fn() }));
vi.mock('@/lib/github-broker/pull-request-list', () => ({ fetchPullRequestListPage }));

vi.mock('@/lib/github-broker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github-broker')>(),
  ensureGitHubPullRequests,
}));

import { GET } from './route';

const tempDirs: string[] = [];

afterEach(() => {
  ensureGitHubPullRequests.mockClear();
  fetchPullRequestListPage.mockReset();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('workspace pull request list entry point', () => {
  it('resolves the actual local origin and forwards pagination and ordering without loading the activity preview', async () => {
    const repoPath = transientRepo('https://github.com/example/workspace.git');
    const page = { repo: 'example/workspace', prs: [{ number: 25 }], nextPage: 3 };
    fetchPullRequestListPage.mockResolvedValue(page);
    const response = await GET(new Request(`http://localhost/api/panel/prs?view=list&state=open&page=2&sort=oldest&repoPath=${encodeURIComponent(repoPath)}`));
    expect(await response.json()).toEqual(page);
    expect(fetchPullRequestListPage).toHaveBeenCalledWith('example/workspace', 'open', 2, expect.any(AbortSignal), 'oldest', false);
    expect(ensureGitHubPullRequests).not.toHaveBeenCalled();
  });

  it.each(['state=unknown', 'page=0', 'page=1.5', 'page=NaN', 'sort=unknown'])('rejects invalid list controls: %s', async (query) => {
    const repoPath = transientRepo('https://github.com/example/workspace.git');
    const response = await GET(new Request(`http://localhost/api/panel/prs?view=list&${query}&repoPath=${encodeURIComponent(repoPath)}`));
    expect(response.status).toBe(400);
    expect(fetchPullRequestListPage).not.toHaveBeenCalled();
  });

  it('reports connection failure without exposing configuration internals', async () => {
    const repoPath = transientRepo('https://github.com/example/workspace.git');
    fetchPullRequestListPage.mockRejectedValue(new Error('Private configuration details'));
    const response = await GET(new Request(`http://localhost/api/panel/prs?view=list&repoPath=${encodeURIComponent(repoPath)}`));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Check your GitHub connection in Settings');
  });
});

function transientRepo(remote?: string): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'o8-pr-route-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '--quiet', repoPath]);
  if (remote) execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remote]);
  return repoPath;
}

describe('GET /api/panel/prs transient repos', () => {
  it('forwards an explicit fresh request to the broker instead of serving the TTL snapshot', async () => {
    const response = await GET(new Request('http://localhost/api/panel/prs?repo=example%2Ffresh&fresh=1'));
    expect(response.status).toBe(200);
    expect(ensureGitHubPullRequests).toHaveBeenCalledWith('example/fresh', { fresh: true });
  });
  it('resolves an unregistered local repo through its GitHub origin', async () => {
    const repoPath = transientRepo('git@github.com:example/transient.git');
    const response = await GET(new Request(
      `http://localhost/api/panel/prs?repo=transient&repoPath=${encodeURIComponent(repoPath)}`,
    ));

    expect(response.status).toBe(200);
    expect(ensureGitHubPullRequests).toHaveBeenCalledWith('example/transient');
  });

  it('returns an empty available response when a transient repo has no GitHub origin', async () => {
    const repoPath = transientRepo();
    const response = await GET(new Request(
      `http://localhost/api/panel/prs?repo=local-only&repoPath=${encodeURIComponent(repoPath)}`,
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prs: [], repo: null, unavailable: true });
    expect(ensureGitHubPullRequests).not.toHaveBeenCalled();
  });
});
