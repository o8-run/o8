import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the exact GitHub panel responses so provider dispatch cannot change them.
const mocks = vi.hoisted(() => ({
  fetchPullRequestListPage: vi.fn(), fetchGitHubPullRequestDetail: vi.fn(), fetchGitHubPullRequestComments: vi.fn(),
  mergeGitHubPullRequest: vi.fn(), commentOnGitHubPullRequest: vi.fn(), listRepos: vi.fn(), getCachedRepoReadiness: vi.fn(),
}));
vi.mock('@/lib/github-broker/pull-request-list', () => ({ fetchPullRequestListPage: mocks.fetchPullRequestListPage }));
vi.mock('@/lib/github-broker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github-broker')>(),
  fetchGitHubPullRequestDetail: mocks.fetchGitHubPullRequestDetail,
  fetchGitHubPullRequestComments: mocks.fetchGitHubPullRequestComments,
  mergeGitHubPullRequest: mocks.mergeGitHubPullRequest,
  commentOnGitHubPullRequest: mocks.commentOnGitHubPullRequest,
}));
vi.mock('@/lib/repos/registry', () => ({ listRepos: mocks.listRepos }));
vi.mock('@/lib/repos/readiness', () => ({ getCachedRepoReadiness: mocks.getCachedRepoReadiness }));
vi.mock('@/lib/github-broker/pull-request-stack', () => ({ readPullRequestStack: vi.fn(async () => ({ status: 'unavailable' })) }));
vi.mock('@/lib/github-broker/pr-merge-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github-broker/pr-merge-gate')>(),
  assessPrMergeGate: vi.fn(async () => ({ allowed: true, snapshot: 'fixture-gate', checks: [] })),
}));

import { GET as listRoute } from './route';
import { GET as detailRoute, POST as writeRoute } from './[number]/route';
import { GET as commentsRoute } from './[number]/comments/route';

const tempDirs: string[] = [];
const params = { params: Promise.resolve({ number: '7' }) };
const head = 'a'.repeat(40);

beforeEach(() => {
  mocks.listRepos.mockResolvedValue([]);
  mocks.getCachedRepoReadiness.mockReturnValue(undefined);
  mocks.fetchPullRequestListPage.mockResolvedValue({ repo: 'example/workspace', nextPage: null, statsUnavailable: false, prs: [{ number: 7, title: 'Add widget', author: 'dev', avatarUrl: null, additions: 3, deletions: 1, checks: 'success', requestedReviewers: [], state: 'open', draft: false, headRefName: 'feat/widget', baseRefName: 'main', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/example/workspace/pull/7', labels: [] }] });
  mocks.fetchGitHubPullRequestComments.mockResolvedValue({ comments: [{ id: 11, author: 'reviewer', body: 'Nit', path: 'src/a.ts', line: 2, side: 'RIGHT', createdAt: '2026-01-02T00:00:00Z', state: 'COMMENTED', diffHunk: '@@', inReplyTo: null }], issueComments: [{ id: 12, body: 'Looks good', user: 'reviewer', created_at: '2026-01-02T00:00:00Z' }], reviews: [{ id: 13, state: 'APPROVED' }], discussionIncomplete: false });
  mocks.fetchGitHubPullRequestDetail.mockImplementation(async (_repo: string, number: number, review: Promise<string | null>) => ({ number, title: 'Add widget', body: 'Body', state: 'open', author: 'dev', headRefName: 'feat/widget', baseRefName: 'main', headSha: head, baseSha: 'b'.repeat(40), additions: 3, deletions: 1, changedFiles: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: null, mergedAt: null, mergeable: true, reviewDecision: await review, statusCheckRollup: [{ name: 'ci', status: 'completed', conclusion: 'success', url: null }], url: 'https://github.com/example/workspace/pull/7', files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' }] }));
  mocks.mergeGitHubPullRequest.mockResolvedValue({});
  mocks.commentOnGitHubPullRequest.mockResolvedValue({ id: 1 });
});
afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function githubCheckout(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'o8-gh-snapshot-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '--quiet', repoPath]);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'git@github.com:example/workspace.git']);
  return repoPath;
}
const post = (body: unknown) => writeRoute(new Request('http://localhost/api/panel/prs/7', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);

describe('GitHub panel responses stay byte-identical', () => {
  it('list, detail, comments and writes', async () => {
    const list = await listRoute(new Request(`http://localhost/api/panel/prs?view=list&repoPath=${encodeURIComponent(githubCheckout())}`));
    const detail = await detailRoute(new Request('http://localhost/api/panel/prs/7?repo=example%2Fworkspace'), params);
    const comments = await commentsRoute(new Request('http://localhost/api/panel/prs/7/comments?repo=example%2Fworkspace'), params);
    const merge = await post({ action: 'merge', repo: 'example/workspace', mergeMethod: 'squash', commitSha: head });
    const comment = await post({ action: 'comment', repo: 'example/workspace', comment: 'Thanks' });
    const receipt = await Promise.all([list, detail, comments, merge, comment].map(async (response) => `${response.status} ${await response.text()}`));
    expect(receipt).toMatchSnapshot();
    expect(mocks.fetchPullRequestListPage).toHaveBeenCalledWith('example/workspace', 'open', 1, expect.any(AbortSignal), 'updated', false);
    expect(mocks.mergeGitHubPullRequest).toHaveBeenCalledWith('example/workspace', 7, { deleteBranch: false, mergeMethod: 'squash', expectedHeadSha: head, beforePublish: expect.any(Function) });
    expect(mocks.commentOnGitHubPullRequest).toHaveBeenCalledWith('example/workspace', 7, 'Thanks');
  });
});
