/** Disposable production setup handlers. Only CLI discovery and background scans are fixtures. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

export async function startOnboardingServer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-setup-')));
  const data = join(root, 'data'); const repo = join(root, 'repo');
  mkdirSync(data); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  Object.assign(process.env, { NODE_ENV: 'test', O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: join(data, 'fixture.db') });
  for (const key of ['WS_TOKEN', 'O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const token = process.env.O8_NEXT_API_TOKEN;
  if (!token) throw new Error('Fixture credential required');
  writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
  createRequire(import.meta.url)('./setup-discovery.cjs');
  const { addRepo } = await import('../../src/lib/repos/registry');
  await addRepo(repo);
  const defaults = await import('../../src/app/api/panel/operator-defaults/route');
  const repos = await import('../../src/app/api/panel/repos/route');
  const config = await import('../../src/app/api/setup/config/route');
  const history = await import('../../src/app/api/mobile/history/route');
  const context = await import('../../src/app/api/v2/chat-history/route');
  const queue = await import('../../src/app/api/orchestrator/composer-queue/route');
  const wsInfo = await import('../../src/app/api/panel/ws-info/route');
  const { getAllRuntimes } = await import('../../src/lib/runtimes');
  for (const runtime of getAllRuntimes()) runtime.discoverSessions = async () => [];
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: state } = await import('../../src/app/api/orchestrator/state/route');
  const { GET: inventory } = await import('../../src/app/api/runtime/inventory/route');
  const { panelGateMiddleware } = await import('../../src/middleware');
  const gets: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/panel/repos': repos.GET, '/api/panel/operator-defaults': defaults.GET,
    '/api/mobile/orchestrator/threads': sessions, '/api/orchestrator/state': state,
    '/api/runtime/inventory': inventory,
    '/api/setup/config': config.GET,
    '/api/mobile/history': history.GET, '/api/v2/chat-history': context.GET,
    '/api/orchestrator/composer-queue': queue.GET, '/api/panel/ws-info': wsInfo.GET,
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const route = req.method === 'GET' ? gets[url.pathname]
        : req.method === 'POST' && url.pathname === '/api/panel/operator-defaults' ? defaults.POST
        : req.method === 'POST' && url.pathname === '/api/setup/config' ? config.POST
        : req.method === 'POST' && url.pathname === '/api/v2/chat-history' ? context.POST
        : req.method === 'POST' && url.pathname === '/api/panel/repos' ? repos.POST : undefined;
      if (!route) { req.resume(); res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 1024 * 1024) throw new Error('Body limit'); }
      const request = new NextRequest(url, { method: req.method,
        headers: { host: url.host, 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
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
  const close = () => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  setTimeout(close, 120_000).unref();
}
