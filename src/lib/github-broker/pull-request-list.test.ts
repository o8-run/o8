import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('reports which pull requests wait in the merge queue', async () => {
    const pulls = [pull(1), pull(2)];
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path === '/graphql'
      ? Response.json({ data: { nodes: [
        { number: 1, additions: 1, deletions: 0, reviewRequests: { nodes: [] }, commits: { nodes: [] }, mergeQueueEntry: { position: 2, state: 'AWAITING_CHECKS', enqueuedAt: '2026-11-17T02:00:00Z', estimatedTimeToMerge: 540 } },
        { number: 2, additions: 1, deletions: 0, reviewRequests: { nodes: [] }, commits: { nodes: [] }, mergeQueueEntry: null },
      ] } })
      : Response.json(pulls),
    }));
    const result = await fetchPullRequestListPage('example/repo', 'open', 1);
    expect(result.prs[0].mergeQueue).toEqual({ position: 2, state: 'checking', enqueuedAt: '2026-11-17T02:00:00Z', estimatedSeconds: 540 });
    expect(result.prs[1].mergeQueue).toBeNull();
    expect(JSON.parse(githubInstallationFetch.mock.calls[1][2].body as string).query).toContain('mergeQueueEntry { position state enqueuedAt estimatedTimeToMerge }');
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

  // #5169: the o8-run/o8 list hung past its 15 s GitHub timeout because a
  // stalled response body ignored the abort. Every wait is bounded now.
  describe('a stalled GitHub response (#5169)', () => {
    const stalled = () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
    function shortDeadline() {
      const deadlines: number[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('GitHub read timed out.', 'TimeoutError')), 40);
        return controller.signal;
      });
      return deadlines;
    }
    afterEach(() => { vi.restoreAllMocks(); });

    it('answers at its own deadline when the list body never finishes', async () => {
      const deadlines = shortDeadline();
      githubInstallationFetch.mockResolvedValue({ response: stalled() });
      const started = Date.now();
      await expect(fetchPullRequestListPage('example/repo', 'open', 1)).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(deadlines).toEqual([15_000]);
    });

    it('releases the request when the caller disconnects mid-body', async () => {
      githubInstallationFetch.mockResolvedValue({ response: stalled() });
      const caller = new AbortController();
      setTimeout(() => caller.abort(new DOMException('Client closed.', 'AbortError')), 40);
      await expect(fetchPullRequestListPage('example/repo', 'open', 1, caller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('keeps the list when only the optional summary body stalls', async () => {
      shortDeadline();
      githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({
        response: path === '/graphql' ? stalled() : Response.json([pull(1)]),
      }));
      const result = await fetchPullRequestListPage('example/repo', 'open', 1);
      expect(result.prs.map((pr) => pr.number)).toEqual([1]);
      expect(result.statsUnavailable).toBe(true);
    });
  });
});
it('returns the head and detects pending checks even when the aggregate is failing', async () => {
  const source = { ...pull(7), head: { ref: 'work', sha: 'a'.repeat(40) } };
  githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path === '/graphql'
    ? Response.json({ data: { nodes: [{ number: 7, additions: 1, deletions: 0, commits: { nodes: [{ commit: { statusCheckRollup: {
      state: 'FAILURE', contexts: { checkRunCountsByState: [{ state: 'IN_PROGRESS', count: 1 }, { state: 'FAILURE', count: 1 }], statusContextCountsByState: [] },
    } } }] } }] } }) : Response.json([source]) }));
  const page = await fetchPullRequestListPage('example/repo', 'open', 1);
  expect(page.prs[0]).toMatchObject({ headSha: 'a'.repeat(40), updatedAt: source.updated_at, checks: 'failure', checksPending: true });
});

it.each(['REQUESTED', 'WAITING', 'FUTURE_PENDING', 'SUCCESS', 'FAILURE', 'CANCELLED'])('uses the shared unfinished-check rule for summary state %s', async state => {
  githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path === '/graphql'
    ? Response.json({ data: { nodes: [{ number: 7, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: {
      checkRunCountsByState: [{ state, count: 1 }], statusContextCountsByState: [],
    } } } }] } }] } }) : Response.json([pull(7)]) }));
  const page = await fetchPullRequestListPage('example/repo', 'open', 1);
  expect(page.prs[0].checksPending).toBe(['REQUESTED', 'WAITING', 'FUTURE_PENDING'].includes(state));
});

describe('failed checks that the base branch does not require', () => {
  const failingStats = (numbers: number[], pending = false) => ({ data: { nodes: numbers.map((number) => ({ number, additions: 1, deletions: 0, commits: { nodes: [{ commit: { statusCheckRollup: {
    state: 'FAILURE', contexts: { checkRunCountsByState: pending ? [{ state: 'IN_PROGRESS', count: 1 }] : [], statusContextCountsByState: [] },
  } } }] } })) } });
  const answer = (contexts: Array<Record<string, unknown>>, hasNextPage = false) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes: contexts } } } }] } });
  const respond = (stats: unknown, required: unknown) => githubInstallationFetch.mockImplementation(async (_repo: string, path: string, init?: { body?: string }) => ({
    response: path !== '/graphql' ? Response.json([pull(1), pull(2)]) : Response.json(String(init?.body).includes('PullRequestListRequiredChecks') ? required : stats),
  }));

  it('passes a pull request whose only failures are optional, and keeps a required failure red', async () => {
    respond(failingStats([1, 2]), { data: {
      p0: answer([{ __typename: 'CheckRun', conclusion: 'FAILURE', isRequired: false }, { __typename: 'CheckRun', conclusion: 'SUCCESS', isRequired: true }]),
      p1: answer([{ __typename: 'CheckRun', conclusion: 'FAILURE', isRequired: true }]),
    } });
    const page = await fetchPullRequestListPage('example/repo', 'open', 1);
    expect(page.prs.map((pr) => pr.checks)).toEqual(['success', 'failure']);
    const body = JSON.parse(githubInstallationFetch.mock.calls[2][2].body as string);
    expect(body.query).toContain('isRequired(pullRequestNumber: 1)');
    expect(body.query).toContain('isRequired(pullRequestNumber: 2)');
  });

  it('reads as pending when optional failures sit beside unfinished checks', async () => {
    respond(failingStats([1], true), { data: { p0: answer([{ __typename: 'StatusContext', state: 'ERROR', isRequired: false }, { __typename: 'CheckRun', conclusion: null, isRequired: true }]) } });
    const page = await fetchPullRequestListPage('example/repo', 'open', 1);
    expect(page.prs[0]).toMatchObject({ checks: 'pending', checksPending: true });
  });

  it.each([
    ['more checks than one page', answer([{ __typename: 'CheckRun', conclusion: 'FAILURE', isRequired: false }], true)],
    ['an unanswered required flag', answer([{ __typename: 'CheckRun', conclusion: 'FAILURE', isRequired: null }])],
    ['a missing answer', null],
  ])('keeps the failure on %s', async (_label, p0) => {
    respond(failingStats([1]), { data: { p0 } });
    expect((await fetchPullRequestListPage('example/repo', 'open', 1)).prs[0].checks).toBe('failure');
  });

  it('keeps the failure when the required-check read fails', async () => {
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string, init?: { body?: string }) => {
      if (path === '/graphql' && String(init?.body).includes('PullRequestListRequiredChecks')) throw new Error('unavailable');
      return { response: path === '/graphql' ? Response.json(failingStats([1])) : Response.json([pull(1)]) };
    });
    expect((await fetchPullRequestListPage('example/repo', 'open', 1)).prs[0].checks).toBe('failure');
  });
});
