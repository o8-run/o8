/**
 * #3665: a chat view that stays open across a ws-server restart must keep
 * receiving its turns. The desktop client keeps its replay cursor (the highest
 * `seq` it applied) and reconnects with `since: <cursor>`; its de-dup drops any
 * event whose seq is not above that cursor. Real ws-server process, restarted
 * on the same data directory; only the Codex CLI protocol is scripted.
 */
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-replay-restart-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const fakeCli = join(root, 'scripted-codex.mjs');
const loopbackOnly = join(root, 'loopback-listener.mjs');
const token = 'replay-restart-token';
mkdirSync(dataDir);
for (const [key, value] of Object.entries({
  O8_DATA_DIR: dataDir,
  CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
})) vi.stubEnv(key, value);

const { PATCH, POST } = await import('@/app/api/v2/chat-history/route');
const { GET: listThreads } = await import('@/app/api/mobile/orchestrator/threads/route');
const { buildOrchestratorSendPayload } = await import('@/components/desktop/thoughts/use-orchestrator-stream/send-payload');
const { skipDuplicateBySeq } = await import('@/lib/orchestrator/replay-cursor');

interface WireEvent { event?: string; seq?: number; data?: Record<string, unknown> }
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess | undefined;
let wsPort = 0;
let serverOutput = '';
let childEnv: NodeJS.ProcessEnv;

async function waitFor(predicate: () => boolean, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (wsProcess && (wsProcess.exitCode !== null || wsProcess.signalCode !== null)) {
      throw new Error(`WebSocket server exited: ${serverOutput.slice(-3_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${serverOutput.slice(-1_500)}`);
}

async function startServer() {
  serverOutput = '';
  wsProcess = execFile(process.execPath, ['--import', loopbackOnly, '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: childEnv,
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(() => serverOutput.includes('WebSocket server listening'), 'WebSocket startup', 60_000);
}

async function stopServer() {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  const child = wsProcess;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
    if (!stopped) { child.kill('SIGKILL'); await exited; }
  }
  wsProcess = undefined;
}

/** Subscribes the way the desktop stream does on (re)connect, carrying its cursor. */
async function connect(threadId: string, since: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  const events: WireEvent[] = [];
  socket.on('message', (chunk) => {
    const msg = JSON.parse(String(chunk));
    if (msg.channel === 'orchestrator') events.push(msg);
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend: 'codex', since }));
  await waitFor(() => events.some((event) => event.event === 'status' && event.data?.snapshot === true), 'subscribe snapshot');
  return { socket, events };
}

async function runTurn(socket: WebSocket, events: WireEvent[], threadId: string, id: string, message: string) {
  const start = events.length;
  socket.send(buildOrchestratorSendPayload({
    repoPath, threadId, clientMessageId: id,
    wireMessage: message, displayMessage: message,
    permissionMode: 'plan', orchestrationMode: 'fleet', pickedMode: 'multitask',
    model: 'gpt-6.1-sol', backend: 'codex',
  }));
  await waitFor(() => events.slice(start).some((event) => (
    event.event === 'status' && event.data?.status === 'ready' && event.data?.snapshot !== true
  )), `turn ${id} to finish`);
  return events.slice(start).filter((event) => typeof event.seq === 'number');
}

beforeAll(async () => {
  mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Replay Fixture');
  git('config', 'user.email', 'replay@example.test');
  writeFileSync(join(repoPath, 'notes.txt'), 'base\n');
  git('add', 'notes.txt');
  git('commit', '-qm', 'fixture');
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'replay-repo', name: 'repo', localPath: repoPath, addedAt: new Date().toISOString() },
  ] }));
  writeFileSync(fakeCli, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
const emit = (value) => console.log(JSON.stringify(value));
const prompt = process.argv.join('\\n');
const text = prompt.includes('second turn') ? 'Second reply after restart.' : prompt.includes('inbox initial empty turn') ? '' : 'First reply.';
emit({ type: 'thread.started', thread_id: 'scripted-codex-replay' });
if (prompt.includes('stream-heavy replay fixture')) {
  const { existsSync } = await import('node:fs');
  for (let i = 0; i < 12; i++) emit({ type: 'item.completed', item: { type: 'agent_message', text: 'chunk-' + i + ':' + 'x'.repeat(4 * 1024) } });
  while (!existsSync(${JSON.stringify(join(root, 'release-stream'))})) await new Promise(resolve => setTimeout(resolve, 25));
} else emit({ type: 'item.completed', item: { type: 'agent_message', text } });
emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`);
  chmodSync(fakeCli, 0o755);
  writeFileSync(loopbackOnly, `import { Server } from 'node:net';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
`);
  apiServer = createServer((request, response) => {
    const status = request.url === '/api/setup/identity' ? { configured: false } : { ready: true };
    response.writeHead(['/api/setup/identity', '/api/setup/status', '/api/panel/health'].includes(request.url ?? '') ? 200 : 404,
      { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status));
  });
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing API port');
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const wsAddress = portProbe.address();
  if (!wsAddress || typeof wsAddress === 'string') throw new Error('Missing WebSocket port');
  wsPort = wsAddress.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const home = join(root, 'home');
  mkdirSync(home);
  childEnv = {
    NODE_ENV: 'test', PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
    CORTEX_IDE_OWNED_CODEX_ROOT: join(root, 'owned-codex'),
    O8_CODEX_BIN: fakeCli, O8_SUBSCRIPTION_PROFILE: 'both',
    O8_ORCHESTRATOR_REPLAY_BYTE_LIMIT: String(16 * 1024),
    ...(process.env.O8_TEST_FILE_MARKER ? { O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER } : {}),
    O8_API_PORT: String(address.port), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${address.port}`,
  };
  writeFileSync(join(dataDir, 'api-port'), String(address.port));
  writeFileSync(join(dataDir, 'ws-port'), String(wsPort));
  await startServer();
}, 90_000);

afterAll(async () => {
  await stopServer();
  if (apiServer?.listening) {
    apiServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('orchestrator replay cursor across a ws-server restart (#3665)', () => {
  it('bounds an unfinished stream by bytes and replays the exact recorded tail (#4422)', async () => {
    const threadId = `thoughts-replay-heavy-${Date.now()}`;
    const first = await connect(threadId, 0);
    first.socket.send(buildOrchestratorSendPayload({
      repoPath, threadId, clientMessageId: 'heavy-turn',
      wireMessage: 'stream-heavy replay fixture', displayMessage: 'stream-heavy replay fixture',
      permissionMode: 'plan', orchestrationMode: 'fleet', pickedMode: 'multitask',
      model: 'gpt-6.1-sol', backend: 'codex',
    }));
    try {
      await waitFor(() => first.events.some((event) => String(event.data?.text).includes('chunk-11:') || event.event === 'error' || (event.data?.status === 'ready' && !event.data?.snapshot)), 'recorded heavy stream');
      expect(first.events.some((event) => String(event.data?.text).includes('chunk-11:'))).toBe(true);
      const recorded = first.events.filter((event) => typeof event.seq === 'number');
      const replay = await connect(threadId, 0);
      const lastSeq = recorded.at(-1)?.seq;
      await waitFor(() => replay.events.some((event) => event.seq === lastSeq), 'replay tail to arrive');
      const replayed = replay.events.filter((event) => typeof event.seq === 'number');
      const size = replayed.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
      console.log(`[replay-memory] orchestrator retained ${size} bytes from ${recorded.length} recorded envelopes`);
      expect(size).toBeLessThanOrEqual(16 * 1024);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed).toEqual(recorded.slice(-replayed.length));
      const cursor = Number(replayed.at(-2)?.seq);
      const resumed = await connect(threadId, cursor);
      await waitFor(() => resumed.events.some((event) => event.seq === lastSeq), 'cursor replay tail to arrive');
      expect(resumed.events.filter((event) => typeof event.seq === 'number')).toEqual(replayed.filter((event) => Number(event.seq) > cursor));
    } finally {
      writeFileSync(join(root, 'release-stream'), 'release');
      await waitFor(() => first.events.some((event) => event.event === 'status' && event.data?.status === 'ready' && !event.data?.snapshot), 'heavy turn completion');
    }
  }, 60_000);

  it('clears an explicit active override only on a real WS turn and refuses settle while it runs (#5090)', async () => {
    const threadId = `thoughts-inbox-ws-${Date.now()}`;
    const first = await connect(threadId, 0);
    await runTurn(first.socket, first.events, threadId, 'inbox-first', 'inbox initial empty turn');
    const mutate = (inboxAction: string) => PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'PATCH', body: JSON.stringify({ tabId: threadId, inboxAction }),
    }));
    const projected = async () => {
      const response = await listThreads(new NextRequest('http://localhost/api/mobile/orchestrator/threads?limit=500'));
      return (await response.json()).threads.find((thread: { id: string }) => thread.id === threadId);
    };
    expect((await mutate('settle')).status).toBe(200);
    expect((await projected()).settledOverride).toBe('settled');
    expect((await mutate('unsettle')).status).toBe(200);
    const active = await projected();
    expect(active.settledOverride).toBe('active');
    // Saving an unchanged transcript is metadata activity, never a run.
    expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST', body: JSON.stringify({ tabId: threadId, messages: [] }),
    }))).status).toBe(200);
    expect((await projected()).settledOverride).toBe('active');
    rmSync(join(root, 'release-stream'), { force: true });
    const start = first.events.length;
    first.socket.send(buildOrchestratorSendPayload({ repoPath, threadId, clientMessageId: 'inbox-running',
      wireMessage: 'stream-heavy replay fixture', displayMessage: 'stream-heavy replay fixture',
      permissionMode: 'plan', orchestrationMode: 'fleet', pickedMode: 'multitask', model: 'gpt-6.1-sol', backend: 'codex' }));
    try {
      await waitFor(() => first.events.slice(start).some(event => String(event.data?.text).includes('chunk-11:')), 'inbox live stream');
      expect(await projected()).toMatchObject({ settledOverride: null, settledAt: null, unsettledAt: active.unsettledAt });
      expect((await mutate('settle')).status).toBe(409);
    } finally {
      writeFileSync(join(root, 'release-stream'), 'release');
      await waitFor(() => first.events.slice(start).some(event => event.event === 'status' && event.data?.status === 'ready' && !event.data?.snapshot), 'inbox turn completion');
    }
    expect((await mutate('settle')).status).toBe(200);
  }, 180_000);

  it('delivers the next turn to a view that kept its cursor through the restart', async () => {
    const threadId = `thoughts-replay-restart-${Date.now()}`;
    // The client's replay cursor, carried across reconnects as the desktop stream does.
    const cursor = { current: 0 };
    const applied = (events: WireEvent[]) => events.filter((event) => !skipDuplicateBySeq(event, cursor));

    const first = await connect(threadId, cursor.current);
    const firstTurn = applied(await runTurn(first.socket, first.events, threadId, 'turn-1', 'first turn'));
    expect(firstTurn.some((event) => event.event === 'status' && event.data?.status === 'ready')).toBe(true);
    expect(JSON.stringify(firstTurn)).toContain('First reply.');
    const cursorBeforeRestart = cursor.current;
    expect(cursorBeforeRestart).toBeGreaterThan(0);

    await stopServer();
    await startServer();

    const second = await connect(threadId, cursor.current);
    const secondWire = await runTurn(second.socket, second.events, threadId, 'turn-2', 'second turn');
    const secondTurn = applied(secondWire);
    expect(secondWire.length).toBeGreaterThan(0);
    // Every event of the new turn reaches the view: none is mistaken for a replay.
    expect(secondTurn).toHaveLength(secondWire.length);
    expect(secondTurn.some((event) => event.event === 'status' && event.data?.status === 'ready')).toBe(true);
    expect(JSON.stringify(secondTurn)).toContain('Second reply after restart.');
    expect(cursor.current).toBeGreaterThan(cursorBeforeRestart);
  }, 180_000);
});
