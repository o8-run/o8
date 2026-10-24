/** Disposable production HTTP handlers + src/ws-server.ts + real Pi SDK worker.
 * Only the model transport and external tool servers are replaced. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

export async function startWorkerServer() {
  // History and durable queue keys must use the same workspace identity.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-worker-')));
  const data = join(root, 'data'); const repo = join(root, 'repo'); const profile = join(root, 'profile');
  mkdirSync(join(data, 'chat-history'), { recursive: true }); mkdirSync(repo); mkdirSync(profile);
  // No tool calls in this model fixture; an empty owned workspace suffices.
  const token = process.env.O8_NEXT_API_TOKEN || randomBytes(32).toString('hex');
  writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
  writeFileSync(join(data, 'chat-history', 'thoughts-composer-first.json'), JSON.stringify({
    title: 'Fixture worker', repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: true,
    savedAt: '2026-10-01T00:00:00.000Z', messages: [{ id: 'initial', role: 'assistant', content: 'Fixture ready',
      timestamp: 1790812800000, receipt: { permissionMode: 'plan' } }],
  }));
  const wsPort = await freePort();
  Object.assign(process.env, { NODE_ENV: 'test', O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: join(data, 'fixture.db'), O8_WS_PORT: String(wsPort), WS_PORT: String(wsPort),
    CORTEX_REALTIME_INTERNAL_ORIGIN: `http://127.0.0.1:${wsPort}` });
  for (const key of ['WS_TOKEN', 'O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const { getSqlite } = await import('../../src/lib/db');
  const { ensureV71ComposerQueueSchema } = await import('../../src/lib/db/v71-composer-queue-migration');
  ensureV71ComposerQueueSchema(getSqlite());
  // The adjacent transcript surface also requests the existing inventory GET.
  // Fence discovery to this owned store before exposing its production handler.
  const { getAllRuntimes } = await import('../../src/lib/runtimes');
  for (const runtime of getAllRuntimes()) runtime.discoverSessions = async () => [];
  if (process.argv.includes('--issues')) execFileSync('git', ['init', '-q', repo]);
  const issues = process.argv.includes('--issues')
    ? await (await import('./issues-fixture')).issueFixture(data, root, repo) : null;
  const { GET: inventory } = await import('../../src/app/api/runtime/inventory/route');
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../src/app/api/mobile/history/route');
  const { GET: wsInfo } = await import('../../src/app/api/panel/ws-info/route');
  const { GET: context } = await import('../../src/app/api/v2/chat-history/route');
  const { GET: state } = await import('../../src/app/api/orchestrator/state/route');
  const { GET: status } = await import('../../src/app/api/panel/status/route');
  const { POST: sync } = await import('../../src/app/api/mobile/sync/route');
  const queue = await import('../../src/app/api/orchestrator/composer-queue/route');
  const { panelGateMiddleware } = await import('../../src/middleware');
  const gets: Record<string, (request: NextRequest) => Promise<Response>> = {
    ...issues?.gets,
    '/api/mobile/orchestrator/threads': sessions, '/api/mobile/history': history, '/api/panel/ws-info': wsInfo,
    '/api/v2/chat-history': context, '/api/orchestrator/state': state, '/api/orchestrator/composer-queue': queue.GET,
    '/api/panel/status': status, '/api/runtime/inventory': inventory,
  };
  const mutations: Record<string, (request: NextRequest) => Promise<Response>> = { POST: queue.POST, PATCH: queue.PATCH, DELETE: queue.DELETE };
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      const route = req.method === 'GET' ? gets[url.pathname]
        : req.method === 'POST' && url.pathname === '/api/mobile/sync' ? sync
        : url.pathname === '/api/orchestrator/composer-queue' ? mutations[req.method ?? '']
        : req.method === 'POST' ? issues?.posts[url.pathname] : undefined;
      if (!route) { req.resume(); res.writeHead(404).end(); return; }
      if ((route === history && url.searchParams.get('sessionKey') !== 'llm-chat:thoughts-composer-first')
        || (route === context && url.searchParams.get('tabId') !== 'thoughts-composer-first')) { res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 1024 * 1024) throw new Error('Fixture body limit'); }
      if (body && !issues?.posts[url.pathname]) {
        const target = JSON.parse(body);
        const valid = route === sync
          ? target.history?.sessionKey === 'llm-chat:thoughts-composer-first' && Object.keys(target).every(key => key === 'history')
          : target.repoPath === repo && target.threadId === 'thoughts-composer-first';
        if (!valid) { res.writeHead(400).end(); return; }
      }
      const request = new NextRequest(url, { method: req.method,
        headers: { host: url.host, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
      const gate = panelGateMiddleware(request);
      const response = gate.headers.get('x-middleware-next') === '1' ? await route(request) : gate;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture route failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture origin');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.O8_API_PORT = String(address.port);
  writeFileSync(join(data, 'api-port'), String(address.port));
  writeFileSync(join(data, 'ws-port'), String(wsPort));
  const worker = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/worker-runtime.ts'], {
    stdio: 'pipe', env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: profile, USERPROFILE: profile,
      O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'fixture.db'),
      O8_NEXT_WORKER_ROOT: root, O8_API_PORT: String(address.port), O8_WS_PORT: String(wsPort), WS_PORT: String(wsPort),
      NEXT_ORIGIN: origin, CORTEX_REALTIME_INTERNAL_ORIGIN: `http://127.0.0.1:${wsPort}`,
      ...(process.env.O8_TEST_FILE_MARKER ? { O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER } : {}) },
  });
  // Capture diagnostics in owned storage only. Never print paths or runtime data.
  const log = join(root, 'runtime.log');
  const { appendFileSync } = await import('node:fs');
  worker.stderr.on('data', chunk => appendFileSync(log, chunk));
  worker.stdout.on('data', chunk => appendFileSync(log, chunk));
  process.stdin.on('data', chunk => { if (!worker.stdin.destroyed) worker.stdin.write(chunk); });
  let closing = false;
  async function close() {
    if (closing) return; closing = true;
    issues?.close();
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit'); worker.kill('SIGTERM');
      const timer = setTimeout(() => worker.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    server.closeAllConnections(); server.close();
    if (process.env.O8_NEXT_REQUEST_LOG) writeFileSync(process.env.O8_NEXT_REQUEST_LOG, JSON.stringify(requests));
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  }
  process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
  setTimeout(() => { void close(); }, 120_000).unref();
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error('Fixture runtime exited before readiness');
    try { if ((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() > deadline) { await close(); throw new Error('Fixture runtime did not become ready'); }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  process.stdout.write(`${JSON.stringify({ origin })}\n`);
}
