/** PR fixture registration; only the external GitHub transport is authored. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
import { NextRequest } from 'next/server';

let fixture: (() => Promise<SurfaceRoutes>) | undefined;
export async function prepare({ dataDir, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--pull-requests')) return {};
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  for (const key of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH']) delete process.env[key];
  writeFileSync(join(dataDir, 'active-identity'), 'fixture-pr-owner');
  writeFileSync(join(dataDir, 'github-app-managed.json'), JSON.stringify({ installed: true, token: 'fixture-github-token',
    installationId: 1, ownerClerkUserId: 'fixture-pr-owner', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  const originalFetch = globalThis.fetch;
  const comments: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const pulls = new Map<number, Record<string, unknown>>();
  let scenario = '';
  let linkOnMetadata: (() => Promise<void>) | undefined;
  const providerWrites: Array<{ method: string; path: string; publication: boolean }> = [];
  let failClose = false;
  let failClosedRead = true;
  for (const number of [7, 8, 9, 10]) pulls.set(number, { id: 7000 + number, number, node_id: `pr-${number}`, title: `Fixture pull request ${number}`,
    body: 'Review this fixture change.', state: 'open', draft: false, mergeable: true, merged_at: null,
    user: { login: number === 7 ? 'fixture-author' : 'other-author' }, labels: [{ name: 'native' }],
    head: { ref: `fixture-${number}`, sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 900, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: number === 10 } },
    additions: 1, deletions: 1, changed_files: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    html_url: `https://github.com/example/repo/pull/${number}` });
  // Never fall through to an account or network. All production broker calls
  // encounter this external boundary; unknown calls fail the fixture.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.github.com') throw new Error('Unexpected fixture network request');
    const path = url.pathname; const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== 'GET') providerWrites.push({ method, path, publication: (method === 'PUT' && path.endsWith('/merge'))
      || (path === '/graphql' && String(body.query).includes('enablePullRequestAutoMerge')) });
    const match = path.match(/\/(?:pulls|issues)\/(\d+)/); const number = Number(match?.[1]);
    const pull = pulls.get(number);
    if (path.endsWith('/stacks')) return Response.json([]);
    if (path === '/graphql') {
      const query = String(body.query);
      if (query.includes('PullRequestListStats')) return Response.json({ data: { nodes: [...pulls.values()].map(p => ({
        number: p.number, additions: 1, deletions: 1, reviewRequests: { nodes: [{ requestedReviewer: { login: 'fixture-author' } }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
      })) } });
      const mutation = query.match(/\{\s*(\w+)\(input:/)?.[1];
      const id = (body.variables as { input: { pullRequestId: string } }).input.pullRequestId;
      const target = pulls.get(Number(id.split('-')[1]))!;
      if (mutation === 'convertPullRequestToDraft') target.draft = true;
      if (mutation === 'markPullRequestReadyForReview') target.draft = false;
      if (mutation === 'enablePullRequestAutoMerge') target.auto_merge = {};
      if (mutation === 'disablePullRequestAutoMerge') target.auto_merge = null;
      return Response.json({ data: { [mutation!]: { pullRequest: { id } } } });
    }
    if (path.endsWith('/pulls')) {
      if (url.searchParams.get('state') === 'closed') {
        if (failClosedRead) { failClosedRead = false; return Response.json({ message: 'Fixture read failed' }, { status: 502 }); }
        return Response.json([]);
      }
      const page = Number(url.searchParams.get('page'));
      return Response.json(page === 2 ? [pulls.get(8), pulls.get(9), pulls.get(10)] : [pulls.get(7)], { headers: page === 1 ? { link: '<https://api.github.com/fixture?page=2>; rel="next"' } : {} });
    }
    if (path.endsWith('/files')) return Response.json([{ filename: 'change.rs', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-before\n+after' }]);
    if (path.endsWith('/check-runs') && scenario === 'checks-unavailable') return Response.json({ message: 'Fixture checks unavailable' }, { status: 503 });
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [
      { name: 'CI', status: scenario === 'checks-pending' ? 'in_progress' : 'completed',
        conclusion: scenario === 'checks-pending' ? null : scenario === 'checks-failed' ? 'failure' : scenario === 'checks-neutral' ? 'neutral' : 'success', html_url: 'https://github.com/example/repo/actions/runs/1' },
      ...(scenario === 'checks-changed' ? [{ name: 'New passing check', status: 'completed', conclusion: 'success' }] : []),
      ...(process.argv.includes('--check-buckets') ? ['FAILURE', 'timed_out', 'action_required', 'startup_failure', '', null, 'neutral', 'future_conclusion', 'skipped', 'cancelled']
        .map((conclusion, index) => ({ name: `Fixture check ${index}`, status: conclusion ? 'completed' : 'in_progress', conclusion })) : []),
    ] });
    if (path.endsWith('/comments')) {
      if (method === 'POST') comments.push({ id: comments.length + 1, body: body.body, user: { login: 'fixture-author' }, created_at: new Date().toISOString() });
      if (body.body === 'Fixture partial close') failClose = true;
      if (body.body === 'Fixture advance head' && pull) (pull.head as { sha: string }).sha = 'd'.repeat(40);
      return Response.json(path.includes('/issues/') ? comments : []);
    }
    if (path.endsWith('/reviews')) {
      if (method === 'POST') reviews.push({ id: reviews.length + 1, state: body.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', body: body.body, user: { login: 'fixture-author' } });
      return Response.json(method === 'GET' ? reviews : { id: reviews.length }, {
        headers: scenario === 'reviews-incomplete' ? { link: '<https://api.github.com/fixture?page=2>; rel="next"' } : {},
      });
    }
    if (path.endsWith('/merge') && pull) {
      if (scenario === 'merge-refused') return Response.json({ message: 'Fixture GitHub merge rule refused' }, { status: 409 });
      if (body.sha !== (pull.head as { sha: string }).sha || pull.draft || pull.state !== 'open' || (body.merge_method === 'rebase' && number !== 10)) return Response.json({ message: 'Merge refused' }, { status: 409 });
      pull.state = 'closed'; pull.merged_at = new Date().toISOString();
      return Response.json({ merged: true, sha: 'c'.repeat(40) });
    }
    if (pull && path.endsWith(`/pulls/${number}`)) {
      if (linkOnMetadata) { const link = linkOnMetadata; linkOnMetadata = undefined; await link(); }
      if (scenario === 'provider-unavailable') return Response.json({ message: 'Fixture read failed' }, { status: 502 });
      if (method === 'PATCH' && failClose) { failClose = false; return Response.json({ message: 'Fixture close failed' }, { status: 502 }); }
      if (method === 'PATCH') pull.state = body.state;
      return Response.json(pull);
    }
    throw new Error(`Unhandled GitHub fixture route: ${method} ${path}`);
  };
  fixture = async () => {
    const list = await import('../../../src/app/api/panel/prs/route');
    const detail = await import('../../../src/app/api/panel/prs/[number]/route');
    const preview = await import('../../../src/app/api/orchestrator/merge-preview/route');
    const { createLane } = await import('../../../src/lib/lane/registry');
    createLane({ repoPath: repo, worktreePath: repo, branch: 'fixture-missing', baseBranch: 'main', runtime: 'codex', packetId: 'next-pr-drift' });
    const gates = await (await import('../pull-request-gates-fixture')).pullRequestGatesFixture(repo, name => {
      scenario = name;
      if (name === 'review-changes' || name === 'review-approved') reviews.push({ id: 99,
        state: name === 'review-changes' ? 'CHANGES_REQUESTED' : 'APPROVED', user: { login: 'fixture-reviewer' } });
      if (name === 'review-cleared') for (const review of reviews) if (review.state === 'REQUEST_CHANGES' || review.state === 'CHANGES_REQUESTED') review.state = 'DISMISSED';
      if (name === 'base-changed') (pulls.get(7)!.base as { sha: string }).sha = 'e'.repeat(40);
      if (name === 'method-changed') (pulls.get(7)!.base as { repo: { allow_squash_merge: boolean } }).repo.allow_squash_merge = false;
      if (name === 'fork-collision') (pulls.get(7)!.head as { repo: { full_name: string } }).repo.full_name = 'fork/repo';
      if (name === 'link-on-metadata') linkOnMetadata = async () => {
        await gates.control(new NextRequest('http://localhost/__fixture/pr-gates', { method: 'POST', body: JSON.stringify({ packet: 'held' }) }));
      };
    });
    const receipts: Array<{ method: string; path: string; body: unknown }> = [];
    return {
      priority: 10,
      routes: {
        'GET /api/panel/prs': list.GET,
        'GET /api/orchestrator/merge-preview': preview.GET,
        'GET /api/orchestrator/state': gates.state,
        'POST /__fixture/pr-gates': gates.control,
        'GET /api/panel/github-status': async () => Response.json({ authenticated: true, username: 'fixture-author' }),
        'GET /api/panel/status': async () => Response.json({ repo, receipts, providerWrites }),
      },
      match: (method, path) => {
        const number = path.match(/^\/api\/panel\/prs\/(\d+)$/)?.[1];
        if (!number || !['GET', 'POST'].includes(method)) return;
        return request => (method === 'POST' ? detail.POST : detail.GET)(request, { params: Promise.resolve({ number }) });
      },
      admit: () => 200,
      before: ({ method, url, body }) => { receipts.push({ method, path: url.pathname, body: body ? JSON.parse(body) : null }); },
      after: ({ body }) => !!body && JSON.parse(body).comment === 'Fixture lose response',
    };
  };
  return { close: () => { globalThis.fetch = originalFetch; } };
}
export default async function register(): Promise<SurfaceRoutes> {
  return fixture ? fixture() : {};
}
