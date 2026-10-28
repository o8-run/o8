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

beforeAll(async () => {
  const at = Date.now() - 100_000;
  const messages = Array.from({ length: 74 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user',
    content: `Saved turn ${i}`, timestamp: at + i * 1000 }));
  for (let i = 0; i < 6; i++) {
    const id = `vis-${randomUUID()}`; ids.push(id);
    const html = `<h2>Saved chart ${i}</h2><button>Explore saved values</button>`;
    const document = { kind: 'o8-visualization' as const, id, title: `Saved chart ${i}`, height: 160,
      createdAt: new Date(at + (3 + i * 12) * 1000).toISOString(), repoPath: repo, threadId, packetId: null,
      html, rootId: id, version: 1, source: { html } };
    insertVisualization(document);
    const reference = visualizationReference(document);
    Object.assign(messages[3 + i * 12], { toolCalls: [{ id: `render-${i}`, name: 'o8_html_render', args: {}, status: 'done',
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
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ThemeProvider } from '@/lib/theme/context';
    import { MessageVisualizations } from '@/components/desktop/visualizations/MessageVisualizations';
    fetch('/history').then(r=>r.json()).then(({messages})=>createRoot(document.getElementById('root')).render(
      <ThemeProvider><main>{messages.map(m=><section key={m.id} style={{minHeight:100}}>
        <p>{m.content}</p><MessageVisualizations toolCalls={m.toolCalls}/></section>)}</main></ThemeProvider>));
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' }, logLevel: 'silent' });
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><style>${readFileSync('src/app/globals.css', 'utf8')}</style><div id="root"></div><script src="/fixture.js"></script>`);
      } else if (req.url === '/fixture.js') {
        res.setHeader('content-type', 'text/javascript'); res.end(built.outputFiles[0].text);
      } else {
        const request = new NextRequest(`${base}${req.url}`, { headers: { authorization: `Bearer ${token}` } });
        const id = req.url?.split('/').at(-1)?.split('?')[0] ?? '';
        if (stalled && id === ids[0] && !req.url?.includes('?')) return;
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
    await expect.poll(() => page.locator('[data-o8-visualization] iframe').count(), { timeout: 16_000 }).toBe(6);
    await expect.poll(() => page.getByText('Loading visualization…', { exact: true }).count(), { timeout: 16_000 }).toBe(0);
    expect(await page.locator('[data-o8-visualization] iframe').evaluateAll(nodes => nodes.every(n => getComputedStyle(n).opacity === '1'))).toBe(true);
    expect(await page.getByText('Context compacted', { exact: true }).count()).toBe(6);
  } finally { await page.close(); }
}, 45_000);

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
    await missing.getByRole('button', { name: 'Rebuild visualization' }).click();
    expect(await missing.getByRole('region', { name: 'Question about this visualization' }).innerText()).toContain('Rebuild');
  } finally { stalled = false; await page.close(); }
}, 60_000);
