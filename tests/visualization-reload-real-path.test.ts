import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { visualizationReference } from '@/lib/visualizations/types';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(), requestRealtimeRefresh: vi.fn() }));
const directory = mkdtempSync(join(tmpdir(), 'o8-visual-reload-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'fixture.db'));
const token = 'visualization-reload-fixture-token-0123456789';
writeFileSync(join(directory, 'ws-token'), token);
const { GET: visualization } = await import('@/app/api/visualizations/[id]/route');
const { insertVisualization } = await import('@/lib/visualizations/store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { writePersistedLlmChat, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const repo = join(directory, 'repo'); mkdirSync(repo);
const threadId = 'thoughts-visualization-reload';
const ids: string[] = [];
let server: Server;
let browser: Browser;
let base: string;
let stalled = false;
let stallNearest = false;
let sourceDelay = 100;

beforeAll(async () => {
  const at = Date.now() - 100_000;
  const messages = Array.from({ length: 74 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user',
    content: `Saved turn ${i}`, timestamp: at + i * 1000 }));
  for (let i = 0; i < 30; i++) {
    const id = `vis-${randomUUID()}`; ids.push(id);
    const html = `<h2>Saved chart ${i}</h2><button>Explore saved values</button>`;
    const document = { kind: 'o8-visualization' as const, id, title: `Saved chart ${i}`, height: 160,
      createdAt: new Date(at + (3 + i * 2) * 1000).toISOString(), repoPath: repo, threadId, packetId: null,
      html, rootId: id, version: 1, source: { html } };
    insertVisualization(document);
    const reference = visualizationReference(document);
    Object.assign(messages[3 + i * 2], { toolCalls: [{ id: `render-${i}`, name: 'o8_html_render', args: {}, status: 'done',
      result: JSON.stringify({ visualization: reference }) }] });
  }
  // Canonical visible history retains old tool results beside persisted compaction boundaries.
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [...messages, ...Array.from({ length: 6 }, (_, i) => ({
    id: `compaction-${i}`, role: 'system', content: 'Context compacted', timestamp: at + 74_000 + i,
    type: 'compaction', isCompaction: true, compactedCount: 12,
    compaction: { timestamp: at + 74_000 + i, trigger: 'manual', source: 'summary', summary: 'Saved decisions',
      compactedThroughId: messages[11 + i * 12].id, summarizedMessageIds: messages.slice(0, 12 + i * 12).map(message => message.id) },
  }))] as Parameters<typeof writePersistedLlmChat>[1]['messages'] });
  closeDb();
  const built = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React, { useLayoutEffect } from 'react'; import { createRoot } from 'react-dom/client';
    import { ThemeProvider } from '@/lib/theme/context';
    import { MessageVisualizations } from '@/components/desktop/visualizations/MessageVisualizations';
    function AtTail({children}) { useLayoutEffect(()=>{const root=document.getElementById('root'); root.scrollTop=root.scrollHeight;},[]); return children; }
    fetch('/history').then(r=>r.json()).then(({messages})=>createRoot(document.getElementById('root')).render(
      <ThemeProvider><AtTail><main>{messages.map(m=><section key={m.id} style={{minHeight:100}}>
        <p>{m.content}</p><MessageVisualizations toolCalls={m.toolCalls}/></section>)}{location.search==='?duplicate' ? <MessageVisualizations toolCalls={messages[3].toolCalls}/> : null}</main></AtTail></ThemeProvider>));
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' }, logLevel: 'silent' });
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url?.startsWith('/?')) {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><style>${readFileSync('src/app/globals.css', 'utf8')}</style><div id="root" style="height:700px;overflow:auto"></div><script src="/fixture.js"></script>`);
      } else if (req.url === '/fixture.js') {
        res.setHeader('content-type', 'text/javascript'); res.end(built.outputFiles[0].text);
      } else {
        const request = new NextRequest(`${base}${req.url}`, { headers: { authorization: `Bearer ${token}` } });
        const id = req.url?.split('/').at(-1)?.split('?')[0] ?? '';
        if (!req.url?.includes('?') && req.url?.startsWith('/api/visualizations/')) {
          if ((stallNearest && ids.slice(-4).includes(id)) || (stalled && id === ids[0])) return;
          // Keep requests outstanding long enough to expose an unbounded burst.
          await new Promise(done => setTimeout(done, sourceDelay));
        }
        const response = req.url === '/history' ? Response.json(readPersistedLlmChat(threadId)!.history)
          : await visualization(request, { params: Promise.resolve({ id }) });
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: resolveBrowserPath() ?? undefined, headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close(); server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

it('resolves every saved card after a cold reload of compacted history, including offscreen cards', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await page.goto(base); await page.locator('[data-o8-visualization]').first().waitFor({ timeout: 3000 });
    await page.reload();
    await expect.poll(() => page.locator('[data-o8-visualization] iframe').count(), { timeout: 16_000 }).toBe(30);
    await expect.poll(() => page.getByText('Loading visualization…', { exact: true }).count(), { timeout: 16_000 }).toBe(0);
    expect(await page.locator('[data-o8-visualization] iframe').evaluateAll(nodes => nodes.every(n => getComputedStyle(n).opacity === '1'))).toBe(true);
    expect(await page.getByText('Context compacted', { exact: true }).count()).toBe(6);
  } finally { await page.close(); }
}, 45_000);

it('bounds 30 real saved source requests to four and starts with cards nearest the viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const active = new Set<unknown>();
  const requested: string[] = [];
  let peak = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/visualizations/') || url.search) return;
    requested.push(url.pathname.split('/').at(-1)!);
    active.add(request); peak = Math.max(peak, active.size);
  });
  page.on('requestfinished', request => active.delete(request));
  page.on('requestfailed', request => active.delete(request));
  try {
    await page.goto(base);
    await expect.poll(() => page.locator('[data-o8-visualization] > iframe').evaluateAll(nodes =>
      nodes.filter(n => getComputedStyle(n).opacity === '1').length), { timeout: 16_000 }).toBe(30);
    expect(requested).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(4);
    expect(new Set(requested.slice(0, 4))).toEqual(new Set(ids.slice(-4)));
    expect(await page.getByText('Loading visualization…', { exact: true }).count()).toBe(0);
  } finally { await page.close(); }
}, 30_000);

it('deduplicates the same saved source across two mounted cards', async () => {
  const page = await browser.newPage();
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/visualizations/') && !url.search) requested.push(url.pathname.split('/').at(-1)!);
  });
  try {
    await page.goto(`${base}?duplicate`);
    await expect.poll(() => page.locator('[data-o8-visualization] > iframe').evaluateAll(nodes =>
      nodes.filter(n => getComputedStyle(n).opacity === '1').length), { timeout: 16_000 }).toBe(31);
    expect(requested.filter(id => id === ids[0])).toHaveLength(1);
    expect(requested).toHaveLength(30);
  } finally { await page.close(); }
}, 30_000);

it('gives all 30 healthy sources their own deadline after waiting for a fetch slot', async () => {
  sourceDelay = 2000;
  const page = await browser.newPage();
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/visualizations/') && !url.search) requested.push(url.pathname);
  });
  try {
    await page.addInitScript(() => {
      const errors: string[] = [];
      Object.assign(window, { visualizationErrors: errors });
      new MutationObserver(() => {
        document.querySelectorAll('[data-o8-visualization]').forEach(card => {
          if (card.querySelector('button')?.textContent === 'Retry visualization') errors.push(card.textContent ?? '');
        });
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(base);
    await expect.poll(() => page.locator('[data-o8-visualization] > iframe').evaluateAll(nodes =>
      nodes.filter(n => getComputedStyle(n).opacity === '1').length), { timeout: 25_000 }).toBe(30);
    expect(requested).toHaveLength(30);
    expect(await page.evaluate(() => Reflect.get(window, 'visualizationErrors'))).toEqual([]);
    expect(await page.getByText('Loading visualization…', { exact: true }).count()).toBe(0);
  } finally { sourceDelay = 100; await page.close(); }
}, 35_000);

it('releases stalled fetch slots so queued cards can load without expiring first', async () => {
  stallNearest = true;
  const page = await browser.newPage();
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/visualizations/') && !url.search) requested.push(url.pathname);
  });
  try {
    await page.goto(base);
    await expect.poll(() => page.locator('[data-o8-visualization] > iframe').evaluateAll(nodes =>
      nodes.filter(n => getComputedStyle(n).opacity === '1').length), { timeout: 20_000 }).toBe(26);
    expect(await page.getByRole('button', { name: 'Retry visualization' }).count()).toBe(4);
    expect(await page.getByText('Loading visualization…', { exact: true }).count()).toBe(0);
    expect(requested).toHaveLength(30);
    expect(await page.getByRole('button', { name: 'Rebuild visualization', exact: true }).count()).toBe(4);
  } finally { stallNearest = false; await page.close(); }
}, 30_000);

it('ends a missing or stalled source with recovery controls, then retries a recovered request', async () => {
  getSqlite().prepare('DELETE FROM transcript_visualizations WHERE id=?').run(ids[5]);
  stalled = true;
  const page = await browser.newPage();
  try {
    await page.goto(base); await page.reload();
    const missing = page.locator(`[data-o8-visualization="${ids[5]}"]`);
    await expect.poll(() => missing.innerText(), { timeout: 16_000 }).toMatch(/unavailable/i);
    expect(await missing.getByRole('button', { name: 'Rebuild visualization' }).count()).toBe(1);
    const waiting = page.locator(`[data-o8-visualization="${ids[0]}"]`);
    await expect.poll(() => waiting.innerText(), { timeout: 20_000 }).toMatch(/could not be loaded|did not finish loading/i);
    stalled = false;
    await waiting.getByRole('button', { name: 'Retry visualization' }).click();
    await expect.poll(() => waiting.locator('iframe').count(), { timeout: 16_000 }).toBe(1);
    await expect.poll(() => waiting.getByText('Loading visualization…').count(), { timeout: 16_000 }).toBe(0);
    await missing.getByRole('button', { name: 'Rebuild visualization' }).press('Enter');
    expect(await missing.getByRole('region', { name: 'Question about this visualization' }).innerText()).toContain('Rebuild');
  } finally { stalled = false; await page.close(); }
}, 60_000);
