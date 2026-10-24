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
  const settings = process.argv.includes('--settings') ? await (await import('./settings-fixture')).settingsFixture(root) : null;
  const { ensureV71ComposerQueueSchema } = await import('../../src/lib/db/v71-composer-queue-migration');
  const { getSqlite } = await import('../../src/lib/db');
  ensureV71ComposerQueueSchema(getSqlite());
  // Complete one-time legacy boot repairs against the empty owned store before
  // adding post-boot recordings (their deliberately tight timestamps are valid).
  const { listMobileOrchestratorThreads } = await import('../../src/lib/mobile/orchestrator-thread-history');
  listMobileOrchestratorThreads();
  const seeds = (process.argv.includes('--inbox-empty') ? [] : JSON.parse(readFileSync(resolve('native/o8-next/fixtures/sessions.json'), 'utf8'))) as Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
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
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../src/app/api/mobile/history/route');
  const { GET: wsInfo } = await import('../../src/app/api/panel/ws-info/route');
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { GET: context } = await import('../../src/app/api/v2/chat-history/route');
  const { GET: state } = await import('../../src/app/api/orchestrator/state/route');
  await isolateTranscriptDiscovery(transcriptFixtures);
  const { GET: inventory } = await import('../../src/app/api/runtime/inventory/route');
  const brain = process.argv.includes('--brain');
  if (brain) await (await import('./brain-fixture')).seedBrainFixture(dataDir, repo);
  const brainAsk = brain ? (await import('../../src/app/api/cortex/ask/route')).POST : null;
  const brainRequests: unknown[] = [];
  const review = process.argv.includes('--review');
  const inbox = process.argv.includes('--inbox');
  const inboxApprovals = inbox && !process.argv.includes('--inbox-empty') ? await (await import('./inbox-fixture')).seedInboxFixture(repo, dataDir) : [];
  const inboxPlan = process.argv.includes('--inbox-plan') && process.env.O8_NEXT_INBOX_PLAN_FIXTURE
    ? await (await import('./inbox-plan-fixture')).seedInboxPlanFixture(repo, dataDir, fixtureToken, process.env.O8_NEXT_INBOX_PLAN_FIXTURE) : null;
  if (inboxPlan) inboxApprovals.push(...inboxPlan.approvals);
  const planProxy = inboxPlan ? await import('../../src/app/api/v2/proxy/llm/route') : null;
  const inboxRoutes = inbox ? await import('../../src/app/api/panel/supervisor-inbox/route') : null;
  const approvalRoutes = inbox ? await import('../../src/app/api/panel/approvals/route') : null;
  if (inbox && process.env.O8_NEXT_INBOX_ORACLE) await (await import('./inbox-fixture')).writeInboxOracle(process.env.O8_NEXT_INBOX_ORACLE);
  if (review) await (await import('./review-fixture')).seedReviewFixture(repo);
  const packetDiff = await import('../../src/app/api/lanes/[id]/diff/route');
  const worktreeDiff = await import('../../src/app/api/worktrees/diff/route');
  const reviewState = await import('../../src/app/api/orchestrator/review-state/route');
  const reviewDecision = await import('../../src/app/api/orchestrator/review/route');
  const queue = await import('../../src/app/api/orchestrator/composer-queue/route');
  const { panelGateMiddleware } = await import('../../src/middleware');
  // Fixture admission is the same injectable native boundary as the existing
  // composer real-path tests. It never starts a runtime or uses an account.
  if (composer) {
    const { getOrchestratorBackend } = await import('../../src/lib/lane/orchestrator-backends/registry');
    Object.defineProperty(getOrchestratorBackend('pi'), 'liveSteer', { value:
      async (_repo: string, _text: string, options: { beforeAdmit: () => void }) => {
        options.beforeAdmit(); return { accepted: true };
      }, configurable: true });
  }
  const getRoutes: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/mobile/orchestrator/threads': sessions, '/api/mobile/history': history,
    '/api/v2/chat-history': context, '/api/orchestrator/state': state,
    '/api/orchestrator/composer-queue': queue.GET, '/api/panel/ws-info': wsInfo,
    '/api/runtime/inventory': inventory,
    ...(inboxRoutes && approvalRoutes ? {
      '/api/panel/supervisor-inbox': inboxRoutes.GET, '/api/panel/approvals': approvalRoutes.GET,
    } : {}),
    ...(settings ? Object.fromEntries(Object.entries(settings.routes).filter(([key]) => key.startsWith('GET ')).map(([key, route]) => [key.slice(4), route])) : {}),
    ...(review ? {
      '/api/worktrees/diff': worktreeDiff.GET,
      '/api/orchestrator/review-state': reviewState.GET,
      ...Object.fromEntries(['next-review-approve', 'next-review-reject'].map(id => [
        `/api/lanes/${id}/diff`, (request: NextRequest) => packetDiff.GET(request, { params: Promise.resolve({ id }) }),
      ])),
    } : {}),
  };
  const requests: string[] = [];
  let responseLost = false;
  let reviewResponseLost = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      if (process.argv.includes('--terminal') && req.method === 'GET' && url.pathname === '/api/panel/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return;
      }
      const settingsRoute = settings?.routes[`${req.method} ${url.pathname}`];
      const control = settings && url.pathname === '/__fixture/settings' && req.method === 'POST' ? settings.control : null;
      const route = control ?? settingsRoute ?? (req.method === 'POST' && url.pathname === '/api/cortex/ask' && brainAsk ? brainAsk
        : req.method === 'GET' ? getRoutes[url.pathname]
        : composer && url.pathname === '/api/orchestrator/composer-queue'
          ? req.method === 'POST' ? queue.POST : req.method === 'PATCH' ? queue.PATCH : req.method === 'DELETE' ? queue.DELETE : null
          : review && req.method === 'POST' && url.pathname === '/api/orchestrator/review' ? reviewDecision.POST
            : approvalRoutes && req.method === 'POST' && url.pathname === '/api/panel/approvals' ? approvalRoutes.POST
              : planProxy && req.method === 'POST' && url.pathname === '/api/v2/proxy/llm' ? planProxy.POST : null);
      if (!route) { res.writeHead(404).end(); return; }
      // Prevent this development host from becoming a provider-history reader.
      if (route === history && !seeds.some(seed => `llm-chat:${seed.id}` === url.searchParams.get('sessionKey'))
        && !(transcriptFixtures && url.searchParams.get('sessionKey') === 'opencode-owned:next-worker')) { res.writeHead(404).end(); return; }
      if (route === context && !seeds.some(seed => seed.id === url.searchParams.get('tabId'))) { res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 1024 * 1024) throw new Error('Fixture body limit'); }
      if (body && !settingsRoute && !control) {
        const target = JSON.parse(body) as { threadId?: string; repoPath?: string; packetId?: string; id?: string; action?: string };
        const owned = route === brainAsk ? target.repoPath === repo || !target.repoPath : route === reviewDecision.POST
          ? ['next-review-approve', 'next-review-reject'].includes(target.packetId ?? '')
          : route === approvalRoutes?.POST ? inboxApprovals.some((approval) => approval.id === target.id) && ['approve', 'reject'].includes(target.action ?? '')
          : route === planProxy?.POST ? ['inbox-plan-native', 'inbox-plan-desktop'].includes(String(req.headers['x-tab-id'])) && target.repoPath === repo
          : target.threadId?.startsWith('thoughts-composer-') && target.repoPath === repo;
        if (!owned) { res.writeHead(400).end(); return; }
      }
      const request = new NextRequest(url, { method: req.method,
        headers: { host: url.host, 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(typeof req.headers['x-clerk-session-token'] === 'string' ? { 'x-clerk-session-token': req.headers['x-clerk-session-token'] } : {}),
          ...(typeof req.headers['x-tab-id'] === 'string' ? { 'x-tab-id': req.headers['x-tab-id'] } : {}) }, ...(body ? { body } : {}) });
      const gate = panelGateMiddleware(request);
      if (route === brainAsk && gate.status === 200 && body && process.env.O8_NEXT_BRAIN_REQUEST_LOG) {
        brainRequests.push(JSON.parse(body));
        writeFileSync(process.env.O8_NEXT_BRAIN_REQUEST_LOG, JSON.stringify(brainRequests));
      }
      if (gate.status === 200 && route === approvalRoutes?.POST && JSON.parse(body).action === 'approve'
        && inboxPlan?.approvals.some((approval) => approval.id === JSON.parse(body).id)) inboxPlan.beforeDecision();
      const response = gate.status === 200 ? settingsRoute ? await settings!.run(route, request) : await route(request) : gate;
      if (settingsRoute && req.method !== 'GET' && response.ok && settings!.dropResponse()) { res.destroy(); return; }
      // PATCH exercises actual steer admission and its persisted transcript echo.
      if (composer && response.ok && (route === queue.PATCH || (route === queue.POST && JSON.parse(body).intent === 'steer-now'))) {
        const { claimComposerSteer } = await import('../../src/lib/orchestrator/composer-queue');
        const { runQueuedComposerSteer } = await import('../../src/lib/ws-server/composer-queue-heartbeat');
        const item = claimComposerSteer((await response.clone().json()).item.id);
        if (item) await runQueuedComposerSteer(item);
      }
      if (composer && route === queue.POST && response.ok && !responseLost
        && JSON.parse(body).payload?.text === 'Fixture lose response') {
        responseLost = true; res.destroy(); return;
      }
      if (review && process.argv.includes('--review-drop-first') && route === reviewDecision.POST
        && response.ok && !reviewResponseLost && JSON.parse(body).approved === false) {
        reviewResponseLost = true; res.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (route === brainAsk && response.body) {
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
      ...(peer ? { terminalSession: peer.sessionName } : {}) })}\n`);
  });
  async function close() {
    await inboxPlan?.close();
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
