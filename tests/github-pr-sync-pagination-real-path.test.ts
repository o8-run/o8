vi.mock('@/lib/github-broker/repo-access', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/github-broker/repo-access')>(), canReadGitHubSnapshot: () => true, usesAnonymousGitHubReads: () => false }));
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
  line: null as ((line: string) => void) | null,
}));
vi.mock('@/lib/github-broker/auth', () => ({
  githubInstallationFetch: fixture.fetch,
  hasGitHubBrokerAccess: () => true,
}));
vi.mock('@/lib/github-broker', async () => ({
  ...await import('@/lib/github-broker/sync'),
  ...await import('@/lib/github-broker/repo'),
}));
vi.mock('@/lib/mcp/orphan-exit-bootstrap', () => ({}));
vi.mock('@/lib/mcp/neutralize-server-only', () => ({}));
vi.mock('node:readline', () => ({
  createInterface: () => ({ on: (event: string, callback: (line: string) => void) => {
    if (event === 'line') fixture.line = callback;
  } }),
}));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'fixture-token' }));
vi.mock('@/lib/projects/store', () => ({}));
vi.mock('@/lib/projects/suggest', () => ({}));
vi.mock('@/lib/mcp/cortex-delegation-handlers', () => ({ createCortexDelegationHandlers: () => ({}) }));

process.env.CORTEX_API_BASE = 'http://fixture';
process.env.CORTEX_READONLY = '1';

const { buildOutsideHumanWaitingInbox } = await import('@/lib/supervisor/inbox');
const { closeDb, getSqlite } = await import('@/lib/db');
const { ensureGitHubPullRequest, ensureGitHubPullRequestByHead, ensureGitHubPullRequests } = await import('@/lib/github-broker/sync');
const { listGitHubPullRequests, invalidateGitHubSync, readGitHubSyncState, markGitHubSyncError } = await import('@/lib/github-broker/store');
const { GET } = await import('@/app/api/panel/prs/route');
await import('@/lib/mcp/cortex-mcp-server');

const repo = 'example/widgets';
const installation = { id: 1, account: { login: 'example' } };
function pull(number: number, updated = '2026-10-10T12:00:00Z') {
  return {
    id: 1000 + number, number, title: `PR ${number}`, state: 'open',
    user: { login: 'contributor', type: 'User' }, author_association: 'CONTRIBUTOR',
    body: 'Fixture', html_url: `https://github.com/${repo}/pull/${number}`,
    created_at: '2026-10-01T12:00:00Z', updated_at: updated,
    head: { ref: `branch-${number}`, sha: `sha-${number}` }, base: { ref: 'main' },
    additions: number, deletions: 2, changed_files: 3, comments: 0,
  };
}
let pulls: ReturnType<typeof pull>[];
let failedPage: number | null;
let notModified: boolean;
function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { installation, response: status === 304 ? new Response(null, { status }) : Response.json(body, { status, headers }) };
}
function transport(_repo: string, endpoint: string) {
  const url = new URL(endpoint, 'https://api.github.test');
  if (url.pathname === `/repos/${repo}/pulls`) {
    if (url.searchParams.get('state') === 'closed') return respond([]);
    const page = Number(url.searchParams.get('page') || 1);
    if (page === failedPage) return respond({ message: 'Fixture list failure' }, 503);
    if (notModified) return respond(null, 304);
    const size = Number(url.searchParams.get('per_page'));
    const items = pulls.slice((page - 1) * size, page * size);
    const headers: Record<string, string> = { etag: '"fixture"' };
    if (page * size < pulls.length) headers.link = `<https://api.github.test/repos/${repo}/pulls?page=${page + 1}>; rel="next"`;
    return respond(items, 200, headers);
  }
  const match = url.pathname.match(/\/pulls\/(\d+)$/);
  if (match) return respond(pulls.find((item) => item.number === Number(match[1])));
  throw new Error(`Unexpected fixture request: ${endpoint}`);
}
function openCalls() {
  return fixture.fetch.mock.calls.filter(([, endpoint]) => endpoint.includes('state=open'));
}
function detailCalls() {
  return fixture.fetch.mock.calls.filter(([, endpoint]) => /\/pulls\/\d+$/.test(endpoint));
}
async function panel() {
  return (await GET(new Request(`http://fixture/api/panel/prs?repo=${repo}`))).json();
}
async function operator() {
  let resolve!: (message: { result: { isError?: boolean; content: Array<{ text: string }> } }) => void;
  const response = new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    const text = String(chunk);
    if (text.startsWith('{')) {
      const message = JSON.parse(text);
      if (message.id === 'pagination') resolve(message);
    }
    return true;
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://fixture' || (init?.method ?? 'GET') !== 'GET'
      || url.pathname !== '/api/panel/prs' || url.searchParams.get('repo') !== repo) {
      throw new Error('Only the fixture panel route is permitted.');
    }
    return GET(new Request(`http://fixture${url.pathname}${url.search}`));
  });
  try {
    fixture.line!(JSON.stringify({ jsonrpc: '2.0', id: 'pagination', method: 'tools/call', params: {
      name: 'cortex_list_prs', arguments: { repo, limit: 500 },
    } }));
    const message = await response;
    return { ...message.result, data: JSON.parse(message.result.content[0].text) };
  } finally {
    stdout.mockRestore();
    fetch.mockRestore();
  }
}
beforeEach(() => {
  buildOutsideHumanWaitingInbox(new Date(), 24 * 60 * 60_000);
  for (const table of ['github_pull_requests', 'github_sync_state', 'github_installations', 'supervisor_inbox']) {
    getSqlite().prepare(`DELETE FROM ${table}`).run();
  }
  pulls = Array.from({ length: 125 }, (_, index) => pull(index + 1));
  failedPage = null;
  notModified = false;
  fixture.fetch.mockReset().mockImplementation(transport);
});
afterAll(() => closeDb());

describe('bounded open PR sync through persisted panel and MCP listings', () => {
  it('returns every PR beyond page one and reuses unchanged persisted details', async () => {
    const initial = await panel();
    expect(initial.error).toBeNull();
    expect(initial.prs).toHaveLength(125);
    expect(listGitHubPullRequests(repo)).toHaveLength(125);
    expect(openCalls()).toHaveLength(2);
    expect(openCalls().every(([, endpoint]) => endpoint.includes('per_page=100'))).toBe(true);
    expect(detailCalls()).toHaveLength(125);
    const result = await operator();
    expect(result.data).toMatchObject({ count: 125, returned: 125, stale: false, error: null });
    expect(result.isError).not.toBe(true);
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockClear();
    expect((await panel()).prs).toHaveLength(125);
    expect(openCalls()).toHaveLength(2);
    expect(detailCalls()).toHaveLength(0);
    expect((await panel()).prs.find((item: { number: number }) => item.number === 125).additions).toBe(125);
    pulls[124] = { ...pull(125, '2026-10-11T12:00:00Z'), additions: 900 };
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockClear();
    expect((await panel()).prs.find((item: { number: number }) => item.number === 125).additions).toBe(900);
    expect(detailCalls()).toHaveLength(1);
  });

  it('preserves the entire prior snapshot and reports an intermediate listing failure', async () => {
    await ensureGitHubPullRequests(repo);
    const prior = listGitHubPullRequests(repo);
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockClear();
    failedPage = 2;
    const result = await operator();
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ count: 125, stale: true, error: expect.stringContaining('503') });
    expect(listGitHubPullRequests(repo)).toEqual(prior);
    expect(detailCalls()).toHaveLength(0);
    expect(readGitHubSyncState(repo, 'pull_requests')?.lastError).toContain('503');
  });

  it('reports a five-page cap with no prior snapshot instead of a complete-looking count', async () => {
    pulls = Array.from({ length: 501 }, (_, index) => pull(index + 1));
    const result = await operator();
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ count: 0, stale: true, error: expect.stringMatching(/500|five|5 pages/) });
    expect(openCalls()).toHaveLength(5);
    expect(detailCalls()).toHaveLength(0);
    expect(listGitHubPullRequests(repo)).toHaveLength(0);
  });

  it('preserves prior rows at the cap and accepts an exactly complete 500-PR listing', async () => {
    await panel();
    const prior = listGitHubPullRequests(repo);
    pulls = Array.from({ length: 501 }, (_, index) => pull(index + 1));
    invalidateGitHubSync(repo, 'pull_requests');
    expect((await panel()).error).toMatch(/500|five|5 pages/);
    expect(listGitHubPullRequests(repo)).toEqual(prior);
    pulls.pop();
    expect((await panel()).prs).toHaveLength(500);
    expect((await operator()).data).toMatchObject({ count: 500, returned: 200, stale: false, error: null });
  });

  it('deduplicates boundary overlap before fetching details', async () => {
    pulls.splice(100, 0, pulls[99]);
    const result = await panel();
    expect(result.prs).toHaveLength(125);
    expect(detailCalls()).toHaveLength(125);
  });

  it('keeps cached error results stale even inside the success TTL', async () => {
    await panel();
    markGitHubSyncError(repo, 'pull_requests', 'Fixture detail failure');
    const result = await operator();
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ count: 125, stale: true, error: 'Fixture detail failure' });
  });

  it('keeps a failed single-PR refresh out of the complete listing state', async () => {
    await panel();
    fixture.fetch.mockImplementation((repoName: string, endpoint: string) => (
      /\/pulls\/7$|head=/.test(endpoint) ? respond({ message: 'Fixture single failure' }, 503) : transport(repoName, endpoint)
    ));
    expect(await ensureGitHubPullRequest(repo, 7)).toMatchObject({ stale: true, error: expect.stringContaining('503') });
    expect(await ensureGitHubPullRequestByHead(repo, 'branch-7')).toMatchObject({ stale: true, error: expect.stringContaining('503') });
    expect(readGitHubSyncState(repo, 'pull_requests')?.lastError ?? null).toBeNull();
    const result = await operator();
    expect(result.isError).not.toBe(true);
    expect(result.data).toMatchObject({ count: 125, stale: false, error: null });
  });

  it('bounds and normalizes persisted upstream errors in the operator response', async () => {
    await panel();
    markGitHubSyncError(repo, 'pull_requests', `Fixture failure\n${'x'.repeat(10_000)}`);
    const result = await operator();
    expect(result.isError).toBe(true);
    expect(result.data.stale).toBe(true);
    expect(result.data.error).not.toContain('\n');
    expect(result.data.error.length).toBeLessThan(1000);
  });

  it('retains the prior snapshot if a changed detail fails after listing succeeds', async () => {
    await panel();
    const prior = listGitHubPullRequests(repo);
    pulls[124] = pull(125, '2026-10-11T12:00:00Z');
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockImplementation((repoName: string, endpoint: string) => (
      endpoint.endsWith('/pulls/125') ? respond({ message: 'Fixture detail failure' }, 502) : transport(repoName, endpoint)
    ));
    const result = await operator();
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ stale: true, error: expect.stringContaining('502') });
    expect(listGitHubPullRequests(repo)).toEqual(prior);
  });

  it('retries unassessed attention without losing stored details', async () => {
    pulls = [pull(1)];
    await panel();
    getSqlite().prepare('UPDATE github_pull_requests SET last_human_comment_at = NULL').run();
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockClear();
    expect((await panel()).prs[0].additions).toBe(1);
    expect(detailCalls()).toHaveLength(1);
    expect(getSqlite().prepare('SELECT last_human_comment_at FROM github_pull_requests').get()).toMatchObject({
      last_human_comment_at: '2026-10-01T12:00:00Z',
    });
  });

  it('keeps the prior snapshot on 304 without fetching open details', async () => {
    await panel();
    const prior = listGitHubPullRequests(repo);
    invalidateGitHubSync(repo, 'pull_requests');
    fixture.fetch.mockClear();
    notModified = true;
    expect(await panel()).toMatchObject({ stale: false, error: null });
    expect(listGitHubPullRequests(repo)).toEqual(prior);
    expect(detailCalls()).toHaveLength(0);
  });
});
