import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { fakeCodexScript, reviewWorkerHelper } from './fixtures/lead-handoff-scripts';
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/claude-code/warm-repl-pool', () => ({
  askClaudeWarm: vi.fn(async () => ''),
  prewarmClaudeRepl: vi.fn(),
}));
interface CliResult { exitCode: number | null; stdout: string; stderr: string }
interface LeadCliReceipt {
  lead: {
    id: string;
    threadId: string;
    status: string;
    routing: { backend: string; model: string; effort: string };
    result?: { turnId: string; status: string } | null;
  };
  admittedTurnId?: string;
  latestTurn: { id: string; status: string } | null;
  cursor: number;
}
const testHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-lead-handoff-home-')));
const dataDir = path.join(testHome, '.o8');
const repoPath = path.join(testHome, 'repo');
const remotePath = path.join(testHome, 'remote.git');
const briefPath = path.join(testHome, 'brief.json');
const fakeCodex = path.join(testHome, '.local', 'bin', 'codex');
const argsPath = path.join(testHome, 'codex-args.jsonl');
const workerCapturePath = path.join(testHome, 'lead-worker.json');
const workerMarkersPath = path.join(testHome, 'lead-worker-markers.jsonl');
const reviewCapturePath = path.join(testHome, 'lead-review.json');
const dispatchDebugPath = path.join(testHome, 'lead-dispatch-debug.json');
const dispatchReadyPath = path.join(testHome, 'lead-dispatch-ready');
const workerReturnReadyPath = path.join(testHome, 'lead-worker-return-ready');
const token = 'lead-handoff-operator-token-0123456789abcdef';
const workerToken = 'lead-handoff-worker-token-0123456789abcdef';
const originalEnv = {
  HOME: process.env.HOME,
  O8_WORKER_ENV_ALLOW: process.env.O8_WORKER_ENV_ALLOW,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  CORTEX_IDE_OWNED_CODEX_ROOT: process.env.CORTEX_IDE_OWNED_CODEX_ROOT,
  WS_TOKEN: process.env.WS_TOKEN,
  O8_CODEX_BIN: process.env.O8_CODEX_BIN,
  O8_TEST_LEAD_ARGS: process.env.O8_TEST_LEAD_ARGS,
  O8_CRASH_SURVIVABLE_WORKERS: process.env.O8_CRASH_SURVIVABLE_WORKERS,
  O8_STORAGE_RESERVE_RATIO: process.env.O8_STORAGE_RESERVE_RATIO,
  O8_STORAGE_RESERVE_FLOOR_GB: process.env.O8_STORAGE_RESERVE_FLOOR_GB,
  O8_CLAUDE_CODE_BIN: process.env.O8_CLAUDE_CODE_BIN,
  O8_TEST_REVIEW_HELPER: process.env.O8_TEST_REVIEW_HELPER,
  O8_TEST_CONNECTED_WORKER_FILE: process.env.O8_TEST_CONNECTED_WORKER_FILE,
  O8_TEST_WORKER_MARKERS: process.env.O8_TEST_WORKER_MARKERS,
  O8_TEST_REVIEW_FILE: process.env.O8_TEST_REVIEW_FILE,
  O8_TEST_DISPATCH_DEBUG_FILE: process.env.O8_TEST_DISPATCH_DEBUG_FILE,
  O8_TEST_SOURCE_ROOT: process.env.O8_TEST_SOURCE_ROOT,
  O8_TEST_TARGET_REPO: process.env.O8_TEST_TARGET_REPO,
  O8_TEST_DISPATCH_READY_FILE: process.env.O8_TEST_DISPATCH_READY_FILE,
  O8_TEST_WORKER_RETURN_READY_FILE: process.env.O8_TEST_WORKER_RETURN_READY_FILE,
};
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
writeFileSync(path.join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
// The owned-session adapter captures this root during module initialization.
// Keep the Vitest parent and the separately spawned WS supervisor on one
// explicit root before either imports runtime code.
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(dataDir, 'owned-codex');
// ws-auth caches its data-dir at import time. Pin the credential explicitly so
// the test parent and the child WS supervisor authenticate the real completion
// callback with the same token even if another setup module loaded ws-auth.
process.env.WS_TOKEN = token;
process.env.O8_CODEX_BIN = fakeCodex;
process.env.O8_TEST_LEAD_ARGS = argsPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_STORAGE_RESERVE_RATIO = '0.000001';
process.env.O8_STORAGE_RESERVE_FLOOR_GB = '0.001';
process.env.O8_CLAUDE_CODE_BIN = fakeCodex;
const leadRoute = await import('@/app/api/orchestrator/lead/route');
const { __resetLeadRuntimeForTests, getLeadStatus, queueLeadReviewContinuation, queueLeadSupervisorReturn, sendLead } = await import('@/lib/orchestrator/lead-lifecycle');
const { closeDb, getSqlite } = await import('@/lib/db');
const { panelGateMiddleware } = await import('@/middleware');
const { readOrchestratorBackendSessionId, readOrchestratorThreadMessages } = await import('@/lib/mobile/orchestrator-thread-history');
const { probeMetadataLockProcessIdentitySync } = await import('@/lib/worktree/metadata-lock-process-identity');
const { appendEvent, createLane, updateLane } = await import('@/lib/lane/registry');
const { withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { addRepo } = await import('@/lib/repos/registry');
const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
const { findLaneByPacket } = await import('@/lib/lane/registry');

let apiServer: Server | null = null;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let wsOutput = '';
let retainDiagnosticFixture = false;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForWsOutput(text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wsOutput.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${text}: ${wsOutput.slice(-2_000)}`);
}

async function startSecondRouteServer(): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  const port = await freePort();
  const source = `
    import { createServer } from 'node:http';
    import { NextRequest } from 'next/server';
    const route = (await import('./src/app/api/orchestrator/lead/route.ts')).default;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const next = new NextRequest('http://127.0.0.1' + url.pathname + url.search, {
        method: request.method, headers: request.headers, body: body || undefined,
      });
      const result = request.method === 'GET' ? await route.GET(next) : await route.POST(next);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    });
    server.listen(Number(process.env.O8_TEST_SECOND_PORT), '127.0.0.1', () => console.log('ready'));
  `;
  const child = spawn(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', source,
  ], { cwd: process.cwd(), env: { ...process.env, O8_TEST_SECOND_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  await vi.waitFor(() => expect(output).toContain('ready'), { timeout: 10_000 });
  return { child, port, output: () => output };
}

function readArgs(): string[][] {
  try {
    return readFileSync(argsPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch { return []; }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeRouteResponse(response: ServerResponse, routeResponse: Response): Promise<void> {
  response.writeHead(routeResponse.status, { 'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json' });
  response.end(await routeResponse.text());
}

function runCli(args: string[], port = apiPort): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        O8_DATA_DIR: dataDir,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_API_PORT: String(port),
        O8_API_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

async function settled(leadId: string, timeout = '10s'): Promise<LeadCliReceipt> {
  const result = await runCli(['lead', 'wait', leadId, '--timeout', timeout]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as LeadCliReceipt;
}

function startArgs(key: string): string[] {
  return [
    'lead', 'start', '--repo', repoPath, '--backend', 'codex',
    '--model', 'gpt-5.6-sol', '--effort', 'high', '--brief', briefPath,
    '--idempotency-key', key,
  ];
}

beforeAll(async () => {
  mkdirSync(path.dirname(fakeCodex), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', remotePath]);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(path.join(repoPath, 'README.md'), 'lead handoff fixture\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-qm', 'test: seed lead fixture']);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remotePath]);
  execFileSync('git', ['-C', repoPath, 'push', '-qu', 'origin', 'main']);
  writeFileSync(briefPath, JSON.stringify({
    objective: 'Own this bounded task through worker review and terminal handback.',
    scope: ['The isolated fixture repository.'],
    doneTests: ['The deterministic provider reply is persisted.'],
    nonGoals: ['No production mutation.'],
    budgets: ['No external API spend.'],
    escalationCriteria: ['Escalate only when operator authority is required.'],
  }), 'utf8');
  writeFileSync(fakeCodex, fakeCodexScript, 'utf8');
  chmodSync(fakeCodex, 0o755);
  process.env.O8_TEST_REVIEW_HELPER = reviewWorkerHelper;
  process.env.O8_TEST_CONNECTED_WORKER_FILE = workerCapturePath;
  process.env.O8_TEST_WORKER_MARKERS = workerMarkersPath;
  process.env.O8_TEST_REVIEW_FILE = reviewCapturePath;
  process.env.O8_TEST_DISPATCH_DEBUG_FILE = dispatchDebugPath;
  process.env.O8_TEST_SOURCE_ROOT = process.cwd();
  process.env.O8_TEST_TARGET_REPO = repoPath;
  process.env.O8_TEST_DISPATCH_READY_FILE = dispatchReadyPath;
  process.env.O8_TEST_WORKER_RETURN_READY_FILE = workerReturnReadyPath;
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], { cwd: process.cwd(), stdio: 'ignore' });

  apiServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/panel/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    if (requestUrl.pathname === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }
    if (requestUrl.pathname === '/api/setup/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    if (requestUrl.pathname !== '/api/orchestrator/lead') { response.writeHead(404).end(); return; }
    const body = await readBody(request);
    const nextRequest = new NextRequest(`http://127.0.0.1${requestUrl.pathname}${requestUrl.search}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: body || undefined,
    });
    await writeRouteResponse(response, request.method === 'GET'
      ? await leadRoute.GET(nextRequest)
      : await leadRoute.POST(nextRequest));
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('lead fixture server did not bind');
  apiPort = address.port;
  process.env.O8_API_PORT = String(apiPort);
  wsPort = await freePort();
  process.env.O8_WS_PORT = String(wsPort);
  // Exercise the runtime's explicit environment allowlist for this isolated fake provider.
  // Keep filtering enabled and keep fixture credentials out of the executable.
  process.env.O8_WORKER_ENV_ALLOW = [
    ...Object.keys(originalEnv).filter(key => key.startsWith('O8_TEST_')),
    'O8_WORKER_ENV_ALLOW',
  ].join(',');
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_DEFAULT_DISPATCH_RUNTIME: 'codex',
      O8_SUBSCRIPTION_PROFILE: 'both',
      O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_WORKER_SANDBOX: '0',
      O8_WORKTREE_ROOT: path.join(dataDir, 'worktrees'),
      O8_APFS_COW_WORKSPACES: '0',
      O8_APFS_DEPENDENCY_IMAGES: '0',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { wsOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { wsOutput += String(chunk); });
  await waitForWsOutput('WebSocket server listening');
}, 60_000);

afterAll(async () => {
  __resetLeadRuntimeForTests();
  if (wsProcess?.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => error ? reject(error) : resolveClose());
  });
  closeDb();
  if (!retainDiagnosticFixture) rmSync(testHome, { recursive: true, force: true });
  for (const [key, previous] of Object.entries(originalEnv)) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('persistent lead handoff real path', () => {
  it('drives actual CLI, authenticated route, provider process, and persisted resume pins', async () => {
    const started = await runCli(startArgs('lead-start-main'));
    expect(started.exitCode, started.stderr).toBe(0);
    const startReceipt = JSON.parse(started.stdout) as LeadCliReceipt;
    const first = await settled(startReceipt.lead.id);
    expect(first.lead, JSON.stringify(first)).toMatchObject({
      id: startReceipt.lead.id,
      threadId: startReceipt.lead.threadId,
      status: 'completed',
      routing: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    });
    const follow = await runCli([
      'lead', 'send', first.lead.id, '--message', 'Continue with the same persistent lead.',
      '--idempotency-key', 'lead-follow-main',
    ]);
    expect(follow.exitCode, follow.stderr).toBe(0);
    await settled(first.lead.id);

    const calls = readArgs();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('model=gpt-5.6-sol');
    expect(calls[0]).toContain('model_reasoning_effort=high');
    expect(calls[1].slice(0, 3)).toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);
    expect(calls[1]).toContain('model=gpt-5.6-sol');
    expect(calls[1]).toContain('model_reasoning_effort=high');
    expect(readOrchestratorThreadMessages(first.lead.threadId).map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);

    const repeatedStart = await runCli(startArgs('lead-start-main'));
    expect(repeatedStart.exitCode, repeatedStart.stderr).toBe(0);
    expect((JSON.parse(repeatedStart.stdout) as LeadCliReceipt).lead.id).toBe(first.lead.id);
    expect(readArgs()).toHaveLength(2);

    const duplicate = await runCli([
      'lead', 'send', first.lead.id, '--message', 'Continue with the same persistent lead.',
      '--idempotency-key', 'lead-follow-main',
    ]);
    expect(duplicate.exitCode, duplicate.stderr).toBe(0);
    expect((JSON.parse(duplicate.stdout) as LeadCliReceipt).admittedTurnId)
      .toBe((JSON.parse(follow.stdout) as LeadCliReceipt).admittedTurnId);
    expect(readArgs()).toHaveLength(2);
  }, 20_000);

  it('serializes simultaneous sends and retrieves results after client loss and runtime reset', async () => {
    const current = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const [left, right] = await Promise.all([
      runCli(['lead', 'send', current.id, '--message', '[fixture:slow-left-2541]', '--idempotency-key', 'parallel-left']),
      runCli(['lead', 'send', current.id, '--message', '[fixture:right-2541]', '--idempotency-key', 'parallel-right']),
    ]);
    expect(left.exitCode, left.stderr).toBe(0);
    expect(right.exitCode, right.stderr).toBe(0);
    await settled(current.id);
    const calls = readArgs();
    expect(calls).toHaveLength(4);
    expect(new Set(calls.slice(2).map((args) => args.at(-1)?.includes('[fixture:slow-left-2541]') ? 'left' : 'right')))
      .toEqual(new Set(['left', 'right']));

    const lost = await runCli([
      'lead', 'send', current.id, '--message', 'client may disconnect after admission',
      '--idempotency-key', 'lost-client',
    ]);
    expect(lost.exitCode, lost.stderr).toBe(0);
    await settled(current.id);
    const statusBeforeRestart = getLeadStatus(current.id);
    expect(readOrchestratorBackendSessionId(statusBeforeRestart.lead.threadId, 'codex'))
      .toBe('fixture-persistent-lead-thread');
    const callsBeforeRestart = readArgs().length;
    const resumed = spawn(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx',
      '--input-type=module',
      '--eval',
      `const lifecycle = (await import('./src/lib/orchestrator/lead-lifecycle.ts')).default;
       lifecycle.sendLead({ leadId: process.env.O8_TEST_LEAD_ID, message: 'fresh process resume', idempotencyKey: 'fresh-process-resume' });
       const deadline = Date.now() + 10000;
       let cursor = 0;
       while (Date.now() < deadline) {
         const receipt = await lifecycle.waitForLead({ leadId: process.env.O8_TEST_LEAD_ID, afterCursor: cursor, waitMs: 250 });
         cursor = receipt.cursor;
         if (['completed', 'blocked', 'needs_approval', 'failed', 'stopped'].includes(receipt.lead.status)) {
           if (receipt.lead.status !== 'completed') throw new Error('fresh process lead ended ' + receipt.lead.status);
           process.exit(0);
         }
       }
       throw new Error('fresh process lead timed out');`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, O8_TEST_LEAD_ID: current.id },
      stdio: 'pipe',
      timeout: 15_000,
    });
    const [resumeCode] = await once(resumed, 'exit') as [number | null];
    expect(resumeCode).toBe(0);
    expect(readArgs()).toHaveLength(callsBeforeRestart + 1);
    expect(readArgs().filter((args) => args[0] === 'exec').at(-1)?.slice(0, 3))
      .toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);
    __resetLeadRuntimeForTests();
    const reattached = await runCli(['lead', 'status', current.id]);
    expect(reattached.exitCode, reattached.stderr).toBe(0);
    expect((JSON.parse(reattached.stdout) as LeadCliReceipt).lead.status).toBe('completed');
  }, 20_000);

  it('shares atomic admission across live route processes without stealing a live owner', async () => {
    const second = await startSecondRouteServer();
    try {
      const [left, right] = await Promise.all([
        runCli(startArgs('cross-process-start')),
        runCli(startArgs('cross-process-start'), second.port),
      ]);
      expect(left.exitCode, left.stderr).toBe(0);
      expect(right.exitCode, `${right.stderr}\n${second.output()}`).toBe(0);
      const a = JSON.parse(left.stdout) as LeadCliReceipt;
      const b = JSON.parse(right.stdout) as LeadCliReceipt;
      expect(b.lead.id).toBe(a.lead.id);
      expect(getSqlite().prepare(
        'SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?',
      ).get(a.lead.id)).toEqual({ count: 1 });
      await settled(a.lead.id);
      getSqlite().prepare('DELETE FROM orchestrator_lead_turns WHERE lead_id = ?').run(a.lead.id);
      const repaired = await runCli(startArgs('cross-process-start'), second.port);
      expect(repaired.exitCode, repaired.stderr).toBe(0);
      expect(getSqlite().prepare(
        'SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?',
      ).get(a.lead.id)).toEqual({ count: 1 });
      await settled(a.lead.id);
      const callsBefore = readArgs().length;
      const prior = await runCli([
        'lead', 'send', a.lead.id, '--message', '[fixture:slow-left-2541] prior turn',
        '--idempotency-key', 'cross-process-prior',
      ]);
      await vi.waitFor(() => expect(getLeadStatus(a.lead.id).lead.status).toBe('running'));
      const slow = await runCli([
        'lead', 'send', a.lead.id, '--message', '[fixture:hang] cross-process owner',
        '--idempotency-key', 'cross-process-live-owner',
      ]);
      expect(slow.exitCode, slow.stderr).toBe(0);
      const priorDone = await runCli(['lead', 'wait', a.lead.id, '--turn',
        (JSON.parse(prior.stdout) as LeadCliReceipt).admittedTurnId!, '--timeout', '10s']);
      expect((JSON.parse(priorDone.stdout) as LeadCliReceipt).lead.status).not.toBe('completed');
      expect((JSON.parse(priorDone.stdout) as LeadCliReceipt).lead.result).toBeNull();
      await vi.waitFor(() => expect(readArgs()).toHaveLength(callsBefore + 2), { timeout: 5_000 });
      const status = await fetch(`http://127.0.0.1:${second.port}/api/orchestrator/lead?leadId=${a.lead.id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await status.json() as LeadCliReceipt).lead.status).toBe('running');
      await runCli(['lead', 'stop', a.lead.id, '--reason', 'cross-process proof complete']);
    } finally {
      if (second.child.exitCode === null) {
        second.child.kill('SIGTERM');
        await once(second.child, 'exit');
      }
    }
  }, 30_000);

  it('fails mismatched routing before admission or provider side effects', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const turnCount = (getSqlite().prepare('SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?').get(lead.id) as { count: number }).count;
    const callCount = readArgs().length;
    const mismatch = await runCli([
      'lead', 'send', lead.id, '--message', 'must not persist', '--idempotency-key', 'wrong-binding',
      '--thread-id', 'thoughts-other',
    ]);
    expect(mismatch.exitCode).toBe(5);
    expect((getSqlite().prepare('SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?').get(lead.id) as { count: number }).count).toBe(turnCount);
    expect(readArgs()).toHaveLength(callCount);

    const invalid = await runCli(startArgs('invalid-model').map((part) => part === 'gpt-5.6-sol' ? 'claude-opus-5' : part));
    expect(invalid.exitCode).toBe(1);
    expect(getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'invalid-model'`).get()).toBeUndefined();
    expect(readArgs()).toHaveLength(callCount);
  });

  it('rejects semantic idempotency conflicts while replaying an unchanged admission', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const callsBefore = readArgs().length;
    const input = {
      leadId: lead.id,
      message: 'Preserve this exact durable request.',
      displayMessage: 'Visible durable request.',
      permissionMode: 'full' as const,
      idempotencyKey: 'semantic-idempotency-replay',
    };
    const admitted = sendLead(input);
    const replayed = sendLead(input);
    expect(replayed.admittedTurnId).toBe(admitted.admittedTurnId);
    expect(() => sendLead({ ...input, permissionMode: 'plan' as const })).toThrow(/idempotency key/i);
    expect(getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns
      WHERE lead_id = ? AND idempotency_key = 'semantic-idempotency-replay'
    `).get(lead.id)).toEqual({ count: 1 });
    expect(readArgs()).toHaveLength(callsBefore);
    await settled(lead.id);
    expect(readArgs()).toHaveLength(callsBefore + 1);
  }, 10_000);

  it('returns live supervisor context once and consumes it after the lead stops', async () => {
    const started = await runCli(startArgs('live-supervisor-return'));
    const receipt = JSON.parse(started.stdout) as LeadCliReceipt;
    await settled(receipt.lead.id);
    const sourceTurnId = receipt.admittedTurnId!;
    const mission = await createMission({
      issues: [{ number: 2541, title: 'Live context fixture', body: 'No exit receipt.', url: '' }],
      repoPath, runtime: 'codex', constraints: '', orchestratorThreadId: receipt.lead.threadId,
      orchestratorTurnId: `lead-assistant-${sourceTurnId}`,
    });
    const packet = mission.packets[0];
    const lane = createLane({
      repoPath, branch: 'live-supervisor-context', runtime: 'codex', packetId: packet.id,
      sessionKey: 'fixture-live-supervisor-context', label: 'Live context fixture',
    });
    updateLane(lane.id, { status: 'running' }, 'system', { reason: 'fixture live worker' });
    const message = '[SUPERVISOR] Agent "fixture" (fixture-live-supervisor-context) — STUCK for 1s';
    const operatorTurnCount = (getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND kind = 'operator'
    `).get(receipt.lead.id) as { count: number }).count;
    expect(queueLeadSupervisorReturn(repoPath, message)).toBe(true);
    expect(queueLeadSupervisorReturn(repoPath, message)).toBe(true);
    expect(getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND kind = 'operator'
    `).get(receipt.lead.id)).toEqual({ count: operatorTurnCount + 1 });
    const stopped = await runCli(['lead', 'stop', receipt.lead.id, '--reason', 'live supervisor return proof']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(queueLeadSupervisorReturn(repoPath, message)).toBe(true);
  }, 10_000);

  it('preserves an interrupted turn and requires an explicit recovery send', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const latest = getSqlite().prepare(
      'SELECT id FROM orchestrator_lead_turns WHERE lead_id = ? ORDER BY ordinal DESC LIMIT 1',
    ).get(lead.id) as { id: string };
    const deadOwner = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)']);
    const probe = probeMetadataLockProcessIdentitySync(deadOwner.pid!);
    expect(probe.state).toBe('live');
    deadOwner.kill('SIGTERM');
    await once(deadOwner, 'exit');
    getSqlite().prepare(`
      UPDATE orchestrator_lead_turns
      SET status = 'running', owner_pid = ?, owner_identity_json = ?, lease_token = 'dead-owner', finished_at = NULL
      WHERE id = ?
    `).run(deadOwner.pid, probe.state === 'live' ? JSON.stringify(probe.identity) : null, latest.id);
    getSqlite().prepare(
      `UPDATE orchestrator_leads SET status = 'running', current_turn_id = ? WHERE id = ?`,
    ).run(latest.id, lead.id);
    const recovered = getLeadStatus(lead.id);
    expect(recovered.lead.status).toBe('blocked');
    expect(recovered.latestTurn?.status).toBe('interrupted');
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', 'Recover explicitly after interruption.',
      '--idempotency-key', 'recover-interrupted',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    expect((await settled(lead.id)).lead.status).toBe('completed');
  }, 10_000);

  it('dispatches a real worker and returns its production review wake to the same lead', async () => {
    const started = await runCli(startArgs('dispatch-real-worker-start'));
    expect(started.exitCode, started.stderr).toBe(0);
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    expect((await settled(lead.id)).lead.status).toBe('completed');
    rmSync(workerCapturePath, { force: true });
    rmSync(workerMarkersPath, { force: true });
    rmSync(reviewCapturePath, { force: true });
    rmSync(dispatchReadyPath, { force: true });
    rmSync(workerReturnReadyPath, { force: true });
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:dispatch-worker]',
      '--idempotency-key', 'dispatch-real-worker',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    const waitedPromise = runCli(['lead', 'wait', lead.id, '--turn',
      (JSON.parse(sent.stdout) as LeadCliReceipt).admittedTurnId!, '--timeout', '40s']);
    const leadTurnId = (JSON.parse(sent.stdout) as LeadCliReceipt).admittedTurnId!;
    const [{ getOrCreateWsToken }, { resolvePortInfo }] = await Promise.all([
      import('@/lib/ws-auth'),
      import('@/lib/panel/api-port'),
    ]);
    const completionPushes: Array<{ url: string; status: number }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/supervisor/completed')) completionPushes.push({ url, status: response.status });
      return response;
    };
    expect(getOrCreateWsToken() === token).toBe(true);
    expect(resolvePortInfo().wsPort).toBe(wsPort);
    await addRepo(repoPath);
    const mission = await createMission({
      issues: [{ number: 92541, title: 'Persistent lead worker fixture', body: 'Write the deterministic proof file.', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
      sealedTaskContract: {
        version: 1,
        requirements: [{ id: 'R1', source: 'Write the deterministic proof file.',
          expectedBehavior: 'Commit the worker proof in lead-worker-proof.txt.',
          productionPath: 'lead-worker-proof.txt', verification: 'Read the committed proof file.' }],
        smallestRoute: [{ path: 'lead-worker-proof.txt', requirements: ['R1'], reason: 'The worker returns one proof file.' }],
        exclusions: ['No external provider calls.'],
      },
      orchestratorThreadId: lead.threadId,
      orchestratorTurnId: `lead-assistant-${leadTurnId}`,
    });
    await dispatchMission({ missionId: mission.missionId });
    const packetId = mission.packets[0].id;
    await vi.waitFor(() => expect(findLaneByPacket(packetId)?.sessionKey).toBeTruthy(), { timeout: 10_000 });
    const lane = findLaneByPacket(packetId)!;
    expect(lane.worktreePath).toBeTruthy();
    const proofPath = path.join(lane.worktreePath!, 'lead-worker-proof.txt');
    await vi.waitFor(() => expect(existsSync(proofPath)).toBe(true), { timeout: 10_000 });
    writeFileSync(workerCapturePath, JSON.stringify({
      missionId: mission.missionId,
      packetId,
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
      threadId: lead.threadId,
      turnId: `lead-assistant-${leadTurnId}`,
    }));
    writeFileSync(dispatchReadyPath, 'ready');
    await vi.waitFor(() => expect(getLeadStatus(lead.id).latestTurn?.status).toBe('waiting_workers'), { timeout: 5_000 });
    writeFileSync(workerReturnReadyPath, 'ready');
    await vi.waitFor(() => expect(existsSync(workerCapturePath)).toBe(true), { timeout: 20_000 });
    const waited = await waitedPromise;
    globalThis.fetch = originalFetch;
    if (waited.exitCode !== 0) {
      retainDiagnosticFixture = true;
    }
    expect(
      waited.exitCode,
      `${waited.stderr}\ncompletion pushes:\n${JSON.stringify(completionPushes)}\nstatus:\n${JSON.stringify(getLeadStatus(lead.id))}\nprovider calls:\n${JSON.stringify(readArgs())}\nworker:\n${existsSync(workerCapturePath) ? readFileSync(workerCapturePath, 'utf8') : '(missing)'}\nreview:\n${existsSync(reviewCapturePath) ? readFileSync(reviewCapturePath, 'utf8') : '(missing)'}\nws tail:\n${wsOutput.slice(-8_000)}`,
    ).toBe(0);
    const terminal = JSON.parse(waited.stdout) as LeadCliReceipt;
    expect(
      ['completed', 'needs_approval'],
      `${JSON.stringify(terminal)}\nreview:\n${existsSync(reviewCapturePath) ? readFileSync(reviewCapturePath, 'utf8') : '(missing)'}\nprovider calls:\n${JSON.stringify(readArgs())}\ndispatch:\n${existsSync(dispatchDebugPath) ? readFileSync(dispatchDebugPath, 'utf8') : '(missing)'}\nws tail:\n${wsOutput.slice(-4_000)}`,
    ).toContain(terminal.lead.status);
    expect(existsSync(workerCapturePath)).toBe(true);
    const worker = JSON.parse(readFileSync(workerCapturePath, 'utf8')) as {
      missionId: string;
      packetId: string;
      laneId: string;
      threadId: string;
      turnId: string;
    };
    expect(worker.threadId).toBe(lead.threadId);
    expect(worker.turnId).toBe((JSON.parse(sent.stdout) as LeadCliReceipt).admittedTurnId?.replace('lead-turn-', 'lead-assistant-lead-turn-'));
    expect(existsSync(reviewCapturePath)).toBe(true);
    const review = JSON.parse(readFileSync(reviewCapturePath, 'utf8')) as {
      packetId: string;
      review: { recorded: boolean; contractCoverage: { status: string } };
    };
    expect(review.packetId).toBe(worker.packetId);
    expect(review.review.recorded).toBe(true);
    expect(review.review.contractCoverage.status).toBe('passed');
    expect(terminal.lead.status).toBe('needs_approval');
    expect(readArgs().filter((args) => args[0] === 'exec').at(-1)?.slice(0, 3))
      .toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);

    const reviewCount = () => (getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND kind = 'review'
    `).get(lead.id) as { count: number }).count;
    const sameAttemptWatches = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ surfaceId: lane.sessionKey, repoPath, name: lane.label, prompt: 'duplicate' }),
    })));
    expect(sameAttemptWatches.map((response) => response.status)).toEqual([200, 200]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reviewCount()).toBe(1);
    expect(queueLeadReviewContinuation({
      repoPath, packetId: worker.packetId, laneId: worker.laneId, label: 'duplicate natural return',
    })).toBe(true);
    expect(reviewCount()).toBe(1);
    // Model a new admitted worker turn before its exit. A watch must not
    // resurrect an awaiting-review packet without new work admission.
    await withMissionRegistryState(worker.missionId, (state) => {
      const packet = state.packets.find(candidate => candidate.id === worker.packetId)!;
      packet.status = 'running';
      return { state, result: undefined };
    });
    updateLane(worker.laneId, { status: 'running' }, 'system', { reason: 'fixture successor admitted' });
    expect(findLaneByPacket(worker.packetId)?.status).toBe('running');
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState(state => {
      const packet = state.packets.find(candidate => candidate.id === worker.packetId);
      if (packet) {
        packet.status = 'running';
      }
    });

    appendEvent(worker.laneId, 'runtime_process_exit', 'system', {
      surfaceId: lane.sessionKey,
      runId: 'fixture-successor-finished-run',
      exitCode: 0,
      signal: null,
      classification: 'clean-exit',
      runtimeOutcome: 'finished',
    });
    const successorWatch = await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ surfaceId: lane.sessionKey, repoPath, name: lane.label, prompt: 'successor' }),
    });
    expect(successorWatch.status).toBe(200);
    await vi.waitFor(() => expect(reviewCount()).toBe(2), { timeout: 10_000 });
    expect((await settled(lead.id)).lead.status).toBe('needs_approval');

    updateLane(worker.laneId, { status: 'failed' }, 'system', { reason: 'retired test generation' });
    await withMissionRegistryState(worker.missionId, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === worker.packetId)!;
      packet.releaseState = 'released';
      packet.status = 'released';
      packet.releaseStatePayload = { source: 'test_release', releasedAt: new Date().toISOString() };
      return { state, result: undefined };
    });
    const released = await runCli([
      'lead', 'send', lead.id, '--message', 'Confirm released work is terminal.',
      '--idempotency-key', 'released-worker-terminal',
    ]);
    expect(released.exitCode, released.stderr).toBe(0);
    expect((await settled(lead.id)).lead.status).toBe('completed');
  }, 90_000);

  it('preserves legacy WS chat and governs persistent WS execution, display, permissions, and stop', async () => {
    const started = await runCli(startArgs('outcome-and-ws'));
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    await settled(lead.id);
    const missing = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:no-outcome]', '--idempotency-key', 'no-outcome',
    ]);
    expect(missing.exitCode, missing.stderr).toBe(0);
    const missingDone = await runCli(['lead', 'wait', lead.id, '--turn',
      (JSON.parse(missing.stdout) as LeadCliReceipt).admittedTurnId!, '--timeout', '1s']);
    expect(missingDone.exitCode).toBe(7);
    expect((JSON.parse(missingDone.stdout) as LeadCliReceipt).lead.status).toBe('unreported');
    const errored = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:event-error]', '--idempotency-key', 'event-error',
    ]);
    expect(errored.exitCode, errored.stderr).toBe(0);
    const errorTurn = (JSON.parse(errored.stdout) as LeadCliReceipt).admittedTurnId!;
    expect((await runCli(['lead', 'wait', lead.id, '--turn', errorTurn, '--timeout', '10s'])).stdout)
      .toContain('fixture orchestrator event failed');

    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    const wsEvents: Array<Record<string, unknown>> = [];
    socket.on('message', (chunk) => { wsEvents.push(JSON.parse(String(chunk)) as Record<string, unknown>); });
    await once(socket, 'open');
    const legacyCalls = readArgs().length;
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId: 'thoughts-unbound-legacy',
      message: '[fixture:legacy-full] provider-only context', displayMessage: 'Legacy visible request.',
      backend: 'codex', model: 'gpt-5.6-sol', thinkingEffort: 'high', permissionMode: 'full',
      orchestrationMode: 'fleet',
    }));
    await vi.waitFor(() => expect(readArgs()).toHaveLength(legacyCalls + 1), { timeout: 10_000 });
    expect(readArgs().at(-1)?.at(-1)).toContain('[fixture:legacy-full] provider-only context');

    const payload = JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId: lead.threadId,
      clientMessageId: 'persistent-ws-send',
      message: '[fixture:wire-full] private execution directive\nVisible operator request.',
      displayMessage: 'Visible operator request.', backend: 'codex',
      model: 'gpt-5.6-sol', thinkingEffort: 'high', permissionMode: 'plan', orchestrationMode: 'fleet',
    });
    socket.send(payload);
    socket.send(payload);
    await vi.waitFor(() => expect(getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns
      WHERE lead_id = ? AND idempotency_key = 'ws:persistent-ws-send'
    `).get(lead.id)).toEqual({ count: 1 }), { timeout: 5_000 });
    await settled(lead.id);
    const persisted = getSqlite().prepare(`
      SELECT message, display_message, permission_mode FROM orchestrator_lead_turns
      WHERE lead_id = ? AND idempotency_key = 'ws:persistent-ws-send'
    `).get(lead.id) as { message: string; display_message: string; permission_mode: string };
    expect(persisted).toEqual({
      message: '[fixture:wire-full] private execution directive\nVisible operator request.',
      display_message: 'Visible operator request.',
      permission_mode: 'plan',
    });
    const providerCall = readArgs().at(-1)!;
    expect(providerCall).toContain('sandbox_mode=read-only');
    expect(providerCall.at(-1)).toContain('[fixture:wire-full] private execution directive');
    expect(readOrchestratorThreadMessages(lead.threadId).filter((entry) => entry.role === 'user').at(-1)?.content)
      .toBe('Visible operator request.');
    await vi.waitFor(() => expect(JSON.stringify(wsEvents)).toContain('"leadStatus":"completed"'), { timeout: 5_000 });
    expect(JSON.stringify(wsEvents)).toContain('"status":"ready"');

    const turnsBeforeAttachment = (getSqlite().prepare(
      'SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?',
    ).get(lead.id) as { count: number }).count;
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId: lead.threadId,
      clientMessageId: 'unsupported-attachment', message: 'Inspect image.',
      backend: 'codex', model: 'gpt-5.6-sol', thinkingEffort: 'high', permissionMode: 'plan',
      attachments: [{ dataUri: 'data:image/png;base64,AA==', name: 'proof.png' }],
    }));
    await vi.waitFor(() => expect(JSON.stringify(wsEvents)).toContain('Attachments are not supported'), { timeout: 5_000 });
    expect((getSqlite().prepare(
      'SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?',
    ).get(lead.id) as { count: number }).count).toBe(turnsBeforeAttachment);

    const stopStarted = await runCli(startArgs('ws-durable-stop'));
    const stopLead = (JSON.parse(stopStarted.stdout) as LeadCliReceipt).lead;
    await settled(stopLead.id);
    const callsBeforeStop = readArgs().length;
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId: stopLead.threadId,
      clientMessageId: 'ws-stop-running', message: '[fixture:hang] stop through WS',
      displayMessage: 'Stop through WS.', backend: 'codex', model: 'gpt-5.6-sol',
      thinkingEffort: 'high', permissionMode: 'full', orchestrationMode: 'fleet',
    }));
    await vi.waitFor(() => expect(getLeadStatus(stopLead.id).lead.status).toBe('running'), { timeout: 5_000 });
    await vi.waitFor(() => expect(readArgs()).toHaveLength(callsBeforeStop + 1), { timeout: 5_000 });
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId: stopLead.threadId,
      clientMessageId: 'ws-stop-queued', message: 'This queued turn must not drain.',
      backend: 'codex', model: 'gpt-5.6-sol', thinkingEffort: 'high', permissionMode: 'full',
    }));
    await vi.waitFor(() => expect(getLeadStatus(stopLead.id).queueDepth).toBe(1), { timeout: 5_000 });
    socket.send(JSON.stringify({
      type: 'orchestrator-interrupt', repoPath, threadId: stopLead.threadId,
      clientMessageId: 'ws-stop-command', backend: 'codex',
    }));
    await vi.waitFor(() => expect(getLeadStatus(stopLead.id).lead.status).toBe('stopped'), { timeout: 5_000 });
    expect(getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM orchestrator_lead_turns
      WHERE lead_id = ? AND status IN ('queued', 'running')
    `).get(stopLead.id)).toEqual({ count: 0 });
    expect(getSqlite().prepare(`
      SELECT status FROM orchestrator_lead_turns
      WHERE lead_id = ? AND idempotency_key = 'ws:ws-stop-queued'
    `).get(stopLead.id)).toEqual({ status: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(readArgs()).toHaveLength(callsBeforeStop + 1);
    expect(JSON.stringify(wsEvents)).toContain('"status":"stopped"');
    socket.terminate();
  }, 50_000);

  it('persists stop across runtime recovery and never relaunches', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const callsBeforeSend = readArgs().length;
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:hang] do not finish', '--idempotency-key', 'stop-hang',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).lead.status).toBe('running'), { timeout: 2_000 });
    await vi.waitFor(() => expect(readArgs()).toHaveLength(callsBeforeSend + 1), { timeout: 2_000 });
    const callsAtStop = readArgs().length;
    const [stopped, raced] = await Promise.all([
      runCli(['lead', 'stop', lead.id, '--reason', 'bounded stop proof']),
      runCli(['lead', 'send', lead.id, '--message', 'stop race', '--idempotency-key', 'stop-race']),
    ]);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect([0, 5]).toContain(raced.exitCode);
    expect((JSON.parse(stopped.stdout) as LeadCliReceipt).lead.status).toBe('stopped');
    expect(getLeadStatus(lead.id).queueDepth).toBe(0);
    __resetLeadRuntimeForTests();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getLeadStatus(lead.id).lead.status).toBe('stopped');
    expect(readArgs()).toHaveLength(callsAtStop);
    const stoppedWorker = JSON.parse(readFileSync(workerCapturePath, 'utf8')) as { packetId: string; laneId: string };
    const turnsAtStop = getLeadStatus(lead.id).latestTurn?.ordinal;
    expect(queueLeadReviewContinuation({
      repoPath,
      packetId: stoppedWorker.packetId,
      laneId: stoppedWorker.laneId,
      label: 'stopped review return',
    })).toBe(true);
    expect(getLeadStatus(lead.id).latestTurn?.ordinal).toBe(turnsAtStop);
    expect(readArgs()).toHaveLength(callsAtStop);
    const refused = await runCli([
      'lead', 'send', lead.id, '--message', 'must not auto-resume', '--idempotency-key', 'after-stop',
    ]);
    expect(refused.exitCode).toBe(5);
    expect(readArgs()).toHaveLength(callsAtStop);
  }, 10_000);

  it('keeps the new route operator-only and rejects malformed waits without side effects', async () => {
    const worker = panelGateMiddleware(new NextRequest('http://localhost:3001/api/orchestrator/lead', {
      method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'x-o8-worker-packet-id': 'packet-worker' },
    }));
    expect(worker.status).toBe(403);
    const operator = panelGateMiddleware(new NextRequest('http://localhost:3001/api/orchestrator/lead', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }));
    expect(operator.status).toBe(200);

    const countsBefore = getSqlite().prepare(`
      SELECT
        (SELECT COUNT(*) FROM orchestrator_leads) AS leads,
        (SELECT COUNT(*) FROM orchestrator_lead_turns) AS turns,
        (SELECT COUNT(*) FROM orchestrator_lead_events) AS events
    `).get();
    const leadId = (getSqlite().prepare(
      `SELECT id FROM orchestrator_leads WHERE start_key = 'outcome-and-ws'`,
    ).get() as { id: string }).id;
    const malformedSend = await fetch(`http://127.0.0.1:${apiPort}/api/orchestrator/lead`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send', leadId, message: 'reject me', idempotencyKey: 'bad-type', model: 7 }),
    });
    expect(malformedSend.status).toBe(400);
    const malformed = await fetch(
      `http://127.0.0.1:${apiPort}/api/orchestrator/lead?leadId=unused&waitMs=1x`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_lead_wait' },
    });
    expect(getSqlite().prepare(`
      SELECT
        (SELECT COUNT(*) FROM orchestrator_leads) AS leads,
        (SELECT COUNT(*) FROM orchestrator_lead_turns) AS turns,
        (SELECT COUNT(*) FROM orchestrator_lead_events) AS events
    `).get()).toEqual(countsBefore);
  });
  it('includes the structured outcome in the caller handback receipt', async () => {
    const started = await runCli(startArgs('outcome-receipt'));
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    const completed = await settled(lead.id);
    expect(readFileSync(fakeCodex, 'utf8')).toBe(fakeCodexScript);
    expect(completed.lead.result).toMatchObject({
      outcome: { kind: 'completed', summary: expect.any(String), evidence: expect.any(Array) },
    });
  });

  it('requires a turn outcome before handback and clears it on more work', async () => {
    const started = await runCli(startArgs('turn-outcome-required'));
    expect(started.exitCode, started.stderr).toBe(0);
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    const completed = await settled(lead.id);
    expect(completed.lead.status).toBe('completed');
    const sent = await runCli(['lead', 'send', lead.id, '--message', '[fixture:no-outcome]',
      '--idempotency-key', 'missing-report']);
    expect(sent.exitCode, sent.stderr).toBe(0);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).latestTurn?.status).toBe('unreported'), { timeout: 5_000 });
    const status = await runCli(['lead', 'status', lead.id]);
    expect(JSON.parse(status.stdout)).toMatchObject({ lead: { status: 'unreported', result: {
      outcome: null, error: null, reason: 'turn ended without an outcome report',
    } } });
    const waited = await runCli(['lead', 'wait', lead.id, '--timeout', '1s']);
    expect(waited.exitCode).toBe(7);
    expect(waited.stderr).toContain('unreported: turn ended without an outcome report');
    expect(JSON.parse(waited.stdout).requestedTurn).toMatchObject({
      id: JSON.parse(sent.stdout).admittedTurnId, status: 'unreported', error: null,
      reason: 'turn ended without an outcome report',
    });
    const terminalWait = await leadRoute.GET(new NextRequest(
      `http://localhost/api/orchestrator/lead?leadId=${lead.id}&afterCursor=${JSON.parse(status.stdout).cursor}&waitMs=30000`,
      { headers: { authorization: `Bearer ${token}` } },
    ));
    expect(await terminalWait.json()).toMatchObject({ requestedTurn: { status: 'unreported', error: null } });
    const late = await runCli(['lead', 'report', lead.id, '--turn', JSON.parse(sent.stdout).admittedTurnId,
      '--repo', repoPath, '--thread-id', lead.threadId, '--kind', 'completed', '--summary', 'Late',
      '--evidence', '["late evidence"]']);
    expect(late.exitCode).toBe(5);
    expect(late.stderr).toContain('Only the active lead turn');
    const more = await runCli(['lead', 'send', lead.id, '--message', '[fixture:hang]',
      '--idempotency-key', 'more-work']);
    expect(more.exitCode, more.stderr).toBe(0);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).lead.status).toBe('running'));
    expect(getLeadStatus(lead.id).lead.result).toBeNull();
    await runCli(['lead', 'stop', lead.id]);
  }, 20_000);


  it.each([
    ['failed', 'blocked'], ['awaiting_human', 'needs_approval'], ['running', 'waiting_workers'], ['reviewing', 'blocked'],
  ] as const)('preserves %s worker obligations without a lead report', async (workerStatus, expected) => {
    const started = await runCli(startArgs(`obligation-${workerStatus}`));
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    await settled(lead.id);
    const mission = await createMission({
      issues: [{ number: 6040, title: 'Worker obligation', body: 'Keep the obligation visible.', url: '' }],
      repoPath, runtime: 'codex', constraints: '', orchestratorThreadId: lead.threadId,
    });
    const lane = createLane({ repoPath, branch: `obligation-${workerStatus}`, runtime: 'codex',
      packetId: mission.packets[0].id, sessionKey: `obligation-${workerStatus}`, label: 'Obligation' });
    updateLane(lane.id, { status: 'running' }, 'system');
    if (workerStatus !== 'running') updateLane(lane.id, { status: workerStatus }, 'system');
    await runCli(['lead', 'send', lead.id, '--message', '[fixture:no-outcome]',
      '--idempotency-key', `missing-${workerStatus}`]);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).latestTurn?.status).toBe(expected), { timeout: 5_000 });
    if (workerStatus === 'reviewing') {
      const waited = await runCli(['lead', 'wait', lead.id, '--timeout', '1s']);
      expect(waited.exitCode, waited.stderr).toBe(0);
      expect(JSON.parse(waited.stdout).requestedTurn.status).toBe('blocked');
    }
    await runCli(['lead', 'stop', lead.id]);
  }, 20_000);

  it.each(['completed', 'waiting_workers', 'needs_context', 'needs_approval', 'blocked'].flatMap(kind => [
    { kind, workers: ['reviewing'], expected: 'blocked', scenario: 'reviewing' },
    { kind, workers: ['failed', 'running'], expected: 'waiting_workers', scenario: 'failed plus running' },
    { kind, workers: ['failed', 'awaiting_human'], expected: 'needs_approval', scenario: 'failed plus approval' },
  ]))('reported turns retain origin/main classification: $kind / $scenario', async ({ kind, workers, expected }) => {
    const started = await runCli(startArgs(`main-parity-${kind}-${workers.join('-')}`));
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    await settled(lead.id);
    const mission = await createMission({
      issues: workers.map((_, index) => ({ number: 60400 + index, title: 'Classification parity', body: 'Keep the recorded outcome.', url: '' })),
      repoPath, runtime: 'codex', constraints: '', orchestratorThreadId: lead.threadId,
    });
    expect(mission.packets).toHaveLength(workers.length);
    for (const [index, status] of workers.entries()) {
      const lane = createLane({ repoPath, branch: `parity-${kind}-${index}`, runtime: 'codex',
        packetId: mission.packets[index].id, sessionKey: `parity-${lead.id}-${index}`, label: 'Parity worker' });
      updateLane(lane.id, { status: 'running' }, 'system');
      if (status !== 'running') updateLane(lane.id, { status: status as 'failed' | 'reviewing' | 'awaiting_human' }, 'system');
    }
    if (kind === 'completed' && workers.includes('running')) {
      const { runSilentExitTickForTesting } = await import('@/lib/supervisor/silent-exit-detector');
      await runSilentExitTickForTesting();
    }
    const sent = await runCli(['lead', 'send', lead.id, '--message', `[fixture:outcome:${kind}]`, '--idempotency-key', 'reported-parity']);
    expect(sent.exitCode, sent.stderr).toBe(0);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).latestTurn?.status).toBe(expected), { timeout: 5_000 });
    expect(getLeadStatus(lead.id).latestTurn?.outcome?.kind).toBe(kind);
    const waited = await runCli(['lead', 'wait', lead.id, '--timeout', '1s']);
    expect(waited.exitCode, waited.stderr).toBe(expected === 'waiting_workers' ? 6 : 0);
    expect(JSON.parse(waited.stdout).requestedTurn.status).toBe(expected);
    await runCli(['lead', 'stop', lead.id]);
  }, 20_000);

  it('only a no-outcome turn gives a failed worker precedence over a running worker', async () => {
    const started = await runCli(startArgs('unreported-mixed-workers'));
    const lead = (JSON.parse(started.stdout) as LeadCliReceipt).lead;
    await settled(lead.id);
    const mission = await createMission({ issues: [1, 2].map(number => ({ number, title: 'Mixed workers', body: 'Keep failure visible.', url: '' })),
      repoPath, runtime: 'codex', constraints: '', orchestratorThreadId: lead.threadId });
    for (const [index, packet] of mission.packets.entries()) {
      const lane = createLane({ repoPath, branch: `mixed-${index}`, runtime: 'codex', packetId: packet.id,
        sessionKey: `mixed-${lead.id}-${index}`, label: 'Mixed worker' });
      updateLane(lane.id, { status: 'running' }, 'system');
      if (index === 0) updateLane(lane.id, { status: 'failed' }, 'system');
    }
    await runCli(['lead', 'send', lead.id, '--message', '[fixture:no-outcome]', '--idempotency-key', 'mixed-no-outcome']);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).latestTurn?.status).toBe('blocked'), { timeout: 5_000 });
    const waited = await runCli(['lead', 'wait', lead.id, '--timeout', '1s']);
    expect(waited.exitCode, waited.stderr).toBe(0);
    expect(JSON.parse(waited.stdout).requestedTurn.status).toBe('blocked');
    await runCli(['lead', 'stop', lead.id]);
  }, 20_000);

});
