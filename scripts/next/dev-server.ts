/** Disposable route host. Imports production handlers; no runtime discovery,
 * background server startup, provider calls, app connections, or app data paths. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { attachReplaySocket } from './replay-socket';
import { isolateTranscriptDiscovery, seedTranscriptFixtures } from './transcript-fixtures';
import { attachTranscriptSocket } from './transcript-socket';
import { startTerminalFixture } from './terminal-fixture';
import { surfaceEntries, type SurfaceContext, type SurfaceRoutes } from './surface-routes';

async function main() {
  if (process.argv.includes('--worker')) {
    await (await import('./worker-server')).startWorkerServer();
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-dev-')));
  const dataDir = join(root, 'data');
  const repo = join(root, 'fixture-repo');
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), O8_OWNED_OPENCODE_ROOT: join(dataDir, 'owned-opencode'), NODE_ENV: 'test', WS_TOKEN: randomBytes(32).toString('hex') });
  for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const fixtureToken = process.env.O8_NEXT_API_TOKEN || randomBytes(32).toString('hex');
  writeFileSync(join(dataDir, 'ws-token'), fixtureToken, { mode: 0o600 });
  delete process.env.WS_TOKEN;
  // Bind publication before imports: publisher captures its origin at load time.
  const realtime = createServer((req, res) => {
    req.resume(); res.writeHead(req.url === '/internal/realtime' && req.method === 'POST' ? 204 : 404).end();
  });
  await new Promise<void>(resolveReady => realtime.listen(0, '127.0.0.1', resolveReady));
  const realtimeAddress = realtime.address();
  if (!realtimeAddress || typeof realtimeAddress === 'string') throw new Error('Missing publication fixture port');
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = `http://127.0.0.1:${realtimeAddress.port}`;
  // Isolate profile and process boundaries before production modules can cache
  // a runtime path or a subprocess function during import.
  const entries = await surfaceEntries();
  const context: SurfaceContext = { root, dataDir, repo, fixtureToken, seeds: [], transcriptFixtures: process.argv.includes('--transcript') };
  const surfaces: SurfaceRoutes[] = [];
  for (const entry of entries) if (entry.prepare) surfaces.push(await entry.prepare(context));
  const { ensureV71ComposerQueueSchema } = await import('../../src/lib/db/v71-composer-queue-migration');
  const { getSqlite } = await import('../../src/lib/db');
  ensureV71ComposerQueueSchema(getSqlite());
  // Complete one-time legacy boot repairs against the empty owned store before
  // adding post-boot recordings (their deliberately tight timestamps are valid).
  const { listMobileOrchestratorThreads } = await import('../../src/lib/mobile/orchestrator-thread-history');
  listMobileOrchestratorThreads();
  const seeds = ((process.argv.includes('--inbox-empty') || process.argv.includes('--projects')) ? [] : JSON.parse(readFileSync(resolve('native/o8-next/fixtures/sessions.json'), 'utf8'))) as Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
  for (const seed of seeds) {
    writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
      messages: seed.messages, repoPath: repo, repoName: 'fixture-repo', backend: 'claude', model: 'claude-code',
      savedAt: '2026-10-01T00:00:00.000Z', orchestratorVisible: true }));
  }
  if (process.argv.includes('--shell') && !process.argv.includes('--inbox-empty')) {
    const { seedShellWorkspace } = await import('./shell-fixture');
    seeds.push(seedShellWorkspace(dataDir, root));
  }
  const composer = process.argv.includes('--composer');
  const transcriptFixtures = process.argv.includes('--transcript');
  if (transcriptFixtures) seeds.push(...seedTranscriptFixtures(dataDir, repo));
  if (composer) {
    for (const id of ['thoughts-composer-first', 'thoughts-composer-second', 'thoughts-composer-legacy']) {
      seeds.push({ id, title: id, messages: [] });
      writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({
        title: id, repoPath: repo, backend: 'pi', model: id.endsWith('-legacy') ? null : 'pi', orchestratorVisible: true,
        savedAt: '2026-10-01T00:00:00.000Z', messages: [{ id: 'initial', role: 'assistant', content: 'Fixture ready',
          timestamp: 1790812800000, receipt: { permissionMode: 'plan' } }],
      }));
    }
  }
  await isolateTranscriptDiscovery(transcriptFixtures);
  context.seeds = seeds;
  for (const entry of entries) if (entry.default) surfaces.push(await entry.default(context));
  surfaces.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { panelGateMiddleware } = await import('../../src/middleware');
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      const method = req.method ?? 'GET';
      const registration = surfaces.map(surface => ({ surface, route: surface.match?.(method, url.pathname) ?? surface.routes?.[`${method} ${url.pathname}`] })).find(entry => entry.route);
      if (!registration?.route) { res.writeHead(404).end(); return; }
      const { surface, route } = registration;
      if (surface.early) {
        const response = await route(new NextRequest(url));
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer())); return;
      }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 1024 * 1024) throw new Error('Fixture body limit'); }
      const input = { route, url, method, body, headers: req.headers };
      const admission = surface.admit?.(input) ?? (body ? 400 : 200);
      if (admission !== 200) { res.writeHead(admission).end(); return; }
      const request = new NextRequest(url, { method: req.method,
        headers: { host: url.host, 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(typeof req.headers['x-clerk-session-token'] === 'string' ? { 'x-clerk-session-token': req.headers['x-clerk-session-token'] } : {}),
          ...(typeof req.headers['x-tab-id'] === 'string' ? { 'x-tab-id': req.headers['x-tab-id'] } : {}) }, ...(body ? { body } : {}) });
      const gate = panelGateMiddleware(request);
      if (gate.status === 200) surface.before?.(input);
      const response = gate.status === 200 ? await (surface.run ? surface.run(route, request) : route(request)) : gate;
      if (await surface.after?.(input, response)) { res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (surface.stream?.includes(route) && response.body) {
        const reader = response.body.getReader();
        res.on('close', () => { void reader.cancel().catch(() => {}); });
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
        res.end();
      } else res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture route failed'); }
  });
  const terminal = process.argv.includes('--terminal');
  const wsToken = getOrCreateWsToken();
  const closeSockets = terminal ? () => {}
    : (transcriptFixtures ? attachTranscriptSocket : attachReplaySocket)(server, wsToken, requests);
  let closeTerminal = async () => {};
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    Object.assign(process.env, { O8_WS_PORT:String(address.port), WS_PORT:String(address.port), O8_API_PORT:String(address.port) });
    const peer = terminal ? await startTerminalFixture(dataDir, repo, address.port, wsToken) : null;
    if (peer) {
      closeTerminal = peer.close;
      process.env.O8_WS_PORT = String(peer.port); process.env.WS_PORT = String(peer.port);
    }
    writeFileSync(join(dataDir,'ws-port'),String(peer?.port ?? address.port));
    if (process.argv.includes('--shell')) {
      writeFileSync(join(dataDir, 'api-port'), String(address.port));
      process.stdout.write(`${JSON.stringify({ configDir: dataDir })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}`,
      ...Object.assign({}, ...surfaces.map(surface => surface.receipt)),
      ...(peer ? { terminalSession: peer.sessionName } : {}) })}\n`);
  });
  async function close() {
    for (const surface of surfaces) await surface.close?.();
    await closeTerminal();
    closeSockets();
    server.closeAllConnections(); server.close();
    realtime.closeAllConnections(); realtime.close();
    if (process.env.O8_NEXT_REQUEST_LOG) writeFileSync(process.env.O8_NEXT_REQUEST_LOG, JSON.stringify(requests));
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  }
  process.once('SIGTERM', close); process.once('SIGINT', close);
  setTimeout(close, 120_000).unref();

}
void main().catch(error => { console.error('[o8-next]', error); process.exitCode = 1; });
