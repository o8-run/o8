import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorBackendSetting, ThoughtsOperatorDefaults } from '@/components/desktop/thoughts/operator-defaults';

import { buildMobileOrchestratorSend } from '@/lib/mobile/orchestrator-wire';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

// #4899 admits a Codex effort only with model/list evidence; the fake codex cannot serve one.
vi.mock('@/lib/codex/service-tier-catalogue', async (original) => ({
  ...await original<typeof import('@/lib/codex/service-tier-catalogue')>(),
  getCodexSpeedCatalogue: async () => ({ models: { 'gpt-6.1-sol': [] }, reasoningEfforts: { 'gpt-6.1-sol': ['medium'] } }),
}));

const networkFetch = globalThis.fetch;
// Match addRepo's physical paths even when the temporary root is a symlink
// (for example /var on macOS), so registration cannot create a second repo id.
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-orchestrator-model-attribution-')));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DB_PATH = join(dataDir, 'cortex-ide.db');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');
const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');
const { buildOrchestratorSendPayload } = await import('@/components/desktop/thoughts/use-orchestrator-stream/send-payload');
const { resolveOrchestratorTurnOptions } = await import('@/components/desktop/thoughts/use-orchestrator-stream/resolve-turn-options');
const { prepareOrchestratorTurn } = await import('@/components/desktop/thoughts/use-orchestrator-stream/turn-option-resolution');
const { mapHistoryMessagesToTranscript } = await import('@/components/desktop/thoughts/history-transcript');
const { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK } = await import('@/components/desktop/thoughts/operator-defaults');
const { composerBackendTurnOverride, resolveFreshComposerTurnOptions } = await import('@/components/desktop/thoughts/useBackendSwitchChoice');
const originPath = join(dataDir, 'origin.git');
const seedPath = join(dataDir, 'seed');
const repoPath = join(dataDir, 'repo');
const token = 'orchestrator-model-attribution-token';
const promptCapturePath = join(dataDir, 'turn-prompt.txt');
const workerCapturePath = join(dataDir, 'turn-worker.json');
const continuationCapturePath = join(dataDir, 'review-continuations.jsonl');
const connectedWorkerHelper = `
  import { readFileSync, writeFileSync } from 'node:fs';
  const repos = (await import('./src/lib/repos/registry.ts')).default;
  const controlPlane = (await import('./src/lib/orchestrator/control-plane.ts')).default;
  const laneRegistry = (await import('./src/lib/lane/registry.ts')).default;
  const runtimeCapabilities = (await import('./src/lib/orchestrator/runtime-capabilities.ts')).default;
  const chatHistory = (await import('./src/lib/llm/chat-history-store.ts')).default;
  const projects = (await import('./src/lib/projects/store.ts')).default;
  const repo = await repos.addRepo(process.env.O8_TEST_TARGET_REPO);
  // Mission creation needs the client's selected project and authoritative
  // membership. Keep this separate from the virtual/name-collision fixture.
  const project = projects.createProject({ name: 'Connected receipt ' + process.env.O8_TEST_TURN_ID });
  projects.addRepoToProject(project.id, repo.id, null, 'manual');
  const rpc = async (name, args) => {
    const response = await fetch('http://127.0.0.1:' + process.env.O8_API_PORT + '/api/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readFileSync(process.env.O8_DATA_DIR + '/ws-token', 'utf8').trim() },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
    });
    const reply = await response.json();
    if (!response.ok || reply.error || reply.result?.isError) throw new Error('Registered mission call failed: ' + JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  const mission = await rpc('create_mission', {
    issues_inline: [{ title: 'Connected receipt fixture', body: 'Write FIRST_RUN.txt and commit it.' }],
    dispatch: false, model: 'gpt-6.1-sol', requestedEffort: 'medium',
    repoPath: process.env.O8_TEST_TARGET_REPO,
    projectId: project.id,
    runtime: 'codex',
    constraints: '',
    orchestratorThreadId: process.env.O8_TEST_THREAD_ID,
    orchestratorTurnId: process.env.O8_TEST_TURN_ID,
  });
  await rpc('dispatch_mission', { missionId: mission.missionId });
  const packetId = mission.packets[0].id;
  const deadline = Date.now() + 15_000;
  let packet;
  let lane;
  let history;
  let storedTurn;
  let pendingWorkers;
  let receiptWorkers;
  while (Date.now() < deadline) {
    packet = controlPlane.readOrchestratorControlPlaneState().packets.find((row) => row.id === packetId);
    lane = laneRegistry.listLanes(new Set([packetId]))[0];
    history = chatHistory.readPersistedLlmChat(process.env.O8_TEST_THREAD_ID)?.history;
    storedTurn = history?.messages.find((message) => message.id === process.env.O8_TEST_TURN_ID);
    pendingWorkers = history?.pendingTurnWorkers?.[process.env.O8_TEST_TURN_ID];
    receiptWorkers = storedTurn?.receipt?.workers;
    const launchCompleted = Boolean(lane?.sessionKey)
      || Boolean(packet && packet.status !== 'queued' && packet.status !== 'launching');
    const workerLanded = [...(pendingWorkers ?? []), ...(receiptWorkers ?? [])]
      .some((worker) => worker.packetId === packetId);
    if (launchCompleted && workerLanded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!lane || ![...(pendingWorkers ?? []), ...(receiptWorkers ?? [])].some((worker) => worker.packetId === packetId)) {
    throw new Error(
      'Timed out waiting for the connected worker receipt after launch completion. '
      + 'packet=' + (packet?.status ?? 'missing') + ' lane=' + (lane?.status ?? 'missing'),
    );
  }
  if (packet?.projectId !== project.id) throw new Error('Mission did not persist the selected project.');
  writeFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, JSON.stringify({
    packetId,
    runtime: lane.runtime,
    model: lane.model ?? runtimeCapabilities.getRuntimeCapability(lane.runtime).defaultModel,
    turnId: process.env.O8_TEST_TURN_ID,
    packetThreadId: packet?.orchestratorThreadId,
    packetTurnId: packet?.orchestratorTurnId,
    landedVia: (pendingWorkers ?? []).some((worker) => worker.packetId === packetId)
      ? 'pending buffer'
      : 'direct merge',
    immediatePending: pendingWorkers,
    immediateWorkers: receiptWorkers,
  }));
  process.exit(0);
`;
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
let serverOutput = '';
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');

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

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${serverOutput.slice(-2_000)}\n${serverOutput.split('\n').filter(line => /supervisor|completion|review-continuation/.test(line)).slice(-35).join('\n')}`);
}

async function persistDefaults(orchestratorModel: string, orchestratorBackend: 'claude' | 'codex') {
  const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestratorModel, orchestratorBackend }),
  }));
  expect(response.ok).toBe(true);
}

async function submitComposerTurn(
  socket: WebSocket,
  threadId: string,
  capturedModel: string,
  capturedBackend: OrchestratorBackendSetting,
  options: {
    thinkingEffort?: ThinkingEffort;
    orchestrationMode?: OrchestratorExecutionMode;
    pickedMode?: ComposerWireMode;
    message?: string;
  } = {},
) {
  let displayedModel = capturedModel;
  let displayedBackend = capturedBackend;
  let displayedDefaults: ThoughtsOperatorDefaults = THOUGHTS_OPERATOR_DEFAULTS_FALLBACK;
  const backendSourceRef = { current: 'default' as const };
  const controller = new AbortController();
  const turnOptions = await resolveOrchestratorTurnOptions({
    model: capturedModel,
    backend: composerBackendTurnOverride(capturedBackend),
    thinkingEffort: options.thinkingEffort,
    orchestrationMode: options.orchestrationMode,
    pickedMode: options.pickedMode,
    resolveTurnOptions: (signal) => resolveFreshComposerTurnOptions({
      repoPath,
      backend: capturedBackend,
      backendSourceRef,
      setBackend: (value) => { displayedBackend = typeof value === 'function' ? value(displayedBackend) : value; },
      setModel: (value) => { displayedModel = typeof value === 'function' ? value(displayedModel) : value; },
      setOperatorDefaults: (value) => { displayedDefaults = typeof value === 'function' ? value(displayedDefaults) : value; },
    }, signal),
  }, controller.signal);
  if (!turnOptions) throw new Error('Composer turn option resolution was cancelled.');
  const turn = prepareOrchestratorTurn(options.message ?? 'reply deterministically', turnOptions);
  if (options.message === 'dispatch connected receipt worker') rmSync(workerCapturePath, { force: true });
  socket.send(buildOrchestratorSendPayload({
    repoPath,
    threadId,
    clientMessageId: `${threadId}-client-message`,
    wireMessage: turn.wireMessage,
    displayMessage: turn.displayMessage,
    permissionMode: turn.permissionMode,
    orchestrationMode: turn.orchestrationMode,
    pickedMode: turn.pickedMode,
    thinkingEffort: turn.thinkingEffort,
    model: turn.model,
    backend: turn.backend,
  }));
  const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
  await waitFor(() => {
    try {
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages?: Array<{ role?: string; content?: string; receipt?: unknown }> };
      return history.messages?.some((entry) => (
        entry.role === 'assistant'
        && entry.content === ''
        && entry.receipt !== undefined
      )) ?? false;
    } catch {
      return false;
    }
  }, 'receipt-only assistant row before reply text');
  await waitFor(() => {
    try {
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages?: Array<{ role?: string; model?: string; content?: string; receipt?: unknown }> };
      return history.messages?.some((entry) => (
        entry.role === 'assistant'
        && entry.content === 'deterministic assistant reply'
        && (options.thinkingEffort === undefined || entry.receipt !== undefined)
      )) ?? false;
    } catch {
      return false;
    }
  }, 'persisted assistant attribution', options.message === 'dispatch connected receipt worker' ? 90_000 : 20_000);
  const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages: Array<{ id: string; role: string; model?: string }> };
  const assistant = history.messages.find((entry) => entry.role === 'assistant');
  const persisted = readPersistedLlmChat(threadId);
  const transcript = mapHistoryMessagesToTranscript(
    persisted?.history.messages ?? [],
    persisted?.history.pendingTurnWorkers,
  );
  return {
    displayedModel,
    displayedBackend,
    recordedModel: assistant?.model,
    recordedMessageId: assistant?.id,
    wirePrompt: readFileSync(promptCapturePath, 'utf8'),
    worker: existsSync(workerCapturePath)
      ? JSON.parse(readFileSync(workerCapturePath, 'utf8')) as {
          packetId: string;
          runtime: string;
          model: string;
          turnId: string;
          packetThreadId: string;
          packetTurnId: string;
          landedVia: 'pending buffer' | 'direct merge';
          immediatePending?: unknown;
          immediateWorkers?: unknown;
        }
      : null,
    threadId,
    receipt: transcript.find((entry) => entry.role === 'assistant')?.receipt,
  };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/panel/operator-defaults')) {
      return GET(new Request(`http://127.0.0.1${url}`));
    }
    return networkFetch(input, init);
  }));
  execFileSync('git', ['init', '--bare', originPath], { stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, seedPath], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: seedPath, stdio: 'pipe' });
  writeFileSync(join(seedPath, 'README.md'), 'turn receipt fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: seedPath });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test', 'commit', '-qm', 'fixture'], { cwd: seedPath });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedPath, stdio: 'pipe' });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: originPath, stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, repoPath], { stdio: 'pipe' });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({
    version: 1,
    repos: [
      { id: 'virtual-repo', name: 'repo', localPath: repoPath, addedAt: new Date().toISOString() },
      { id: 'collision-repo', name: 'seed', localPath: seedPath, addedAt: new Date().toISOString() },
    ],
  }));
  execFileSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval',
    `const store = (await import('./src/lib/projects/store.ts')).default;
     const project = store.createProject({ name: 'repo', description: 'SETTINGS_COLLISION_MARKER must never enter the virtual turn.' });
     store.addRepoToProject(project.id, 'collision-repo', 'fullstack');`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
    },
  });
  const fakeCodex = join(dataDir, 'fake-codex.mjs');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') { console.log('Logged in using fixture'); process.exit(0); }
if (process.argv.includes('--input-format')) {
  const { createInterface } = await import('node:readline');
  createInterface({input: process.stdin}).on('line', () => {
    console.log(JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'Deterministic fixture completion context.'}]}}));
    console.log(JSON.stringify({type: 'result', subtype: 'success', result: 'Deterministic fixture completion context.', is_error: false, usage: {input_tokens: 1, output_tokens: 1}}));
  });
  await new Promise(() => {});
}
if (process.argv.includes('--output-format')) {
  console.log(JSON.stringify({type: 'result', subtype: 'success', result: 'Deterministic fixture context.', is_error: false, usage: {input_tokens: 1, output_tokens: 1}}));
  process.exit(0);
}
const prompt = process.argv.join('\\n');
if (prompt.includes('[FLEET] Lane') && prompt.includes('reached review-ready') && !prompt.includes('thoughts-turn-worker-receipt-')) {
  appendFileSync(process.env.O8_TEST_CONTINUATION_CAPTURE, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + String.fromCharCode(10));
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'review-origin-fixture'}));
  console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'bounded continuation is running'}}));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (prompt.includes('Packet: Connected receipt fixture')) {
  const workCwd = process.argv[process.argv.indexOf('-C') + 1];
  writeFileSync(workCwd + '/FIRST_RUN.txt', 'owned review fixture\\n');
  spawnSync('git', ['add', 'FIRST_RUN.txt'], {cwd: workCwd});
  const commit = spawnSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test', 'commit', '-qm', 'fixture change'], {cwd: workCwd});
  if (commit.status !== 0) process.exit(1);
}
if (process.env.O8_TEST_TURN_PROMPT_FILE && prompt.includes('orchestratorThreadId:')) {
  writeFileSync(process.env.O8_TEST_TURN_PROMPT_FILE, prompt);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-thread' }));
if (prompt.includes('dispatch connected receipt worker') && !prompt.includes('Packet: Connected receipt fixture')) {
  const threadId = prompt.match(/orchestratorThreadId: "([^"]+)"/)?.[1];
  const turnId = prompt.match(/orchestratorTurnId: "([^"]+)"/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    '--input-type=module',
    '--eval',
    process.env.O8_TEST_CONNECTED_WORKER_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_THREAD_ID: threadId, O8_TEST_TURN_ID: turnId },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
await new Promise((resolve) => setTimeout(resolve, 150));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'deterministic assistant reply' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(fakeCodex, 0o755);
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  symlinkSync(fakeCodex, join(dataDir, 'bin', 'codex'));
  const { invalidateRuntimeAuthCache } = await import('@/lib/runtimes/shared/auth-detect');
  invalidateRuntimeAuthCache();
  apiPort = await freePort();
  wsPort = await freePort();
  vi.stubEnv('O8_WS_PORT', String(wsPort));
  writeFileSync(join(dataDir, 'ws-port'), String(wsPort));
  const { POST: createMissionPost } = await import('@/app/api/orchestrator/create-mission/route');
  const { POST: dispatchPost } = await import('@/app/api/orchestrator/dispatch/route');
  const { POST: mcpPost } = await import('@/app/api/mcp/route');
  const { panelGateMiddleware } = await import('@/middleware');
  for (const [key, value] of Object.entries({ O8_CODEX_BIN: fakeCodex, O8_CLAUDE_CODE_BIN: fakeCodex, O8_SKIP_PRELAUNCH_TYPECHECK: '1',
    O8_WORKER_SANDBOX: '0', O8_CRASH_SURVIVABLE_WORKERS: '0', O8_APFS_COW_WORKSPACES: '0',
    O8_APFS_DEPENDENCY_IMAGES: '0', O8_WORKTREE_ROOT: join(dataDir, 'worktrees'),
    CORTEX_IDE_OWNED_CODEX_ROOT: join(dataDir, 'owned-codex'), O8_OPERATOR_MCP_PROFILE: 'full' })) vi.stubEnv(key, value);
  apiServer = createServer(async (request, response) => {
    if (['/api/mcp', '/api/orchestrator/create-mission', '/api/orchestrator/dispatch'].includes(request.url ?? '')) {
      try {
        let body = ''; for await (const chunk of request) body += chunk.toString();
        const req = new NextRequest(`http://127.0.0.1:${apiPort}${request.url}`, {
          method: request.method, headers: request.headers as Record<string, string>, body,
        });
        const gate = panelGateMiddleware(req);
        const result = gate.status !== 200 ? gate : request.url === '/api/mcp' ? await mcpPost(req)
          : request.url === '/api/orchestrator/create-mission' ? await createMissionPost(req) : await dispatchPost(req);
        response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({error: String(error)})); }
      return;
    }
    if (request.url === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }
    if (request.url === '/api/panel/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ready: true})); return; }
    if (request.url === '/api/setup/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  writeFileSync(join(dataDir, 'api-port'), String(apiPort));
  vi.stubEnv('O8_API_PORT', String(apiPort));
  wsProcess = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_CODEX_BIN: fakeCodex,
      O8_CLAUDE_CODE_BIN: fakeCodex,
      O8_TEST_TURN_PROMPT_FILE: promptCapturePath,
      O8_TEST_CONTINUATION_CAPTURE: continuationCapturePath,
      O8_TEST_CONNECTED_WORKER_FILE: workerCapturePath,
      O8_TEST_CONNECTED_WORKER_HELPER: connectedWorkerHelper,
      O8_TEST_SOURCE_ROOT: process.cwd(),
      O8_TEST_TARGET_REPO: repoPath,
      // Children inherit only allowlisted names (#4585); the fake codex and its connected-worker
      // helper read these fixture knobs. No provider credential is listed.
      O8_WORKER_ENV_ALLOW: ['O8_TEST_TURN_PROMPT_FILE', 'O8_TEST_CONTINUATION_CAPTURE', 'O8_TEST_CONNECTED_WORKER_FILE',
        'O8_TEST_CONNECTED_WORKER_HELPER', 'O8_TEST_SOURCE_ROOT', 'O8_TEST_TARGET_REPO'].join(','),
      O8_DEFAULT_DISPATCH_RUNTIME: 'codex',
      O8_SUBSCRIPTION_PROFILE: 'both',
      O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_WORKER_SANDBOX: '0',
      O8_CRASH_SURVIVABLE_WORKERS: '0',
      O8_WORKTREE_ROOT: join(dataDir, 'worktrees'),
      O8_APFS_COW_WORKSPACES: '0',
      O8_APFS_DEPENDENCY_IMAGES: '0',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(() => serverOutput.includes('WebSocket server listening'), 'ws-server startup', 45_000);
  await waitFor(() => serverOutput.includes('[supervisor] Started'), 'supervisor callback registration', 60_000);
}, 90_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (existsSync(continuationCapturePath)) {
    for (const line of readFileSync(continuationCapturePath, 'utf8').trim().split('\n')) {
      try {
        const { pid } = JSON.parse(line) as { pid: number };
        const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {encoding: 'utf8'});
        if (args.includes(join(dataDir, 'fake-codex.mjs'))) process.kill(pid, 'SIGTERM');
      } catch { /* The owned fixture process already exited. */ }
    }
  }
  const { resetWarmReplPool } = await import('@/lib/claude-code/warm-repl-pool');
  resetWarmReplPool();
  if (wsProcess?.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) { apiServer.closeAllConnections(); await new Promise<void>((resolve) => apiServer.close(() => resolve())); }
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_DATA_DIR;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.CORTEX_IDE_DB_PATH;
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
});

describe('orchestrator model attribution through the real WebSocket turn handler', () => {
  it('rejects an unsupported image before accepting or persisting a text-only turn', async () => {
    const threadId = `thoughts-invalid-image-${Date.now()}`;
    const clientMessageId = `invalid-image-${Date.now()}`;
    const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    const events: Array<{ event?: string; data?: { error?: string; clientMessageId?: string } }> = [];
    socket.on('message', (chunk) => {
      events.push(JSON.parse(String(chunk)) as (typeof events)[number]);
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId, clientMessageId,
      message: 'Inspect this photo', displayMessage: 'Inspect this photo',
      backend: 'codex', orchestrationMode: 'single',
      attachments: [{ dataUri: 'data:image/heic;base64,aW1hZ2U=', name: 'photo.heic' }],
    }));
    await waitFor(() => events.some((event) => event.event === 'error'
      && event.data?.clientMessageId === clientMessageId), 'image rejection');
    expect(events.find((event) => event.event === 'error' && event.data?.clientMessageId === clientMessageId)?.data?.error)
      .toContain('PNG, JPEG, GIF, or WebP');
    expect(events.some((event) => event.event === 'send-ack' && event.data?.clientMessageId === clientMessageId)).toBe(false);
    expect(existsSync(historyPath)).toBe(false);
  }, 30_000);

  it('keeps a virtual repo project isolated through a real WebSocket send', async () => {
    const projectId = 'repo:virtual-repo';
    const threadId = `thoughts-virtual-ws-${Date.now()}`;
    const message = 'Work only in this single repo.';
    const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    const errors: string[] = [];
    let subscribed = false;
    socket.on('message', (chunk) => {
      const event = JSON.parse(String(chunk)) as { event?: string; data?: { error?: string } };
      if (event.event === 'error' && event.data?.error) errors.push(event.data.error);
      if (event.event === 'status') subscribed = true;
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend: 'codex' }));
    await waitFor(() => subscribed, 'virtual project thread subscription');
    socket.send(JSON.stringify({
      type: 'orchestrator-send', repoPath, threadId, projectId,
      message, displayMessage: message, backend: 'codex', model: 'gpt-5.6-sol',
      permissionMode: 'plan', orchestrationMode: 'fleet',
    }));

    await waitFor(() => existsSync(historyPath) || errors.length > 0, 'virtual project thread persistence');
    expect(errors).toEqual([]);
    const history = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      projectId: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(history.projectId).toBe(projectId);
    expect(history.messages.find((entry) => entry.role === 'user')?.content).toBe(message);
    await waitFor(() => existsSync(promptCapturePath) || errors.length > 0, 'virtual project prompt capture');
    expect(errors).toEqual([]);
    const prompt = readFileSync(promptCapturePath, 'utf8');
    expect(prompt).toContain('Main repo: repo');
    expect(prompt).not.toContain('SETTINGS_COLLISION_MARKER');
    const projectBrief = prompt.split('## Project Brief\n\n')[1]?.split('\n\n## Task')[0];
    expect(projectBrief).toContain(`Main repo: repo at ${repoPath}`);
    expect(projectBrief).not.toContain(seedPath);
  }, 30_000);

  it('records the freshly resolved default on the next real WebSocket turn', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const first = await submitComposerTurn(socket, `thoughts-model-attribution-a-${Date.now()}`, 'gpt-5.6-sol', 'codex');
    expect(first).toMatchObject({ displayedModel: 'gpt-5.6-sol', displayedBackend: 'codex', recordedModel: 'gpt-5.6-sol' });

    await persistDefaults('gpt-5.6-terra', 'codex');
    const second = await submitComposerTurn(socket, `thoughts-model-attribution-b-${Date.now()}`, 'gpt-5.6-sol', 'codex');
    expect(second).toMatchObject({ displayedModel: 'gpt-5.6-terra', displayedBackend: 'codex', recordedModel: 'gpt-5.6-terra' });
  }, 30_000);

  it.each([true, false])('keeps mobile attribution with a prior desktop turn: %s', async (hasPriorTurn) => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');
    await persistDefaults('gpt-5.6-sol', 'codex');
    const threadId = `thoughts-mobile-receipt-${hasPriorTurn}-${Date.now()}`;
    if (hasPriorTurn) await submitComposerTurn(socket, threadId, 'gpt-5.6-sol', 'codex', {
      orchestrationMode: 'fleet', pickedMode: 'fast', thinkingEffort: 'high',
    });
    const wire = buildMobileOrchestratorSend({ repoPath, threadId, backend: 'codex', agent: null, projectId: null },
      'mobile reply', `${threadId}-mobile`);
    socket.send(JSON.stringify(wire));
    socket.send(JSON.stringify(wire));
    await waitFor(() => {
      const rows = readPersistedLlmChat(threadId)?.history.messages.filter((row) => row.role === 'assistant') ?? [];
      return rows.length === (hasPriorTurn ? 2 : 1) && rows.at(-1)?.content === 'deterministic assistant reply';
    }, 'mobile reply persisted');
    const history = readPersistedLlmChat(threadId)!.history;
    const assistant = history.messages.filter((row) => row.role === 'assistant').at(-1)!;
    expect(assistant.receipt?.mode).toBe(hasPriorTurn ? 'fast' : 'multitask');
    if (hasPriorTurn) expect(assistant.model).toBe('gpt-5.6-sol');
    expect(assistant.model).toBeTruthy();
    expect(assistant.model).toBe(assistant.receipt?.leadModel);
    if (hasPriorTurn) {
      expect(assistant.receipt?.effort).toBe('high');
      expect(readFileSync(promptCapturePath, 'utf8')).toContain('[Mode: Shared] Work in the current checkout.');
    }
    expect(history.messages.filter((row) => row.role === 'user' && row.content === 'mobile reply')).toHaveLength(1);
    expect(history.repoPath).toBe(repoPath);
  }, 30_000);

  it('persists the effective model, effort, and mode through the desktop history reader', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-receipt-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      { thinkingEffort: 'high', orchestrationMode: 'fleet', pickedMode: 'multitask' },
    );

    expect(turn.receipt).toEqual({
      permissionMode: 'full', terminal: { userMessageId: `orch-user-${turn.threadId}-client-message`, outcome: 'completed', completedAt: expect.any(Number) },
      leadModel: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'multitask',
      pickedMode: 'multitask',
    });
    expect(turn.wirePrompt).toContain(`orchestratorThreadId: "${turn.threadId}"`);
    expect(turn.wirePrompt).toContain(`orchestratorTurnId: "${turn.recordedMessageId}"`);
  }, 30_000);

  it('persists the effective Fusion override and the picked Solo mode', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-receipt-override-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      { thinkingEffort: 'high', orchestrationMode: 'fusion', pickedMode: 'solo' },
    );

    expect(turn.receipt).toEqual({
      permissionMode: 'full', terminal: { userMessageId: `orch-user-${turn.threadId}-client-message`, outcome: 'completed', completedAt: expect.any(Number) },
      leadModel: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'fusion',
      pickedMode: 'solo',
    });
  }, 30_000);

  it('carries the sent turn ids through a real mission dispatch into the worker receipt', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-worker-receipt-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      {
        thinkingEffort: 'high',
        orchestrationMode: 'fleet',
        pickedMode: 'multitask',
        message: 'dispatch connected receipt worker',
      },
    );

    const expectedWorker = {
      packetId: turn.worker?.packetId,
      runtime: 'codex',
      model: turn.worker?.model,
    };
    expect(turn.worker).toMatchObject({
      ...expectedWorker,
      turnId: turn.recordedMessageId,
      packetThreadId: turn.threadId,
      packetTurnId: turn.recordedMessageId,
    });
    expect(turn.worker?.landedVia).toMatch(/^(pending buffer|direct merge)$/);
    expect([turn.worker?.immediatePending, turn.worker?.immediateWorkers]).toContainEqual([expectedWorker]);
    expect(turn.receipt?.workers).toEqual([expectedWorker]);
    console.log(`[turn-receipt-test] worker row landed via ${turn.worker?.landedVia}`);
  }, 120_000);
});


it('returns review-ready to the dispatching chat and its selected model, and Stop reaches that continuation', async () => {
  await persistDefaults('gpt-6.1-sol', 'codex');
  rmSync(continuationCapturePath, { force: true });
  const threadId = `thoughts-review-origin-${Date.now()}`;
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  const events: Array<{ event?: string; data?: Record<string, unknown> }> = [];
  socket.on('message', chunk => events.push(JSON.parse(String(chunk))));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend: 'codex' }));
  const result = await submitComposerTurn(socket, threadId, 'gpt-6.1-sol', 'codex', {
    thinkingEffort: 'medium', orchestrationMode: 'fleet', message: 'dispatch connected receipt worker',
  });
  expect(result.worker?.packetThreadId).toBe(threadId);
  const { getLaneEvents, listLanes } = await import('@/lib/lane/registry');
  const lane = listLanes(new Set([result.worker!.packetId]))[0];
  const sessionPath = join(dataDir, 'owned-codex', lane.sessionKey!.slice('codex-owned:'.length), 'session.json');
  await waitFor(() => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')).recentRuns[0].outcome === 'finished'; } catch { return false; }
  }, 'real worker exit persisted');
  const runId = JSON.parse(readFileSync(sessionPath, 'utf8')).recentRuns[0].id;
  const completion = await networkFetch(`http://127.0.0.1:${wsPort}/supervisor/completed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({surfaceId: lane.sessionKey, runId}),
  });
  expect(completion.status).toBe(200);
  expect(await completion.json()).toMatchObject({ok: true, ingested: true});

  await waitFor(() => existsSync(continuationCapturePath), 'real review-ready continuation', 90_000);
  const starts = readFileSync(continuationCapturePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(starts).toHaveLength(1);
  const started = starts[0] as { pid: number; argv: string[] };
  expect(started.argv.find(arg => arg.startsWith('model='))).toBe('model=gpt-6.1-sol');
  expect(started.argv.find(arg => arg.startsWith('model_reasoning_effort='))).toBe('model_reasoning_effort=medium');
  expect(started.argv.join(' ')).toContain(`orchestratorThreadId: "${threadId}"`);
  await waitFor(() => events.some(event => event.event === 'output' && event.data?.threadId === threadId
    && event.data?.text === 'bounded continuation is running'), 'same-chat continuation activity');
  const correlationId = `stop-review-${Date.now()}`;
  socket.send(JSON.stringify({ type: 'orchestrator-interrupt', repoPath, threadId, backend: 'codex', clientMessageId: correlationId }));
  await waitFor(() => events.some(event => event.event === 'interrupt-ack' && event.data?.clientMessageId === correlationId), 'registered Stop acknowledgement');
  expect(events.find(event => event.event === 'interrupt-ack' && event.data?.clientMessageId === correlationId)?.data?.interrupted).toBe(true);
  await waitFor(() => { try { process.kill(started.pid, 0); return false; } catch { return true; } }, 'continuation process exit');
  await waitFor(() => getLaneEvents(lane.id).some(event => event.payload.event === 'chat_review_continuation_interrupted'), 'durable continuation interrupt');
  expect(getLaneEvents(lane.id).filter(event => event.payload.event === 'chat_review_continuation_claimed')).toHaveLength(1);
  expect(readFileSync(continuationCapturePath, 'utf8').trim().split('\n')).toHaveLength(starts.length);
  for (let attempt = 0; attempt < 2; attempt++) {
    execFileSync(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
      const registry = (await import('./src/lib/lane/registry.ts')).default;
      const origins = (await import('./src/lib/orchestrator/review-continuation-origin.ts')).default;
      const runner = (await import('./src/lib/ws-server/review-chat-continuation.ts')).default;
      const lane = registry.getLane(${JSON.stringify(lane.id)});
      const resolution = origins.resolveReviewChatOrigin(lane);
      if (resolution.kind !== 'bound') throw new Error('Expected durable originating turn.');
      await runner.runReviewChatContinuation(lane, resolution.origin, '[FLEET] Lane reached review-ready', {
        registerAbort: () => () => {}, publish: () => {},
      });
      process.exit(0);
    `], { cwd: process.cwd(), env: process.env, timeout: 15_000, stdio: 'pipe' });
  }
  expect(readFileSync(continuationCapturePath, 'utf8').trim().split('\n')).toHaveLength(starts.length);

}, 130_000);


it('routes only complete durable origins and keeps truly unbound legacy packets distinct', async () => {
  const { routeReviewContinuation } = await import('@/lib/orchestrator/review-continuation');
  const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
  const { addRepo } = await import('@/lib/repos/registry');
  const { createProject, addRepoToProject } = await import('@/lib/projects/store');
  const repo = await addRepo(repoPath);
  const project = createProject({ name: 'Durable origin mission fixture' });
  addRepoToProject(project.id, repo.id, null, 'manual');
  const threadId = `thoughts-negative-origin-${Date.now()}`;
  async function prepared(extra: Record<string, unknown>) {
    const response = await networkFetch(`http://127.0.0.1:${apiPort}/api/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_mission', arguments: {
        repoPath, projectId: project.id, runtime: 'codex', model: 'gpt-6.1-sol', requestedEffort: 'medium', dispatch: false,
        issues_inline: [{title: 'Origin refusal fixture', body: 'Prepared only.'}], ...extra,
      } } }),
    });
    expect(response.ok).toBe(true);
    const result = await response.json(); expect(result.result.isError, result.result.content?.[0]?.text).not.toBe(true);
    const created = JSON.parse(result.result.content[0].text);
    const packet = readMissionRegistryEntry(created.missionId)!.mission.packets[0];
    expect(packet.projectId).toBe(project.id);
    return { id: `lane-${packet.id}`, label: 'Prepared fixture', repoPath, packetId: packet.id };
  }
  const bound = await prepared({orchestratorThreadId: threadId, orchestratorTurnId: 'origin-turn'});
  const origin = vi.fn();
  const route = () => routeReviewContinuation(bound, () => false, origin);
  route(); expect(origin).not.toHaveBeenCalled();
  const history = { repoPath, messages: [{id: 'origin-turn', role: 'assistant' as const, content: '', timestamp: Date.now(), backend: 'codex' as const,
    model: 'gpt-6.1-sol', receipt: {leadModel: 'gpt-6.1-sol', effort: 'medium' as const, mode: 'multitask' as const}}] };
  writePersistedLlmChat(threadId, history, {replace: true});
  route(); expect(origin).toHaveBeenCalledOnce();
  origin.mockClear();
  for (const invalid of [
    {...history, repoPath: seedPath},
    {...history, messages: []},
    {...history, messages: [{...history.messages[0], model: 'gpt-6-astra'}]},
    {...history, messages: [history.messages[0], {...history.messages[0], id: 'changed-backend', backend: 'claude' as const}]},
  ]) {
    writePersistedLlmChat(threadId, invalid, {replace: true}); route();
    expect(origin).not.toHaveBeenCalled();
  }
  // Threads led by the built-in agent bind under the same checks (#3410).
  for (const [backend, model] of [['o8', 'o8-free'], ['pi', 'pi']] as const) {
    const agentThreadId = `thoughts-${backend}-origin-${Date.now()}`;
    const agentBound = await prepared({orchestratorThreadId: agentThreadId, orchestratorTurnId: 'origin-turn'});
    const agentRoute = () => routeReviewContinuation(agentBound, () => false, origin);
    const turn = {...history.messages[0], backend, model, receipt: {...history.messages[0].receipt, leadModel: model}};
    const agentHistory = {repoPath, backend, messages: [turn]};
    writePersistedLlmChat(agentThreadId, agentHistory, {replace: true});
    agentRoute(); expect(origin).toHaveBeenCalledOnce();
    expect(origin.mock.calls[0][1]).toEqual({threadId: agentThreadId, turnId: 'origin-turn', backend, model, effort: 'medium', mode: 'fleet'});
    origin.mockClear();
    for (const invalid of [
      {...agentHistory, repoPath: seedPath},
      {...agentHistory, messages: []},
      {...agentHistory, messages: [{...turn, model: 'gpt-6.1-sol'}]},
      {...agentHistory, messages: [turn, {...turn, id: 'changed-backend', backend: 'codex' as const}]},
      {...agentHistory, backend: 'codex'},
    ]) {
      writePersistedLlmChat(agentThreadId, invalid, {replace: true}); agentRoute();
      expect(origin).not.toHaveBeenCalled();
    }
  }
  // #3727: a mission created over MCP with no chat origin stays at review; no session is woken to merge it.
  const unbound = await prepared({});
  routeReviewContinuation(unbound, () => false, origin);
  expect(origin).not.toHaveBeenCalled();
}, 30_000);
