import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const access = vi.hoisted(() => ({ role: 'operator' }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipalContext: () => ({ role: access.role }) }));
const directory = mkdtempSync(join(tmpdir(), 'o8-mobile-visuals-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'fixture.db'));
const repo = join(directory, 'project'); mkdirSync(repo);
writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'project', name: 'Project', localPath: repo,
  remoteUrl: null, defaultBranch: 'main', isGitRepo: false, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }] }));
const threadId = 'thoughts-mobile-visual';
const id = 'vis-12345678-1234-4234-8234-123456789abc';
const { GET: read } = await import('@/app/api/visualizations/[id]/route');
const { GET: list } = await import('@/app/api/visualizations/route');
const { insertVisualization } = await import('@/lib/visualizations/store');
const { closeDb } = await import('@/lib/db');
let server: Server;
let browser: Browser;
let base: string;
let bundle: string;
let viewerBundle: string | undefined;
const reads: string[] = [];

async function compile(contents: string) {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' }, logLevel: 'silent' });
  return result.outputFiles[0].text;
}
beforeAll(async () => {
  insertVisualization({ kind: 'o8-visualization', id, title: 'Saved mobile chart', height: 240,
    createdAt: new Date().toISOString(), html: '<section style="height:180px;position:relative"><h2 style="margin:0;line-height:24px">Saved mobile values</h2><button id="count" style="position:absolute;left:0;top:50px;width:120px;height:44px">0</button></section><script>document.querySelector("#count").addEventListener("click", e => { e.target.textContent = Number(e.target.textContent) + 1; o8Viz.setState({clicks:Number(e.target.textContent)}); })</script>',
    repoPath: repo, threadId, packetId: null });
  closeDb();
  bundle = await compile(`
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { OrchestratorView } from '@/components/mobile/OrchestratorView';
    import { ThemeProvider } from '@/components/mobile/ThemeContext';
    createRoot(document.getElementById('root')).render(<ThemeProvider><OrchestratorView onBack={()=>{}} /></ThemeProvider>);
  `);
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, base);
      if (url.pathname === '/mobile' || url.pathname.startsWith('/mobile/visualizations/')) {
        res.setHeader('content-type', 'text/html');
        res.setHeader('content-security-policy', "frame-src http://localhost:* http://127.0.0.1:* 'self'; frame-ancestors 'self'");
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;font-family:system-ui}#root{height:100dvh}*{box-sizing:border-box}</style><div id="root"></div><script src="/fixture.js?viewer=' + (url.pathname !== '/mobile' ? '1' : '0') + '"></script>');
        return;
      }
      if (url.pathname === '/fixture.js') {
        if (url.searchParams.get('viewer') === '1' && !viewerBundle) viewerBundle = await compile(`
          import React from 'react'; import { createRoot } from 'react-dom/client';
          import Page from '@/app/mobile/visualizations/[id]/page';
          Page({params:Promise.resolve({id:location.pathname.split('/').pop()})}).then(node=>createRoot(document.getElementById('root')).render(node));
        `);
        res.setHeader('content-type', 'text/javascript'); res.end(url.searchParams.get('viewer') === '1' ? viewerBundle : bundle); return;
      }
      let response: Response;
      if (url.pathname.startsWith('/api/visualizations/')) {
        reads.push(url.pathname);
        response = await read(new NextRequest(url), { params: Promise.resolve({ id: url.pathname.split('/').pop()! }) });
      } else if (url.pathname === '/api/visualizations') response = await list(new NextRequest(url));
      else if (url.pathname === '/api/mobile/orchestrator/threads') response = Response.json({ threads: [{ id: threadId, title: 'Saved visual thread', repoPath: repo, repoName: 'Project', lastActivity: Date.now() }] });
      else if (url.pathname === '/api/v2/chat-history') response = Response.json({ messages: [{ id: 'answer', role: 'assistant', content: 'Explore the saved chart.', timestamp: Date.now() }] });
      else response = Response.json({});
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for the mobile visualization test.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close(); server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

async function tapSavedValue(page: Page) {
  const frame = page.locator('[data-o8-visualization] > iframe');
  await expect.poll(() => frame.evaluate(node => getComputedStyle(node).opacity), { timeout: 10_000 }).toBe('1');
  const box = await frame.boundingBox();
  if (!box) throw new Error('The saved visualization has no visible frame.');
  // Touch the fixture's button inside both opaque frames. Its state travels
  // through the production bridge and persists in the host's existing store.
  await page.touchscreen.tap(box.x + 60, box.y + 72);
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem(`o8:visualization-view:v1:${id}`) ?? '{}').clicks, id)).toBe(1);
}

it('opens a saved thread visualization through its mobile deep link and the existing read route', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${base}/mobile`);
    const open = page.getByRole('link', { name: 'Open Saved mobile chart', exact: true });
    await open.waitFor({ timeout: 3000 });
    expect(await open.getAttribute('href')).toBe(`/mobile/visualizations/${id}`);
    await open.tap();
    await page.waitForURL(`**/mobile/visualizations/${id}`);
    const frame = page.locator('[data-o8-visualization] > iframe');
    // Readiness comes from the real inner frame after it reports its rendered height.
    await expect.poll(() => frame.evaluate(node => getComputedStyle(node).opacity), { timeout: 10_000 }).toBe('1');
    expect(await frame.getAttribute('srcdoc')).toContain('Saved mobile values');
    await tapSavedValue(page);
    expect(reads).toContain(`/api/visualizations/${id}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goBack();
    await page.getByText('Saved visual thread', { exact: true }).first().waitFor();
  } finally { await page.close(); }
}, 20_000);
it('cold-opens the deep link after a reload at a narrow phone width', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${base}/mobile/visualizations/${id}`); await page.reload();
    await tapSavedValue(page);
    expect(await page.getByRole('link', { name: 'Back to mobile' }).getAttribute('href')).toBe('/mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); }
}, 20_000);
it('preserves the existing read route refusal for enrolled-device authority', async () => {
  access.role = 'device';
  try {
    expect((await read(new NextRequest(`${base}/api/visualizations/${id}`), { params: Promise.resolve({ id }) })).status).toBe(401);
  } finally { access.role = 'operator'; }
});
