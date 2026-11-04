import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureGitLabProvider } from '@/lib/git-providers/detect';
import { GET as listRoute } from './route';
import { GET as detailRoute, POST as writeRoute } from './[number]/route';
import { GET as commentsRoute } from './[number]/comments/route';

// A local fake of the GitLab REST v4 endpoints the provider uses. No network.
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const PROJECT = '/api/v4/projects/group%2Fsub%2Fwidget';
const TOKEN = 'fixture-gitlab-token';
const requests: Array<{ method: string; url: string; token: string | undefined; body: unknown }> = [];
const tempDirs: string[] = [];
let server: Server;
let host: string;
let merged = false;

const author = { username: 'dev', avatar_url: 'https://gitlab.example/avatar.png' };
const mergeRequest = () => ({
  iid: 4, title: 'Add widget', description: 'Adds the widget.', state: merged ? 'merged' : 'opened', draft: false, author,
  reviewers: [{ username: 'lead' }], source_branch: 'feat/widget-gitlab-fixture', target_branch: 'main', source_project_id: 9, target_project_id: 9,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null, merged_at: merged ? '2026-01-03T00:00:00Z' : null,
  web_url: 'https://gitlab.example/group/sub/widget/-/merge_requests/4', labels: ['feature'], sha: HEAD,
  diff_refs: { base_sha: BASE, head_sha: HEAD }, has_conflicts: false, detailed_merge_status: 'mergeable',
});

async function readBody(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = request.url ?? '';
    const body = await readBody(request);
    requests.push({ method: request.method ?? 'GET', url, token: request.headers['private-token'] as string | undefined, body });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (request.headers['private-token'] !== TOKEN) return json(401, { message: '401 Unauthorized' });
    const route = `${request.method} ${url.split('?')[0]}`;
    if (route === `GET ${PROJECT}/merge_requests`) return json(200, [mergeRequest()], { 'x-next-page': '2' });
    if (route === `GET ${PROJECT}/merge_requests/4/changes`) return json(200, { ...mergeRequest(), changes: [
      { old_path: 'src/widget.ts', new_path: 'src/widget.ts', diff: '@@ -1,2 +1,3 @@\n line\n-old\n+new\n+added\n' },
      { old_path: 'src/old.ts', new_path: 'src/renamed.ts', renamed_file: true, diff: '' },
    ] });
    if (route === `GET ${PROJECT}/merge_requests/4/pipelines`) return json(200, [
      { id: 31, sha: HEAD, status: 'success', web_url: 'https://gitlab.example/pipelines/31' },
      { id: 30, sha: 'e'.repeat(40), status: 'failed', web_url: 'https://gitlab.example/pipelines/30' },
    ]);
    if (route === `GET ${PROJECT}/merge_requests/4/notes`) return json(200, [
      { id: 51, body: 'merged main', author, created_at: '2026-01-02T00:00:00Z', system: true },
      { id: 52, body: 'Rename this', author: { username: 'lead' }, created_at: '2026-01-02T01:00:00Z', type: 'DiffNote', position: { new_path: 'src/widget.ts', old_path: 'src/widget.ts', new_line: 2, old_line: null } },
      { id: 53, body: 'Looks good overall', author: { username: 'lead' }, created_at: '2026-01-02T02:00:00Z', type: null },
    ]);
    if (route === `POST ${PROJECT}/merge_requests/4/notes`) return json(201, { id: 54, body: body?.body });
    if (route === `PUT ${PROJECT}/merge_requests/4/merge`) { merged = true; return json(200, mergeRequest()); }
    return json(404, { message: '404 Not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureGitLabProvider({ hosts: [{ baseUrl: `http://${host}` }], token: (baseUrl) => baseUrl === `http://${host}` ? TOKEN : null });
});
afterAll(async () => {
  configureGitLabProvider();
  await new Promise((resolve) => server.close(resolve));
});
afterEach(() => {
  requests.splice(0);
  merged = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitlabCheckout(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'o8-gitlab-panel-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '--quiet', repoPath]);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', `http://${host}/group/sub/widget.git`]);
  return repoPath;
}
const slug = () => `${host}/group/sub/widget`;
const params = { params: Promise.resolve({ number: '4' }) };
const readDetail = async () => {
  const response = await detailRoute(new Request(`http://localhost/api/panel/prs/4?repo=${encodeURIComponent(slug())}`), params);
  return { status: response.status, body: await response.json() };
};
const post = (body: Record<string, unknown>) => writeRoute(new Request('http://localhost/api/panel/prs/4', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: slug(), ...body }),
}), params);

describe('GitLab merge requests through the PR panel routes', () => {
  it('lists open merge requests for a project whose origin is a configured GitLab host', async () => {
    const response = await listRoute(new Request(`http://localhost/api/panel/prs?view=list&state=open&page=1&sort=oldest&repoPath=${encodeURIComponent(gitlabCheckout())}`));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toMatchObject({ repo: slug(), nextPage: 2, statsUnavailable: true });
    expect(page.prs).toEqual([expect.objectContaining({
      number: 4, title: 'Add widget', author: 'dev', state: 'open', draft: false, headRefName: 'feat/widget-gitlab-fixture', baseRefName: 'main',
      requestedReviewers: ['lead'], labels: ['feature'], mergeable: 'MERGEABLE', headRepoFullName: slug(), url: 'https://gitlab.example/group/sub/widget/-/merge_requests/4',
    })]);
    expect(requests).toEqual([expect.objectContaining({ method: 'GET', token: TOKEN })]);
    expect(new URL(requests[0].url, 'http://x').searchParams.toString()).toBe('state=opened&page=1&per_page=100&order_by=updated_at&sort=asc');
  });

  it('reads detail with files, pipeline checks, notes and an enforceable merge gate', async () => {
    const { status, body } = await readDetail();
    expect(status).toBe(200);
    expect(body.pr).toMatchObject({
      number: 4, state: 'open', headSha: HEAD, baseSha: BASE, resolvedRepo: slug(), additions: 2, deletions: 1, changedFiles: 2, mergeable: true,
      statusCheckRollup: [{ name: 'pipeline #31', status: 'completed', conclusion: 'success', url: 'https://gitlab.example/pipelines/31' }],
      reviewComments: [{ id: 52, author: 'lead', body: 'Rename this', path: 'src/widget.ts', line: 2, side: 'RIGHT', state: 'COMMENTED', inReplyTo: null }],
      issueComments: [{ id: 53, body: 'Looks good overall', user: 'lead', created_at: '2026-01-02T02:00:00Z' }],
      diffStat: 'src/widget.ts | +2 -1\nsrc/renamed.ts | +0 -0', allowedMergeMethods: ['merge', 'squash'],
      mergeGate: { allowed: true, headSha: HEAD, packets: [] },
    });
    expect(body.pr.files.map((file: { path: string; status: string; previousPath: string | null }) => [file.path, file.status, file.previousPath]))
      .toEqual([['src/widget.ts', 'modified', null], ['src/renamed.ts', 'renamed', 'src/old.ts']]);
    expect(body.pr.mergeGate.snapshot).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serves the notes through the comments route', async () => {
    const response = await commentsRoute(new Request(`http://localhost/api/panel/prs/4/comments?repo=${encodeURIComponent(slug())}`), params);
    expect(await response.json()).toMatchObject({ prNumber: 4, repo: slug(), reviews: [], comments: [{ id: 52, path: 'src/widget.ts', line: 2 }] });
  });

  it('posts a note', async () => {
    const response = await post({ action: 'comment', comment: '  Thanks  ' });
    expect(await response.json()).toEqual({ ok: true, action: 'commented' });
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: `${PROJECT}/merge_requests/4/notes`, token: TOKEN, body: { body: 'Thanks' } });
  });

  it('merges the reviewed head bound to the gate snapshot, keeping the source branch', async () => {
    const { body } = await readDetail();
    const response = await post({ action: 'merge', mergeMethod: 'squash', commitSha: HEAD, expectedMergeGate: body.pr.mergeGate.snapshot });
    expect(await response.json()).toEqual({ ok: true, action: 'merged' });
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: `${PROJECT}/merge_requests/4/merge`, token: TOKEN,
      body: { sha: HEAD, squash: true, should_remove_source_branch: false, squash_commit_message: 'Add widget (!4) [via-o8]' } });
  });

  it('refuses a stale head, a changed gate or an unsupported method without publishing', async () => {
    const { body } = await readDetail();
    for (const attempt of [
      { mergeMethod: 'merge', commitSha: 'f'.repeat(40) },
      { mergeMethod: 'merge', commitSha: HEAD, expectedMergeGate: '0'.repeat(64) },
      { mergeMethod: 'rebase', commitSha: HEAD, expectedMergeGate: body.pr.mergeGate.snapshot },
    ]) {
      const response = await post({ action: 'merge', ...attempt });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, mergeRefused: true });
    }
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);
  });
});
