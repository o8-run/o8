import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/github-broker/auth', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/github-broker/auth')>(),
  hasGitHubBrokerAccess: () => true,
  githubInstallationFetch: provider.read,
}));

const root = mkdtempSync(path.join(tmpdir(), 'o8-conversation-pr-context-'));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', path.join(root, 'context.db'));

const { closeDb } = await import('@/lib/db');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { GET: historyGet } = await import('@/app/api/orchestrator/history/route');
const linksApi = await import('@/app/api/orchestrator/pull-request-context/route');
const { getSqlite } = await import('@/lib/db');
const { upsertGitHubRepository, upsertGitHubPullRequest, replaceGitHubPullRequests, getGitHubPullRequestByNumber } = await import('@/lib/github-broker/store');
const { getCanonicalChatHistoryPath, persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
const { createLane, updateLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
const { resolveRequestPrincipal } = await import('@/lib/auth/principal');
const { panelGateMiddleware } = await import('@/middleware');
const { DELETE: deleteHistory } = await import('@/app/api/v2/chat-history/route');

let sequence = 0;

function request(method: string, body?: unknown, query = '', token = getOrCreateWsToken()): NextRequest {
  return new NextRequest(`http://localhost/api/orchestrator/pull-request-context${query}`, {
    method, headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mirror(repositoryId: number, repositoryFullName: string, pullRequestId: number, number = 7) {
  const [owner, name] = repositoryFullName.split('/');
  upsertGitHubRepository({ repoId: repositoryId, fullName: repositoryFullName, owner, name, private: false });
  upsertGitHubPullRequest({
    pullRequestId, repositoryId, repoFullName: repositoryFullName, number, title: 'Fixture PR', state: 'open',
    author: { login: 'fixture-owner' }, body: '', headRefName: 'shared-branch', baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [],
    url: `https://github.com/${repositoryFullName}/pull/${number}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', closedAt: null, mergedAt: null,
  });
  return { host: 'github.com', repositoryId, pullRequestId, number };
}

function fixture() {
  sequence++;
  const threadId = `thoughts-context-${sequence}`;
  const otherThreadId = `${threadId}-unrelated`;
  for (const id of [threadId, otherThreadId]) writePersistedLlmChat(id, {
    title: id, repoPath: root, repoBranch: 'shared-branch',
    messages: [{ id: 'message', role: 'user', content: 'Preserved', timestamp: 1 }],
  });
  const first = mirror(sequence * 10 + 1, `fixture/repo-${sequence}`, sequence * 100 + 1);
  const second = mirror(sequence * 10 + 2, `fixture/other-${sequence}`, sequence * 100 + 2);
  return { threadId, otherThreadId, first, second };
}

async function history(threadId: string) {
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${threadId}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  return response.json();
}

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('exposes an explicit context-link collection through persisted conversation history', async () => {
  const threadId = 'thoughts-pr-context';
  writePersistedLlmChat(threadId, {
    title: 'Context links',
    messages: [{ id: 'message', role: 'user', content: 'Keep the discussion.', timestamp: 1 }],
  });
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${threadId}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.timeline[0].content).toBe('Keep the discussion.');
  expect(body.pullRequestContext).toEqual({ links: [], nextCursor: null });
});

it('attaches idempotently, survives database reopen, and keeps same-number cross-repository links distinct', async () => {
  const f = fixture();
  const body = { threadId: f.threadId, ...f.first };
  const created = await linksApi.POST(request('POST', body));
  expect(created.status).toBe(201);
  const first = await created.json();
  expect(first.result.link).toMatchObject({ ...body, kind: 'context', source: 'operator' });
  const duplicate = await linksApi.POST(request('POST', body));
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).result.link.id).toBe(first.result.link.id);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.second }))).status).toBe(201);
  closeDb();
  const forward = await history(f.threadId);
  expect(forward.pullRequestContext.links.map((link: { pullRequestId: number }) => link.pullRequestId))
    .toEqual([f.first.pullRequestId, f.second.pullRequestId]);
  const query = new URLSearchParams(Object.entries(f.first).map(([key, value]) => [key, String(value)]));
  const reverse = await linksApi.GET(request('GET', undefined, `?${query}`));
  expect((await reverse.json()).result.links.map((link: { threadId: string }) => link.threadId)).toEqual([f.threadId]);
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM conversation_pr_context WHERE thread_id = ?').get(f.threadId)).toEqual({ n: 2 });
});

it.each(['upsert', 'replace'] as const)('keeps a known repository ID after a later %s omits it', async writer => {
  const f = fixture();
  const repoFullName = `fixture/repo-${sequence}`;
  const current = getGitHubPullRequestByNumber(repoFullName, f.first.number)!;
  expect(current.repositoryId).toBe(f.first.repositoryId);
  const withoutId = { ...current, title: 'Updated without repository identity' };
  delete withoutId.repositoryId;
  if (writer === 'upsert') upsertGitHubPullRequest(withoutId);
  else replaceGitHubPullRequests(repoFullName, [withoutId]);

  closeDb();
  expect(getGitHubPullRequestByNumber(repoFullName, f.first.number)).toMatchObject({
    repositoryId: f.first.repositoryId,
    title: 'Updated without repository identity',
  });
  expect(getSqlite().prepare('SELECT repository_id FROM github_pull_requests WHERE pull_request_id = ?')
    .get(f.first.pullRequestId)).toEqual({ repository_id: f.first.repositoryId });
  // The surviving mirror identity must still authorize a new explicit link
  // through the actual operator API, rather than only a direct store read.
  const attached = await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }));
  expect(attached.status).toBe(201);
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links)
    .toEqual([expect.objectContaining({ ...f.first, repositoryFullName: repoFullName })]);
});

it('retains immutable identities across rename and archive, then unlinks without changing history or primary delivery', async () => {
  const f = fixture();
  const lane = createLane({ repoPath: root, branch: 'shared-branch', runtime: 'codex', packetId: `fixture-${sequence}` });
  updateLane(lane.id, { prNumber: 99 });
  const laneBefore = getLane(lane.id);
  const eventsBefore = getLaneEvents(lane.id);
  const file = getCanonicalChatHistoryPath(f.threadId);
  const archived = { ...JSON.parse(readFileSync(file, 'utf8')), archivedAt: '2026-01-02T00:00:00Z' };
  persistCanonicalChatHistoryRecord(f.threadId, archived);
  const historyBefore = readFileSync(file, 'utf8');
  const payload = { threadId: f.threadId, ...f.first };
  expect((await linksApi.POST(request('POST', payload))).status).toBe(201);
  mirror(f.first.repositoryId, `fixture/renamed-${sequence}`, f.first.pullRequestId);
  closeDb();
  const links = (await history(f.threadId)).pullRequestContext.links;
  expect(links[0]).toMatchObject({ ...payload, repositoryFullName: `fixture/renamed-${sequence}` });
  expect(links[0].url).toBe(`https://github.com/fixture/renamed-${sequence}/pull/7`);
  expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
  expect((await linksApi.DELETE(request('DELETE', payload))).status).toBe(200);
  expect((await linksApi.DELETE(request('DELETE', payload)).then(response => response.json())).result.removed).toBe(false);
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  expect(readFileSync(file, 'utf8')).toBe(historyBefore);
  expect(getLane(lane.id)).toEqual(laneBefore);
  expect(getLaneEvents(lane.id)).toEqual(eventsBefore);
});

it('pages forward and reverse links without duplicating same-branch conversations', async () => {
  const f = fixture();
  for (const [threadId, identity] of [[f.threadId, f.first], [f.threadId, f.second], [f.otherThreadId, f.first]] as const) {
    expect((await linksApi.POST(request('POST', { threadId, ...identity }))).status).toBe(201);
  }
  const first = await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&limit=1`)).then(r => r.json());
  expect(first.result.links).toHaveLength(1);
  expect(first.result.nextCursor).toBe(first.result.links[0].id);
  const second = await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&limit=1&after=${first.result.nextCursor}`)).then(r => r.json());
  expect(second.result.links[0].id).not.toBe(first.result.links[0].id);
  expect(second.result.nextCursor).toBeNull();
  const query = new URLSearchParams(Object.entries(f.first).map(([key, value]) => [key, String(value)]));
  const reverse = await linksApi.GET(request('GET', undefined, `?${query}&limit=1`)).then(r => r.json());
  const next = await linksApi.GET(request('GET', undefined, `?${query}&limit=1&after=${reverse.result.nextCursor}`)).then(r => r.json());
  expect([reverse.result.links[0].threadId, next.result.links[0].threadId]).toEqual([f.threadId, f.otherThreadId]);
});

it.each(['anonymous', 'unknown', 'worker'] as const)(
  'refuses non-operator authority on every new route method (%s)', async authority => {
    const token = authority === 'worker' ? getOrCreateLocalWorkerToken() : authority === 'unknown' ? 'unknown-token' : '';
    const f = fixture();
    expect(resolveRequestPrincipal(request('GET', undefined, '', token)))
      .toBe(authority === 'worker' ? 'worker' : 'anonymous');
    for (const handler of [linksApi.GET, linksApi.POST, linksApi.DELETE]) {
      const method = handler === linksApi.GET ? 'GET' : handler === linksApi.POST ? 'POST' : 'DELETE';
      const response = await handler(request(method, method === 'GET' ? undefined : { threadId: f.threadId, ...f.first }, '', token));
      expect(response.status).toBe(403);
      expect(panelGateMiddleware(request(method, method === 'GET' ? undefined : {}, '', token)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  },
);

it('retains the default middleware gate and does not expose context to unauthenticated history reads', async () => {
  const f = fixture();
  expect(panelGateMiddleware(request('GET')).headers.get('x-middleware-next')).toBe('1');
  await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }));
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${f.threadId}`, {
    headers: { host: 'localhost' },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).pullRequestContext).toBeUndefined();
});

it('refuses wrong identities, invalid threads and malformed requests without persistence or network actions', async () => {
  const f = fixture();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network action'));
  try {
    for (const override of [{ repositoryId: f.second.repositoryId }, { pullRequestId: f.second.pullRequestId }, { number: 8 }]) {
      const response = await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, ...override }));
      expect(response.status).toBe(409);
    }
    for (const override of [{ host: 'other.example' }, { number: 1.5 }, { repositoryId: -1 }, { threadId: '../escape' }]) {
      expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, ...override }))).status).toBe(400);
    }
    expect((await linksApi.POST(request('POST', { threadId: 'thoughts-missing', ...f.first }))).status).toBe(404);
    expect((await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&after=no`))).status).toBe(400);
    expect((await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&repositoryId=1`))).status).toBe(400);
    const malformed = new NextRequest('http://localhost/api/orchestrator/pull-request-context', {
      method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` }, body: '{',
    });
    expect((await linksApi.POST(malformed)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  } finally { fetch.mockRestore(); }
});

it('refuses stale-name reuse and requires provider repository identity instead of a current name join', async () => {
  const f = fixture();
  const oldName = `repo-${sequence}`;
  upsertGitHubRepository({ repoId: f.first.repositoryId, fullName: `fixture/renamed-${sequence}`,
    owner: 'fixture', name: `renamed-${sequence}`, private: false });
  upsertGitHubRepository({ repoId: f.first.repositoryId + 2, fullName: `fixture/${oldName}`,
    owner: 'fixture', name: oldName, private: false });
  const staleName = await linksApi.POST(request('POST', {
    threadId: f.threadId, ...f.first, repositoryId: f.first.repositoryId + 2,
  }));
  expect(staleName.status).toBe(409);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
  const links = (await history(f.threadId)).pullRequestContext.links;
  expect(links[0].repositoryId).toBe(f.first.repositoryId);
  mirror(f.first.repositoryId, `fixture/renamed-${sequence}`, f.first.pullRequestId);
  expect((await history(f.threadId)).pullRequestContext.links[0].repositoryFullName).toBe(`fixture/renamed-${sequence}`);
});

it('allows unlink after the real conversation deletion entry point and stale mirror removal', async () => {
  const f = fixture();
  const payload = { threadId: f.threadId, ...f.first };
  await linksApi.POST(request('POST', payload));
  const response = await deleteHistory(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${f.threadId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  getSqlite().prepare('DELETE FROM github_pull_requests WHERE pull_request_id = ?').run(f.first.pullRequestId);
  const removed = await linksApi.DELETE(request('DELETE', payload));
  expect(removed.status).toBe(200);
  expect((await removed.json()).result.removed).toBe(true);
});

it('refuses legacy mirror rows without immutable repository evidence after reopening the database', async () => {
  const f = fixture();
  getSqlite().prepare('UPDATE github_pull_requests SET repository_id = NULL WHERE pull_request_id = ?').run(f.first.pullRequestId);
  closeDb();
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(409);
});

it('does not treat an enterprise mirror with matching numeric IDs as a GitHub.com PR', async () => {
  const f = fixture();
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
  getSqlite().prepare('UPDATE github_pull_requests SET url = ? WHERE pull_request_id = ?')
    .run(`https://enterprise.example/fixture/repo-${sequence}/pull/7`, f.first.pullRequestId);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(409);
  expect((await history(f.threadId)).pullRequestContext.links[0].url)
    .toBe(`https://github.com/fixture/repo-${sequence}/pull/7`);
});

it('ignores a hostless repository-name cache collision for new and existing GitHub.com links', async () => {
  const f = fixture();
  const payload = { threadId: f.threadId, ...f.first };
  await linksApi.POST(request('POST', payload));
  upsertGitHubRepository({ repoId: f.first.repositoryId, fullName: `enterprise/colliding-${sequence}`,
    owner: 'enterprise', name: `colliding-${sequence}`, private: true });
  const expected = `https://github.com/fixture/repo-${sequence}/pull/7`;
  expect((await history(f.threadId)).pullRequestContext.links[0].url).toBe(expected);
  const response = await linksApi.POST(request('POST', { threadId: f.otherThreadId, ...f.first }));
  expect(response.status).toBe(201);
  expect((await response.json()).result.link.url).toBe(expected);
});

it('pins signed webhook repository identity before an operator attaches the PR', async () => {
  const f = fixture();
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'fixture-not-used-for-signing');
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'fixture-webhook-only');
  const { POST: webhook } = await import('@/app/api/github/webhook/route');
  const raw = JSON.stringify({
    action: 'opened', repository: { id: f.first.repositoryId, full_name: `fixture/repo-${sequence}` },
    pull_request: { id: f.first.pullRequestId, number: 7, title: 'Fixture PR', state: 'open',
      html_url: `https://github.com/fixture/repo-${sequence}/pull/7`,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  });
  getSqlite().prepare('UPDATE github_pull_requests SET repository_id = NULL WHERE pull_request_id = ?').run(f.first.pullRequestId);
  const signature = `sha256=${createHmac('sha256', 'fixture-webhook-only').update(raw).digest('hex')}`;
  const response = await webhook(new NextRequest('http://localhost/api/github/webhook', {
    method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': signature }, body: raw,
  }));
  expect(response.status).toBe(200);
  expect(getSqlite().prepare('SELECT repository_id FROM github_pull_requests WHERE pull_request_id = ?')
    .get(f.first.pullRequestId)).toEqual({ repository_id: f.first.repositoryId });
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
});

it('exposes conversation PR association parity in the actual operator MCP catalog', async () => {
  const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2366, method: 'tools/list' }, 'full');
  expect((response?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toContain('o8_conversation_prs');
});

it('persists independent context, review and imported associations without changing primary delivery', async () => {
  const f = fixture();
  const lane = createLane({ repoPath: root, branch: 'shared-branch', runtime: 'codex' });
  updateLane(lane.id, { prNumber: 99 });
  const before = getLane(lane.id);
  for (const kind of ['context', 'review', 'import']) {
    const response = await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, kind }));
    expect(response.status).toBe(201);
    expect((await response.json()).result.link).toMatchObject({ kind, source: 'operator' });
  }
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, kind: 'import' }))).status).toBe(200);
  for (const override of [{ kind: 'delivery' }, { source: 'packet' }]) expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, ...override }))).status).toBe(400);
  await linksApi.DELETE(request('DELETE', { threadId: f.threadId, ...f.first, kind: 'review' }));
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links.map((link: { kind: string }) => link.kind)).toEqual(['context', 'import']);
  expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
  expect(getLane(lane.id)).toEqual(before);
});

it('resolves provider identities and refuses mixed or wrong repository addresses', async () => {
  const f = fixture();
  const resolved = await linksApi.GET(request('GET', undefined, `?repo=fixture/repo-${sequence}&number=7&resolve=1`));
  expect((await resolved.json()).result.identity).toEqual(f.first);
  for (const query of [`?repo=fixture/missing&number=7`, `?repo=fixture/repo-${sequence}&number=7&repositoryId=${f.second.repositoryId}`, `?threadId=${f.threadId}&repo=fixture/repo-${sequence}`, '?threadId=../escape']) {
    expect((await linksApi.GET(request('GET', undefined, query))).status).toBeGreaterThanOrEqual(400);
  }
  getSqlite().prepare('UPDATE github_pull_requests SET url = ? WHERE pull_request_id = ?').run('https://enterprise.example/fixture/pr/pull/7', f.first.pullRequestId);
  expect((await linksApi.GET(request('GET', undefined, `?repo=fixture/repo-${sequence}&number=7&resolve=1`))).status).toBe(409);
});

it('gives a paired mobile read the same links and archived thread, but no mutation capability', async () => {
  const { GET: mobileGet } = await import('@/app/api/mobile/conversation-pr-context/route');
  const { createHash } = await import('node:crypto');
  const f = fixture();
  const token = 'fixture-device-context-read';
  const { readActiveTokenHashes, writeActiveTokenHashes } = await import('@/lib/mobile/device-token-file');
  writeActiveTokenHashes([createHash('sha256').update(token).digest('hex')]);
  expect(readActiveTokenHashes().has(createHash('sha256').update(token).digest('hex'))).toBe(true);
  persistCanonicalChatHistoryRecord(f.threadId, { ...JSON.parse(readFileSync(getCanonicalChatHistoryPath(f.threadId), 'utf8')), archivedAt: '2026-01-02T00:00:00Z' });
  await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, kind: 'import' }));
  const mobileRequest = (bearer: string, query = `?threadId=${f.threadId}`, method = 'GET') => new NextRequest(`http://localhost/api/mobile/conversation-pr-context${query}`, { method, headers: { authorization: `Bearer ${bearer}`, host: 'localhost' } });
  const mobile = await mobileGet(mobileRequest(token));
  expect(mobile.status).toBe(200);
  const body = await mobile.json();
  expect(body.result.links).toEqual((await history(f.threadId)).pullRequestContext.links);
  expect(body.result.thread).toMatchObject({ id: f.threadId });
  expect(panelGateMiddleware(mobileRequest(token)).headers.get('x-middleware-next')).toBe('1');
  expect(panelGateMiddleware(mobileRequest(token, '', 'POST')).status).toBe(403);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.second }, '', token))).status).toBe(403);
  for (const bearer of ['', 'invalid', getOrCreateLocalWorkerToken()]) expect((await mobileGet(mobileRequest(bearer))).status).toBe(403);
});

it('roundtrips the built CLI and registered MCP tool through the real API and persisted reverse links', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { build } = await import('esbuild');
  const f = fixture();
  provider.read.mockImplementation(async (repo: string, resource: string) => {
    const current = getGitHubPullRequestByNumber(repo, 7)!;
    expect(resource).toBe(`/repos/${repo}/pulls/7`);
    return { installation: { id: 2366 }, response: Response.json({ id: current.pullRequestId, number: 7, title: current.title, state: 'open',
      base: { repo: { id: current.repositoryId }, ref: 'main' }, head: { ref: 'shared-branch' }, html_url: current.url }) };
  });
  const calls: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    calls.push(`${incoming.method} ${incoming.url}`);
    let body = ''; for await (const chunk of incoming) body += chunk;
    if (!incoming.url?.startsWith('/api/orchestrator/pull-request-context')) { outgoing.writeHead(404).end(); return; }
    const req = new NextRequest(`http://localhost${incoming.url}`, { method: incoming.method, headers: { host: 'localhost', authorization: incoming.headers.authorization ?? '' }, ...(body ? { body } : {}) });
    const handler = incoming.method === 'POST' ? linksApi.POST : incoming.method === 'DELETE' ? linksApi.DELETE : linksApi.GET;
    const response = await handler(req);
    outgoing.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const bundle = path.join(root, 'o8-cli.mjs');
    await build({ entryPoints: [path.join(process.cwd(), 'cli/src/index.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: '"fixture"' }, banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url); globalThis.require = require;" } });
    const run = async (args: string[], token = getOrCreateWsToken()) => {
      const env: NodeJS.ProcessEnv = { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: token };
      delete env.O8_WORKER_TOKEN; delete env.O8_WORKER_PACKET_ID; delete env.O8_SPECTATOR_TOKEN;
      const child = spawn(process.execPath, [bundle, 'conversation-prs', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      return { code, stdout, stderr };
    };
    const address = ['--repo', `fixture/repo-${sequence}`, '--number', '7'];
    const add = await run(['add', '--thread', f.threadId, ...address, '--kind', 'import']);
    expect(add.code, add.stderr).toBe(0);
    expect(JSON.parse(add.stdout).result.link).toMatchObject({ kind: 'import', source: 'operator' });
    closeDb();
    const cli = await run(['list', '--thread', f.threadId]);
    expect(cli.code, cli.stderr).toBe(0);
    const expected = JSON.parse(cli.stdout).result.links;
    const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    setApiBase(`http://127.0.0.1:${port}`);
    const mcp = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2366, method: 'tools/call', params: { name: 'o8_conversation_prs', arguments: { action: 'list', threadId: f.threadId } } }, 'full');
    const result = mcp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError, result.content[0].text).not.toBe(true);
    expect(JSON.parse(result.content[0].text).result.links).toEqual(expected);
    const reverse = await run(['reverse', ...address]);
    expect(JSON.parse(reverse.stdout).result.links).toEqual(expected);
    const denied = await run(['add', '--thread', f.otherThreadId, ...address], getOrCreateLocalWorkerToken());
    expect(denied.code).toBe(3);
    expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
    const wrong = await run(['add', '--thread', f.threadId, '--repository-id', String(f.second.repositoryId), '--pr-id', String(f.first.pullRequestId), '--number', '7']);
    expect(wrong.code).toBe(5);
    const callMcp = async (args: Record<string, unknown>) => {
      const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2367, method: 'tools/call', params: { name: 'o8_conversation_prs', arguments: args } }, 'full');
      const result = response?.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError, result.content[0].text).not.toBe(true);
      return JSON.parse(result.content[0].text);
    };
    expect((await callMcp({ action: 'add', threadId: f.threadId, ...f.first, kind: 'review' })).result.created).toBe(true);
    const providerReads = provider.read.mock.calls.length;
    provider.read.mockRejectedValue(new Error('Offline provider'));
    expect((await callMcp({ action: 'remove', threadId: f.threadId, repo: `fixture/repo-${sequence}`, number: 7, kind: 'review' })).result.removed).toBe(true);
    const remove = await run(['remove', '--thread', f.threadId, ...address, '--kind', 'import']);
    expect(provider.read).toHaveBeenCalledTimes(providerReads);
    expect(remove.code, remove.stderr).toBe(0);
    closeDb();
    expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
    expect(calls.every(call => /^(GET|POST|DELETE) \/api\/orchestrator\/pull-request-context/.test(call))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);


it('binds only the durable packet owner, including archived missions and multiple primary deliveries', async () => {
  const f = fixture();
  const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { recordMission } = await import('@/lib/db/missions-store');
  const { recordConversationPrDelivery } = await import('@/lib/orchestrator/pull-request-delivery');
  const packets = [1, 2].map(index => ({ id: `pkt-context-${sequence}-${index}`, title: 'Delivery', runtime: 'codex', orchestratorThreadId: f.threadId }));
  const state = normalizeOrchestratorMissionState({ version: 2, missionId: `mission-context-${sequence}`, repoPath: root, runtime: 'codex', prompt: 'Delivery', packets });
  recordMission({ id: state.missionId!, repoPath: root, runtime: 'codex', prompt: '', summary: '', constraints: '', totalWaves: 1, packetMeta: [], missionState: state });
  getSqlite().prepare('UPDATE missions SET archived_at = ? WHERE id = ?').run(Date.now(), state.missionId);
  const lanes = packets.map((packet, index) => {
    const lane = createLane({ repoPath: root, branch: 'shared-branch', runtime: 'codex', packetId: packet.id });
    updateLane(lane.id, { prNumber: [f.first, f.second][index].number });
    return lane;
  });
  // No current mission contains them: only the durable archived registry owns these packets.
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ version: 2, packets: [] }));
  provider.read.mockImplementation(async (repo: string) => {
    const pr = getGitHubPullRequestByNumber(repo.toLowerCase(), 7)!;
    return { response: Response.json({ id: pr.pullRequestId, number: 7, base: { repo: { id: pr.repositoryId } }, html_url: pr.url }) };
  });
  for (let index = 0; index < lanes.length; index++) {
    const repo = index ? `fixture/other-${sequence}` : `fixture/repo-${sequence}`;
    await recordConversationPrDelivery(lanes[index].id, `https://github.com/${repo.toUpperCase()}/pull/7`);
    await recordConversationPrDelivery(lanes[index].id, `https://github.com/${repo.toUpperCase()}/pull/7`);
  }
  closeDb();
  const links = (await history(f.threadId)).pullRequestContext.links;
  expect(links).toHaveLength(2);
  expect(links.map((link: { packetId: string }) => link.packetId)).toEqual(packets.map(packet => packet.id));
  expect(links.every((link: { kind: string; source: string }) => link.kind === 'delivery' && link.source === 'packet')).toBe(true);
  expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ ...state, packets: [{ ...state.packets[0], orchestratorThreadId: f.otherThreadId }] }));
  await expect(recordConversationPrDelivery(lanes[0].id, `https://github.com/fixture/repo-${sequence}/pull/7`)).rejects.toThrow(/inconsistent/);
  expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
  expect((await linksApi.DELETE(request('DELETE', { threadId: f.threadId, ...f.first, kind: 'delivery' }))).status).toBe(400);
  // A display URL can be reused after rename. A resolved lane provenance is immutable.
  mirror(f.first.repositoryId, `fixture/renamed-delivery-${sequence}`, f.first.pullRequestId);
  mirror(f.first.repositoryId + 10000, `fixture/repo-${sequence}`, f.first.pullRequestId + 100000);
  closeDb();
  const afterReuse = (await history(f.threadId)).pullRequestContext.links;
  expect(afterReuse).toHaveLength(2);
  expect(afterReuse[0]).toMatchObject({ repositoryId: f.first.repositoryId, pullRequestId: f.first.pullRequestId, repositoryFullName: `fixture/renamed-delivery-${sequence}` });

});


it.each(['offline', 'wrong-url', 'missing-id'] as const)('leaves a %s delivery unresolved instead of trusting a stale mirror', async failure => {
  const f = fixture();
  const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { recordMission } = await import('@/lib/db/missions-store');
  const { recordConversationPrDelivery } = await import('@/lib/orchestrator/pull-request-delivery');
  const packetId = `pkt-unverified-${sequence}`;
  const state = normalizeOrchestratorMissionState({ version: 2, missionId: `mission-unverified-${sequence}`, repoPath: root, runtime: 'codex',
    prompt: 'Delivery', packets: [{ id: packetId, title: 'Delivery', runtime: 'codex', orchestratorThreadId: f.threadId }] });
  recordMission({ id: state.missionId!, repoPath: root, runtime: 'codex', prompt: '', summary: '', constraints: '', totalWaves: 1, packetMeta: [], missionState: state });
  const lane = createLane({ repoPath: root, branch: 'shared-branch', runtime: 'codex', packetId });
  updateLane(lane.id, { prNumber: 7 });
  const url = `https://github.com/fixture/repo-${sequence}/pull/7`;
  provider.read.mockImplementation(async () => {
    if (failure === 'offline') throw new Error('Offline provider');
    return { response: Response.json({ id: failure === 'missing-id' ? undefined : f.first.pullRequestId,
      number: 7, base: { repo: { id: f.first.repositoryId } }, html_url: failure === 'wrong-url' ? `${url}0` : url }) };
  });
  await expect(Promise.resolve().then(() => recordConversationPrDelivery(lane.id, url))).rejects.toThrow();
  const reads = provider.read.mock.calls.length;
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  // Even a later populated mirror cannot authenticate a failed original publication receipt.
  mirror(f.first.repositoryId, `fixture/repo-${sequence}`, f.first.pullRequestId);
  expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  await expect(recordConversationPrDelivery(lane.id, url)).rejects.toThrow(/not verified at publication/);
  expect(provider.read).toHaveBeenCalledTimes(reads);
  expect(getSqlite().prepare('SELECT packet_id FROM conversation_pr_delivery_intents WHERE lane_id = ?').get(lane.id)).toEqual({ packet_id: packetId });
});

it('imports an accessible external PR from an empty mirror through the actual resolver and targeted broker read', async () => {
  const f = fixture();
  const repo = `external/import-${sequence}`;
  const identity = { host: 'github.com', repositoryId: 82366, pullRequestId: 823660, number: 103 };
  expect(getGitHubPullRequestByNumber(repo, 103)).toBeNull();
  provider.read.mockImplementation(async (requested: string, resource: string, init?: RequestInit) => {
    expect(requested).toBe(repo); expect(resource).toBe(`/repos/${repo}/pulls/103`); expect(init?.method ?? 'GET').toBe('GET');
    return { installation: { id: 2366 }, response: Response.json({ id: identity.pullRequestId, number: 103, title: 'External PR', state: 'open',
      base: { ref: 'main', repo: { id: identity.repositoryId } }, head: { ref: 'external-review' }, html_url: `https://github.com/${repo}/pull/103`, user: { login: 'fixture-author' } }) };
  });
  const resolved = await linksApi.GET(request('GET', undefined, `?repo=${repo}&number=103&resolve=1&refresh=1`));
  expect(resolved.status).toBe(200); expect((await resolved.json()).result.identity).toEqual(identity);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...identity, kind: 'import' }))).status).toBe(201);
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links).toEqual([expect.objectContaining({ ...identity, repositoryFullName: repo, kind: 'import', source: 'operator' })]);
  expect(getGitHubPullRequestByNumber(repo, 103)).toMatchObject({ repositoryId: identity.repositoryId, pullRequestId: identity.pullRequestId });
});
