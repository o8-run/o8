import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundleServers } from '../scripts/lib/server-bundles.mjs';
import { WebSocket } from 'ws';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-server-boot-'));
const state = join(root, 'state');
const journal = join(root, 'boot.jsonl');
const release = join(root, 'release');
const steps = [
  ['await terminalHostReady;', 'terminal-host'],
  ['expireStaleApprovals();', 'approvals'],
  ['await pruneOrphanedCodexWorktreeBranches(REPO_ROOT);', 'branches'],
  ['await runWorktreeMaintenanceTick(REPO_ROOT);', 'worktrees'],
  ["const resolved = sweepMergedPacketVerificationIncidents({ event: 'startup_sweep' });", 'incidents'],
  ['await checkLaunchAgentHealth();', 'launch-health'],
  ['const result = await sweepPacketsMergedByAncestry();', 'merged-packets'],
  ['const codexRebound = rehydrateCodexOrchestratorTurns({ onReboundEvent: handleReboundOrchestratorEvent });', 'sessions'],
  ['logStorageAdmissionReconciliation(await reconciliation.initial);', 'storage'],
  ['const result = await reconcileResourceLeasesAtStartup();', 'leases'],
  ['const receipt = await reconcileDependencyImagesAtStartup();', 'dependency-images'],
  ['await reconcileOrphanedWorktrees();', 'lanes'],
  ['startReviewWatchers();', 'review-watchers'],
  ['  startPollingLoops();', 'polling'],
  ['  startBrowserDiscoveryRealtimeLoop();', 'browser-discovery'],
  ['  startAttachedBrowserRefreshLoop();', 'attached-browser'],
] as const;
let api: Server | undefined;
let child: ChildProcess | undefined;
let socket: WebSocket | undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}

afterAll(async () => {
  socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 4_000);
    await exited;
    clearTimeout(force);
  }
  if (api?.listening) {
    api.closeAllConnections();
    await new Promise<void>(done => api!.close(() => done()));
  }
  rmSync(root, { recursive: true, force: true });
});

it('serves compiled WS health and ping before Next, and fences first use until every recovery phase finishes', async () => {
  mkdirSync(state);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  const isolated = join(root, 'isolated');
  mkdirSync(isolated);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const token = 'fixture-boot-token';
  writeFileSync(join(state, 'ws-token'), token, { mode: 0o600 });
  const compiled = join(root, 'ws-server.mjs');
  // Observe the real WS source while building the same split layout the
  // exporter ships, including its generated launcher and sibling chunks.
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'scripts'));
  symlinkSync(resolve('src/lib'), join(root, 'src/lib'), 'junction');
  writeFileSync(join(root, 'tsconfig.json'), readFileSync(resolve('tsconfig.json')));
  writeFileSync(join(root, 'scripts/server-only-stub.js'), readFileSync(resolve('scripts/server-only-stub.js')));
  let contents = readFileSync(resolve('src/ws-server.ts'), 'utf8');
  // Observe completed calls in the real entry point; no recovery subsystem is stubbed.
  for (const [call, step] of steps) {
    if (!contents.includes(call)) throw new Error(`Missing boot observation: ${step}`);
    contents = contents.replace(call, `${call}\n__bootDone(${JSON.stringify(step)});`);
  }
  contents = contents.replace('const db = getDb();', `if (existsSync(${JSON.stringify(join(root, 'fail'))})) throw new Error('fixture recovery failure');\nconst db = getDb();`);
  contents = contents.replace('  switch (msg.type) {', `  if (msg.type === 'realtime-subscribe') __bootDone('first-ws-use');\n  switch (msg.type) {`);
  contents = `import { appendFileSync as __append } from 'node:fs';
function __bootDone(step: string) { __append(${JSON.stringify(journal)}, JSON.stringify(step) + '\\n'); }
${contents}`;
  writeFileSync(join(root, 'src/ws-server.ts'), contents);
  bundleServers({ root, outDir: root });
  const apiPort = await freePort();
  const wsPort = await freePort();
  api = createServer((request, response) => {
    request.resume();
    if (request.url === '/api/panel/status' && !existsSync(release)) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ configured: false, ready: true }));
  });
  api.listen(apiPort, '127.0.0.1');
  await once(api, 'listening');
  const started = performance.now();
  let diagnostic = '';
  const launch = () => spawn(process.execPath, [compiled], { env: {
    NODE_ENV: 'test', PATH: process.env.PATH, HOME: isolated, USERPROFILE: isolated,
    O8_DATA_DIR: state, CORTEX_IDE_DATA_DIR: state, CORTEX_IDE_DB_PATH: join(state, 'db.sqlite'),
    CORTEX_IDE_REVIEW_REPO_ROOT: repo, O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_SILENT_EXIT_DETECTOR_ENABLED: '0',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  child = launch();
  child.stderr?.on('data', chunk => { diagnostic += String(chunk); });
  let health: Response | undefined;
  while (performance.now() - started < 3_000) {
    try { health = await fetch(`http://127.0.0.1:${wsPort}/health`, { signal: AbortSignal.timeout(300) }); } catch { /* still booting */ }
    if (health?.ok) break;
    await new Promise(done => setTimeout(done, 25));
  }
  expect(health?.status, `compiled WS must answer health within 3s while Next is unavailable: ${diagnostic.replace(/\/[^\s)]+/g, '<path>').slice(-600)}`).toBe(200);
  expect(await health!.json()).toMatchObject({ product: 'o8', status: 'ok' });
  socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
  await once(socket, 'open');
  const pong = new Promise<void>(done => socket!.on('message', raw => {
    if (JSON.parse(String(raw)).channel === 'pong') done();
  }));
  socket.send(JSON.stringify({ type: 'ping' }));
  await pong;
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
  const disconnected = once(socket, 'close');
  socket.close();
  await disconnected;
  let answered = false;
  const firstUse = fetch(`http://127.0.0.1:${wsPort}/terminal-sessions`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(async response => {
    answered = true;
    expect(response.status).toBe(200);
    return response.json();
  });
  await new Promise(done => setTimeout(done, 100));
  expect(answered).toBe(false);
  expect(existsSync(journal)).toBe(false);
  appendFileSync(release, 'ready');
  await expect(firstUse).resolves.toMatchObject({ sessions: [] });
  expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    .toEqual(steps.map(([, step]) => step));

  let exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  rmSync(journal);
  rmSync(release);
  child = launch();
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok) break; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 25));
  }
  const waitingRequest = fetch(`http://127.0.0.1:${wsPort}/terminal-spawn`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionName: 'cortex-fixture-shutdown', shellCommand: 'exit', cwd: repo }),
  }).then(response => response.status, () => 'closed');
  await new Promise(done => setTimeout(done, 100));
  exited = once(child, 'exit');
  child.kill('SIGTERM');
  expect([503, 'closed']).toContain(await waitingRequest);
  await exited;
  expect(existsSync(journal)).toBe(false);

  writeFileSync(release, 'ready');
  writeFileSync(join(root, 'fail'), 'fail');
  child = launch();
  const [code] = await once(child, 'exit');
  expect(code).toBe(1);
  expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(['terminal-host']);
}, 30_000);
