import { beforeEach, describe, expect, it, vi } from 'vitest';

const { githubInstallationFetch, hasGitHubBrokerAccess } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn(), hasGitHubBrokerAccess: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch, hasGitHubBrokerAccess }));
import { fetchPullRequestListPage } from './pull-request-list';

function pull(number: number) {
  return { number, node_id: `node-${number}`, title: `Change ${number}`, user: { login: 'author', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, state: 'open', merged_at: null, draft: false, head: { ref: 'work' }, base: { ref: 'main' }, updated_at: '2026-10-07T12:00:00Z', created_at: '2026-10-05T12:00:00Z', html_url: `https://github.com/example/repo/pull/${number}`, labels: [{ name: 'ui' }] };
}

beforeEach(() => { vi.clearAllMocks(); hasGitHubBrokerAccess.mockReturnValue(true); });

describe('paged pull request reads', () => {
  it('reads more than the activity cap, batches diff totals and checks, and preserves the next page', async () => {
    const pulls = Array.from({ length: 25 }, (_, index) => pull(index + 1));
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path === '/graphql'
      ? Response.json({ data: { nodes: pulls.map((pr) => ({ number: pr.number, additions: 27, deletions: 4, reviewRequests: { nodes: [{ requestedReviewer: { login: 'reviewer' } }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } })) } })
      : Response.json(pulls, { headers: { link: '<https://api.github.com/repos/example/repo/pulls?page=3>; rel="next"' } }),
    }));
    const result = await fetchPullRequestListPage('example/repo', 'open', 2, undefined, 'oldest');
    expect(result.prs).toHaveLength(25);
    expect(result.nextPage).toBe(3);
    expect(result.statsUnavailable).toBe(false);
    expect(result.prs[0]).toMatchObject({ additions: 27, deletions: 4, checks: 'success', requestedReviewers: ['reviewer'], avatarUrl: 'https://avatars.githubusercontent.com/u/1' });
    expect(githubInstallationFetch).toHaveBeenCalledTimes(2);
    expect(githubInstallationFetch.mock.calls[0][1]).toContain('per_page=100&sort=updated&direction=asc');
    const body = JSON.parse(githubInstallationFetch.mock.calls[1][2].body as string);
    expect(body.variables.ids).toEqual(pulls.map((pr) => pr.node_id));
  });

  it('keeps public reads available without a connection and marks unavailable stats honestly', async () => {
    hasGitHubBrokerAccess.mockReturnValue(false);
    githubInstallationFetch.mockResolvedValue({ response: Response.json([pull(1)]), anonymous: true });
    {
      const result = await fetchPullRequestListPage('example/repo', 'open', 1);
      expect(githubInstallationFetch).toHaveBeenCalledOnce();
      expect(result.prs[0].additions).toBeNull();
      expect(result.prs[0].requestedReviewers).toBeNull();
      expect(result.statsUnavailable).toBe(true);
    }
  });

  it('retains the list when optional summary access fails and distinguishes merged PRs', async () => {
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path === '/graphql') throw new Error('Summary access unavailable');
      return { response: Response.json([{ ...pull(7), state: 'closed', merged_at: '2026-10-07T12:00:00Z' }]) };
    });
    const result = await fetchPullRequestListPage('example/repo', 'closed', 1);
    expect(result.prs[0]).toMatchObject({ state: 'merged', additions: null, deletions: null, checks: null });
    expect(result.nextPage).toBeNull();
    expect(result.statsUnavailable).toBe(true);
  });
});
