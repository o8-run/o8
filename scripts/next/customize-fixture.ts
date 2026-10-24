/** Production customization handlers over an owned profile, repository and database. */
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

type Handler = (request: NextRequest) => Promise<Response>;

export async function startCustomizeServer() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-next-customize-')));
  const data = join(root, 'data');
  const repo = join(root, 'repo');
  const profile = join(root, 'profile');
  for (const dir of [data, repo, profile]) mkdirSync(dir);
  // The inventory's filesystem input is a disposable profile, never account files.
  Object.defineProperty(os, 'homedir', { value: () => profile });
  syncBuiltinESMExports();
  Object.assign(process.env, {
    NODE_ENV: 'test', O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: join(data, 'fixture.db'),
  });
  for (const key of ['WS_TOKEN', 'O8_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const token = process.env.O8_NEXT_API_TOKEN;
  if (!token) throw new Error('Fixture credential required');
  writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
  execFileSync('git', ['init', '-q', repo]);
  const { addRepo } = await import('../../src/lib/repos/registry');
  await addRepo(repo);
  for (const [base, name] of [[profile, 'Personal'], [repo, 'Fixture']]) {
    mkdirSync(join(base, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(base, '.agents', 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(base, '.claude', 'agents', 'fixture.md'), `---\nname: ${name} agent\ndescription: ${name} guidance\n---\nRead files.`);
    writeFileSync(join(base, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture-hook' }] }] },
    }));
    writeFileSync(join(base, '.agents', 'skills', 'fixture', 'SKILL.md'), `---\nname: ${name} skill\ndescription: Read-only fixture skill\n---\nRead files.`);
  }
  mkdirSync(join(data, 'directives'));
  writeFileSync(join(data, 'directives', 'fixture.md'), '---\nid: fixture\ntitle: Fixture instruction\nscope: global\n---\nFixture instruction body.');
  const inventory = await import('../../src/app/api/customize/inventory/route');
  const directives = await import('../../src/app/api/cortex/directives/route');
  const connections = await import('../../src/app/api/setup/mcp-servers/route');
  const prompts = await import('../../src/app/api/prompt-library/route');
  const entry = await import('../../src/app/api/prompt-library/[id]/route');
  const repos = await import('../../src/app/api/panel/repos/route');
  const { panelGateMiddleware } = await import('../../src/middleware');
  const gets: Record<string, Handler> = {
    '/api/panel/repos': repos.GET, '/api/customize/inventory': inventory.GET,
    '/api/cortex/directives': directives.GET, '/api/setup/mcp-servers': connections.GET,
    '/api/prompt-library': prompts.GET,
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const id = url.pathname.match(/^\/api\/prompt-library\/([^/]+)$/)?.[1];
      const route = req.method === 'GET' ? gets[url.pathname]
        : req.method === 'POST' && url.pathname === '/api/prompt-library' ? prompts.POST
        : id && req.method === 'PATCH' ? (request: NextRequest) => entry.PATCH(request, { params: Promise.resolve({ id }) })
        : id && req.method === 'DELETE' ? (request: NextRequest) => entry.DELETE(request, { params: Promise.resolve({ id }) })
        : undefined;
      if (!route) { req.resume(); res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 1024 * 1024) throw new Error('Body limit');
      }
      const request = new NextRequest(url, {
        method: req.method,
        headers: {
          host: url.host, 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(!process.argv.includes('--customize-denied') && req.headers.authorization
            ? { authorization: req.headers.authorization } : {}),
        },
        ...(body ? { body } : {}),
      });
      const gate = panelGateMiddleware(request);
      const response = gate.status === 200 ? await route(request) : gate;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port required');
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}` })}\n`);
  });
  const close = () => {
    server.closeAllConnections(); server.close();
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  setTimeout(close, 120_000).unref();
}
