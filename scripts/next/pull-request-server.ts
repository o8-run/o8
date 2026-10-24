/** Disposable production PR route host. Only the external GitHub transport is authored. */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-pr-')));
  const data = join(root, 'data'); const repo = join(root, 'repo');
  mkdirSync(data); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  Object.assign(process.env, { O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'fixture.db'), NODE_ENV: 'test' });
  for (const key of ['O8_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN', 'WS_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH']) delete process.env[key];
  writeFileSync(join(data, 'ws-token'), 'fixture-next-pr-operator', { mode: 0o600 });
  writeFileSync(join(data, 'active-identity'), 'fixture-pr-owner');
  writeFileSync(join(data, 'github-app-managed.json'), JSON.stringify({ installed: true, token: 'fixture-github-token',
    installationId: 1, ownerClerkUserId: 'fixture-pr-owner', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  const comments: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const pulls = new Map<number, Record<string, unknown>>();
  let failClose = false;
  let failClosedRead = true;
  for (const number of [7, 8, 9, 10]) pulls.set(number, { number, node_id: `pr-${number}`, title: `Fixture pull request ${number}`,
    body: 'Review this fixture change.', state: 'open', draft: false, mergeable: true, merged_at: null,
    user: { login: number === 7 ? 'fixture-author' : 'other-author' }, labels: [{ name: 'native' }],
    head: { ref: `fixture-${number}`, sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: number === 10 } },
    additions: 1, deletions: 1, changed_files: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    html_url: `https://github.com/example/repo/pull/${number}` });
  // Never fall through to an account or network. All production broker calls
  // encounter this external boundary; unknown calls fail the fixture.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.github.com') throw new Error('Unexpected fixture network request');
    const path = url.pathname; const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const match = path.match(/\/(?:pulls|issues)\/(\d+)/); const number = Number(match?.[1]);
    const pull = pulls.get(number);
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
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/repo/actions/runs/1' }] });
    if (path.endsWith('/comments')) {
      if (method === 'POST') comments.push({ id: comments.length + 1, body: body.body, user: { login: 'fixture-author' }, created_at: new Date().toISOString() });
      if (body.body === 'Fixture partial close') failClose = true;
      if (body.body === 'Fixture advance head' && pull) (pull.head as { sha: string }).sha = 'd'.repeat(40);
      return Response.json(path.includes('/issues/') ? comments : []);
    }
    if (path.endsWith('/reviews')) {
      if (method === 'POST') reviews.push({ id: reviews.length + 1, state: body.event, body: body.body, user: { login: 'fixture-author' } });
      return Response.json(method === 'GET' ? reviews : { id: reviews.length });
    }
    if (path.endsWith('/merge') && pull) {
      if (body.sha !== (pull.head as { sha: string }).sha || pull.draft || pull.state !== 'open' || (body.merge_method === 'rebase' && number !== 10)) return Response.json({ message: 'Merge refused' }, { status: 409 });
      pull.state = 'closed'; pull.merged_at = new Date().toISOString();
      return Response.json({ merged: true, sha: 'c'.repeat(40) });
    }
    if (pull && path.endsWith(`/pulls/${number}`)) {
      if (method === 'PATCH' && failClose) { failClose = false; return Response.json({ message: 'Fixture close failed' }, { status: 502 }); }
      if (method === 'PATCH') pull.state = body.state;
      return Response.json(pull);
    }
    throw new Error(`Unhandled GitHub fixture route: ${method} ${path}`);
  };
  const list = await import('../../src/app/api/panel/prs/route');
  const detail = await import('../../src/app/api/panel/prs/[number]/route');
  const preview = await import('../../src/app/api/orchestrator/merge-preview/route');
  const { createLane } = await import('../../src/lib/lane/registry');
  createLane({ repoPath: repo, worktreePath: repo, branch: 'fixture-missing', baseBranch: 'main', runtime: 'codex', packetId: 'next-pr-drift' });
  const { panelGateMiddleware } = await import('../../src/middleware');
  const receipts: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      let body = ''; for await (const chunk of req) body += String(chunk);
      const request = new NextRequest(url, { method: req.method, headers: { host: url.host, 'x-o8-client-addr': '127.0.0.1',
        'Content-Type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
      const gate = panelGateMiddleware(request);
      let response: Response = gate;
      if (gate.status === 200) {
        receipts.push({ method: req.method!, path: url.pathname, body: body ? JSON.parse(body) : null });
        const number = url.pathname.match(/^\/api\/panel\/prs\/(\d+)$/)?.[1];
        response = url.pathname === '/api/panel/prs' ? await list.GET(request)
          : number ? await (req.method === 'POST' ? detail.POST : detail.GET)(request, { params: Promise.resolve({ number }) })
          : url.pathname === '/api/orchestrator/merge-preview' ? await preview.GET(request)
          : url.pathname === '/api/orchestrator/state' ? Response.json({ mission: { packets: [
            { id: 'next-pr-unwired', workspaceTargetPath: repo, branchTarget: 'fixture-8', status: 'awaiting_review' },
            { id: 'next-pr-drift', workspaceTargetPath: repo, branchTarget: 'fixture-9', status: 'awaiting_review' },
          ] } })
          : url.pathname === '/api/panel/github-status' ? Response.json({ authenticated: true, username: 'fixture-author' })
          : url.pathname === '/api/panel/status' ? Response.json({ repo, receipts }) : new Response('', { status: 404 });
      }
      if (body && JSON.parse(body).comment === 'Fixture lose response') { res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture failed'); }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}` })}\n`);
  });
  const close = () => { server.closeAllConnections(); server.close(() => { rmSync(root, { recursive: true, force: true }); process.exit(0); }); };
  process.on('SIGTERM', close); process.on('SIGINT', close); setTimeout(close, 120_000).unref();
}
void main().catch(() => { process.stderr.write('PR fixture startup failed\n'); process.exit(1); });
