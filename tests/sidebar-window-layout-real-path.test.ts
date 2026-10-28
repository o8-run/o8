import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const repoRoot = process.cwd();
const proofDir = process.env.O8_SIDEBAR_WINDOW_PROOF_DIR;
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import DashboardPage from '@/app/dashboard/page';
localStorage.setItem('fixture:terminal:tile-root', JSON.stringify({ version: 1, activeTabId: 'existing', savedAt: new Date().toISOString(),
  tabs: [{ id: 'existing', kind: 'orchestrator', label: 'Existing conversation', repoPath: '/fixture', repoName: 'Fixture', cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: 'thoughts-existing' }] }));
localStorage.setItem('fixture:history:thoughts-existing', JSON.stringify({ repoPath: '/fixture', title: 'Existing conversation', messages:
  Array.from({ length: 35 }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', text: 'Retained source message ' + i, timestamp: i + 1 })) }));
window.sentTurns = [];
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.includes('operator-defaults')) return Response.json({ values: { telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false } });
  if (url.pathname === '/api/setup/config') return Response.json({ setupComplete: true });
  if (url.pathname === '/api/panel/terminal-state') {
    const key = 'fixture:terminal:' + url.searchParams.get('scope');
    if (init?.method === 'POST') { localStorage.setItem(key, init.body); return Response.json({ ok: true }); }
    const saved = localStorage.getItem(key); return saved ? Response.json(JSON.parse(saved)) : new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/v2/chat-history') {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); localStorage.setItem('fixture:history:' + body.tabId, JSON.stringify(body)); return Response.json({ ok: true }); }
    return Response.json(JSON.parse(localStorage.getItem('fixture:history:' + url.searchParams.get('tabId')) || '{"messages":[]}'));
  }
  if (url.pathname.includes('composer-queue')) return Response.json({ items: [] });
  return Response.json({ agents: [], conversations: [], packets: [], projects: [], approvals: [], tasks: [], worktrees: [], settings: {}, tools: [], repos: [], archivedIds: [], lanes: [], validatedRestorePaths: [] });
};
class FixtureSocket extends EventTarget {
  static OPEN = 1; static CLOSED = 3;
  readyState = 1;
  constructor() { super(); setTimeout(() => this.onopen?.(new Event('open')), 0); }
  send(raw) {
    const data = JSON.parse(raw);
    if (data.type === 'orchestrator-send') window.sentTurns.push(data);
    if (data.type === 'orchestrator-subscribe') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true, threadId: data.threadId } }) }));
  }
  close() { this.readyState = 3; }
}
window.WebSocket = FixtureSocket;
createRoot(document.getElementById('root')).render(createElement(DashboardPage));
`;

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { contents: fixture, resolveDir: repoRoot, loader: 'jsx' },
    absWorkingDir: repoRoot, bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.join(repoRoot, 'src') },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty', '.ttf': 'dataurl' }, legalComments: 'none', logLevel: 'silent',
    plugins: [{ name: 'fixture-io', setup(build) {
      // Account, inventory and transport are fixture boundaries; layout and workspace stay real.
      build.onLoad({ filter: /[\\/]O8AuthProvider\.tsx$/ }, () => ({ contents: 'export const useO8Auth = () => ({ signedIn: false, user: null, isLoaded: true, clerkEnabled: false }); export const O8AuthProvider = ({children}) => children;', loader: 'jsx' }));
      build.onLoad({ filter: /[\\/]useRuntimeInventory\.ts$/ }, () => ({ contents: 'const value = { inventory: [], loading: false, error: null, refresh() {} }; export const useRuntimeInventory = () => value; export const invalidateRuntimeInventory = () => {};', loader: 'js' }));
      build.onLoad({ filter: /[\\/]DesktopWebSocketContext\.tsx$/ }, () => ({ contents: 'const noop = () => {}; const value = { connectionState: "disconnected", sendTerminalCreate: noop, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalVisibility: noop, sendTerminalDetach: noop }; export const DesktopWebSocketProvider = ({ children }) => children; export const useSharedDesktopWs = () => value; export const useWsConnectionEpoch = () => 0; export const useWsConnectionState = () => "disconnected";', loader: 'jsx' }));
      build.onLoad({ filter: /[\\/]XtermPanel\.tsx$/ }, () => ({ contents: 'export const XtermPanel = () => null;', loader: 'js' }));
      // Next's server-only bundle-size diagnostic has no browser entry point.
      build.onResolve({ filter: /next\/dist\/compiled\/gzip-size/ }, () => ({ path: 'gzip-size', namespace: 'fixture-next' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-next' }, () => ({ contents: 'export default async () => 0; export const sync = () => 0;', loader: 'js' }));
    } }],
  });
  bundle = built.outputFiles[0].text;
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for sidebar geometry verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it.each(['light', 'dark'] as const)('keeps the production dashboard bounded while toggling, resizing and zooming in %s', async palette => {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://localhost/dashboard');
    await page.addStyleTag({ content: fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8') });
    await page.evaluate(palette => {
      localStorage.setItem('cortex-theme-palette', palette); localStorage.setItem('cortex-reduce-transparency', 'on');
      localStorage.setItem('o8:sidebar:visible', 'false'); localStorage.setItem('o8:sidebar:width', '500');
      localStorage.setItem('o8:ui-zoom', '1.5');
    }, palette);
    await page.addScriptTag({ content: bundle });
    const input = page.locator('[data-o8-workspace-root] textarea').first();
    await input.waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`Dashboard fixture did not mount: ${JSON.stringify(errors)}`); }); await input.fill('Keep the selected chat and this exact draft.');
    const aside = page.locator('#o8-chat-list');
    const workspace = page.locator('[data-mcp-scope="workspace"]');
    const selected = await page.locator('[data-o8-workspace-root]').first().getAttribute('data-o8-active-tab-id');
    const closed = await workspace.boundingBox();
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).filter({ visible: true }).click();
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `sidebar-open-before-assert-${palette}.png`) }); }
    await expect.poll(() => aside.evaluate(node => getComputedStyle(node).position)).toBe('absolute');
    const opened = await workspace.boundingBox();
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `sidebar-open-${palette}.png`) }); }
    expect(Math.abs(opened!.width - closed!.width)).toBeLessThanOrEqual(2);
    for (const width of [900, 1680, 900]) {
      await page.setViewportSize({ width, height: width === 900 ? 700 : 1050 });
      await expect.poll(() => aside.evaluate(node => getComputedStyle(node).position)).toBe('absolute');
      if (!await aside.isVisible()) await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).filter({ visible: true }).click();
      const bounds = await aside.boundingBox();
      if (proofDir && width === 900) await page.screenshot({ path: path.join(proofDir, `sidebar-compact-${palette}.png`) });
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).filter({ visible: true }).click();
      await expect.poll(() => aside.isVisible()).toBe(false);
      const composer = await input.boundingBox();
      expect(composer!.x).toBeGreaterThanOrEqual(0); expect(composer!.x + composer!.width).toBeLessThanOrEqual(width);
      expect(await input.inputValue()).toBe('Keep the selected chat and this exact draft.');
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).filter({ visible: true }).click();
    }
    await page.setViewportSize({ width: 1680, height: 1050 });
    await input.press('Meta+0');
    await expect.poll(() => aside.evaluate(node => getComputedStyle(node).position)).toBe('relative');
    expect(await page.locator('[data-o8-workspace-root]').first().getAttribute('data-o8-active-tab-id')).toBe(selected);
    expect(await input.inputValue()).toBe('Keep the selected chat and this exact draft.');
    expect(await page.evaluate(() => localStorage.getItem('o8:sidebar:width'))).toBe('500');
    expect(await page.evaluate(() => (window as unknown as { sentTurns: unknown[] }).sentTurns)).toEqual([]);
    expect(errors).toEqual([]);
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `sidebar-${palette}.png`) }); }
  } finally { await page.close(); }
}, 60_000);

it.each(['light', 'dark'] as const)('keeps a small drawer bounded and open through breakpoint crossings in %s', async palette => {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 }, deviceScaleFactor: 2 });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://localhost/dashboard');
    await page.addStyleTag({ content: fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8') });
    await page.evaluate(palette => {
      localStorage.setItem('cortex-theme-palette', palette);
      localStorage.setItem('cortex-reduce-transparency', 'on');
      localStorage.setItem('o8:sidebar:visible', 'false');
      localStorage.setItem('o8:sidebar:width', '500');
    }, palette);
    const mount = () => page.addScriptTag({ content: bundle });
    await mount();
    const input = page.locator('[data-o8-workspace-root] textarea').first();
    await input.fill('Retain the unsent draft.');
    const chat = page.locator('[data-o8-active-chat="true"]');
    await chat.waitFor();
    const thread = await chat.getAttribute('data-o8-chat-thread');
    const aside = page.locator('#o8-chat-list');
    const toggle = () => page.getByRole('button', { name: 'Toggle sidebar', exact: true }).filter({ visible: true }).first();
    await toggle().click();
    await page.mouse.move(590, 680);
    await expect.poll(() => aside.isVisible()).toBe(true);
    expect((await aside.boundingBox())!.width).toBeLessThanOrEqual(300);
    for (const width of [1440, 600, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await expect.poll(() => aside.evaluate(node => getComputedStyle(node).position)).toBe(width === 1440 ? 'relative' : 'absolute');
      expect(await aside.isVisible()).toBe(true);
      const bounds = (await aside.boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await input.inputValue()).toBe('Retain the unsent draft.');
      expect(await chat.getAttribute('data-o8-chat-thread')).toBe(thread);
    }
    await page.setViewportSize({ width: 600, height: 700 });
    await expect.poll(() => aside.evaluate(node => getComputedStyle(node).position)).toBe('absolute');
    await chat.evaluate(node => { node.scrollTop = 120; });
    const scrollTop = await chat.evaluate(node => node.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await toggle().click();
    await expect.poll(() => aside.isVisible()).toBe(false);
    await page.keyboard.press('Meta+b');
    await expect.poll(() => aside.isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => aside.isVisible()).toBe(false);
    await toggle().click();
    await page.getByRole('button', { name: 'Close chats sidebar' }).click({ position: { x: 430, y: 400 } });
    await expect.poll(() => aside.isVisible()).toBe(false);
    expect(await chat.evaluate(node => node.scrollTop)).toBe(scrollTop);
    expect(await page.evaluate(() => localStorage.getItem('o8:sidebar:width'))).toBe('500');
    await toggle().click();
    await page.reload();
    await page.addStyleTag({ content: fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8') });
    await mount();
    await expect.poll(() => aside.isVisible()).toBe(true);
    expect((await aside.boundingBox())!.width).toBeLessThanOrEqual(300);
    expect(await page.evaluate(() => localStorage.getItem('o8:sidebar:visible'))).toBe('true');
    expect(await page.evaluate(() => (window as unknown as { sentTurns: unknown[] }).sentTurns)).toEqual([]);
  } finally { await page.close(); }
}, 60_000);
