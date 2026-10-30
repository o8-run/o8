/** Grid fixture host using the dev-server.ts pattern and production GET handlers.
 * Kept separate so transcript/composer/terminal fixture changes can merge independently. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { startTerminalFixture } from './terminal-fixture';
import { attachPaneGridSocket, installPaneRuntime, seedPaneGrid } from './pane-fixture';

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'o8-next-grid-'));
  const dataDir = join(root, 'data');
  const repo = join(root, 'fixture-repo');
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), O8_OWNED_PI_ROOT: join(dataDir, 'owned-pi'), NODE_ENV: 'test' });
  for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP', 'WS_TOKEN']) delete process.env[key];
  writeFileSync(join(dataDir, 'ws-token'), process.env.O8_NEXT_API_TOKEN || randomBytes(32).toString('hex'), { mode: 0o600 });
  // Bind an owned publication sink before modules capture their origin.
  const realtime = createServer((req, res) => {
    req.resume(); res.writeHead(req.url === '/internal/realtime' && req.method === 'POST' ? 204 : 404).end();
  });
  await new Promise<void>(ready => realtime.listen(0, '127.0.0.1', ready));
  const publicationAddress = realtime.address();
  if (!publicationAddress || typeof publicationAddress === 'string') throw new Error('Missing fixture publication port');
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = `http://127.0.0.1:${publicationAddress.port}`;
  const { ensureV71ComposerQueueSchema } = await import('../../src/lib/db/v71-composer-queue-migration');
  const { getSqlite } = await import('../../src/lib/db');
  ensureV71ComposerQueueSchema(getSqlite());
  const { listMobileOrchestratorThreads } = await import('../../src/lib/mobile/orchestrator-thread-history');
  listMobileOrchestratorThreads();
  const seeds = seedPaneGrid(dataDir, repo);
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../src/app/api/mobile/history/route');
  const { GET: wsInfo } = await import('../../src/app/api/panel/ws-info/route');
  const { GET: state } = await import('../../src/app/api/orchestrator/state/route');
  const { GET: inventory } = await import('../../src/app/api/runtime/inventory/route');
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { panelGateMiddleware } = await import('../../src/middleware');
  const terminals = process.argv.includes('--terminals');
  await installPaneRuntime(dataDir, repo, terminals);
  const routes: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/mobile/orchestrator/threads': sessions, '/api/mobile/history': history,
    '/api/orchestrator/state': state, '/api/runtime/inventory': inventory, '/api/panel/ws-info': wsInfo,
  };
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      if (terminals && req.method === 'GET' && url.pathname === '/api/panel/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return;
      }
      const route = req.method === 'GET' ? routes[url.pathname] : undefined;
      if (!route) { req.resume(); res.writeHead(404).end(); return; }
      const key = url.searchParams.get('sessionKey');
      if (route === history && !(terminals && /^pi-owned:grid-terminal-[0-5]$/.test(key ?? '')) && key !== 'pi-owned:grid-runtime'
        && !seeds.some(seed => `llm-chat:${seed.id}` === key)) { res.writeHead(404).end(); return; }
      const request = new NextRequest(url, { headers: { host: url.host, 'x-o8-client-addr': '127.0.0.1',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
      const gate = panelGateMiddleware(request);
      const response = gate.status === 200 ? await route(request) : gate;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture route failed'); }
  });
  const token = getOrCreateWsToken();
  const closeSockets = terminals ? () => {} : attachPaneGridSocket(server, token, requests);
  let closeTerminal = async () => {};
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    Object.assign(process.env, { O8_WS_PORT: String(address.port), WS_PORT: String(address.port), O8_API_PORT: String(address.port) });
    const peer = terminals ? await startTerminalFixture(dataDir, repo, address.port, token,
      Array.from({ length: 6 }, (_, index) => `cortex-next-grid-${index}`)) : null;
    if (peer) {
      closeTerminal = peer.close;
      process.env.O8_WS_PORT = String(peer.port); process.env.WS_PORT = String(peer.port);
    }
    writeFileSync(join(dataDir, 'ws-port'), String(peer?.port ?? address.port));
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, workspace: repo })}\n`);
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await closeTerminal();
    closeSockets(); server.closeAllConnections(); server.close();
    realtime.closeAllConnections(); realtime.close();
    if (process.env.O8_NEXT_REQUEST_LOG) writeFileSync(process.env.O8_NEXT_REQUEST_LOG, JSON.stringify(requests));
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  }
  process.once('SIGTERM', close); process.once('SIGINT', close);
  if (process.argv.includes('--owned-stdio')) {
    process.stdin.once('end', () => { void close(); });
    process.stdin.resume();
  } else setTimeout(close, 120_000).unref();
}
void main().catch(() => { console.error('[o8-next-grid] Fixture startup failed'); process.exitCode = 1; });
