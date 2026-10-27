import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runChat } from '../cli/src/commands/chat';
import { MODEL_IDS } from '@/lib/models';
import type { PersistedTabState } from '@/lib/terminal/tab-state';

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'connectivity-check-'));
const repoPath = join(root, 'repo');
const probe = 'Reply with exactly: terminal chat is connected';
const auth = randomUUID();
const tabUrl = 'http://localhost/api/panel/terminal-state?scope=tile-root';
let worker: ChildProcess;
let api: Server;
let serverOutput = '';
let wsPort: number;
let stateRoute: typeof import('@/app/api/panel/terminal-state/route');
let recentRoute: typeof import('@/app/api/v2/chat-history/list/route');
let restore: typeof import('@/components/desktop/workspace-terminal/terminal-restore');
let threads: typeof import('@/lib/mobile/orchestrator-thread-history');
let tabState: typeof import('@/lib/terminal/tab-state');

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}. ${serverOutput.slice(-1000)}`);
}
function historyFiles() { return existsSync(join(root, 'chat-history')) ? readdirSync(join(root, 'chat-history')).filter(file => file.endsWith('.json')).sort() : []; }
function savedState() { return JSON.parse(readFileSync(join(root, 'terminal-states', 'tile-root.json'), 'utf8')) as PersistedTabState; }

beforeAll(async () => {
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'state.db'));
  mkdirSync(repoPath); mkdirSync(join(root, 'terminal-states')); mkdirSync(join(root, 'chat-history'));
  execFileSync('git', ['init', '-q', repoPath]);
  writeFileSync(join(root, 'ws-token'), auth, { mode: 0o600 });
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'check-repo', name: 'check', localPath: repoPath, addedAt: new Date().toISOString() },
  ] }));
  writeFileSync(join(root, 'terminal-states', 'tile-root.json'), JSON.stringify({
    version: 1, activeTabId: 'orchestrator-real', savedAt: new Date().toISOString(), tabs: [
      { id: 'orchestrator-real', kind: 'orchestrator', label: 'Real work', cliAgent: 'codex', repoPath, orchestratorThreadId: 'thoughts-real' },
    ],
  }));
  const binary = join(root, 'fixture-runtime.mjs');
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.161.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using fixture'); process.exit(0); }
if (args[0] !== 'exec') process.exit(0);
writeFileSync(join(import.meta.dirname, 'runtime-called'), 'called');
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-check'}));
console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'terminal chat is connected'}}));
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}));
`);
  chmodSync(binary, 0o755);
  api = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ready":true,"configured":false}'); });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiPort = (api.address() as { port: number }).port;
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  wsPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  vi.stubEnv('O8_WS_PORT', String(wsPort)); vi.stubEnv('O8_API_PORT', String(apiPort)); vi.stubEnv('O8_API_TOKEN', auth);
  worker = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_CODEX_BIN: binary, O8_CLAUDE_CODE_BIN: binary,
      O8_CRASH_SURVIVABLE_ORCHESTRATOR: '0', O8_SUBSCRIPTION_PROFILE: 'both', CORTEX_IDE_OWNED_CODEX_ROOT: join(root, 'owned-runtime') },
  });
  worker.stdout?.on('data', chunk => { serverOutput += String(chunk); });
  worker.stderr?.on('data', chunk => { serverOutput += String(chunk); });
  await until(() => serverOutput.includes('WebSocket server listening'), 'server launch');
  stateRoute = await import('@/app/api/panel/terminal-state/route');
  recentRoute = await import('@/app/api/v2/chat-history/list/route');
  restore = await import('@/components/desktop/workspace-terminal/terminal-restore');
  threads = await import('@/lib/mobile/orchestrator-thread-history');
  tabState = await import('@/lib/terminal/tab-state');
}, 60_000);
afterAll(async () => {
  if (worker?.exitCode === null) { worker.kill('SIGTERM'); await Promise.race([once(worker, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]); }
  if (api?.listening) { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
  (await import('@/lib/db')).closeDb();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('terminal chat checks through real entry points and persisted workspace state', () => {
  it('checks the transport from the CLI without a conversation, runtime turn, or workspace mutation', async () => {
    const beforeFiles = historyFiles();
    const beforeState = savedState();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runChat(['--check'])).toBe(0);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('connected');
    } finally { output.mockRestore(); }
    expect(historyFiles()).toEqual(beforeFiles);
    expect(savedState()).toEqual(beforeState);
    expect(existsSync(join(root, 'runtime-called'))).toBe(false);
    const recent = await recentRoute.GET(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'));
    expect(recent.status).toBe(200);
    expect((await recent.json()).conversations).toEqual([]);
  });

  it('rejects the legacy probe prompt before it can create a visible conversation', async () => {
    const beforeFiles = historyFiles();
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(auth)}`);
    const events: Array<{ event?: string; data?: { error?: string; status?: string } }> = [];
    socket.on('message', chunk => events.push(JSON.parse(String(chunk))));
    try {
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'orchestrator-send', repoPath, threadId: 'thoughts-legacy-probe',
        clientMessageId: randomUUID(), message: probe, displayMessage: probe,
        backend: 'codex', model: MODEL_IDS.raw.openAiGpt55, permissionMode: 'plan', orchestrationMode: 'fleet', pinBackend: true }));
      await until(() => events.some(event => event.event === 'error' || (event.event === 'status' && event.data?.status === 'ready')), 'probe response');
      expect.soft(events.some(event => event.event === 'error' && event.data?.error?.includes('o8 chat --check'))).toBe(true);
      expect.soft(historyFiles()).toEqual(beforeFiles);
      expect(existsSync(join(root, 'runtime-called'))).toBe(false);
    } finally { socket.terminate(); }
  });

  it('removes saved probe tabs on API/client restore and excludes probe-only history from discovery', async () => {
    const real = savedState().tabs[0];
    const legacy = { ...real, id: 'orchestrator-probe', label: probe, orchestratorThreadId: 'thoughts-saved-probe' };
    const similar = { ...real, id: 'orchestrator-related', label: `${probe} documentation`, orchestratorThreadId: 'thoughts-related' };
    const shell = { id: 'terminal-kept', kind: 'terminal' as const, label: probe, cliAgent: 'shell', repoPath };
    writeFileSync(join(root, 'terminal-states', 'tile-root.json'), JSON.stringify({
      version: 1, activeTabId: legacy.id, tabs: [real, legacy, similar, shell], savedAt: new Date().toISOString(),
    }));
    for (const [id, title, followup] of [
      ['thoughts-saved-probe', probe, false], ['thoughts-followup', probe, true], ['thoughts-renamed', 'Connection audit', false],
    ] as const) writeFileSync(join(root, 'chat-history', `${id}.json`), JSON.stringify({
      repoPath, title, backend: 'codex', orchestratorVisible: true, mobileRevealRequestedAt: new Date().toISOString(), messages: [
        { id: 'user-probe', role: 'user', content: probe, timestamp: 1 },
        { id: 'reply-probe', role: 'assistant', content: 'terminal chat is connected', timestamp: 2 },
        ...(followup ? [{ id: 'real-followup', role: 'user', content: 'Now inspect the actual work.', timestamp: 3 }] : []),
      ],
    }));
    const response = await stateRoute.GET(new Request(tabUrl));
    expect(response.status).toBe(200);
    const state = await response.json() as PersistedTabState;
    expect.soft(state.tabs.map(tab => tab.id)).toEqual([real.id, similar.id, shell.id]);
    expect.soft(state.activeTabId).toBe(real.id);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => stateRoute.GET(new Request(new URL(String(input), 'http://localhost')))));
    const initial = await restore.loadInitialTabState({ stateScope: 'tile-root', defaultTab: 'orchestrator', splitCreated: false, preferredRepoPath: repoPath }, () => false);
    expect.soft(initial?.tabs.some(tab => tab.id === legacy.id)).toBe(false);
    const recent = await (await recentRoute.GET(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
    expect.soft(recent.conversations.map((entry: { tabId: string }) => entry.tabId)).not.toContain('thoughts-saved-probe');
    expect.soft(recent.conversations.map((entry: { tabId: string }) => entry.tabId)).toContain('thoughts-followup');
    expect.soft(recent.conversations.map((entry: { tabId: string }) => entry.tabId)).toContain('thoughts-renamed');
    expect.soft(threads.listMobileOrchestratorThreads().map(thread => thread.id)).not.toContain('thoughts-saved-probe');
    expect(threads.listMobileOrchestratorRevealRequests(null).map(request => request.thread.id)).not.toContain('thoughts-saved-probe');
  });

  it.each(['orchestrator', 'llm-chat', 'chat'] as const)('keeps a probe-titled %s tab and its focus after real user work on load and save', async kind => {
    const real = { id: 'orchestrator-real', kind: 'orchestrator' as const, label: 'Real work', cliAgent: 'codex', repoPath, orchestratorThreadId: 'thoughts-real' };
    const continued = { ...real, kind, id: `${kind}-continued`, label: probe, orchestratorThreadId: `thoughts-continued-${kind}`,
      chatSessionKey: 'codex:continued-thread' };
    const check = { ...real, id: 'orchestrator-check-only', label: probe, orchestratorThreadId: 'thoughts-check-only' };
    const state: PersistedTabState = { version: 1, activeTabId: continued.id, tabs: [real, check, continued], savedAt: new Date().toISOString() };
    for (const [id, realWork] of [[continued.orchestratorThreadId, true], [check.orchestratorThreadId, false]] as const) {
      writeFileSync(join(root, 'chat-history', `${id}.json`), JSON.stringify({ repoPath, title: probe, messages: [
        { id: 'check-user', role: 'user', content: probe, timestamp: 1 },
        { id: 'check-answer', role: 'assistant', content: 'terminal chat is connected', timestamp: 2 },
        ...(realWork ? [{ id: 'work-user', role: 'user', content: 'Inspect the failing build and repair it.', timestamp: 3 }] : []),
      ] }));
    }
    writeFileSync(join(root, 'terminal-states', 'tile-root.json'), JSON.stringify(state));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), 'http://localhost'), init);
      return init?.method === 'POST' ? stateRoute.POST(request) : stateRoute.GET(request);
    }));
    const loaded = await tabState.loadTabState('tile-root');
    expect.soft(loaded?.activeTabId).toBe(continued.id);
    expect.soft(loaded?.tabs.map(tab => tab.id)).toEqual([real.id, continued.id]);
    const initial = await restore.loadInitialTabState({ stateScope: 'tile-root', defaultTab: 'orchestrator', splitCreated: false, preferredRepoPath: repoPath }, () => false);
    expect.soft(initial?.activeTabId).toBe(continued.id);
    expect.soft(initial?.tabs.some(tab => tab.id === continued.id)).toBe(true);
    await tabState.saveTabState(state, 'tile-root');
    expect.soft(savedState().activeTabId).toBe(continued.id);
    expect.soft(savedState().tabs.map(tab => tab.id)).toEqual([real.id, continued.id]);
    expect((await tabState.loadTabState('tile-root'))?.activeTabId).toBe(continued.id);
  });
});
