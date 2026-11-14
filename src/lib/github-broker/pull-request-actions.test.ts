import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transport: vi.fn(), head: vi.fn(), publication: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch: mocks.transport }));
vi.mock('./actions', () => ({ getGitHubPullRequestHeadRef: mocks.head }));
vi.mock('./publication', () => ({ publishGitHubPullRequest: mocks.publication }));
import { updateGitHubPullRequestMode } from './pull-request-actions';
const sha = 'a'.repeat(40);
beforeEach(() => { vi.resetAllMocks(); mocks.head.mockResolvedValue({ nodeId: 'pr-node', sha, state: 'open' }); });
describe('repository-bound PR mode actions', () => {
  it.each([['draft', 'convertPullRequestToDraft'], ['ready', 'markPullRequestReadyForReview'], ['disable-auto-merge', 'disablePullRequestAutoMerge']] as const)('confirms %s through the resolved PR node', async (action, mutation) => {
    mocks.transport.mockResolvedValue({ response: Response.json({ data: { [mutation]: { pullRequest: { id: 'pr-node' } } } }) });
    await updateGitHubPullRequestMode('example/repo', 7, action, { expectedHeadSha: sha, mergeMethod: 'rebase' });
    const [repo, path, init] = mocks.transport.mock.calls[0]; expect(repo).toBe('example/repo'); expect(path).toBe('/graphql');
    const body = JSON.parse(init.body); expect(body.variables.input.pullRequestId).toBe('pr-node');
  });
  it('routes auto-merge through shared publication with the caller head pin', async () => {
    await updateGitHubPullRequestMode('example/repo', 7, 'enable-auto-merge', { expectedHeadSha: sha, mergeMethod: 'rebase' });
    expect(mocks.publication).toHaveBeenCalledWith('example/repo', 7, 'enable-auto-merge', { expectedHeadSha: sha, mergeMethod: 'rebase' });
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('refuses a new head before any mutation', async () => {
    await expect(updateGitHubPullRequestMode('example/repo', 7, 'ready', { expectedHeadSha: 'b'.repeat(40) })).rejects.toThrow('changed'); expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('does not turn a GraphQL rejection or wrong receipt into success', async () => {
    mocks.transport.mockResolvedValue({ response: Response.json({ errors: [{ message: 'Denied' }] }) });
    await expect(updateGitHubPullRequestMode('example/repo', 7, 'draft')).rejects.toThrow('did not confirm');
    mocks.transport.mockResolvedValue({ response: Response.json({ data: { convertPullRequestToDraft: { pullRequest: { id: 'other-pr' } } } }) });
    await expect(updateGitHubPullRequestMode('example/repo', 7, 'draft')).rejects.toThrow('did not confirm'); expect(mocks.transport).toHaveBeenCalledTimes(2);
  });
});
