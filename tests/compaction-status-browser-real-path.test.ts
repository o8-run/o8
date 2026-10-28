import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const proof = process.env.O8_COMPACTION_STATUS_PROOF_DIR;
let origin = process.env.O8_COMPACTION_STATUS_ORIGIN;
let server: Server | undefined; let browser: Browser;
beforeAll(async () => {
  if (proof) {
    if (resolve(proof).startsWith(`${process.cwd()}${sep}`)) throw new Error('Screenshots must be outside the repository.');
    mkdirSync(proof, { recursive: true });
  }
  if (!origin) {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ThemeProvider } from '@/lib/theme/context';
      import { DesktopWebSocketProvider } from '@/components/desktop/hooks/DesktopWebSocketContext';
      import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
      import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
      import { compactionThread } from '@/components/desktop/thoughts/chat-panel/fixtures/compaction-thread';
      createRoot(document.getElementById('root')).render(<ThemeProvider><DesktopWebSocketProvider>
        <main style={{display:'flex',flexDirection:'column',height:'100vh',boxSizing:'border-box',padding:12,
          color:'var(--t-text)',background:'var(--t-bg)',fontFamily:'var(--font-sans-system)'}}>
          <section style={{display:'flex',flexDirection:'column',minHeight:0,flex:1,width:'100%',maxWidth:760,margin:'auto',background:'var(--t-chat-surface-bg)'}}>
          <ChatMessageList displayMessages={compactionThread} displayWaiting={false} isOrchestratorMode activeTargetLabel="Lead"
            activeTargetColor="var(--t-accent)" thoughtsMutedGlass="var(--t-hover)" thoughtsElevatedBorder="none" thoughtsElevatedShadow="none" emptyStateFallback={null}/>
          <ComposerArea literalInput input="Keep the next follow-up visible." onInputChange={()=>{}} isOrchestratorMode displayWaiting={false}
            chatMessages={compactionThread} sessionRulesThreadId="thoughts-fixture" repoPath="/fixture" showBrain={false} activeTargetLabel="Lead"
            targetAgentExists thoughtsBodyBackground="transparent" enhancing={false} preEnhanceInput={null} onEnhance={()=>{}} onUndoEnhance={()=>{}}
            onSubmit={()=>{}} onSlashCommand={()=>{}} modelLabel="Default" effort="high" onEffortChange={()=>{}} adaptiveEnabled={false}
            repoLabel="Sample" displayMessagesCount={5} hasAssistantActivity/>
          </section>
        </main>
      </DesktopWebSocketProvider></ThemeProvider>);
    ` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_RUNTIME': '"browser"',
      'process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY': '""' },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty', '.ttf': 'dataurl' }, legalComments: 'none', logLevel: 'silent' });
    const html = `<!doctype html><html><head><style>${readFileSync('src/app/globals.css', 'utf8')}</style></head><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing browser fixture listener');
    origin = `http://127.0.0.1:${address.port}`;
  }
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for compaction status verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(done => server ? server.close(() => done()) : done()); });

for (const appearance of ['light', 'dark', 'light-glass', 'dark-glass', 'all-glass']) {
  it.each([390, 900])(`keeps active, cleared and unconfirmed compaction quiet and stable in ${appearance} at %ipx`, async width => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: Date.now() });
    let unavailable = false;
    let operation = { operationId: 'compaction-browser-proof', repoPath: '/fixture', threadId: 'thoughts-fixture', phase: 'compacting',
      requestedAt: Date.now() - 14_000, startedAt: Date.now() - 12_000, updatedAt: Date.now(), settledAt: undefined as number | undefined };
    await page.routeWebSocket('**/ws?**', socket => { socket.onMessage(() => {}); });
    await page.route('**/api/**', route => {
      if (route.request().url().includes('/api/orchestrator/compact?')) return unavailable ? route.abort('failed') : route.fulfill({ json: { operation } });
      return route.fulfill({ json: {} });
    });
    await page.addInitScript(mode => {
      Object.assign(window, { __O8_HOST_PLATFORM__: 'macos' });
      localStorage.setItem('cortex-theme-palette', mode.startsWith('light') ? 'light' : 'dark');
      localStorage.setItem('cortex-workspace-glass', String(mode === 'all-glass'));
      localStorage.setItem('cortex-reduce-transparency', mode.includes('glass') ? 'off' : 'on');
    }, appearance);
    try {
      await page.goto(`${origin}/preview/compaction-thread?composer=1&view=reloaded`);
      const row = page.locator('[data-compaction-status]');
      await row.waitFor({ timeout: 10_000 });
      expect(await row.getAttribute('data-compaction-phase')).toBe('compacting');
      expect(await row.locator('[role="progressbar"]').getAttribute('aria-valuenow')).toBeNull();
      expect(await page.getByText('Messages sent now will be queued', { exact: false }).count()).toBe(0);
      const textarea = page.locator('[data-o8-composer-root] textarea').first();
      const activeBounds = await textarea.boundingBox();
      const bounds = await row.boundingBox();
      expect(bounds!.height).toBeLessThanOrEqual(22);
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      if (proof) await page.screenshot({ path: join(proof, `${appearance}-${width}-active.png`) });
      await page.clock.fastForward(31_000);
      await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('compacting');
      expect(await row.getByRole('button', { name: 'Check status' }).count()).toBe(1);
      expect(await textarea.boundingBox()).toEqual(activeBounds);
      const now = await page.evaluate(() => Date.now());
      operation = { ...operation, phase: 'complete', settledAt: now, updatedAt: now };
      await page.clock.fastForward(1100);
      await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('complete');
      await page.clock.fastForward(7100);
      await expect.poll(() => row.count()).toBe(0);
      expect(await textarea.boundingBox()).toEqual(activeBounds);
      if (proof) await page.screenshot({ path: join(proof, `${appearance}-${width}-cleared.png`) });
      // Reopen the same production tree with an active receipt, then lose all
      // verification. The elapsed state must become uncertain, never a timer-based success.
      operation = { ...operation, operationId: 'compaction-stalled-proof', phase: 'compacting', requestedAt: now + 8200,
        startedAt: now + 8200, updatedAt: now + 8200, settledAt: undefined };
      await page.reload(); await row.waitFor();
      unavailable = true;
      await page.clock.fastForward(46_000);
      await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('uncertain');
      expect(await row.getByRole('button', { name: 'Check status' }).count()).toBe(1);
      expect(await row.locator('[role="progressbar"]').count()).toBe(0);
      expect(await textarea.boundingBox()).toEqual(activeBounds);
      expect(await textarea.inputValue()).toBe('Keep the next follow-up visible.');
      if (proof) await page.screenshot({ path: join(proof, `${appearance}-${width}-stalled.png`) });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 45_000);
}
