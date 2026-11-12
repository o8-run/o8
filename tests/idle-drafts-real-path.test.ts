import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ list: vi.fn(), comment: vi.fn(), close: vi.fn(), detail: vi.fn(), assign: vi.fn(), preview: vi.fn(), dispatch: vi.fn() }));
vi.mock('@/lib/lane/commands', async original => ({ ...await original<typeof import('@/lib/lane/commands')>(), dispatch: h.dispatch }));
vi.mock('@/lib/github-broker/pull-request-list', () => ({ fetchPullRequestListPage: h.list }));
vi.mock('@/lib/github-broker', async original => ({ ...await original<typeof import('@/lib/github-broker')>(),
  resolveRepoSlug: async () => 'example/repo', ensureGitHubPullRequests: h.preview,
  commentOnGitHubPullRequest: h.comment, closeGitHubPullRequest: h.close, fetchGitHubPullRequestDetail: h.detail,
}));
vi.mock('@/lib/github-broker/auth', async original => ({ ...await original<typeof import('@/lib/github-broker/auth')>(),
  githubInstallationFetch: h.assign,
}));
vi.mock('@/lib/review/workspace', () => ({ getWorkspaceReviewSnapshot: async () => null }));
vi.mock('@/lib/repos/registry', async original => ({ ...await original<typeof import('@/lib/repos/registry')>(), listRepos: async () => [{ localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' }] }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [], events: [], meta: { mode: 'live', sourceLabel: 'fixture' } }) }));
import { GET } from '@/app/api/panel/prs/route';
import { POST } from '@/app/api/panel/prs/[number]/route';
import { GET as inbox } from '@/app/api/mobile/inbox/route';
const age = 4 * 86400000;
function row(overrides = {}) {
  return { number: 7, title: 'Idle fixture', draft: true, state: 'open', updatedAt: new Date(Date.now() - age).toISOString(),
    checks: 'failure', mergeable: 'CONFLICTING', baseRefName: 'main', url: 'https://github.com/example/repo/pull/7', ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({ prs: [row(), row({ number: 8, draft: false }), row({ number: 9, updatedAt: new Date().toISOString() }),
    row({ number: 10, state: 'closed' }), row({ number: 11, updatedAt: 'invalid' })], repo: 'example/repo', nextPage: 2 });
  h.preview.mockResolvedValue({ prs: [], stale: false });
  h.detail.mockResolvedValue({ number: 7, state: 'open', draft: true });
  h.assign.mockResolvedValue({ response: Response.json({ assignees: [{ login: 'fixture-owner' }] }) });
});
const post = (decision: string, extra = {}) => POST(new Request('http://localhost/api/panel/prs/7', {
  method: 'POST', body: JSON.stringify({ action: 'draft-decision', decision, repo: 'example/repo', ...extra }),
}), { params: Promise.resolve({ number: '7' }) });
it('lists idle drafts through the panel HTTP entry point with age, checks, conflict and three decisions', async () => {
  const response = await GET(new Request('http://localhost/api/panel/prs?view=idle-drafts&repo=example/repo'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.drafts).toHaveLength(1);
  expect(body.drafts[0]).toMatchObject({ number: 7, ageDays: 4, checks: 'failure', conflictsWithMain: true,
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
  h.detail.mockResolvedValue({ state: 'open', draft: false });
  expect((await post('continue')).status).toBe(409);
  h.detail.mockResolvedValue({ state: 'open', draft: true });
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
      ? await POST(new Request(url, { method: 'POST', body: Buffer.concat(chunks).toString() }), { params: Promise.resolve({ number: '7' }) })
      : await GET(new Request(url));
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
  vi.stubEnv('O8_API_PORT', String(address.port)); vi.stubEnv('O8_API_TOKEN', 'fixture');
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
    await runInbox({ human: false } as Parameters<typeof runInbox>[0], 'continue-draft', ['7', '--repo', 'example/repo', '--reason', 'Resume tomorrow']);
    expect(h.comment).toHaveBeenLastCalledWith('example/repo', 7, 'Continue draft: Resume tomorrow');
    h.comment.mockClear(); h.close.mockRejectedValueOnce(new Error('uncertain close'));
    const result = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_idle_drafts', arguments: { action: 'close', repo: 'example/repo', number: 7, reason: 'Superseded' } } });
    expect(JSON.stringify(result)).toContain('Inspect');
    expect(h.comment).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
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
