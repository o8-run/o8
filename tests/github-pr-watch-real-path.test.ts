import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/panel/prs/[number]/route';
import { getSqlite } from '@/lib/db';
import { githubInstallationFetch } from '@/lib/github-broker/auth';

const state = vi.hoisted(() => ({ installation: 8100, token: 'fixture-token', head: 'a'.repeat(40), comments: [] as Array<{ id: number; body: string; user: { login: string }; created_at: string }> }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({ readManagedGithubToken: () => ({ installationId: state.installation, token: state.token, accountLogin: 'example' }) }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: async () => [{ remoteUrl: 'https://github.com/example/watch', localPath: '/fixture/github-watch' }] }));
vi.mock('@/lib/repos/readiness', () => ({ getCachedRepoReadiness: () => null }));
const request = vi.fn();
const context = (number: number) => ({ params: Promise.resolve({ number: String(number) }) });
const read = (number: number, poll = false) => GET(new Request(`http://localhost/api/panel/prs/${number}?repo=example/watch${poll ? '&poll=1' : ''}`), context(number));
const responseFor = (url: string) => {
  const number = Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
  if (number) return Response.json({ number, title: 'Fixture change', state: 'open', head: { sha: state.head, ref: 'work' }, base: { sha: 'd'.repeat(40), ref: 'main' }, html_url: `https://github.com/example/watch/pull/${number}` });
  if (url.includes('/files?')) return Response.json([{ filename: 'app.ts', additions: 1, patch: '+fixture' }]);
  if (url.includes('/check-runs?')) return Response.json({ check_runs: [] });
  if (url.includes('/issues/') && url.includes('/comments?')) return Response.json(state.comments);
  return Response.json([]);
};
beforeEach(() => { state.installation++; state.head = 'a'.repeat(40); state.token = 'fixture-token'; state.comments = []; request.mockReset(); request.mockImplementation(async (url: string) => responseFor(url)); vi.stubGlobal('fetch', request); });
afterEach(() => vi.unstubAllGlobals());

it('protects the durable route baseline when overlapping reads finish backwards', async () => {
  await read(2100);
  let finish!: (response: Response) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  request.mockImplementation((url: string) => {
    if (url.includes('/files?') && state.head.startsWith('b')) { entered(); return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve(responseFor(url));
  });
  state.head = 'b'.repeat(40); const older = read(2100); await started;
  state.head = 'c'.repeat(40); const newer = await read(2100);
  expect(newer.status).toBe(200); expect((await newer.json()).pr.watch.changes).toEqual(['head']);
  finish(Response.json([{ filename: 'old.ts' }])); expect((await older).status).toBe(409);
  expect((await (await read(2100)).json()).pr.watch.changes).toEqual([]);
  const row = getSqlite().prepare("SELECT COUNT(*) AS count FROM automation_source_events WHERE source_id='github:example/watch#2100'").get() as { count: number };
  expect(row.count).toBe(1);
});
it('does not notify for an own reply observed before its delayed posting result returns', async () => {
  await read(2101);
  let finish!: (response: Response) => void; let entered!: () => void;
  const posted = new Promise<void>(resolve => { entered = resolve; });
  request.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/comments')) {
      state.comments = [{ id: 400, body: 'Own reply', user: { login: 'fixture-bot' }, created_at: '2026-01-01T00:00:00Z' }]; entered();
      return new Promise(resolve => { finish = resolve; });
    }
    return Promise.resolve(responseFor(url));
  });
  const posting = POST(new Request('http://localhost/api/panel/prs/2101', { method: 'POST', body: JSON.stringify({ repo: 'example/watch', action: 'comment', comment: 'Own reply' }) }), context(2101));
  await posted;
  let settled = false; const concurrent = read(2101).then(response => { settled = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 50)); expect(settled).toBe(false);
  finish(Response.json({ id: 400, html_url: 'https://github.com/example/watch/pull/2101#issuecomment-400' }));
  expect((await posting).status).toBe(200);
  expect((await (await concurrent).json()).pr.watch.changes).toEqual([]);
  expect((await (await read(2101)).json()).pr.watch.changes).toEqual([]);
});
it('propagates a first quota refusal with Retry-After and does not classify permission refusals as quota', async () => {
  request.mockImplementationOnce(async () => Response.json({ message: 'Forbidden' }, { status: 403 }));
  expect((await githubInstallationFetch('example/watch', '/repos/example/watch/permission')).response.status).toBe(403);
  expect((await githubInstallationFetch('example/watch', '/repos/example/watch/unrelated')).response.status).toBe(200);
  request.mockImplementation(async () => Response.json({ message: 'Slow down' }, { status: 429, headers: { 'retry-after': '90' } }));
  const response = await read(2102, true);
  expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(89);
});
it('does not reuse a diff when the credential changes while the repository and head stay the same', async () => {
  expect((await read(2103)).status).toBe(200); state.token = 'new-fixture-token';
  request.mockImplementation(async (url: string) => url.includes('/files?') ? Response.json({ message: 'No access' }, { status: 401 }) : responseFor(url));
  expect((await read(2103)).status).toBe(502);
  expect(request.mock.calls.filter(([url]) => String(url).includes('/files?'))).toHaveLength(2);
});
