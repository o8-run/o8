/** Owned GitHub installation transport; production issue handlers and broker stay intact. */
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest } from 'next/server';

export async function issueFixture(dataDir: string, root: string, repoPath: string) {
  const slugs = ['fixture/alpha', 'fixture/beta', 'fixture/missing'];
  const setup = { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null };
  // Equal recency keeps the seeded alphabetical order across clock ticks.
  const addedAt = new Date().toISOString();
  const repos = slugs.map((slug, index) => ({ id: `issues-${index}`, name: slug.split('/')[1],
    localPath: index === 0 ? repoPath : join(root, index === 1 ? 'second-repo' : 'missing-repo'),
    remoteUrl: `https://github.com/${slug}.git`, defaultBranch: 'main', isGitRepo: true,
    addedAt, lastOpenedAt: null, setup }));
  if (process.argv.includes('--issues-symlink')) {
    const alias = join(root, 'issue-repo-alias');
    symlinkSync(repoPath, alias, 'dir');
    repos[0].localPath = alias;
  }
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', repos[0].remoteUrl]);
  if (existsSync(join(repos[1].localPath, '.git'))) {
    execFileSync('git', ['-C', repos[1].localPath, 'remote', 'add', 'origin', repos[1].remoteUrl]);
  }
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos }));
  let mode = '';
  process.stdin.setEncoding('utf8');
  let pending = '';
  process.stdin.on('data', bytes => {
    pending += bytes;
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) mode = line === 'recover' ? '' : line;
  });
  const issue = (slug: string, number: number, title: string, state = 'open') => ({
    id: (slugs.indexOf(slug) + 1) * 10000 + number, number, title, state, body: 'Issue fixture context.', comments: 2,
    labels: [{ name: 'bug', color: 'ff0000' }], user: { login: 'fixture' }, assignees: [],
    html_url: `https://github.com/${slug}/issues/${number}`,
    created_at: '2026-10-01T00:00:00Z', updated_at: new Date().toISOString(),
    closed_at: state === 'closed' ? new Date().toISOString() : null,
  });
  const records = new Map(slugs.map(slug => [slug, slug.endsWith('beta')
    ? [issue(slug, 17, 'Separate installation')]
    : [issue(slug, 7, 'Repair fixture'), issue(slug, 8, 'Closed fixture', 'closed')]]));
  const creations = new Map<string, number>();
  const managedMode = process.argv.includes('--issues-managed');
  const { writeActiveIdentity, writeManagedGithubState, bumpSignInEpoch } = await import('../../src/lib/github-broker/managed');
  const setAccount = (account: 'a' | 'b') => {
    writeActiveIdentity(`fixture-issue-owner-${account}`);
    bumpSignInEpoch();
    writeManagedGithubState({ installed: true, ownerClerkUserId: `fixture-issue-owner-${account}`,
      token: `fixture-managed-${account}`, installationId: 101, accountLogin: 'fixture', expiresAt: '2099-01-01T00:00:00Z' });
  };
  let switchOnReserve = false;
  const postsSeen: Array<{ title: string; account: string }> = [];
  if (managedMode) {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    setAccount('a');
    const { getSqlite } = await import('../../src/lib/db');
    getSqlite().function('fixture_issue_reservation', () => { if (switchOnReserve) { switchOnReserve = false; setAccount('b'); } return 0; });
    getSqlite().exec(`CREATE TRIGGER fixture_issue_reservation AFTER INSERT ON idempotency_keys
      WHEN NEW.verb = 'github_issue_create' BEGIN SELECT fixture_issue_reservation(); END`);
  }
  let rateLimitNext = process.argv.includes('--issues-rate-limit-once');
  let holdReplyNext = false;
  let releaseReply: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const installation = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (installation) {
      const index = slugs.indexOf(installation[1]);
      send(index < 0 ? 404 : 200, index < 0 ? { message: 'Repository outside installation' }
        : { id: 101 + index, account: { login: `fixture-${index}` }, permissions: { issues: 'write' } }); return;
    }
    const mint = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) { send(201, { token: `fixture-installation-${mint[1]}`, expires_at: '2099-01-01T00:00:00Z' }); return; }
    const target = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(issues|labels)(?:\/(\d+))?(\/comments)?$/);
    if (!target || !records.has(target[1])) { send(404, { message: 'Outside fixture installation' }); return; }
    const [, slug, resource, number] = target;
    const account = managedMode ? req.headers.authorization === 'Bearer fixture-managed-a' ? 'a'
      : req.headers.authorization === 'Bearer fixture-managed-b' ? 'b' : null : 'app';
    if (managedMode ? !account || slug !== slugs[0]
      : req.headers.authorization !== `Bearer fixture-installation-${101 + slugs.indexOf(slug)}`) {
      send(403, { message: 'Wrong installation credential' }); return;
    }
    if (target[4]) { send(200, []); return; }
    if ((mode === 'detail-error' && number) || (mode === 'mutation-error' && req.method === 'POST')) {
      send(mode === 'mutation-error' ? 422 : 503, { message: 'Fixture request refused' }); return;
    }
    if (resource === 'labels') { send(200, [{ name: 'bug' }]); return; }
    const rows = records.get(slug)!;
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const input = JSON.parse(body);
      postsSeen.push({ title: input.title, account: account! });
      if (rateLimitNext) {
        rateLimitNext = false;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1',
          'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1) })
          .end(JSON.stringify({ message: 'Fixture cooldown' })); return;
      }
      const count = creations.get(slug) ?? 0;
      creations.set(slug, count + 1);
      const created = { ...issue(slug, 9 + count, input.title), body: input.body,
        labels: input.labels.map((name: string) => ({ name, color: 'ff0000' })) };
      if (managedMode) created.user = { login: `fixture-owner-${account}` };
      rows.push(created);
      if (holdReplyNext) {
        holdReplyNext = false;
        await new Promise<void>(resolve => { releaseReply = resolve; });
        releaseReply = undefined;
      }
      if (input.title === 'Commit then disconnect') { res.destroy(); return; }
      if (process.argv.includes('--issues-delay-create') && count === 0) await delay(6500);
      send(201, created); return;
    }
    if (number) { const found = rows.find(row => row.number === Number(number)); send(found ? 200 : 404, found ?? {}); return; }
    send(200, rows.filter(row => row.state === url.searchParams.get('state')));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing GitHub fixture origin');
  process.env.GITHUB_APP_ID = '1';
  if (!managedMode) process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.GEMINI_API_KEY = 'fixture-enhancement-only';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (managedMode && String(input).startsWith('https://api.github.com/')) {
      return originalFetch(String(input).replace('https://api.github.com', process.env.GITHUB_API_BASE_URL!), init);
    }
    if (String(input).startsWith('https://generativelanguage.googleapis.com/')) {
      return Response.json(mode === 'mutation-error' ? { error: 'Enhancement refused' } : { candidates: [{ content: { parts: [{ text: JSON.stringify({
        title: 'Enhanced fixture', body: '## Description\nEnhanced details', labels: ['bug'],
      }) }] } }] }, { status: mode === 'mutation-error' ? 503 : 200 });
    }
    return originalFetch(input, init);
  };
  const list = await import('../../src/app/api/panel/issues/route');
  const detail = await import('../../src/app/api/panel/issues/[number]/route');
  const create = await import('../../src/app/api/panel/issues/create/route');
  const enhance = await import('../../src/app/api/panel/issues/enhance/route');
  const registry = await import('../../src/app/api/panel/repos/route');
  const gets: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/panel/repos': registry.GET, '/api/panel/issues': list.GET,
    ...Object.fromEntries([7, 8, 9, 10, 17].map(number => [`/api/panel/issues/${number}`,
      (request: NextRequest) => detail.GET(request, { params: Promise.resolve({ number: String(number) }) })])),
  };
  const posts: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/panel/issues/create': create.POST, '/api/panel/issues/enhance': enhance.POST,
    '/__fixture/issues': async request => {
      const command = await request.json();
      if (command.account && managedMode) setAccount(command.account);
      if (command.switchOnReserve && managedMode) switchOnReserve = true;
      if (command.rateLimitNext) rateLimitNext = true;
      if (command.holdReplyNext) holdReplyNext = true;
      if (command.releaseReply) releaseReply?.();
      return Response.json({ postsSeen, held: Boolean(releaseReply) });
    },
  };
  return { gets, posts, close() { globalThis.fetch = originalFetch; upstream.closeAllConnections(); upstream.close(); } };
}
