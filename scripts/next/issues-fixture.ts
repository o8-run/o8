/** Owned GitHub installation transport; production issue handlers and broker stay intact. */
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

export async function issueFixture(dataDir: string, root: string, repoPath: string) {
  const slugs = ['fixture/alpha', 'fixture/beta', 'fixture/missing'];
  const setup = { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null };
  const repos = slugs.map((slug, index) => ({ id: `issues-${index}`, name: slug.split('/')[1],
    localPath: index === 0 ? repoPath : join(root, index === 1 ? 'second-repo' : 'missing-repo'),
    remoteUrl: `https://github.com/${slug}.git`, defaultBranch: 'main', isGitRepo: true,
    addedAt: new Date().toISOString(), lastOpenedAt: null, setup }));
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', repos[0].remoteUrl]);
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
    const target = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(issues|labels)(?:\/(\d+))?$/);
    if (!target || !records.has(target[1])) { send(404, { message: 'Outside fixture installation' }); return; }
    const [, slug, resource, number] = target;
    if (req.headers.authorization !== `Bearer fixture-installation-${101 + slugs.indexOf(slug)}`) {
      send(403, { message: 'Wrong installation credential' }); return;
    }
    if ((mode === 'detail-error' && number) || (mode === 'mutation-error' && req.method === 'POST')) {
      send(503, { message: 'Fixture request refused' }); return;
    }
    if (resource === 'labels') { send(200, [{ name: 'bug' }]); return; }
    const rows = records.get(slug)!;
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const input = JSON.parse(body);
      const created = { ...issue(slug, 9, input.title), body: input.body,
        labels: input.labels.map((name: string) => ({ name, color: 'ff0000' })) };
      rows.push(created); send(201, created); return;
    }
    if (number) { const found = rows.find(row => row.number === Number(number)); send(found ? 200 : 404, found ?? {}); return; }
    send(200, rows.filter(row => row.state === url.searchParams.get('state')));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing GitHub fixture origin');
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.GEMINI_API_KEY = 'fixture-enhancement-only';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
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
    ...Object.fromEntries([7, 8, 9, 17].map(number => [`/api/panel/issues/${number}`,
      (request: NextRequest) => detail.GET(request, { params: Promise.resolve({ number: String(number) }) })])),
  };
  const posts: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/panel/issues/create': create.POST, '/api/panel/issues/enhance': enhance.POST,
  };
  return { gets, posts, close() { globalThis.fetch = originalFetch; upstream.closeAllConnections(); upstream.close(); } };
}
