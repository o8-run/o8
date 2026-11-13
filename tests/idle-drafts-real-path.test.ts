import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ list: vi.fn(), comment: vi.fn(), close: vi.fn(), detail: vi.fn(), assign: vi.fn(), preview: vi.fn(), dispatch: vi.fn(), repos: vi.fn() }));
vi.mock('@/lib/lane/commands', async original => ({ ...await original<typeof import('@/lib/lane/commands')>(), dispatch: h.dispatch }));
vi.mock('@/lib/github-broker/pull-request-list', () => ({ fetchPullRequestListPage: h.list }));
vi.mock('@/lib/github-broker', async original => ({ ...await original<typeof import('@/lib/github-broker')>(),
  ensureGitHubPullRequests: h.preview,
  commentOnGitHubPullRequest: h.comment, closeGitHubPullRequest: h.close, fetchGitHubPullRequestDetail: h.detail,
}));
vi.mock('@/lib/github-broker/auth', async original => ({ ...await original<typeof import('@/lib/github-broker/auth')>(),
  githubInstallationFetch: h.assign,
}));
vi.mock('@/lib/review/workspace', () => ({ getWorkspaceReviewSnapshot: async () => null }));
vi.mock('@/lib/repos/registry', async original => ({ ...await original<typeof import('@/lib/repos/registry')>(), listRepos: h.repos }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [], events: [], meta: { mode: 'live', sourceLabel: 'fixture' } }) }));
import { GET } from '@/app/api/panel/prs/route';
import { POST } from '@/app/api/panel/prs/[number]/route';
import { GET as inbox } from '@/app/api/mobile/inbox/route';
const age = 4 * 86400000;
const headSha = 'a'.repeat(40);
let observedUpdatedAt = new Date(Date.now() - age).toISOString();
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
function row(overrides = {}) {
  return { number: 7, title: 'Idle fixture', draft: true, state: 'open', headSha, updatedAt: observedUpdatedAt,
    checks: 'failure', mergeable: 'CONFLICTING', baseRefName: 'main', url: 'https://github.com/example/repo/pull/7', ...overrides };
}
beforeEach(async () => {
  vi.clearAllMocks();
  observedUpdatedAt = new Date(Date.now() - age).toISOString();
  const { bumpSignInEpoch } = await import('@/lib/github-broker/managed');
  bumpSignInEpoch();
  h.repos.mockResolvedValue([{ name: 'Fixture repository', localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' }]);
  h.comment.mockReset().mockResolvedValue(undefined); h.close.mockReset().mockResolvedValue(undefined);
  h.list.mockResolvedValue({ prs: [row(), row({ number: 8, draft: false }), row({ number: 9, updatedAt: new Date().toISOString() }),
    row({ number: 10, state: 'closed' }), row({ number: 11, updatedAt: 'invalid' })], repo: 'example/repo', nextPage: 2 });
  h.preview.mockResolvedValue({ prs: [], stale: false });
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [] });
  h.assign.mockResolvedValue({ response: Response.json({ assignees: [{ login: 'fixture-owner' }] }) });
});
const post = (decision: string, extra = {}, token = getOrCreateWsToken()) => POST(new Request('http://localhost/api/panel/prs/7', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'draft-decision', decision, repo: 'example/repo', expectedHeadSha: headSha, expectedUpdatedAt: observedUpdatedAt, ...extra }),
}), { params: Promise.resolve({ number: '7' }) });
it('lists idle drafts through the panel HTTP entry point with age, checks, conflict and three decisions', async () => {
  const response = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.drafts).toHaveLength(1);
  expect(body.drafts[0]).toMatchObject({ number: 7, headSha, updatedAt: observedUpdatedAt, ageDays: 4, checks: 'failure', conflictsWithMain: true,
    decisions: ['continue', 'handoff', 'close'] });
  expect(body.nextPage).toBe(2);
  expect(h.preview).not.toHaveBeenCalled();
});
it('surfaces the same drafts in the existing Inbox data path', async () => {
  const response = await inbox(new NextRequest('http://localhost/api/mobile/inbox?fresh=1'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.staleDrafts?.drafts[0]).toMatchObject({ number: 7 });
  expect(body.items).toContainEqual(expect.objectContaining({ id: 'idle-draft:example/repo:7', kind: 'review',
    detail: expect.stringContaining('Continue / Handoff / Close') }));
});
it('Continue records a comment without closing or assigning', async () => {
  expect((await post('continue', { reason: 'Picking this up' })).status).toBe(200);
  expect(h.comment).toHaveBeenCalledWith('example/repo', 7, 'Continue draft: Picking this up');
  expect(h.close).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
});
it('Handoff records a GitHub owner and comment', async () => {
  expect((await post('handoff', { owner: 'fixture-owner', reason: 'Take over review' })).status).toBe(200);
  expect(h.assign).toHaveBeenCalledWith('example/repo', '/repos/example/repo/issues/7/assignees', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ assignees: ['fixture-owner'] }),
  }));
  expect(h.comment).toHaveBeenCalledWith('example/repo', 7, 'Handoff draft to @fixture-owner: Take over review');
  expect(h.close).not.toHaveBeenCalled();
});
it('Close requires a reason and records it before closing', async () => {
  expect((await post('close')).status).toBe(400); expect(h.comment).not.toHaveBeenCalled();
  expect((await post('close', { reason: 'Superseded' })).status).toBe(200);
  expect(h.comment).toHaveBeenCalledWith('example/repo', 7, 'Close draft: Superseded');
  expect(h.close).toHaveBeenCalledWith('example/repo', 7);
  expect(h.comment.mock.invocationCallOrder[0]).toBeLessThan(h.close.mock.invocationCallOrder[0]);
});
it('refuses a stale decision on a ready PR and invalid owners before writing', async () => {
  h.detail.mockResolvedValue({ ...row(), draft: false, statusCheckRollup: [] });
  expect((await post('continue')).status).toBe(409);
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [] });
  expect((await post('handoff', { owner: 'bad owner' })).status).toBe(400);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled();
});
it('exposes paged results through the CLI command and registered MCP tool without replaying writes', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = 'http://localhost'+request.url;
    const result = request.method === 'POST'
      ? await POST(new Request(url, { method: 'POST', headers: request.headers as Record<string, string>, body: Buffer.concat(chunks).toString() }), { params: Promise.resolve({ number: '7' }) })
      : await GET(new Request(url));
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
  vi.stubEnv('O8_API_PORT', String(address.port)); vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const { runInbox } = await import('../cli/src/commands/inbox');
    expect(await runInbox({ human: false } as Parameters<typeof runInbox>[0], 'drafts', ['--repo', 'example/repo'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).drafts[0]).toMatchObject({ number: 7, ageDays: 4 });
    const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
    setApiBase(`http://127.0.0.1:${address.port}`);
    const { handleOperatorMcpMessage, operatorToolsForProfile } = await import('@/lib/mcp/operator-mcp-host');
    expect(operatorToolsForProfile()).toContainEqual(expect.objectContaining({ name: 'o8_idle_drafts' }));
    const list = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_idle_drafts', arguments: { action: 'list', repo: 'example/repo' } } });
    expect(JSON.stringify(list)).toContain('Idle fixture');
    await runInbox({ human: false } as Parameters<typeof runInbox>[0], 'continue-draft', ['7', '--repo', 'example/repo', '--expected-head-sha', headSha, '--expected-updated-at', observedUpdatedAt, '--reason', 'Resume tomorrow']);
    expect(h.comment).toHaveBeenLastCalledWith('example/repo', 7, 'Continue draft: Resume tomorrow');
    h.comment.mockClear(); h.close.mockRejectedValueOnce(new Error('uncertain close'));
    const result = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_idle_drafts', arguments: { action: 'close', repo: 'example/repo', number: 7, expectedHeadSha: headSha, expectedUpdatedAt: observedUpdatedAt, reason: 'Superseded' } } });
    expect(JSON.stringify(result)).toContain('Inspect');
    expect(h.comment).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
    await expect(runInbox({ human: false, verbose: false }, 'continue-draft', ['7', '--repo', 'example/repo', '--expected-head-sha', headSha, '--expected-updated-at', observedUpdatedAt, '--reason', '--owner', 'x'])).rejects.toMatchObject({ code: 'invalid_args' });
    const commentsBefore = h.comment.mock.calls.length;
    await expect(runInbox({ human: false, verbose: false }, 'continue-draft', ['7', '--repo', 'example/repo', '--expected-head-sha', headSha, '--expected-updated-at', observedUpdatedAt, '--comment', 'Removed field'])).rejects.toMatchObject({ code: 'invalid_args' });
    const removed = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'o8_idle_drafts', arguments: { action: 'continue', repo: 'example/repo', number: 7, expectedHeadSha: headSha, expectedUpdatedAt: observedUpdatedAt, comment: 'Removed field' } } });
    expect(removed?.result).toMatchObject({ isError: true });
    expect(h.comment).toHaveBeenCalledTimes(commentsBefore);

  } finally {
    output.mockRestore(); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
it('reports an unknown conflict against main for a non-main PR base', async () => {
  h.list.mockResolvedValue({ prs: [row({ baseRefName: 'feature/base' })], repo: 'example/repo', nextPage: null });
  const response = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  expect((await response.json()).drafts[0].conflictsWithMain).toBe(null);
});

it('surfaces age, checks, conflicts and decisions through the desktop Inbox feed without new UI', async () => {
  const { GET: desktopInbox } = await import('@/app/api/panel/supervisor-inbox/route');
  const response = await desktopInbox(new Request('http://localhost/api/panel/supervisor-inbox?includeMaintainer=1&scope=all'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.maintainer.contributions[0]).toMatchObject({ number: 7, idleDraft: { ageDays: 4, checks: 'failure', conflictsWithMain: true } });
  expect(body.maintainer.contributions[0].title).toContain('Continue / Handoff / Close');
});

it('uses a three-day threshold and preserves unknown check and mergeability evidence', async () => {
  h.list.mockResolvedValue({ prs: [row({ number: 1, updatedAt: new Date(Date.now() - 3 * 86400000 - 1000).toISOString(), checks: null, mergeable: 'UNKNOWN' }),
    row({ number: 2, updatedAt: new Date(Date.now() - 3 * 86400000 + 1000).toISOString() })], repo: 'example/repo', nextPage: null });
  const response = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  const body = await response.json();
  expect(body.drafts.map((pr: { number: number }) => pr.number)).toEqual([1]);
  expect(body.drafts[0]).toMatchObject({ ageDays: 3, checks: null, conflictsWithMain: null });
  expect(h.dispatch).not.toHaveBeenCalled();
});
it('coalesces repeated Inbox refreshes without reusing summaries across sign-in epochs', async () => {
  const { bumpSignInEpoch } = await import('@/lib/github-broker/managed');
  bumpSignInEpoch();
  await inbox(new NextRequest('http://localhost/api/mobile/inbox?fresh=1'));
  await inbox(new NextRequest('http://localhost/api/mobile/inbox?fresh=1'));
  expect(h.list).toHaveBeenCalledTimes(1);
  bumpSignInEpoch();
  await inbox(new NextRequest('http://localhost/api/mobile/inbox?fresh=1'));
  expect(h.list).toHaveBeenCalledTimes(2);
});

it('reports an uncertain owner assignment without posting a handoff comment', async () => {
  h.assign.mockResolvedValueOnce({ response: Response.json({ error: 'unknown assignment' }, { status: 502 }) });
  const response = await post('handoff', { owner: 'fixture-owner' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ ownerAssigned: null, commentPosted: false });
  expect(h.comment).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
});
it('stops later decision writes when the GitHub account changes during handoff', async () => {
  const { bumpSignInEpoch } = await import('@/lib/github-broker/managed');
  h.assign.mockImplementationOnce(async () => {
    bumpSignInEpoch();
    return { response: Response.json({ assignees: [{ login: 'fixture-owner' }] }) };
  });
  const response = await post('handoff', { owner: 'fixture-owner' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ ownerAssigned: true, commentPosted: false });
  expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  h.comment.mockImplementationOnce(async () => { bumpSignInEpoch(); });
  const closing = await post('close', { reason: 'Superseded' });
  expect(closing.status).toBe(502);
  expect(await closing.json()).toMatchObject({ commentPosted: true });
  expect(h.close).not.toHaveBeenCalled();
});

it.each(['head', 'updatedAt', 'active'] as const)('review correction: Close refuses a changed %s snapshot before any GitHub write', async changed => {
  const listed = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  const seen = (await listed.json()).drafts[0];
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [], ...(changed === 'head' ? { headSha: 'b'.repeat(40) }
    : { updatedAt: new Date(Date.now() - 3600000).toISOString() }) });
  const response = await post('close', { reason: 'Superseded', expectedHeadSha: seen.headSha, expectedUpdatedAt: changed === 'active' ? new Date(Date.now() - 3600000).toISOString() : seen.updatedAt });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/changed|idle|refresh/i);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled();
});
it('review correction: simultaneous decisions cannot post or close twice', async () => {
  let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.detail.mockImplementationOnce(async () => { entered(); await pending; return { ...row(), statusCheckRollup: [] }; });
  const first = post('close', { reason: 'Superseded' });
  await started;
  let second: Response;
  try { second = await post('close', { reason: 'Superseded' }); }
  finally { release(); }
  expect((await first).status).toBe(200);
  expect(second!.status).toBe(409);
  expect(h.comment).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
});
it.each([undefined, 'repo', '/workspace/repo', 'https://github.com/example/repo', '../repo'])('review correction: decisions reject nonliteral repository %s', async repo => {
  const response = await post('continue', { repo });
  expect(response.status).toBe(400);
  expect(h.comment).not.toHaveBeenCalled();
});
it('review correction: oversized UTF-8 reason and removed comment field return 400 before remote writes', async () => {
  expect((await post('close', { reason: 'é'.repeat(2500) })).status).toBe(400);
  expect((await post('continue', { comment: 'x'.repeat(4097) })).status).toBe(400);
  expect((await post('close', { reason: 'x'.repeat(4090) })).status).toBe(400);
  expect(h.detail).not.toHaveBeenCalled(); expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it('review correction: a draft with pending checks is not flagged as idle', async () => {
  h.list.mockResolvedValue({ prs: [row({ checks: 'pending' })], repo: 'example/repo', nextPage: null });
  const response = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  expect((await response.json()).drafts).toEqual([]);
});
it('review correction: mobile reads registered repositories without an environment default or mocked repo resolver', async () => {
  h.repos.mockResolvedValue([{ name: 'First', localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' },
    { name: 'Second', localPath: '/workspace/second', remoteUrl: 'git@github.com:example/second.git' }]);
  h.list.mockImplementation(async (repo: string) => ({ prs: [row()], repo, nextPage: null }));
  const response = await inbox(new NextRequest('http://localhost/api/mobile/inbox?fresh=1'));
  const body = await response.json();
  expect(body.staleDrafts.drafts.map((pr: { repo: string }) => pr.repo).sort()).toEqual(['example/repo', 'example/second']);
  expect(body.items).toContainEqual(expect.objectContaining({ id: 'idle-draft:example/second:7', metadata: expect.objectContaining({ expectedHeadSha: headSha, expectedUpdatedAt: observedUpdatedAt }) }));
});
it('review correction: remote pagination is distinct from the local contribution cap', async () => {
  const { GET: desktopInbox } = await import('@/app/api/panel/supervisor-inbox/route');
  const response = await desktopInbox(new Request('http://localhost/api/panel/supervisor-inbox?includeMaintainer=1&scope=all'));
  expect((await response.json()).maintainer).toMatchObject({ truncated: false, idleDraftNextPages: { 'example/repo': 2 } });
});
it('review correction: a real worker credential cannot submit a draft decision', async () => {
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const response = await post('close', { reason: 'Superseded' }, mintPacketWorkerToken('draft-worker-fixture'));
  expect(response.status).toBe(403);
  expect(h.detail).not.toHaveBeenCalled(); expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it.each(['continue', 'handoff'])('also refuses a stale %s decision without any write', async decision => {
  h.detail.mockResolvedValue({ ...row(), headSha: 'b'.repeat(40), statusCheckRollup: [] });
  expect((await post(decision, { owner: 'fixture-owner', reason: 'Resume' })).status).toBe(409);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it('refuses a newly pending check even when head and timestamp are unchanged', async () => {
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [{ name: 'unit', status: 'in_progress', conclusion: null }] });
  expect((await post('close', { reason: 'Superseded' })).status).toBe(409);
  expect(h.detail).toHaveBeenCalledWith('example/repo', 7, undefined, 'interactive', true);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it('refuses missing snapshot fields and unavailable fresh checks before writing', async () => {
  expect((await post('close', { reason: 'Superseded', expectedHeadSha: undefined })).status).toBe(400);
  expect(h.detail).not.toHaveBeenCalled();
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [], checksUnavailable: true });
  expect((await post('close', { reason: 'Superseded' })).status).toBe(409);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});

it.each(['PENDING', 'EXPECTED'])('refuses a pending required status %s with no check runs and no write', async state => {
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [], requiredStatuses: [{ state }] });
  expect((await post('close', { reason: 'Superseded' })).status).toBe(409);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it('refuses an unregistered literal repo without any GitHub call', async () => {
  const response = await post('continue', { repo: 'example/unregistered' });
  expect(response.status).toBe(403);
  expect(h.detail).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled();
  expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
it('rejects the removed comment field before reading or writing GitHub', async () => {
  expect((await post('continue', { comment: 'Unused text' })).status).toBe(400);
  expect(h.detail).not.toHaveBeenCalled(); expect(h.comment).not.toHaveBeenCalled();
});
it.each(['next-link', 'total-count', 'unbounded-page', 'complete-page'])('fresh detail check-page evidence: %s', async mode => {
  const { fetchGitHubPullRequestDetail } = await vi.importActual<typeof import('@/lib/github-broker/details')>('@/lib/github-broker/details');
  h.detail.mockImplementationOnce(fetchGitHubPullRequestDetail);
  h.assign.mockImplementation(async (_repo: string, path: string) => ({ anonymous: true, response: path.endsWith('/pulls/7')
    ? Response.json({ number: 7, title: 'Idle fixture', state: 'open', draft: true, updated_at: observedUpdatedAt, head: { sha: headSha }, base: { ref: 'main' }, changed_files: 0 })
    : path.includes('/check-runs') ? Response.json({ ...(mode === 'total-count' ? { total_count: 101 } : mode === 'complete-page' ? { total_count: 100 } : {}), check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' })) },
      { headers: mode === 'next-link' ? { link: '<https://api.github.com/repos/example/repo/commits/head/check-runs?page=2>; rel="next"' } : {} }) : Response.json([]) }));
  const response = await post('close', { reason: 'Superseded' });
  if (mode === 'complete-page') {
    expect(response.status, await response.clone().text()).toBe(200);
    expect(h.comment).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
  } else {
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await response.json()).error).toMatch(/check status could not be confirmed/i);
    expect(h.comment).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  }
  expect(h.assign.mock.calls.every(([, , options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('refuses an unfinished requested run even when it still carries a terminal conclusion', async () => {
  h.detail.mockResolvedValue({ ...row(), statusCheckRollup: [{ name: 'retry', status: 'requested', conclusion: 'failure' }] });
  expect((await post('close', { reason: 'Superseded' })).status).toBe(409);
  expect(h.comment).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
});
