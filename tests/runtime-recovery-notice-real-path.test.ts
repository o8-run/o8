import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const recovery = 'The saved runtime session was unavailable. Continuing in a new session with the earlier conversation restored.';
const fixture = `
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ThoughtsChatPanel } from '@/components/desktop/thoughts/ThoughtsChatPanel';
window.fetch = async (input) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.includes('operator-defaults')) return Response.json({ orchestratorBackend: 'codex', orchestratorModel: 'fixture-model' });
  if (url.pathname.includes('composer-queue')) return Response.json({ items: [] });
  if (url.pathname === '/api/v2/chat-history') return Response.json({ messages: [], backend: 'codex', repoPath: url.searchParams.get('tabId') === 'thoughts-other' ? '/other' : '/fixture' });
  return Response.json({ agents: [], conversations: [] });
};
const sockets = new Set();
class FixtureSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 1;
  constructor() { super(); sockets.add(this); setTimeout(() => this.onopen?.(new Event('open')), 0); }
  send(raw) {
    const data = JSON.parse(raw);
    if (data.type === 'orchestrator-subscribe') {
      this.threadId = data.threadId;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true, threadId: data.threadId } }) }));
    }
  }
  close() { this.readyState = 3; sockets.delete(this); }
}
window.WebSocket = FixtureSocket;
window.emit = (event, data) => {
  for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event, data: { backend: 'codex', ...data } }) });
};
window.boundThreads = () => [...sockets].map(socket => socket.threadId);
window.panels = {};
for (const [name, threadId, repoPath] of [['a', 'thoughts-a', '/fixture'], ['b', 'thoughts-b', '/fixture'], ['other', 'thoughts-other', '/other']]) {
  const ref = createRef(); window.panels[name] = ref;
  const host = document.createElement('section'); host.id = name; host.style.cssText = 'display:flex;width:100%;height:650px'; document.getElementById('root').append(host);
  createRoot(host).render(createElement(ThoughtsChatPanel, {
    ref, open: true, agents: [], sessionTargets: [], workspaceTargets: [], repoPath, scopeTabId: name,
    initialMode: 'fleet', preferredRuntime: 'codex', suppressAutoRestore: true, suppressRuntimePrewarm: true,
    missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
    thoughtsBodyBackground: 'var(--t-bg)', thoughtsElevatedSurface: 'var(--t-panel)',
    thoughtsElevatedBorder: 'var(--t-border)', thoughtsElevatedShadow: 'none', thoughtsMutedGlass: 'var(--t-muted)',
    onMissionStateChange() {}, onChromeChange() {},
  }));
}
`;

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.resolve('src') },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'fixture-io', setup(build) {
      // Only inventory and the shared desktop transport are replaced; the panel,
      // orchestrator stream, window notice listener and banner all stay real.
      build.onLoad({ filter: /[\\/]useRuntimeInventory\.ts$/ }, () => ({ contents: 'export const useRuntimeInventory = () => ({ inventory: [], loading: false, error: null, refresh() {} });', loader: 'js' }));
      build.onLoad({ filter: /[\\/]DesktopWebSocketContext\.tsx$/ }, () => ({ contents: 'export const useSharedDesktopWs = () => undefined;', loader: 'js' }));
      build.onResolve({ filter: /next\/dist\/compiled\/gzip-size/ }, () => ({ path: 'gzip-size', namespace: 'fixture-next' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-next' }, () => ({ contents: 'export default async () => 0; export const sync = () => 0;', loader: 'js' }));
    } }],
  });
  bundle = built.outputFiles[0].text;
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for recovery notice verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

interface FixtureWindow extends Window {
  panels: Record<string, { current: { loadThread: (id: string) => Promise<void> } | null }>;
  emit: (event: string, data: Record<string, unknown>) => void;
  boundThreads: () => string[];
}
async function emit(page: Page, event: string, data: Record<string, unknown>) {
  await page.evaluate(({ event, data }) => (window as unknown as FixtureWindow).emit(event, data), { event, data });
}
async function loadThread(page: Page, panel: string, threadId: string) {
  await page.evaluate(async ({ panel, threadId }) => (window as unknown as FixtureWindow).panels[panel].current!.loadThread(threadId), { panel, threadId });
  await expect.poll(() => page.evaluate(id => (window as unknown as FixtureWindow).boundThreads().includes(id), threadId)).toBe(true);
}

it('paints each recovery once in its own real chat and preserves the existing notice kinds', async () => {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root" style="display:flex;gap:12px"></div></body></html>' }));
    await page.goto('http://localhost/');
    await page.clock.install();
    await page.addStyleTag({ content: fs.readFileSync(path.resolve('src/app/globals.css'), 'utf8') });
    await page.addScriptTag({ content: bundle });
    await expect.poll(async () => ({
      errors,
      mounted: await page.evaluate(() => Object.values((window as unknown as FixtureWindow).panels).every(ref => ref.current)),
    })).toEqual({ errors: [], mounted: true });
    for (const name of ['a', 'b', 'other']) await loadThread(page, name, `thoughts-${name}`);
    const retry = { threadId: 'thoughts-a', repoPath: '/fixture', assistantMessageId: 'answer-a1', attempt: 2, reason: 'runtime-session-recovered', notice: recovery };
    await emit(page, 'retry', retry);
    const banner = page.locator('#a [role="status"]').filter({ hasText: recovery });
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.count()).toBe(1);
    expect(await page.locator('#b, #other').getByText(recovery, { exact: true }).count()).toBe(0);
    expect(await banner.evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await banner.getByRole('button', { name: 'Dismiss notice' }).click();
    await emit(page, 'retry', retry);
    expect(await page.getByText(recovery, { exact: true }).count()).toBe(0);
    await emit(page, 'retry', { ...retry, assistantMessageId: 'answer-a2' });
    await expect.poll(() => banner.isVisible()).toBe(true);
    await loadThread(page, 'a', 'thoughts-new');
    expect(await page.getByText(recovery, { exact: true }).count()).toBe(0);
    await emit(page, 'retry', { ...retry, threadId: 'thoughts-new', assistantMessageId: 'answer-new' });
    await expect.poll(() => banner.isVisible()).toBe(true);
    await page.clock.fastForward(7_000);
    await expect.poll(() => page.getByText(recovery, { exact: true }).count()).toBe(0);
    await emit(page, 'retry', { ...retry, threadId: 'thoughts-new', assistantMessageId: 'answer-new' });
    expect(await page.getByText(recovery, { exact: true }).count()).toBe(0);

    await emit(page, 'notice', { kind: 'mcp-reload', noticeId: 'reload-1', repoPath: '/fixture', registered: ['fixture-tool'] });
    const reload = page.getByRole('status').filter({ hasText: 'Reloading with new MCP tools…' });
    await expect.poll(() => reload.count()).toBe(2);
    expect(await page.locator('#other').getByText('Reloading with new MCP tools…').count()).toBe(0);
    expect(await reload.first().textContent()).toContain('fixture-tool');
    await page.clock.fastForward(7_000);
    await expect.poll(() => reload.count()).toBe(0);
    await emit(page, 'notice', { kind: 'cross-house-orchestrator-handoff', noticeId: 'handoff-1', repoPath: '/fixture', message: 'Stand-in orchestrator active.' });
    const handoff = page.locator('#a [role="status"]').filter({ hasText: 'Stand-in orchestrator active.' });
    await expect.poll(() => handoff.isVisible()).toBe(true);
    await page.clock.fastForward(7_000);
    expect(await handoff.isVisible()).toBe(true);
    expect(await handoff.getByRole('button', { name: 'Dismiss notice' }).textContent()).toBe('Dismiss');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60_000);
