import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ repo: 'organization/widgets', account: 'personal' as string | null }));
vi.mock('./env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('./managed', () => ({
  readManagedGithubToken: () => ({ token: 'fixture-installation', installationId: 4738, accountLogin: h.account }),
  readActiveIdentity: () => 'fixture-owner', readSignInEpoch: () => 'fixture-epoch',
}));
vi.mock('@/lib/repos/registry', () => ({ listRepos: async () => [{ remoteUrl: `https://github.com/${h.repo}.git` }] }));
vi.mock('./pull-request-stack-refresh', () => ({ drainPullRequestStackRefresh: async () => {} }));

let closeDb: (() => void) | undefined;
let sequence = 0;
const now = Date.parse('2026-10-25T12:00:00Z');
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(now); h.repo = `organization/widgets-${++sequence}`; h.account = 'personal'; });
afterEach(() => { closeDb?.(); closeDb = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const pull = { id: 1, number: 1, node_id: 'node-1', title: 'A change', state: 'open', user: { login: 'author' }, head: { ref: 'work', sha: 'a'.repeat(40) }, base: { ref: 'main', repo: { id: 2 } }, labels: [], comments: 0, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), html_url: 'https://github.com/organization/widgets/pull/1' };

function publicServer() {
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.has('authorization')) return Response.json({ message: 'Not Found' }, { status: 404 });
    const path = String(url);
    const data = path.includes('/actions/runs') ? { workflow_runs: [{ id: 9, display_title: 'CI' }] }
      : path.includes('/check-runs') ? { check_runs: [{ name: 'typecheck', conclusion: 'success' }] }
      : /\/pulls\/1$/.test(path) ? pull
      : path.includes('/pulls?') && !path.includes('state=closed') ? [pull] : [];
    if (headers.has('if-none-match')) return new Response(null, { status: 304, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50' } });
    return Response.json(data, { headers: { etag: '"public-fixture"', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': String(now / 1000 + 3600) } });
  });
  vi.stubGlobal('fetch', request);
  return request;
}

it('reads PR lists, persisted issue/PR sync, CI and checks anonymously outside the managed account', async () => {
  const request = publicServer();
  const { fetchPullRequestListPage } = await import('./pull-request-list');
  expect((await fetchPullRequestListPage(h.repo, 'open', 1)).prs).toHaveLength(1);
  const db = await import('@/lib/db'); closeDb = db.closeDb;
  const { ensureGitHubIssues, ensureGitHubPullRequests } = await import('./sync');
  expect((await ensureGitHubIssues(h.repo)).error).toBeNull();
  expect((await ensureGitHubPullRequests(h.repo)).prs).toHaveLength(1);
  expect(db.getSqlite().prepare('SELECT number FROM github_pull_requests WHERE repo_full_name = ?').get(h.repo)).toEqual({ number: 1 });
  const { GET } = await import('@/app/api/panel/ci/route');
  expect(await (await GET(new Request(`http://fixture.invalid/api/panel/ci?repo=${h.repo}`))).json()).toMatchObject({ runs: [{ databaseId: 9 }] });
  const { readPullRequestChecks } = await import('./pull-request-checks');
  expect(await readPullRequestChecks(h.repo, pull.head.sha)).toMatchObject([{ name: 'typecheck', conclusion: 'success' }]);
  expect(request.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true);
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/graphql'))).toBe(false);
});

it('uses the managed token for a case-insensitive owner match and refuses cross-owner writes', async () => {
  h.account = 'ORGANIZATION';
  const request = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json([])); vi.stubGlobal('fetch', request);
  const { githubInstallationFetch } = await import('./auth');
  await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls`);
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(true);
  h.account = 'personal';
  await expect(githubInstallationFetch(h.repo, `/repos/${h.repo}/issues`, { method: 'POST' })).rejects.toMatchObject({ code: 'github_org_not_covered' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps same-owner mutations authorized after an optional read falls back to public access', async () => {
  h.account = 'organization';
  const request = publicServer(); const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => init?.method === 'POST' ? Response.json({ number: 10 }, { status: 201 }) : normal(url, init));
  const { githubInstallationFetch } = await import('./auth');
  await githubInstallationFetch(h.repo, `/repos/${h.repo}/actions/runs`);
  expect((await githubInstallationFetch(h.repo, `/repos/${h.repo}/issues`, { method: 'POST', body: '{}' })).response.status).toBe(201);
  expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).has('authorization')).toBe(true);
});

it('retries an installation 404 once without credentials and remembers the public decision across sweeps', async () => {
  h.account = 'organization';
  const request = publicServer();
  const { githubInstallationFetch } = await import('./auth');
  expect((await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls?state=open`)).response.ok).toBe(true);
  closeDb = (await import('@/lib/db')).closeDb;
  const { runGitHubBrokerSyncSweep } = await import('@/lib/supervisor/github-broker-sync');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await runGitHubBrokerSyncSweep();
  vi.setSystemTime(now + 10 * 60_000);
  await runGitHubBrokerSyncSweep();
  expect(request.mock.calls.filter(([, init]) => new Headers(init?.headers).has('authorization'))).toHaveLength(1);
  expect(warn).not.toHaveBeenCalled();
});

it('returns one typed uncovered state through both panel routes and logs it once across sweeps', async () => {
  const request = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ message: 'Not Found' }, { status: 404 })); vi.stubGlobal('fetch', request);
  const { GET: prs } = await import('@/app/api/panel/prs/route');
  const { GET: ci } = await import('@/app/api/panel/ci/route');
  const expected = { code: 'github_org_not_covered', error: "GitHub sign-in doesn't cover organization repos yet" };
  expect(await (await prs(new Request(`http://fixture.invalid/api/panel/prs?repo=${h.repo}&view=list`))).json()).toMatchObject(expected);
  expect(await (await ci(new Request(`http://fixture.invalid/api/panel/ci?repo=${h.repo}`))).json()).toMatchObject(expected);
  closeDb = (await import('@/lib/db')).closeDb;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { runGitHubBrokerSyncSweep } = await import('@/lib/supervisor/github-broker-sync');
  await runGitHubBrokerSyncSweep(); vi.setSystemTime(now + 120_000); await runGitHubBrokerSyncSweep();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2); // Endpoint and repository visibility confirmation.
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
});

it('keeps an hour of 30-second supervisor sweeps below 60 anonymous requests and revalidates with ETags', async () => {
  const request = publicServer();
  const db = await import('@/lib/db'); closeDb = db.closeDb;
  const { runGitHubBrokerSyncSweep } = await import('@/lib/supervisor/github-broker-sync');
  const counts: number[] = [];
  for (let elapsed = 0; elapsed < 3600_000; elapsed += 30_000) {
    vi.setSystemTime(now + elapsed); const before = request.mock.calls.length;
    await runGitHubBrokerSyncSweep(); counts.push(request.mock.calls.length - before);
    // SQLite's datetime('now') uses the real clock; align only successful fixture
    // timestamps with the fake clock used by the actual sweep freshness policy.
    if (request.mock.calls.length > before) db.getSqlite().prepare('UPDATE github_sync_state SET last_successful_at = ? WHERE repo_full_name = ? AND last_error IS NULL').run(new Date(Date.now()).toISOString(), h.repo);
  }
  expect(counts[0]).toBe(5); // Four listings plus the first changed PR detail.
  expect(Math.max(...counts.slice(1))).toBe(4);
  expect(request).toHaveBeenCalledTimes(25);
  expect(request.mock.calls.length).toBeLessThan(60);
  expect(request.mock.calls.some(([, init]) => new Headers(init?.headers).has('if-none-match'))).toBe(true);
  console.info(`anonymous sweep requests: cold=${counts[0]}, refresh=${Math.max(...counts.slice(1))}, hour=${request.mock.calls.length}, sweeps=${counts.length}`);
});

it('accounts anonymous quota globally across repos and honors its reset', async () => {
  const request = vi.fn(async () => Response.json([], { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 90) } })); vi.stubGlobal('fetch', request);
  const { githubInstallationFetch } = await import('./auth');
  await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls`);
  await expect(githubInstallationFetch('other/widgets', '/repos/other/widgets/issues')).rejects.toMatchObject({ retryAt: now + 90_000 });
  expect(request).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 90_001);
  await githubInstallationFetch('other/widgets', '/repos/other/widgets/issues');
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not deny a public repository when one child resource is missing', async () => {
  const request = publicServer();
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => String(url).includes('/pulls/999')
    ? Response.json({ message: 'Missing PR' }, { status: 404 }) : normal(url, init));
  const { githubInstallationFetch } = await import('./auth');
  expect((await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls/999`)).response.status).toBe(404);
  expect((await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls?state=open`)).response.ok).toBe(true);
});

it('confines the request path and never follows a repository transfer with a token', async () => {
  h.account = 'organization';
  const request = publicServer(); const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (new Headers(init?.headers).has('authorization')) {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repos/elsewhere/widgets/pulls' } });
    }
    return normal(url, init);
  });
  const { githubInstallationFetch } = await import('./auth');
  await expect(githubInstallationFetch(h.repo, '/repos/elsewhere/widgets/pulls')).rejects.toThrow('does not match');
  await expect(githubInstallationFetch(h.repo, `@example.invalid/repos/${h.repo}/pulls`)).rejects.toThrow('does not match');
  expect((await githubInstallationFetch(h.repo, `/repos/${h.repo}/pulls?state=open`)).anonymous).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(new Headers(request.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
});

it('revalidates anonymous CI on explicit refresh instead of returning its cached response', async () => {
  const request = publicServer(); const { GET } = await import('@/app/api/panel/ci/route');
  const url = `http://fixture.invalid/api/panel/ci?repo=${h.repo}`;
  await GET(new Request(url)); await GET(new Request(url));
  expect(request).toHaveBeenCalledTimes(1);
  await GET(new Request(`${url}&fresh=1`));
  expect(request).toHaveBeenCalledTimes(2);
  expect(new Headers(request.mock.calls[1][1]?.headers).get('if-none-match')).toBe('"public-fixture"');
});

it('does not expose a previous covered owners private mirror or CI cache to anonymous access', async () => {
  h.account = 'organization';
  const request = publicServer(); const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (!new Headers(init?.headers).has('authorization')) return Response.json({}, { status: 404 });
    return normal(url, { ...init, headers: {} });
  });
  closeDb = (await import('@/lib/db')).closeDb;
  const { ensureGitHubPullRequests } = await import('./sync');
  const { GET } = await import('@/app/api/panel/ci/route');
  expect((await ensureGitHubPullRequests(h.repo)).prs).toHaveLength(1);
  const url = `http://fixture.invalid/api/panel/ci?repo=${h.repo}`;
  expect(await (await GET(new Request(url))).json()).toMatchObject({ runs: [{ databaseId: 9 }] });
  h.account = 'someone-else';
  expect(await ensureGitHubPullRequests(h.repo)).toMatchObject({ prs: [], code: 'github_org_not_covered' });
  expect(await (await GET(new Request(url))).json()).toMatchObject({ runs: [], code: 'github_org_not_covered' });
});
