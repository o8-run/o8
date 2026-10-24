import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), scope: 'synthetic-scope-a', installation: 5, available: true }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null, requireGitHubAppConfig: () => ({ webhookSecret: 'fixture-webhook-only' }) }));
vi.mock('@/lib/github-broker/managed', () => ({ readManagedGithubToken: () => fixture.available ? ({ token: fixture.scope, installationId: fixture.installation }) : null }));
const originalFetch = globalThis.fetch;
const root = mkdtempSync(join(tmpdir(), 'o8-native-stack-read-'));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
const { GET } = await import('@/app/api/panel/pr/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { githubCredentialScope } = await import('@/lib/github-broker/request-budget');
const sha = (letter: string) => letter.repeat(40);
const repo = { id: 101, url: 'https://api.github.com/repos/example/widgets', name: 'widgets' };
const stack = () => ({
  id: 700, number: 7, node_id: 'S_fixture', base: { ref: 'main' },
  url: 'https://api.github.com/repos/example/widgets/stacks/7', open: true,
  pull_requests: [11, 12, 13].map((number, index) => ({
    id: 10000 + number, number, title: `Layer ${index + 1}`, state: 'open',
    html_url: `https://github.com/example/widgets/pull/${number}`,
    head: { ref: `layer-${index + 1}`, sha: sha(String(index + 1)), repo },
    base: { ref: index ? `layer-${index}` : 'main', sha: sha(String(index)), repo },
  })),
});
let targetRepoId = 101; let targetPrId = 10011;
let native = stack();
let list: unknown = [{ number: 7 }];
let failure: number | 'offline' | null = null;
let afterList: (() => void) | null = null;
const requests: Array<{ path: string; method: string }> = [];
let testSequence = 0;
function read() {
  return GET(new NextRequest('http://localhost/api/panel/pr?repo=example/widgets&number=11'));
}
async function context() { const response = await read(); expect(response.status).toBe(200); return (await response.json()).stack; }

beforeEach(() => {
  closeDb();
  fixture.scope = `synthetic-scope-a-${++testSequence}`; fixture.installation = testSequence;
  fixture.available = true; afterList = null;
  targetRepoId = 101; targetPrId = 10011; native = stack(); list = [{ number: 7 }]; failure = null; requests.length = 0;
  vi.stubGlobal('fetch', fixture.fetch);
  fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url); const path = parsed.pathname + parsed.search;
    requests.push({ path, method: init?.method ?? 'GET' });
    let response: Response;
    if (path.includes('/stacks')) {
      if (failure === 'offline') throw new TypeError('Synthetic network failure');
      response = failure ? Response.json({ message: 'Synthetic refusal' }, { status: failure })
        : Response.json(path.includes('?') ? list : native);
      if (path.includes('?')) afterList?.();
    } else if (/\/pulls\/\d+$/.test(path)) response = Response.json({ id: path.endsWith('/11') ? targetPrId : 10000 + Number(path.split('/').at(-1)), number: Number(path.split('/').at(-1)), title: 'Layer 1',
      state: 'open', html_url: 'https://github.com/example/widgets/pull/11',
      head: { sha: sha('1'), ref: 'layer-1' }, base: { sha: sha('0'), ref: 'main', repo: { ...repo, id: targetRepoId } } });
    else if (path.includes('/check-runs')) response = Response.json({ check_runs: [] });
    else response = Response.json([]);
    return response;
  });
});
afterAll(() => { closeDb(); vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe('target PR native stack read through the real route and SQLite', () => {
  it('keeps scoped provenance revisions after target refresh and restart', async () => {
    const first = await context();
    native.pull_requests[2].head.sha = sha('4');
    const second = await context();
    expect(second.history.map((entry: { revision: string }) => entry.revision)).toEqual([first.revision, second.revision]);
    closeDb();
    expect((await context()).history).toEqual(second.history);
    native.pull_requests[2].head.sha = sha('3');
    const rollback = await context();
    expect(rollback.history.map((entry: { revision: string }) => entry.revision)).toEqual([first.revision, second.revision, first.revision]);
  });

  it('refreshes the same persisted stack through a signed PR webhook', async () => {
    await context();
    native.pull_requests[2].head.sha = sha('5');
    const { POST } = await import('@/app/api/github/webhook/route');
    const body = JSON.stringify({ action: 'synchronize', repository: { id: 101, full_name: 'example/widgets' },
      pull_request: { id: 10011, number: 11, title: 'Layer 1', state: 'open', html_url: 'https://github.com/example/widgets/pull/11',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', head: { ref: 'layer-1' }, base: { ref: 'main' } } });
    const signature = 'sha256=' + createHmac('sha256', 'fixture-webhook-only').update(body).digest('hex');
    const readsBeforeDelivery = requests.length;
    const response = await POST(new NextRequest('http://localhost/api/github/webhook', { method: 'POST', body,
      headers: { 'x-hub-signature-256': signature, 'x-github-event': 'pull_request' } }));
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(readsBeforeDelivery);
    closeDb();
    const { runGitHubBrokerSyncSweep } = await import('@/lib/supervisor/github-broker-sync');
    const providerFetch = fixture.fetch.getMockImplementation()!;
    let release!: () => void;
    let held = false;
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pulls/11') && !held) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
      return providerFetch(url, init);
    });
    const sweep = runGitHubBrokerSyncSweep();
    await vi.waitFor(() => expect(held).toBe(true));
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM github_pr_stack_refresh_queue').get()).toEqual({ n: 1 });
    release(); await sweep;
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM github_pr_stack_refresh_queue').get()).toEqual({ n: 0 });
    const row = getSqlite().prepare('SELECT observation_json FROM github_pr_stack_observations WHERE scope = ? AND repo = ? AND pr_number = ?')
      .get(githubCredentialScope('https://api.github.com', fixture.installation, fixture.scope), 'example/widgets', 11) as { observation_json: string };
    expect(JSON.parse(row.observation_json).snapshot.layers[2].headSha).toBe(sha('5'));
    expect(JSON.parse(row.observation_json).history.at(-1).trigger).toBe('webhook');
  });

  it('registers a read-only stack tool in the real operator catalog', async () => {
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2367, method: 'tools/list', params: {} }, 'full');
    const result = response?.result as { tools: Array<{ name: string }> };
    expect(result.tools.some(tool => tool.name === 'o8_pr_stack')).toBe(true);
  });

  it('returns the same ordered stack through authenticated HTTP, built CLI and registered MCP', async () => {
    const { GET: stackGet } = await import('@/app/api/panel/pr-stack/route');
    const { panelGateMiddleware } = await import('@/middleware');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
    const { DEFAULT_API_PORT } = await import('@/lib/panel/api-port');
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      try {
        const req = new NextRequest(`http://fixture.invalid${request.url}`, { headers: { host: 'fixture.invalid', authorization: request.headers.authorization ?? '' } });
        const gate = panelGateMiddleware(req);
        const result = gate && !gate.headers.get('x-middleware-next') ? gate : await stackGet(req);
        calls.push(`${request.method} ${new URL(req.url).pathname}`);
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
      } catch { response.writeHead(500); response.end('Fixture request failed'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const providerFetch = fixture.fetch.getMockImplementation()!;
    fixture.fetch.mockImplementation((url: string, init?: RequestInit) => new URL(url).hostname === '127.0.0.1' ? originalFetch(url, init) : providerFetch(url, init));
    setApiBase(`http://127.0.0.1:${port}`);
    try {
      const token = getOrCreateWsToken();
      const unauthorized = await originalFetch(`http://127.0.0.1:${port}/api/panel/pr-stack?repo=example/widgets&number=11`);
      expect(unauthorized.status).toBe(401);
      const direct = await originalFetch(`http://127.0.0.1:${port}/api/panel/pr-stack?repo=example/widgets&number=11`, { headers: { authorization: `Bearer ${token}` } });
      const expected = (await direct.json()).stack;
      await promisify(execFile)(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd() });
      const result = await promisify(execFile)(process.execPath, ['cli/dist/o8.mjs', 'pr-stack', '--repo', 'example/widgets', '--number', '11'], {
        cwd: process.cwd(), env: { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: token },
      });
      expect(JSON.parse(result.stdout).result.stack.snapshot).toEqual(expected.snapshot);
      const reply = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2367, method: 'tools/call', params: { name: 'o8_pr_stack', arguments: { repo: 'example/widgets', number: 11 } } }, 'full');
      const tool = reply?.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(tool.isError, tool.content[0].text).not.toBe(true);
      expect(JSON.parse(tool.content[0].text).stack.snapshot).toEqual(expected.snapshot);
      expect(calls).toEqual(Array(4).fill('GET /api/panel/pr-stack'));
      expect(requests.every(request => request.method === 'GET')).toBe(true);
    } finally {
      setApiBase(`http://localhost:${DEFAULT_API_PORT}`);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000);

  it('isolates history when a repository name and PR number are reused in the same credential scope', async () => {
    const old = await context();
    targetRepoId = 999; targetPrId = 90011;
    native.id = 900; native.pull_requests = native.pull_requests.map(layer => ({ ...layer, id: 90000 + layer.number,
      title: `New ${layer.title}`, head: { ...layer.head, repo: { ...repo, id: 999 } }, base: { ...layer.base, repo: { ...repo, id: 999 } } }));
    failure = 503;
    expect(await context()).toMatchObject({ snapshot: null, history: [] });
    failure = null;
    const fresh = await context();
    expect(fresh.history).toHaveLength(1);
    expect(fresh.history[0].revision).not.toBe(old.revision);
    expect(fresh.history[0].snapshot.id).toBe(900);
  });

  it('fences an expired queue claimant from releasing or settling its successor', async () => {
    const { enqueuePullRequestStackRefresh, drainPullRequestStackRefresh } = await import('@/lib/github-broker/pull-request-stack-refresh');
    enqueuePullRequestStackRefresh('example/widgets', 11);
    const providerFetch = fixture.fetch.getMockImplementation()!;
    const releases: Array<() => void> = [];
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pulls/11')) await new Promise<void>(resolve => { releases.push(resolve); });
      return providerFetch(url, init);
    });
    const first = drainPullRequestStackRefresh();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    getSqlite().prepare('UPDATE github_pr_stack_refresh_queue SET lease_until=0').run();
    const second = drainPullRequestStackRefresh();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const claim = getSqlite().prepare('SELECT * FROM github_pr_stack_refresh_queue').get();
    releases[0](); await first;
    try { expect(getSqlite().prepare('SELECT * FROM github_pr_stack_refresh_queue').get()).toEqual(claim); }
    finally { releases[1](); await second; }
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM github_pr_stack_refresh_queue').get()).toEqual({ n: 0 });
  });

  it('advances a fresh webhook intent ahead of a repeatedly unavailable stack', async () => {
    const { enqueuePullRequestStackRefresh, drainPullRequestStackRefresh } = await import('@/lib/github-broker/pull-request-stack-refresh');
    enqueuePullRequestStackRefresh('example/widgets', 11);
    failure = 404; await drainPullRequestStackRefresh();
    getSqlite().prepare('UPDATE github_pr_stack_refresh_queue SET retry_at=?').run(Date.now() - 1);
    enqueuePullRequestStackRefresh('example/widgets', 12);
    requests.length = 0; failure = null;
    await drainPullRequestStackRefresh();
    expect(requests[0].path).toBe('/repos/example/widgets/pulls/12');
    expect(getSqlite().prepare('SELECT number FROM github_pr_stack_refresh_queue').all()).toEqual([{ number: 11 }]);
    getSqlite().exec('DELETE FROM github_pr_stack_refresh_queue');
  });

  it('returns ordered native layers with exact revisions and persists them across reopen', async () => {
    const result = await context();
    expect(result).toMatchObject({ status: 'ready', stale: false, source: 'github-native',
      snapshot: { number: 7, id: 700, trunk: 'main', layers: [
        { number: 11, headSha: sha('1'), baseSha: sha('0') },
        { number: 12, headSha: sha('2'), baseSha: sha('1') },
        { number: 13, headSha: sha('3'), baseSha: sha('2') },
      ] } });
    expect(result.fetchedAt).toEqual(expect.any(String));
    closeDb();
    const row = getSqlite().prepare('SELECT observation_json FROM github_pr_stack_observations WHERE scope = ? AND repo = ? AND pr_number = ?')
      .get(githubCredentialScope('https://api.github.com', fixture.installation, fixture.scope), 'example/widgets', 11) as { observation_json: string };
    expect(JSON.parse(row.observation_json)).toEqual(result);
    expect(requests.filter(r => r.path.includes('/stacks')).map(r => r.path)).toEqual([
      '/repos/example/widgets/stacks?pull_request=11&per_page=2', '/repos/example/widgets/stacks/7',
    ]);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('replaces changed provider revisions and clears membership on a confirmed empty list', async () => {
    const first = await context();
    native.pull_requests[2].head.sha = sha('4');
    expect((await context()).snapshot.layers[2].headSha).toBe(sha('4'));
    expect((await context()).revision).not.toBe(first.revision);
    list = [];
    expect(await context()).toMatchObject({ status: 'none', stale: false, snapshot: null });
    closeDb(); failure = 'offline';
    expect(await context()).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it.each([401, 403, 404, 429, 503, 'offline'] as const)('keeps %s distinct from no stack and labels retained data stale', async (reason) => {
    await context(); closeDb(); failure = reason;
    const expected = reason === 'offline' ? 'offline' : reason === 401 || reason === 403 ? 'unauthorized'
      : reason === 404 ? 'unsupported_or_not_found' : reason === 429 ? 'deferred' : 'unavailable';
    expect(await context()).toMatchObject({ status: expected, stale: true, snapshot: reason === 401 || reason === 403 || reason === 429 || reason === 'offline' ? null : { number: 7 } });
  });

  it('never returns retained data from a different credential scope', async () => {
    await context(); closeDb(); fixture.scope = 'synthetic-scope-b'; failure = 'offline';
    expect(await context()).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it.each(['response', 'offline', 'disconnected'] as const)('refuses retained context when authority changes between stack reads (%s)', async (mode) => {
    await context();
    afterList = () => {
      fixture.scope += '-changed';
      if (mode === 'offline') failure = 'offline';
      if (mode === 'disconnected') fixture.available = false;
    };
    expect(await context()).toMatchObject({ status: mode === 'offline' ? 'offline' : 'unauthorized', stale: true, snapshot: null });
  });

  it('prevents an older completed read from replacing a later observation', async () => {
    const originalFetch = fixture.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let held = false;
    const oldNative = structuredClone(native);
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stacks/7') && !held) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return originalFetch(url, init);
    });
    const old = context();
    await vi.waitFor(() => expect(held).toBe(true));
    native.pull_requests[2].head.sha = sha('8');
    const newer = await context();
    finish(Response.json(oldNative));
    expect(await old).toEqual(newer);
    closeDb(); failure = 503;
    expect((await context()).snapshot.layers[2].headSha).toBe(sha('8'));
  });

  it('does not disclose a newer retained snapshot when an older read loses authority', async () => {
    const originalFetch = fixture.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let held = false;
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/stacks?') && !held) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return originalFetch(url, init);
    });
    const old = context();
    await vi.waitFor(() => expect(held).toBe(true));
    expect(await context()).toMatchObject({ status: 'ready', snapshot: { number: 7 } });
    fixture.scope += '-changed'; failure = 'offline';
    finish(Response.json([{ number: 7 }]));
    expect(await old).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it('refuses cross-fork native data without substituting branch ancestry', async () => {
    native.pull_requests[1].head.repo = { ...repo, id: 999 };
    expect(await context()).toMatchObject({ status: 'unsupported_cross_fork', stale: true, snapshot: null });
  });

  it('refuses a partial or unrelated native stack response', async () => {
    native.pull_requests = native.pull_requests.slice(1);
    expect(await context()).toMatchObject({ status: 'unavailable', stale: true, snapshot: null });
  });

  it.each([null, [{ number: 7 }, { number: 8 }], [{ number: 0 }], 'x'.repeat(2 * 1024 * 1024)] )('refuses malformed, ambiguous and oversized native lists', async (value) => {
    list = value;
    expect(await context()).toMatchObject({ status: 'unavailable', stale: true, snapshot: null });
  });
});
