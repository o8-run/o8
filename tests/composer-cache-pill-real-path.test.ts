import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const repoRoot = process.cwd();
const proofDir = process.env.O8_CACHE_PROOF_DIR;
const proofState = process.env.O8_CACHE_PROOF_STATE ?? 'test';
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import DashboardPage from '@/app/dashboard/page';
import { MODEL_IDS } from '@/lib/models';
const cacheNow = Date.now();
localStorage.setItem('o8:prompt-cache-observations:v1', JSON.stringify([{ id: 'fixture-cache', session: 'thoughts-existing', runtime: 'codex', model: MODEL_IDS.codexDefault, startedAt: cacheNow - 60000, endedAt: cacheNow, input: 100, read: 900, write: 0, requestedLifetimeMs: 300000, idleGapMs: null }, { id: 'expired-cache', session: 'thoughts-expired', runtime: 'codex', model: MODEL_IDS.codexDefault, startedAt: cacheNow - 660000, endedAt: cacheNow - 600000, input: 100, read: 900, write: 0, requestedLifetimeMs: 300000, idleGapMs: null }]));
localStorage.setItem('fixture:terminal:tile-root', JSON.stringify({ version: 1, activeTabId: 'existing', savedAt: new Date().toISOString(),
  tabs: [{ id: 'existing', kind: 'orchestrator', label: 'Existing conversation', repoPath: '/fixture', repoName: 'Fixture', cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: 'thoughts-existing' }, { id: 'expired', kind: 'orchestrator', label: 'Expired conversation', repoPath: '/fixture', repoName: 'Fixture', cliAgent: 'shell', mode: 'fleet', orchestratorThreadId: 'thoughts-expired' }] }));
localStorage.setItem('fixture:history:thoughts-existing', JSON.stringify({ backend: 'codex', model: MODEL_IDS.codexDefault, repoPath: '/fixture', title: 'Existing conversation', messages:
  Array.from({ length: 35 }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', text: 'Retained source message ' + i, timestamp: i + 1 })) }));
localStorage.setItem('fixture:history:thoughts-expired', JSON.stringify({ backend: 'codex', repoPath: '/fixture', title: 'Expired conversation', messages: [] }));
window.sentTurns = [];
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.includes('operator-defaults')) return Response.json({ values: { orchestratorBackend: 'codex', orchestratorModel: MODEL_IDS.codexDefault, telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false } });
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
  if (!executablePath) throw new Error('Chromium is required for composer cache verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it.each(['light', 'dark'] as const)('shows the estimate inside the mounted composer cache control in %s', async palette => {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 }, deviceScaleFactor: 2 });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://localhost/dashboard');
    await page.addStyleTag({ content: fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8') });
    await page.evaluate(palette => {
      localStorage.setItem('cortex-theme-palette', palette); localStorage.setItem('cortex-reduce-transparency', 'on');
      localStorage.setItem('o8:sidebar:visible', 'false');
    }, palette);
    await page.addScriptTag({ content: bundle });
    const input = page.locator('[data-o8-workspace-root] textarea').first();
    await input.waitFor();
    const pill = page.locator('[data-context-meter]').first();
    await pill.waitFor();
    if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `${proofState}-${palette}-600.png`) }); }
    await expect.poll(() => pill.textContent()).toMatch(/~[1-5]m/);
    expect(await page.locator('[data-session-cache]').count()).toBe(1);
    expect(await pill.evaluate(node => Boolean(node.closest('[data-o8-composer-root]')))).toBe(true);
    await pill.hover();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor();
    expect(await tooltip.textContent()).toContain('min left · estimate');
    await page.mouse.move(590, 20);
    await pill.focus();
    expect(await tooltip.isVisible()).toBe(true);
    expect(await tooltip.textContent()).toContain('reuse is not guaranteed');
    await pill.press('Enter');
    expect(await pill.getAttribute('aria-expanded')).toBe('true');
    expect(await page.getByText('Runtime reported', { exact: true }).count() + await page.getByText('Estimated locally', { exact: true }).count()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => pill.getAttribute('aria-expanded')).toBe('false');
    await input.fill('Unsent draft remains here');
    await input.focus();
    for (const width of [600, 390, 900, 600, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(200);
      const footer = page.getByTestId('composer-selector-footer').filter({ visible: true }).first();
      const controls = footer.locator('button');
      expect(await controls.count(), 'footer lost a control').toBe(10);
      const layout = await controls.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        let clipped = box.width < 1 || box.height < 1 || !node.checkVisibility({ checkVisibilityCSS: true });
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (/(hidden|clip)/.test(style.overflowX)) {
            const bounds = parent.getBoundingClientRect();
            clipped ||= box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5;
          }
        }
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { name: node.getAttribute('aria-label') ?? node.getAttribute('title') ?? node.textContent, clipped, reachable: node.contains(hit) };
      }));
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, `${proofState}-${palette}-${width}.png`) });
        fs.writeFileSync(path.join(proofDir, `${proofState}-${palette}-${width}.json`), JSON.stringify(await footer.evaluate(node => ({ html: node.outerHTML, box: node.getBoundingClientRect().toJSON() })), null, 2));
      }
      expect(layout.filter(control => control.clipped), `clipped footer controls at ${width}px`).toEqual([]);
      expect(layout.filter(control => !control.reachable), `covered footer controls at ${width}px`).toEqual([]);
      const show = footer.getByRole('button', { name: 'Show with images' }).first();
      expect(await show.isVisible(), `Show is missing at ${width}px`).toBe(true);
      expect(await show.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Show text clipped').toBe(true);
      const leadLabel = footer.getByTestId('composer-selector-lead-label');
      expect(await leadLabel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'model label clipped').toBe(true);
      expect(await pill.innerText(), `cache estimate hidden at ${width}px`).toMatch(/~[1-5]m/);
      if (width === 900) expect(await pill.innerText()).toMatch(/Warm ~[1-5]m/);
      const box = (await pill.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expect.poll(() => pill.textContent()).toMatch(/~[1-5]m/);
      const send = page.locator('[data-testid="composer-send-control"]').filter({ visible: true }).first();
      const sendBox = (await send.boundingBox())!;
      expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(width);
      expect(await send.evaluate(node => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await pill.hover();
      await expect.poll(() => tooltip.isVisible()).toBe(true);
      expect(await tooltip.textContent()).toContain('reuse is not guaranteed');
      await input.focus();
      await pill.focus();
      expect(await tooltip.isVisible()).toBe(true);
      await input.focus();
    }
    await page.locator('[data-o8-workspace-tab="expired"]').click();
    const expired = page.locator('[data-context-meter][data-session-cache="thoughts-expired"]');
    await expect.poll(() => expired.textContent()).toContain('Cold');
    expect(await expired.getAttribute('aria-label')).toContain('Cache likely cold · estimate');
    await page.locator('[data-o8-workspace-tab="existing"]').click();
    await expect.poll(() => page.locator('[data-context-meter][data-session-cache="thoughts-existing"]').textContent()).toMatch(/~[1-5]m/);
    expect(await page.evaluate(() => (window as unknown as { sentTurns: unknown[] }).sentTurns)).toEqual([]);
  } finally { await page.close(); }
}, 60_000);
