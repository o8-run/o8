import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const data = mkdtempSync(join(tmpdir(), 'o8-mobile-issues-'));
let token = '';
let deviceId = '';
const project = join(data, 'project');
const path = '/api/mobile/issues';
const calls: string[] = [];
let origin = '';
let changeAccount = false;
let denyTimeline = false;
const api = 'https://api.github.com/repos/acme/widgets';
const issue = { number: 7, title: 'Repair', state: 'open', html_url: 'https://github.com/acme/widgets/issues/7',
  body: 'Description', created_at: '2026-01-23T12:00:00Z', updated_at: '2026-01-24T12:00:00Z',
  user: { login: 'author' }, labels: [{ name: 'mobile' }], assignees: [], comments: 2 };
const pull = { ...issue, number: 8, html_url: 'https://github.com/acme/widgets/pull/8', pull_request: {} };
const nativeFetch = globalThis.fetch;
const server = createServer(async (req, res) => {
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  if (!await handleNativeHttp(req, res, req.socket.localPort, false, '198.51.100.2')) res.writeHead(404).end();
});
const call = (params: Record<string, string>, bearer = token, method = 'GET') =>
  nativeFetch(origin + path + '?' + new URLSearchParams({ repoPath: project, ...params }), {
    headers: { authorization: 'Bearer ' + bearer }, method,
  });

beforeAll(async () => {
  vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(data, 'test.db'));
  writeFileSync(join(data, 'active-identity'), 'fixture-account');
  writeFileSync(join(data, 'github-app-managed.json'), JSON.stringify({ installed: true, token: 'fixture-installation',
    installationId: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), ownerClerkUserId: 'fixture-account', accountLogin: 'acme' }));
  const { enrollDevice } = await import('@/lib/mobile/device-registry');
  const enrollment = enrollDevice({ identityPublicKey: 'fixture-phone-public-key' });
  token = enrollment.deviceToken;
  deviceId = enrollment.deviceId;
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote "origin"]\n  url = git@github.com:acme/widgets.git\n');
  writeFileSync(join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'project', name: 'Project', localPath: project, remoteUrl: 'git@github.com:acme/old-name.git',
  }, { id: 'uncovered', name: 'Uncovered', localPath: project + '-uncovered', remoteUrl: 'https://github.com/another/widgets.git' },
  { id: 'other', name: 'Other', localPath: project + '-other', remoteUrl: 'https://notgithub.com/acme/private.git' }] }));
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (!input.startsWith(api + '/')) throw new Error('Unexpected upstream');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-installation');
    expect(init?.method ?? 'GET').toBe('GET');
    calls.push(input);
    const url = new URL(input);
    const next = { headers: { link: '<https://api.github.com/unused>; rel="next"' } };
    if (changeAccount) writeFileSync(join(data, 'active-identity'), 'another-account');
    if (url.pathname.endsWith('/comments')) return Response.json([{ id: 42, body: 'Reply', user: { login: 'reviewer' }, created_at: issue.created_at }], next);
    if (url.pathname.endsWith('/timeline') && denyTimeline) return new Response(null, { status: 403 });
    if (url.pathname.endsWith('/timeline')) return Response.json([
      { id: 1, event: 'labeled', label: { name: 'mobile' }, actor: { login: 'reviewer' }, created_at: issue.updated_at },
      { id: 2, event: 'cross-referenced', source: { issue: pull } },
      { id: 3, event: 'cross-referenced', source: { issue: { ...pull, html_url: 'https://github.com/elsewhere/private/pull/8', title: 'other project secret' } } },
    ]);
    if (url.pathname.endsWith('/issues/7')) return Response.json(issue);
    if (url.pathname.endsWith('/issues/8')) return Response.json(pull);
    if (url.pathname.endsWith('/issues')) {
      const page = Number(url.searchParams.get('page'));
      const item = page > 1 ? { ...issue, number: 9, title: 'Third matching result' } : issue;
      return Response.json([item, pull], page === 1 ? next : undefined);
    }
    return new Response(null, { status: 404 });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  (await import('@/lib/db')).closeDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(data, { recursive: true, force: true });
});

it('exposes project issues only through the authenticated read route', async () => {
  expect((await call({})).status).toBe(200);
  expect(await (await call({ state: 'all' })).json()).toMatchObject({ repo: 'acme/widgets', nextPage: 2,
    permissions: { create: false }, issues: [{ number: 7, title: 'Repair', commentCount: 2, labels: ['mobile'] }] });
  expect(await (await call({ query: 'Third matching' })).json()).toMatchObject({
    issues: [{ number: 9 }], nextPage: null,
  });
  expect((await call({ number: '23' })).status).toBe(404);
  expect(calls.at(-1)).toBe(api + '/issues/23');
  const before = calls.length;
  expect((await call({}, 'unknown')).status).toBe(401);
  expect((await call({ repoPath: project + '-uncovered' })).status).toBe(403);
  expect((await call({}, token, 'POST')).status).toBeGreaterThanOrEqual(400);
  expect((await call({ repoPath: project + '-other' })).status).toBe(404);
  expect((await call({ repoPath: 'elsewhere/private' })).status).toBe(404);
  expect((await call({ expectedRepo: 'elsewhere/private' })).status).toBe(409);
  expect((await call({ page: '-1' })).status).toBe(400);
  expect(await (await call({ part: 'resolve', expectedRepo: 'ACME/Widgets' })).json()).toEqual({ repo: 'acme/widgets', repoPath: project });
  expect((await call({ part: 'resolve', expectedRepo: 'elsewhere/private' })).status).toBe(404);
  expect(calls.length).toBe(before);
});

it('reads an issue and its comments, filters references to this project, and resolves a PR separately', async () => {
  const read = await call({ number: '7' });
  const detail = await read.json();
  expect(read.status).toBe(200);
  expect(detail).toMatchObject({ kind: 'issue', issue: { number: 7, body: 'Description', states: [],
    permissions: { comment: false, edit: false, labels: false, assignees: false },
    comments: [{ id: '42', body: 'Reply', anchorId: 'issuecomment-42' }], commentsCursor: '2',
    events: [expect.objectContaining({ kind: 'labeled' })],
    linkedPullRequests: [{ repo: 'acme/widgets', number: 8 }] } });
  expect(JSON.stringify(detail)).not.toContain('other project secret');
  expect(await (await call({ number: '7', cursor: '2' })).json()).toMatchObject({ comments: [{ id: '42' }], nextCursor: '3' });
  expect(await (await call({ number: '8' })).json()).toMatchObject({ kind: 'pull-request', repo: 'acme/widgets', number: 8 });
});

it('retains readable issue text and comments when GitHub refuses the timeline', async () => {
  denyTimeline = true;
  try {
    expect(await (await call({ number: '7' })).json()).toMatchObject({ kind: 'issue', issue: {
      body: 'Description', comments: [{ id: '42' }], events: [], eventsIncomplete: true,
    } });
  } finally { denyTimeline = false; }
});

it('discards an in-flight read after the active account changes and refuses a revoked device', async () => {
  changeAccount = true;
  try { expect((await call({ number: '7' })).status).toBe(409); } finally {
    changeAccount = false;
    writeFileSync(join(data, 'active-identity'), 'fixture-account');
  }
  (await import('@/lib/mobile/device-registry')).revokeDevice(deviceId);
  expect((await call({ number: '7' })).status).toBe(401);
});
