import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolveRepoSlug: vi.fn(), reviewGitHubPullRequest: vi.fn(), commentOnGitHubPullRequest: vi.fn(), closeGitHubPullRequest: vi.fn(), mergeGitHubPullRequest: vi.fn(), fetchGitHubPullRequestDetail: vi.fn(), fetchGitHubPullRequestComments: vi.fn(), listRepos: vi.fn(), getCachedRepoReadiness: vi.fn(), getRepoReadiness: vi.fn(), deriveWorkflowStage: vi.fn(), updateGitHubPullRequestMode: vi.fn() }));
vi.mock('@/lib/github-broker', () => ({ ...mocks, DEFAULT_GITHUB_REPO: 'example/default' }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: mocks.listRepos }));
vi.mock('@/lib/repos/readiness', () => ({ getCachedRepoReadiness: mocks.getCachedRepoReadiness, getRepoReadiness: mocks.getRepoReadiness }));
vi.mock('@/lib/workflows/status', () => ({ deriveWorkflowStage: mocks.deriveWorkflowStage, describeWorkflowStage: () => ({ mergeAllowed: true, mergeDetail: 'Fixture workflow' }) }));
import { GET, POST } from './route';
beforeEach(() => {
  vi.clearAllMocks(); mocks.resolveRepoSlug.mockResolvedValue('example/repo');
  mocks.listRepos.mockResolvedValue([{ localPath: '/workspace/repo', remoteUrl: 'git@github.com:example/repo.git' }]);
  mocks.getCachedRepoReadiness.mockReturnValue(undefined);
  mocks.deriveWorkflowStage.mockReturnValue('review');
});
describe('pull request read entry point', () => {
  it('shares the existing reviews read and uses cached workspace readiness without starting probes', async () => {
    mocks.fetchGitHubPullRequestComments.mockResolvedValue({ comments: [], issueComments: [], reviews: [{ state: 'APPROVED' }, { state: 'COMMENTED' }] });
    mocks.fetchGitHubPullRequestDetail.mockImplementation(async (_repo, number, reviews) => ({ number, state: 'open', files: [], statusCheckRollup: [], reviewDecision: await reviews }));
    const response = await GET(new Request('http://localhost/api/panel/prs/5?repo=workspace'), { params: Promise.resolve({ number: '5' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).pr).toMatchObject({ number: 5, resolvedRepo: 'example/repo', readiness: null, reviewDecision: 'APPROVED' });
    expect(mocks.fetchGitHubPullRequestComments).toHaveBeenCalledTimes(1);
    expect(mocks.getCachedRepoReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.getRepoReadiness).not.toHaveBeenCalled();
  });
  it('returns a retryable, sanitized failure rather than saving an incomplete read', async () => {
    mocks.fetchGitHubPullRequestComments.mockRejectedValue(new Error('Private connection detail'));
    mocks.fetchGitHubPullRequestDetail.mockResolvedValue({ number: 5, files: [] });
    const response = await GET(new Request('http://localhost/api/panel/prs/5'), { params: Promise.resolve({ number: '5' }) });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('Private connection');
  });
});

const post = (body: unknown) => POST(new Request('http://localhost/api/panel/prs/5', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ number: '5' }) });
describe('pull request write entry point', () => {
  it.each(['merge', 'squash', 'rebase'])('keeps the branch and sends the reviewed head for %s', async (mergeMethod) => {
    const commitSha = 'b'.repeat(40);
    expect((await post({ action: 'merge', mergeMethod, commitSha })).status).toBe(200);
    expect(mocks.mergeGitHubPullRequest).toHaveBeenCalledWith('example/repo', 5, { deleteBranch: false, mergeMethod, expectedHeadSha: commitSha, beforePublish: expect.any(Function) });
  });
  it.each([{ action: 'merge' }, { action: 'merge', commitSha: 'a'.repeat(40), mergeMethod: 'bad' }, { action: 'enable-auto-merge', mergeMethod: 'squash' }])('refuses an unbound action', async (body) => {
    expect((await post(body)).status).toBe(400); expect(mocks.mergeGitHubPullRequest).not.toHaveBeenCalled(); expect(mocks.updateGitHubPullRequestMode).not.toHaveBeenCalled();
  });
  it.each(['draft', 'ready', 'enable-auto-merge', 'disable-auto-merge'])('uses the repository-bound handler for %s', async (action) => {
    const commitSha = 'c'.repeat(40);
    expect((await post({ action, commitSha, mergeMethod: 'rebase' })).status).toBe(200);
    expect(mocks.updateGitHubPullRequestMode).toHaveBeenCalledWith('example/repo', 5, action, { expectedHeadSha: commitSha, mergeMethod: 'rebase', ...(action === 'enable-auto-merge' ? { beforePublish: expect.any(Function) } : {}) });
  });
  it.each([['approve', 'APPROVE'], ['request-changes', 'REQUEST_CHANGES'], ['review-comment', 'COMMENT']])('submits %s against the supplied commit', async (action, event) => {
    const commitSha = 'a'.repeat(40);
    const response = await post({ action, repo: 'example/repo', comment: ' Feedback ', commitSha });
    expect(response.status).toBe(200);
    expect(mocks.reviewGitHubPullRequest).toHaveBeenCalledWith('example/repo', 5, { event, body: 'Feedback', commitSha });
    expect(mocks.commentOnGitHubPullRequest).not.toHaveBeenCalled();
  });
  it.each([null, { action: 'comment', comment: {} }, { action: 'approve', commitSha: 'wrong' }, { action: 'review-comment', comment: '  ' }, { action: 'close-with-comment', comment: '' }])('rejects invalid or empty write payloads', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.reviewGitHubPullRequest).not.toHaveBeenCalled(); expect(mocks.commentOnGitHubPullRequest).not.toHaveBeenCalled(); expect(mocks.closeGitHubPullRequest).not.toHaveBeenCalled();
  });
  it('reports a posted comment separately from an unconfirmed close and retries close without reposting', async () => {
    mocks.commentOnGitHubPullRequest.mockResolvedValue({ id: 1 });
    mocks.closeGitHubPullRequest.mockRejectedValueOnce(new Error('Private transport details')).mockResolvedValueOnce({});
    const response = await post({ action: 'close-with-comment', comment: 'Done' });
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ ok: false, commentPosted: true, error: 'Comment posted. Closing could not be confirmed.' });
    expect((await post({ action: 'close' })).status).toBe(200);
    expect(mocks.commentOnGitHubPullRequest).toHaveBeenCalledTimes(1); expect(mocks.closeGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.commentOnGitHubPullRequest.mock.invocationCallOrder[0]).toBeLessThan(mocks.closeGitHubPullRequest.mock.invocationCallOrder[0]);
  });
  it('does not close if posting the comment failed', async () => {
    mocks.commentOnGitHubPullRequest.mockRejectedValueOnce(new Error('Failed'));
    expect((await post({ action: 'close-with-comment', comment: 'Done' })).status).toBe(500);
    expect(mocks.closeGitHubPullRequest).not.toHaveBeenCalled();
  });
});
