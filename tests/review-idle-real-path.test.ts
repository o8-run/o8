import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Frame = { channel?: string; event?: string; data?: { changedFiles?: { path: string }[] } };
const root = mkdtempSync(join(tmpdir(), 'o8-review-idle-'));
const dataDir = join(root, 'data');
const reviewRoot = join(root, 'review');
const token = `review-idle-${process.pid}`;
const requests: { path: string; fresh: boolean }[] = [];
const frames: Frame[] = [];
let apiServer: Server;
let decoyServer: Server;
let wsProcess: ChildProcess | null = null;
let socket: WebSocket | null = null;
let apiPort = 0;
let decoyPort = 0;
let wsPort = 0;
let output = '';
const decoyRequests: string[] = [];
const commentaryAuthorizations: string[] = [];
let holdSnapshot = false;
let releaseSnapshot: (() => void) | null = null;

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}: ${output.slice(-2_000)}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function diffCalls() {
  const file = join(root, 'diff-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

function freshReads() {
  return requests.filter((request) => request.path === '/api/command-center/snapshot' && request.fresh).length;
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${root}`, ...args], {
    cwd, encoding: 'utf8', timeout: 5_000,
  });
}

async function refresh() {
  const response = await fetch(`http://127.0.0.1:${wsPort}/internal/realtime`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'refresh', targets: ['global'], fresh: true, reason: 'review idle acceptance' }),
  });
  expect(response.status).toBe(202);
}

beforeAll(async () => {
  mkdirSync(dataDir);
  mkdirSync(reviewRoot);
  writeFileSync(join(dataDir, 'ws-token'), token, { mode: 0o600 });
  apiPort = await freePort();
  decoyPort = await freePort();
  wsPort = await freePort();
  // A stale disk port must never override the source stack's explicit
  // O8_API_PORT. The decoy catches regressions without touching another app.
  writeFileSync(join(dataDir, 'api-port'), String(decoyPort));
  writeFileSync(join(dataDir, 'ws-port'), String(wsPort));
  decoyServer = createServer((request, response) => {
    decoyRequests.push(request.url ?? '');
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'wrong source API port' }));
  });
  decoyServer.listen(decoyPort, '127.0.0.1');
  await once(decoyServer, 'listening');
  apiServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    requests.push({ path: url.pathname, fresh: url.searchParams.get('fresh') === '1' });
    response.setHeader('Content-Type', 'application/json');
    const inbox = {
      generatedAt: '', mode: 'live', sessions: [], fleetSessions: [], approvals: [], reviewUnits: [], items: [], summary: {},
    };
    if (url.pathname === '/api/panel/status') {
      // Bootstrap waits for API readiness before starting the review watchers.
      response.end(JSON.stringify({ ok: true }));
    } else if (url.pathname === '/api/command-center/snapshot') {
      if (holdSnapshot) {
        holdSnapshot = false;
        await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
        releaseSnapshot = null;
      }
      response.end(JSON.stringify({
        fleet: { agents: [], meta: { mode: 'live' } }, review: null,
        browserInventory: { surfaces: [], generatedAt: '' }, attachedBrowser: null,
      }));
    } else if (url.pathname === '/api/panel/repos') {
      response.end(JSON.stringify({ repos: [] }));
    } else if (url.pathname === '/api/mobile/inbox') {
      response.end(JSON.stringify(inbox));
    } else if (url.pathname === '/api/mobile/sync') {
      response.end(JSON.stringify({ inbox, inboxEtag: 'empty' }));
    } else if (url.pathname === '/api/worktrees/conflicts') {
      response.end(JSON.stringify({ files: [], safe: true, mergeOrder: [] }));
    } else if (url.pathname === '/api/setup/identity') {
      response.end(JSON.stringify({ configured: false }));
    } else if (url.pathname === '/api/broadcast/commentary') {
      commentaryAuthorizations.push(request.headers.authorization ?? '');
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: 'missing operator bearer' }));
      } else {
        response.end(JSON.stringify({ commentary: [], cursor: null, hasMore: false }));
      }
    } else if (url.pathname === '/api/orchestrator/headless-tick') {
      response.end(JSON.stringify({ ok: true }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    O8_REVIEW_TEST_DIR: root, CORTEX_IDE_REVIEW_REPO_ROOT: reviewRoot,
    O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
  };
  delete childEnv.NEXT_ORIGIN;
  wsProcess = execFile(process.execPath, [
    '--require=./tests/helpers/review-idle-preload.cjs',
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: childEnv,
  });
  wsProcess.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  wsProcess.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; }
  }, 'WebSocket health', 30_000);
  socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
  await once(socket, 'open');
  await waitFor(() => frames.some((frame) => frame.event === 'connected'), 'authenticated connection');
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
  await waitFor(() => frames.some((frame) => frame.event === 'file-changes'), 'initial review scan');
  await waitFor(() => freshReads() > 0, 'initial runtime update');
}, 40_000);

afterAll(async () => {
  releaseSnapshot?.();
  socket?.terminate();
  if (wsProcess && wsProcess.exitCode === null) {
    const exited = once(wsProcess, 'exit');
    wsProcess.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (wsProcess.exitCode === null) { wsProcess.kill('SIGKILL'); await exited; }
  }
  if (apiServer?.listening) {
    apiServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  }
  if (decoyServer?.listening) {
    decoyServer.closeAllConnections();
    await new Promise<void>((resolve) => decoyServer.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

describe('review refresh through the real WebSocket server', () => {
  it('authenticates speaker polling against the explicit source API port', async () => {
    await waitFor(() => commentaryAuthorizations.length > 0, 'authenticated commentary poll');
    expect(commentaryAuthorizations.every((authorization) => authorization === `Bearer ${token}`)).toBe(true);
    expect(decoyRequests.some((path) => path.startsWith('/api/broadcast/commentary'))).toBe(false);
    expect(output).not.toContain('[broadcast-speaker]');
  });

  it('keeps ordinary-folder timer scans free of diff shells and runtime rediscovery', async () => {
    // The review root has no Git watcher. Its periodic safety scan still runs.
    const before = freshReads();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(diffCalls()).toBe(0);
    expect(freshReads()).toBe(before);
  });

  it('discovers a linked repository created later and unstaged edits without a watcher', async () => {
    const main = join(root, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 'Fixture');
    git(main, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(join(main, 'tracked.txt'), 'base\n');
    git(main, 'add', 'tracked.txt');
    git(main, 'commit', '-qm', 'fixture');
    git(main, 'worktree', 'add', '-qb', 'review-test', reviewRoot);
    const before = freshReads();
    writeFileSync(join(reviewRoot, 'tracked.txt'), 'changed\nsecond line\n');
    await waitFor(() => frames.some((frame) => frame.data?.changedFiles?.some((file) => file.path === 'tracked.txt')),
      'unstaged linked-worktree edit');
    await waitFor(() => freshReads() > before, 'change-driven runtime refresh');
    expect(diffCalls()).toBeGreaterThan(0);
  });

  it('retains a timer request and an edit arriving during an in-flight review diff', async () => {
    writeFileSync(join(root, 'hold-diff'), 'hold');
    await waitFor(() => existsSync(join(root, 'diff-held')), 'held real diff callback');
    const before = diffCalls();
    writeFileSync(join(reviewRoot, 'late.txt'), 'late edit\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(diffCalls()).toBe(before);
    rmSync(join(root, 'hold-diff'));
    await waitFor(() => frames.some((frame) => frame.data?.changedFiles?.some((file) => file.path === 'late.txt')),
      'trailing refresh for the in-flight edit');
    expect(diffCalls()).toBeGreaterThan(before);
  });

  it('preserves explicit fresh requests and a trailing request while the bridge is busy', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = freshReads();
    holdSnapshot = true;
    await refresh();
    await waitFor(() => releaseSnapshot !== null, 'held snapshot request');
    await refresh();
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseSnapshot?.();
    await waitFor(() => freshReads() >= before + 2, 'second explicit fresh snapshot');
  });

  it('suspends hidden-only review scans but keeps the connection and explicit refresh alive', async () => {
    socket!.send(JSON.stringify({ type: 'review-visibility', visible: false }));
    // Let the already-owned diff complete before counting quiescent work.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = diffCalls();
    writeFileSync(join(reviewRoot, 'hidden.txt'), 'edit while hidden\n');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(diffCalls()).toBe(before);
    expect(socket!.readyState).toBe(WebSocket.OPEN);
    socket!.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => frames.some((frame) => frame.channel === 'pong'), 'hidden connection pong');
    const readsBefore = freshReads();
    await refresh();
    await waitFor(() => freshReads() > readsBefore, 'explicit refresh while hidden');

    socket!.send(JSON.stringify({ type: 'review-visibility', visible: true }));
    await waitFor(() => frames.some((frame) => frame.data?.changedFiles?.some((file) => file.path === 'hidden.txt')),
      'reopen catches hidden edit');
    expect(diffCalls()).toBeGreaterThan(before);
  });

  it('does not let a hidden desktop suppress a second visible or legacy global subscriber', async () => {
    socket!.send(JSON.stringify({ type: 'review-visibility', visible: false }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = diffCalls();
    const second = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
    try {
      await once(second, 'open');
      // Older clients and mobile do not send a visibility hint. Invalid input
      // must not silently turn their default-visible subscription off.
      second.send(JSON.stringify({ type: 'review-visibility', visible: 'false' }));
      second.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
      await waitFor(() => diffCalls() > before, 'second subscriber review scan');
    } finally {
      second.terminate();
      socket!.send(JSON.stringify({ type: 'review-visibility', visible: true }));
    }
  });
});
