// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1"}
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/dashboard/page';
import { getQueryClient } from '@/lib/query/client';
import { resetComposerDraftMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';

// Keep the dashboard, workspace, composer, transport and persistence real.
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, user: null, isLoaded: true, clerkEnabled: false }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({ useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh() {} }) }));
vi.mock('@/components/desktop/workspace-terminal/XtermPanel', () => ({ XtermPanel: () => null }));
vi.mock('@/lib/llm/thread-auto-title', () => ({ maybeQueueThreadAutoTitle: vi.fn() }));
vi.mock('@/lib/repos/github-identity', () => ({ resolveRepoGithubIdentity: () => ({ githubOwner: null, githubRepo: null }) }));
vi.mock('@/lib/llm/thread-repo-metadata', () => ({ resolveThreadRepoMetadata: () => ({}) }));

const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-pane-isolation-'));
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const repoPath = join(fixtureRoot, 'repo');
const profile = join(fixtureRoot, 'profile');
const auth = randomBytes(32).toString('hex');
const originalFetch = globalThis.fetch;
let apiServer: Server;
let wsProcess: ChildProcess | undefined;
let serverOutput = '';
let apiBase = '';
let root: Root | undefined;
let host: HTMLDivElement;
const timers = new Set<ReturnType<typeof setTimeout>>();
const sends: Record<string, unknown>[] = [];
const reveals: string[] = [];
const sockets = new Set<WebSocket>();
const noop = () => {};
const threadA = 'thoughts-pane-a';
const messageA = 'Send only to pane A';
const messageB = 'Send only to pane B';

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
}
async function waitFor(check: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    if (wsProcess && (wsProcess.exitCode !== null || wsProcess.signalCode !== null)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Waiting for ${label}: ${serverOutput.slice(-2500)}`);
}
async function type(input: HTMLTextAreaElement, value: string) {
  expect(input.isConnected).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function pointer(target: EventTarget, kind: string, x: number, y: number) {
  const event = new MouseEvent(kind, { bubbles: true, cancelable: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}
async function send(input: HTMLTextAreaElement, x: number) {
  await expect.poll(async () => {
    await settle();
    return input.closest('[data-o8-workspace-root]')!.querySelector('[data-testid="composer-send-control"]')?.getAttribute('aria-label');
  }, { timeout: 15000 }).toBe('Send (Enter)');
  await act(async () => {
    pointer(input, 'pointerdown', x, 200); input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}
async function history(threadId: string) {
  const response = await originalFetch(`${apiBase}/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`);
  expect(response.status).toBe(200);
  return response.json();
}
async function mount() {
  root = createRoot(host);
  await act(async () => root!.render(createElement(DashboardPage)));
  await vi.dynamicImportSettled();
}

beforeAll(async () => {
  mkdirSync(repoPath); mkdirSync(profile);
  const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'o8 fixture'); git('config', 'user.email', 'fixture@o8.test');
  writeFileSync(join(repoPath, 'notes.txt'), 'fixture\n'); git('add', 'notes.txt'); git('commit', '-qm', 'fixture');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${auth}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'pane-repo', name: 'Fixture', localPath: repoPath, addedAt: new Date().toISOString() }, { id: 'pane-default', name: 'Default', localPath: profile, addedAt: new Date().toISOString() }] }));
  const historyRoute = await import('@/app/api/v2/chat-history/route');
  const terminalRoute = await import('@/app/api/panel/terminal-state/route');
  const revealRoute = await import('@/app/api/mobile/orchestrator/threads/reveal/route');
  apiServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, apiBase);
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const nextRequest = new NextRequest(url, { method: request.method, headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) });
      const route = url.pathname === '/api/v2/chat-history' ? historyRoute
        : url.pathname === '/api/panel/terminal-state' ? terminalRoute
          : url.pathname === '/api/mobile/orchestrator/threads/reveal' ? revealRoute : null;
      let result: Response;
      if (route) {
        result = await (request.method === 'POST' && 'POST' in route ? route.POST(nextRequest) : route.GET(nextRequest));
      } else if (url.pathname === '/api/panel/operator-defaults') {
        result = Response.json({ values: { orchestratorBackend: 'codex', orchestratorModel: 'gpt-6.1-sol', inAppOrchestratorEnabled: true }, dispatchableRuntimes: [{ available: true }, { available: true }] });
      } else {
        result = Response.json({ configured: false, ready: true, items: [], agents: [], conversations: [], packets: [], projects: [], approvals: [], tasks: [], worktrees: [], settings: {}, tools: [], repos: [], archivedIds: [], lanes: [], validatedRestorePaths: [] });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  apiServer.listen(0, '127.0.0.1'); await once(apiServer, 'listening');
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('Missing API address');
  apiBase = `http://127.0.0.1:${apiAddress.port}`;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const wsAddress = probe.address();
  if (!wsAddress || typeof wsAddress === 'string') throw new Error('Missing WebSocket address');
  const wsPort = wsAddress.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const provider = join(fixtureRoot, 'scripted-provider.mjs');
  writeFileSync(provider, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'scripted-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Scripted pane reply' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  chmodSync(provider, 0o755);
  const loopback = join(fixtureRoot, 'loopback.mjs');
  writeFileSync(loopback, `import { Server } from 'node:net';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
`);
  wsProcess = execFile(process.execPath, ['--import', loopback, '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: {
      NODE_ENV: 'test', PATH: process.env.PATH, HOME: profile, USERPROFILE: profile,
      XDG_CONFIG_HOME: join(profile, '.config'), XDG_CACHE_HOME: join(profile, '.cache'),
      O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
      CORTEX_IDE_OWNED_CODEX_ROOT: join(fixtureRoot, 'owned-runtime'), O8_CODEX_BIN: provider, O8_SUBSCRIPTION_PROFILE: 'both',
      O8_API_PORT: String(apiAddress.port), O8_WS_PORT: String(wsPort), NEXT_ORIGIN: apiBase,
      ...(process.env.O8_TEST_FILE_MARKER ? { O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER } : {}),
    },
  });
  wsProcess.stdout?.on('data', chunk => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', chunk => { serverOutput += String(chunk); });
  await waitFor(() => serverOutput.includes('WebSocket server listening'), 'WebSocket startup', 60_000);

  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args); timers.add(timer); return timer;
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', WebSocket);
  const nativeSend = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
    sockets.add(this);
    const payload = JSON.parse(String(args[0]));
    if (payload.type === 'orchestrator-send' && !sends.some(sent => sent.clientMessageId === payload.clientMessageId)) sends.push(payload);
    return nativeSend.apply(this, args);
  });
  window.__O8_WS_PORT__ = wsPort;
  const meta = document.createElement('meta'); meta.name = 'ws-token'; meta.content = auth; document.head.append(meta);
  window.addEventListener('o8:orchestrator-threads', event => {
    const detail = (event as CustomEvent).detail;
    if (detail.event === 'reveal') reveals.push(detail.data.thread.id);
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: noop });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel: noop }) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (text: string) => ({ width: text.length * 8 }), fillRect() {}, clearRect() {}, fillText() {}, setTransform() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => originalFetch(new URL(String(input), apiBase), init));
  getQueryClient().clear(); localStorage.clear(); sessionStorage.clear(); resetComposerDraftMemoryForTests();
  const saved = { version: 1, activeTabId: 'orchestrator-pane-a', savedAt: new Date().toISOString(), tabs: [{
    id: 'orchestrator-pane-a', kind: 'orchestrator', label: 'Pane A', repoPath, repoName: 'Fixture', cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: threadA,
  }] };
  const seed = async (path: string, body: unknown) => {
    const response = await originalFetch(apiBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
  };
  await seed('/api/panel/terminal-state?scope=tile-root', saved);
  await seed('/api/v2/chat-history', { tabId: threadA, repoPath, title: 'Pane A', backend: 'codex', model: 'gpt-6.1-sol', messages: [{ id: 'retained-a', role: 'assistant', content: 'Retained result for pane A', timestamp: 1 }] });
  localStorage.setItem('o8:sidebar:visible', 'false');
  host = document.createElement('div'); document.body.append(host);
}, 90_000);

afterAll(async () => {
  if (root) await act(async () => root!.unmount());
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.terminate();
  if (wsProcess && wsProcess.exitCode === null && wsProcess.signalCode === null) {
    const exited = once(wsProcess, 'exit'); wsProcess.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
    if (!stopped) { wsProcess.kill('SIGKILL'); await exited; }
  }
  if (apiServer?.listening) { apiServer.closeAllConnections(); await new Promise<void>(resolve => apiServer.close(() => resolve())); }
  host?.remove(); getQueryClient().clear(); localStorage.clear(); resetComposerDraftMemoryForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(fixtureRoot, { recursive: true, force: true });
});

it('keeps both dashboard panes independent through B send, A send and persisted reload', async () => {
  await import('@/components/desktop/workspace-terminal/OrchestratorTab');
  await mount();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }, { timeout: 10000 }).toBe(1);
  const inputA = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const paneA = inputA.closest('[data-o8-workspace-root]')!;
  await expect.poll(async () => { await settle(); return paneA.textContent; }).toContain('Retained result for pane A');
  await type(inputA, messageA);
  const tile = host.querySelector<HTMLElement>('[data-tile-id="tile-root"]')!;
  vi.spyOn(tile, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 600));
  await act(async () => {
    pointer(host.querySelector('[aria-label="Run orchestrator"]')!, 'pointerdown', -20, 150);
    pointer(document, 'pointermove', 592, 150); pointer(document, 'pointerup', 592, 150);
  });
  await vi.dynamicImportSettled();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }).toBe(2);
  const inputB = [...host.querySelectorAll<HTMLTextAreaElement>('textarea')].find(input => input !== inputA)!;
  const paneB = inputB.closest('[data-o8-workspace-root]')!;
  const tabA = paneA.getAttribute('data-o8-active-tab-id')!;
  const tabB = paneB.getAttribute('data-o8-active-tab-id')!;
  const scopeB = paneB.closest('[data-tile-id]')!.getAttribute('data-tile-id')!;
  await type(inputB, messageB); await send(inputB, 700);
  await expect.poll(async () => { await settle(); return sends.length; }).toBe(1);
  const threadB = String(sends[0].threadId);
  expect(threadB).not.toBe(threadA);
  await expect.poll(async () => { await settle(); return reveals; }, { timeout: 15000 }).toContain(threadB);
  await expect.poll(async () => { await settle(); return paneB.textContent; }, { timeout: 15000 }).toContain('Scripted pane reply');
  await settle();
  expect.soft(paneA.querySelector('textarea')!.value).toBe(messageA);
  expect.soft(paneA.textContent).toContain('Retained result for pane A');
  expect.soft(paneA.textContent).not.toContain(messageB);
  expect.soft(paneA.textContent).not.toContain('Scripted pane reply');
  await type(paneB.querySelector('textarea')!, 'Next draft in B');
  // Continue after a draft failure so the regression also proves the next send and reload.
  await type(paneA.querySelector('textarea')!, messageA); await send(paneA.querySelector('textarea')!, 100);
  await expect.poll(async () => { await settle(); return sends.length; }).toBe(2);
  expect.soft(sends[1].threadId).toBe(threadA);
  await expect.poll(async () => { await settle(); return paneA.textContent; }, { timeout: 15000 }).toContain('Scripted pane reply');
  await expect.poll(async () => JSON.stringify(await history(String(sends[1].threadId))), { timeout: 10000 }).toContain(messageA);
  expect.soft(JSON.stringify(await history(threadA))).toContain(messageA);
  expect.soft(JSON.stringify(await history(threadA))).not.toContain(messageB);
  expect.soft(JSON.stringify(await history(threadB))).toContain(messageB);
  expect.soft(JSON.stringify(await history(threadB))).not.toContain(messageA);
  expect.soft(paneB.textContent).not.toContain(messageA);
  expect.soft(paneB.querySelector('textarea')!.value).toBe('Next draft in B');
  await type(paneA.querySelector('textarea')!, 'Next draft in A');
  const savedState = async (scope: string) => {
    const response = await originalFetch(`${apiBase}/api/panel/terminal-state?scope=${scope}`);
    return response.status === 204 ? null : response.json();
  };
  await expect.poll(async () => (await savedState(scopeB)).tabs?.[0]?.orchestratorThreadId).toBe(threadB);
  await settle(); await settle();
  expect.soft((await savedState('tile-root'))?.tabs[0]?.orchestratorThreadId).toBe(threadA);
  await act(async () => root!.unmount()); root = undefined;
  resetComposerDraftMemoryForTests(); getQueryClient().clear();
  await mount();
  await expect.poll(async () => { await settle(); return host.querySelectorAll('textarea').length; }).toBe(2);
  const restoredA = host.querySelector(`[data-o8-active-tab-id="${tabA}"]`)!;
  const restoredB = host.querySelector(`[data-o8-active-tab-id="${tabB}"]`)!;
  await expect.poll(async () => { await settle(); return restoredB.textContent; }).toContain(messageB);
  expect.soft(restoredA.querySelector('textarea')!.value).toBe('Next draft in A');
  expect.soft(restoredB.querySelector('textarea')!.value).toBe('Next draft in B');
  expect.soft(restoredA.textContent).toContain(messageA);
  expect.soft(restoredA.textContent).toContain('Retained result for pane A');
  expect.soft(restoredA.textContent).not.toContain(messageB);
  expect.soft(restoredB.textContent).not.toContain(messageA);
  expect(sends).toHaveLength(2);
}, 90_000);
