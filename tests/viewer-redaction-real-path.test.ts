import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { viewerCredentialCorpus, knownViewerOperatorFixture, knownViewerDeviceFixture, knownViewerEnvironmentFixture } from './fixtures/viewer-credential-corpus';

let root: string;
let server: Server;
let origin: string;
let authorization: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const routes = [
  ['/api/panel/file-content', () => import('@/app/api/panel/file-content/route')],
  ['/api/v2/files', () => import('@/app/api/v2/files/route')],
  ['/api/v2/files?preview=1', () => import('@/app/api/v2/files/route')],
  ['/api/panel/file-io', () => import('@/app/api/panel/file-io/route')],
  ['/api/panel/file-diff', () => import('@/app/api/panel/file-diff/route')],
  ['/api/panel/worktree-diff', () => import('@/app/api/panel/worktree-diff/route')],
  ['/api/worktrees/diff', () => import('@/app/api/worktrees/diff/route')],
  ['/api/worktrees/diff?selected=1', () => import('@/app/api/worktrees/diff/route')],
  ['/api/lanes/[id]/diff', () => import('@/app/api/lanes/[id]/diff/route')],
  ['/api/panel/commit-diff', () => import('@/app/api/panel/commit-diff/route')],
  ['/api/panel/commits/[hash]', () => import('@/app/api/panel/commits/[hash]/route')],
  ['/api/panel/commits/[hash]/file', () => import('@/app/api/panel/commits/[hash]/file/route')],
  ['/api/panel/commits', () => import('@/app/api/panel/commits/route')],
  ['/api/panel/git-log', () => import('@/app/api/panel/git-log/route')],
  ['/api/panel/git/log', () => import('@/app/api/panel/git/log/route')],
  ['/api/review/file', () => import('@/app/api/review/file/route')],
  ['/api/mobile/review-file', () => import('@/app/api/mobile/review-file/route')],
  ['/api/review/diff', () => import('@/app/api/review/diff/route')],
  ['/api/panel/file-preview', () => import('@/app/api/panel/file-preview/route')],
  ['/api/mobile/sync', () => import('@/app/api/mobile/sync/route')],
  ['/api/orchestrator/review-state', () => import('@/app/api/orchestrator/review-state/route')],
] as const;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-viewer-redaction-')));
  vi.stubEnv('CORTEX_IDE_REVIEW_REPO_ROOT', root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (let i = 0; i < viewerCredentialCorpus.length; i++) writeFileSync(join(root, `control-${i}.txt`), 'base\n');
  git('add', '.'); git('commit', '-q', '-m', 'base'); git('checkout', '-q', '-b', 'viewer-control');
  // Keep every path discoverable even while the review inventory is cached.
  for (let i = 0; i < viewerCredentialCorpus.length; i++) writeFileSync(join(root, `control-${i}.txt`), 'pending\n');
  const { getDataDir } = await import('@/lib/data-dir-migration');
  writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'viewer-control', name: 'fixture', localPath: root }] }));
  vi.stubEnv('O8_VIEWER_FIXTURE_PASSWORD', knownViewerEnvironmentFixture);
  const { writeActiveTokenHashes } = await import('@/lib/mobile/device-token-file');
  writeActiveTokenHashes([createHash('sha256').update(knownViewerDeviceFixture).digest('hex')]);
  const { getOrCreateWsToken, WS_TOKEN_PATH } = await import('@/lib/ws-auth');
  writeFileSync(WS_TOKEN_PATH, knownViewerOperatorFixture);
  authorization = `Bearer ${getOrCreateWsToken()}`;
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  server = createServer(async (req, res) => { if (!await handleNativeHttp(req, res)) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function assertMasked(raw: string, label: string) {
  const body = JSON.parse(raw);
  const strings: string[] = [];
  const inspect = (value: unknown) => {
    if (typeof value === 'string') {
      strings.push(value);
    } else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  };
  inspect(body);
  const leaked = viewerCredentialCorpus.find(item => raw.includes(item.clear) || strings.some(value => value.includes(item.clear)));
  expect(leaked?.name, `${label}: credential leaked in response body or decoded text`).toBeUndefined();
  expect(body.redaction).toMatchObject({ version: 1, offsetEncoding: 'utf-8' });
  // Each input is exercised separately: a mask in another corpus line cannot satisfy this check.
  expect(body.redaction.spans.length, `${label}: this shape must reach the response`).toBeGreaterThanOrEqual(1);
  for (const span of body.redaction.spans) {
    const value = span.path.split('/').slice(1).reduce((obj: Record<string, unknown>, key: string) => obj[key.replace(/~1/g, '/').replace(/~0/g, '~')], body);
    expect(Buffer.from(value).subarray(span.start, span.end).toString('utf8')).toBe('[redacted]');
    expect(span.kind).toBe('credential');
  }
}

describe('each credential shape through every persisted viewer route and native HTTP', () => {
  it.each(viewerCredentialCorpus)('$name', async (item) => {
    const index = viewerCredentialCorpus.indexOf(item);
    const baseBranch = `viewer-base-${index}`;
    git('branch', baseBranch);
    const file = `control-${index}.txt`;
    const svg = `control-${index}.svg`;
    const content = `π 🔒 safe heading\n${item.text}\n`;
    writeFileSync(join(root, file), content); writeFileSync(join(root, svg), `<svg><!-- ${item.text} --></svg>`);
    git('add', '--', file, svg); git('commit', '-q', '-m', item.text);
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(root, file), `${content}${item.text}\nvisible edit\n`);
    const { createLane } = await import('@/lib/lane/registry');
    const packetId = `viewer-control-${index}`;
    const laneId = createLane({ repoPath: root, worktreePath: root, branch: 'viewer-control', baseBranch, runtime: 'codex', packetId, label: item.text }).id;
    const { invalidateReviewSnapshotCache } = await import('@/lib/review/workspace');
    invalidateReviewSnapshotCache();
    for (const [route, load] of routes) {
      const url = new URL(route.replace('[id]', laneId).replace('[hash]', sha), origin);
      const params = { workspace: root, repoPath: root, worktreePath: root, baseBranch, sha, packetId, limit: '1', path: route === '/api/panel/file-io' ? join(root, file) : route === '/api/panel/file-preview' ? svg : file };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (url.searchParams.has('selected')) url.searchParams.set('file', file);
      const init = { headers: { host: '127.0.0.1', authorization }, ...(route === '/api/mobile/sync' ? { method: 'POST', body: JSON.stringify({ review: { includeFile: file } }) } : {}) };
      const request = new NextRequest(url, init);
      const handlers = await load();
      const handler = ('GET' in handlers ? handlers.GET : handlers.POST) as (req: NextRequest, ctx: { params: Promise<{ id: string; hash: string }> }) => Promise<Response>;
      // Cold direct entry and retained/cached HTTP entry both process the same persisted source.
      const direct = await handler(request, { params: Promise.resolve({ id: laneId, hash: sha }) });
      expect(direct.status, route).toBe(200); assertMasked(await direct.text(), `${route}: direct`);
      const remote = await fetch(url, init);
      expect(remote.status, route).toBe(200); assertMasked(await remote.text(), `${route}: native`);
    }
    expect(readFileSync(join(root, file), 'utf8')).toContain(item.text);
    git('add', '--', file, svg); git('commit', '-q', '-m', 'fixture baseline');
  });

  it('redacts stored approval diff previews through direct and native reads', async () => {
    const { createApproval } = await import('@/lib/approvals/store');
    const corpus = viewerCredentialCorpus.map(item => item.text).join('\n');
    createApproval({ source: 'test', runtime: 'fixture', agent: 'fixture', sessionKey: 'viewer-approval', title: 'fixture', description: 'fixture', summary: 'fixture', risk: 'low', diff: { before: corpus, after: corpus, files: [{ path: 'control.txt', status: 'M', patch: corpus }] } });
    const url = new URL('/api/panel/approvals?sessionKey=viewer-approval&include=diff&scope=all', origin);
    const { GET } = await import('@/app/api/panel/approvals/route');
    const direct = await GET(new NextRequest(url, { headers: { authorization } }));
    for (const response of [direct, await fetch(url, { headers: { authorization } })]) {
      expect(response.status).toBe(200);
      assertMasked(await response.text(), 'stored approval diff');
    }
  });

  it('redacts approval action receipts that retain stored diffs', async () => {
    const { createApproval, resolveApproval, getApproval } = await import('@/lib/approvals/store');
    const corpus = viewerCredentialCorpus.map(item => item.text).join('\n');
    const approval = createApproval({ source: 'test', runtime: 'fixture', agent: 'fixture', sessionKey: 'viewer-receipt', title: 'fixture', description: 'fixture', summary: 'fixture', risk: 'low', diff: { before: corpus, after: corpus } });
    resolveApproval(approval.id, 'reject', 'test');
    const persisted = getApproval(approval.id);
    const url = new URL('/api/panel/approvals', origin);
    const init = { method: 'POST', headers: { authorization }, body: JSON.stringify({ action: 'reject', id: approval.id }) };
    const { POST } = await import('@/app/api/panel/approvals/route');
    const direct = await POST(new NextRequest(url, init));
    for (const response of [direct, await fetch(url, init)]) {
      expect(response.status).toBe(200);
      assertMasked(await response.text(), 'stored approval action receipt');
    }
    expect(getApproval(approval.id)).toEqual(persisted);
  });

  it('redacts snapshot commit text through direct and native reads', async () => {
    const corpus = viewerCredentialCorpus.map(item => item.text).join(' ; ');
    git('commit', '--allow-empty', '-q', '-m', corpus);
    const { invalidateReviewSnapshotCache } = await import('@/lib/review/workspace');
    invalidateReviewSnapshotCache();
    const url = new URL('/api/command-center/snapshot?fresh=1', origin);
    const { GET } = await import('@/app/api/command-center/snapshot/route');
    const direct = await GET(new NextRequest(url, { headers: { authorization } }));
    for (const response of [direct, await fetch(url, { headers: { authorization } })]) {
      expect(response.status).toBe(200);
      assertMasked(await response.text(), 'snapshot commit text');
    }
  });

  it('refuses anonymous native viewer reads', async () => {
    for (const [route] of routes) {
      const url = new URL(route.replace('[id]', 'missing').replace('[hash]', 'abcdef0'), origin);
      expect((await fetch(url)).status, route).toBe(401);
    }
  });

  it('refuses replaying masked reads through existing save routes, including forced saves', async () => {
    const file = 'save-control.txt';
    for (const source of ['password=fixture-save-control', knownViewerOperatorFixture, knownViewerDeviceFixture, knownViewerEnvironmentFixture]) {
      writeFileSync(join(root, file), `${source}\n`);
      const before = readFileSync(join(root, file), 'utf8');
      const { GET, POST } = await import('@/app/api/v2/files/route');
      const url = new URL('/api/v2/files', origin);
      url.search = new URLSearchParams({ workspace: root, path: file }).toString();
      const loaded = await (await GET(new NextRequest(url))).json();
      const response = await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ workspace: root, path: file, content: `${loaded.content}\nedit`, expectedHash: loaded.contentHash, force: true }) }));
      expect(response.status).toBe(409);
      expect(readFileSync(join(root, file), 'utf8')).toBe(before);
      const { GET: readAbsolute, PUT } = await import('@/app/api/panel/file-io/route');
      const absolute = new URL('/api/panel/file-io', origin);
      absolute.searchParams.set('path', join(root, file));
      const opened = await (await readAbsolute(new NextRequest(absolute, { headers: { authorization } }))).json();
      const saved = await PUT(new NextRequest(absolute, { method: 'PUT', headers: { authorization }, body: JSON.stringify({ path: join(root, file), content: `${opened.content}\nedit`, expectedMtimeMs: opened.mtimeMs, force: true }) }));
      expect(saved.status).toBe(409);
      expect(readFileSync(join(root, file), 'utf8')).toBe(before);
    }
  });
});
