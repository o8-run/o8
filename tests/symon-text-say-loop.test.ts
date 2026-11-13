import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSymonTextTurnEval } from '@/lib/mobile/symon-text-eval';

const testState = vi.hoisted(() => ({
  claudeInstalled: true,
  claudeAuthenticated: true,
  codexInstalled: true,
  codexAuthenticated: true,
  evalCalls: [] as string[],
  terminal: null as 'error' | 'interrupted' | null,
  automatic: false,
  evaluate: null as ((code: string) => string) | null,
  turnReplies: [] as Array<{ method: string; turnId: string; state: string }>,
}));

const defaultPlannerInfo = {
  available: true,
  engine: 'claude',
  model: 'claude-opus-4-8',
  effort: 'high',
  tools: [{ name: 'o8_status', parameters: { type: 'object', properties: {} } }],
};

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    async evalJs(code: string) {
      testState.evalCalls.push(code);
      if (testState.evaluate) return { result: testState.evaluate(code) };
      if (code.includes('A.text.plannerInfo')) {
        const info = testState.automatic
          ? { ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true }
          : code.includes('gpt-6.1-sol')
          ? { ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }
          : defaultPlannerInfo;
        return { result: JSON.stringify({ state: 'done', info }) };
      }
      if (testState.terminal) return {
        result: JSON.stringify({
          state: testState.terminal === 'error' ? 'error' : 'done',
          detail: 'fixture terminal failure',
          result: { status: testState.terminal, model: 'gpt-5.6-sol', effort: 'high', text: '' },
        }),
      };
      return {
        result: JSON.stringify({
          state: 'done',
          result: {
            status: 'done',
            text: 'The desktop planner answered.',
            activeMachine: { id: 'macbook', displayName: 'MacBook' },
          },
        }),
      };
    }
  },
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => {
  const getSnapshot = async () => ({
    statuses: {
      claude: {
        installed: testState.claudeInstalled,
        ready: testState.claudeAuthenticated,
      },
      codex: {
        installed: testState.codexInstalled,
        ready: testState.codexAuthenticated,
      },
    },
  });
  return {
    getRuntimeAuthSnapshot: getSnapshot,
    getRuntimeAuthSnapshotForClaudeCarrier: getSnapshot,
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-symon-text-wire-'));
const token = 'symon-text-wire-token';
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
const sockets = new Set<WebSocket>();

async function connectTextSocket(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  await once(socket, 'open');
  return socket;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServerReady(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        // Health reports listener liveness before startup settles. Other routes,
        // including this unhandled path, await the same gate as text messages.
        const ready = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        if (ready.status === 404) return;
      }
    } catch {
      // The real ws-server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ws-server did not finish startup');
}

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  // Startup maintenance must inspect a disposable repository, not the checkout
  // that supplies the real server entry point.
  const reviewRepo = join(dataDir, 'review-repo');
  mkdirSync(reviewRepo, { mode: 0o700 });
  execFileSync('git', ['init', '-q', reviewRepo]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture'], { cwd: reviewRepo });
  apiPort = await freePort();
  wsPort = await freePort();

  const { POST: mintTextSession } = await import('@/app/api/mobile/symon/text-session/route');
  const { POST: runTextTurn, DELETE: interruptTextTurn } = await import('@/lib/symon/http/text-turn');
  apiServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (url.pathname === '/api/panel/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (url.pathname === '/api/mobile/symon/text-session' && request.method === 'POST') {
      const routeResponse = await mintTextSession(new NextRequest(url, {
        method: 'POST',
        headers: request.headers as HeadersInit,
        body,
      }));
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(Buffer.from(await routeResponse.arrayBuffer()));
      return;
    }
    if (url.pathname === '/api/mobile/symon/text-turn' && (request.method === 'POST' || request.method === 'DELETE')) {
      const route = request.method === 'DELETE' ? interruptTextTurn : runTextTurn;
      const routeResponse = await route(new NextRequest(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
        body,
      }));
      const reply = await routeResponse.text();
      testState.turnReplies.push({ method: request.method, turnId: JSON.parse(body.toString()).turnId, state: JSON.parse(reply).state });
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(reply);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');

  const clockShim = join(dataDir, 'deadline-clock.mjs');
  writeFileSync(clockShim, `const realNow = Date.now; let offset = 0;
    Date.now = () => realNow() + offset;
    process.on('SIGUSR2', () => { offset = offset ? 0 : 300001; });`);
  wsProcess = execFile(process.execPath, [
    `--import=${clockShim}`,
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      CORTEX_IDE_REVIEW_REPO_ROOT: reviewRepo,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  await waitForServerReady(wsPort);
}, 30_000);

afterAll(async () => {
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
});

afterEach(async () => {
  if (sockets.size === 0) return;
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.CLOSED) continue;
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  }
  // Server disconnect cleanup persists session removal. Let it finish before
  // the next case mints a session into the same cross-process JSON store.
  await expect.poll(async () => {
    const response = await fetch(`http://127.0.0.1:${wsPort}/health`);
    return (await response.json() as { clients: number }).clients;
  }, { timeout: 2_000 }).toBe(0);
  sockets.clear();
});

beforeEach(() => {
  testState.claudeInstalled = true;
  testState.claudeAuthenticated = true;
  testState.codexInstalled = true;
  testState.codexAuthenticated = true;
  testState.evalCalls.length = 0;
  testState.terminal = null;
  testState.automatic = false;
  testState.evaluate = null;
  testState.turnReplies.length = 0;
});

async function mint(model?: string) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/mobile/symon/text-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceMode: 'o8', currentRoute: '/mobile/ask', ...(model ? { model } : {}) }),
  });
  return {
    response,
    body: await response.json() as {
      session: {
        sessionId: string;
        model: string;
        effort: string;
        engine: string;
        activeMachine: { id: string; displayName: string };
      };
    },
  };
}

describe('Symon text-first say loop wire', () => {
  it('binds an available public model override through mint and the real ws spawn seam', async () => {
    const { response, body: minted } = await mint('codex-sol-xhigh');
    expect(response.status).toBe(200);
    expect(minted.session).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', engine: 'codex' });
    expect(minted.session.activeMachine).toEqual({ id: 'local', displayName: 'This computer' });
    testState.evalCalls.length = 0;

    const socket = await connectTextSocket();
    const frames: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`missing text done: ${JSON.stringify(frames)}`)), 10_000);
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.channel !== 'symon') return;
        frames.push(frame);
        if (frame.type === 'symon-text-done') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({
      channel: 'symon',
      type: 'symon-text-turn',
      sessionId: minted.session.sessionId,
      turnId: 'turn-wire-1',
      text: 'What is the current status?',
    }));
    await done;
    socket.close();

    expect(frames.map((frame) => frame.type)).toEqual([
      'symon-text-status',
      'symon-text-delta',
      'symon-text-done',
    ]);
    for (const frame of frames) {
      expect(frame).not.toHaveProperty('event');
      expect(frame).not.toHaveProperty('data');
    }
    expect(frames).toContainEqual(expect.objectContaining({
      channel: 'symon',
      type: 'symon-text-delta',
      sessionId: minted.session.sessionId,
      turnId: 'turn-wire-1',
      delta: 'The desktop planner answered.',
    }));
    expect(frames.at(-1)).toEqual(expect.objectContaining({
      channel: 'symon',
      type: 'symon-text-done',
      status: 'done',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      activeMachine: { id: 'macbook', displayName: 'MacBook' },
    }));
    expect(frames[0]).toEqual(expect.objectContaining({
      type: 'symon-text-status',
      activeMachine: { id: 'local', displayName: 'This computer' },
    }));
    const spawnEval = testState.evalCalls.find((code) => code.includes('A.text.runTurn'));
    expect(spawnEval).toContain('"engine":"codex"');
    expect(spawnEval).toContain('"model":"gpt-6.1-sol"');
    expect(spawnEval).toContain('"effort":"xhigh"');
  });

  it('uses the native default for omitted or unknown selections and refuses unavailable pins', async () => {
    const omitted = await mint();
    expect(omitted.response.status).toBe(200);
    expect(omitted.body.session).toMatchObject({
      engine: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    const unknown = await mint('gpt-5.6-sol');
    expect(unknown.response.status).toBe(200);
    expect(unknown.body.session).toMatchObject({
      engine: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    testState.codexAuthenticated = false;
    const unavailable = await mint('codex-sol-xhigh');
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.session).toBeUndefined();
  });
});

it.each(['error', 'interrupted'] as const)('reports fallback metadata on WS %s and binds the next turn', async (status) => {
  testState.automatic = true;
  testState.terminal = status;
  const { body: minted } = await mint();
  const socket = await connectTextSocket();
  const sendTurn = (turnId: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('missing terminal frame')), 10_000);
    const receive = (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.type !== 'symon-text-done' || frame.turnId !== turnId) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(frame);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ channel: 'symon', type: 'symon-text-turn',
      sessionId: minted.session.sessionId, turnId, text: 'Hello' }));
  });
  try {
    expect(await sendTurn('terminal-first')).toMatchObject({
      status: status === 'error' ? 'unconfirmed' : 'interrupted', model: 'gpt-5.6-sol', effort: 'high',
      ...(status === 'error' ? { detail: 'fixture terminal failure' } : {}),
    });
    testState.terminal = null;
    testState.evalCalls.length = 0;
    expect(await sendTurn('terminal-next')).toMatchObject({ status: 'done', model: 'gpt-5.6-sol', effort: 'high' });
    const spawnEval = testState.evalCalls.find((code) => code.includes('A.text.runTurn'));
    expect(spawnEval).toContain('"model":"gpt-5.6-sol"');
    expect(spawnEval).toContain('"allowDefaultFallback":false');
  } finally {
    socket.close();
  }
});

it.each([false, true])('reconciles phone Stop before spawning a queued turn (deadline expired: %s)', async (deadlineExpired) => {
  let finishNative!: (result: Record<string, unknown>) => void;
  const nativePending = new Promise<Record<string, unknown>>((resolve) => { finishNative = resolve; });
  const bindingsAtSpawn: Array<Record<string, unknown> | undefined> = [];
  const nativeRun = vi.fn(async (_prompt: string, sessionId: string, turnId: string, _planner: unknown) => {
    bindingsAtSpawn.push((JSON.parse(readFileSync(join(dataDir, 'symon-text-sessions.json'), 'utf8')) as Array<Record<string, unknown>>)
      .find((session) => session.sessionId === sessionId));
    return turnId === 'stop-first' ? nativePending : { status: 'done', model: 'gpt-5.6-sol', effort: 'high', text: 'Next answer.' };
  });
  const nativeInterrupt = vi.fn(async () => true);
  const context = { window: { __o8SymonAgent: { text: {
    plannerInfo: async () => ({ ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true }),
    runTurn: nativeRun,
    interruptTurn: nativeInterrupt,
  } } } };
  testState.evaluate = (code) => runInNewContext(code, context);
  const { body: minted } = await mint();
  const sessionId = minted.session.sessionId;
  const sessionOnDisk = () => (JSON.parse(readFileSync(join(dataDir, 'symon-text-sessions.json'), 'utf8')) as Array<Record<string, unknown>>)
    .find((session) => session.sessionId === sessionId);
  const socket = await connectTextSocket();
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => { frames.push(JSON.parse(String(raw))); });
  const send = (type: string, turnId: string) => socket.send(JSON.stringify({ channel: 'symon', type, sessionId, turnId, text: 'Hello' }));
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 8_000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  };
  const terminal = () => frames.filter((frame) => frame.type === 'symon-text-done');
  let clockAdvanced = false;
  try {
    send('symon-text-turn', 'stop-first');
    await waitFor(() => nativeRun.mock.calls.length === 1);
    expect(nativeRun.mock.calls[0][3]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true });
    send('symon-text-interrupt', 'stop-first');
    await waitFor(() => testState.turnReplies.some((reply) => reply.method === 'DELETE' && reply.state === 'done'));
    send('symon-text-interrupt', 'stop-first'); // duplicate Stop must not redeliver cancellation
    send('symon-text-turn', 'stop-next'); // queue while the native turn is still blocked
    if (deadlineExpired) {
      wsProcess.kill('SIGUSR2');
      clockAdvanced = true;
    }
    // The actual POST poll window must expire while native completion remains held.
    await waitFor(() => testState.turnReplies.some((reply) => reply.method === 'POST' && reply.turnId === 'stop-first' && reply.state === 'pending'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (deadlineExpired) {
      await waitFor(() => terminal().length >= 1);
      expect(terminal()[0]).toMatchObject({ turnId: 'stop-first', status: 'unconfirmed' });
      expect(terminal()[0].model, 'an unresolved native result has no verified effective model').toBeUndefined();
    } else {
      expect(terminal(), 'DELETE acknowledgement must not fabricate native completion').toEqual([]);
    }
    expect(nativeRun).toHaveBeenCalledTimes(1);
    expect(sessionOnDisk()).toMatchObject({ model: 'gpt-6.1-sol', allowDefaultFallback: true });
    finishNative({ status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high', text: '' });
    await waitFor(() => terminal().length === 2);
    expect(terminal().map(({ turnId, status, model, effort }) => ({ turnId, status, model, effort }))).toEqual([
      deadlineExpired
        ? { turnId: 'stop-first', status: 'unconfirmed', model: undefined, effort: undefined }
        : { turnId: 'stop-first', status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high' },
      { turnId: 'stop-next', status: 'done', model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(sessionOnDisk()).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    expect(nativeRun.mock.calls[1][3]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    expect(bindingsAtSpawn[1]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    send('symon-text-turn', 'stop-first');
    send('symon-text-turn', 'stop-next');
    send('symon-text-interrupt', 'stop-first');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminal()).toHaveLength(2);
    expect(nativeRun).toHaveBeenCalledTimes(2);
    expect(nativeInterrupt).toHaveBeenCalledTimes(1);
    expect(testState.turnReplies.filter((reply) => reply.method === 'DELETE')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'symon-text-delta')).toHaveLength(1);
  } finally {
    if (clockAdvanced) wsProcess.kill('SIGUSR2');
    finishNative({ status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high', text: '' });
    socket.close();
  }
}, 20_000);

it('does not replay a missing native call while reconciling a timed-out turn', async () => {
  const runTurn = vi.fn(async () => ({ status: 'done', text: 'Must not run.' }));
  const context = { window: { __o8SymonAgent: { text: { runTurn } } } };
  const result = JSON.parse(runInNewContext(buildSymonTextTurnEval(
    'missing-session', 'missing-turn', 'Hello', { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, true,
  ), context));
  await Promise.resolve();
  expect(result).toEqual({ state: 'call_mismatch' });
  expect(runTurn).not.toHaveBeenCalled();
});
