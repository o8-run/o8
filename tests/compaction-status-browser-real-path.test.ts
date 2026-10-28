import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { startCompactionBrowserBackend } from './fixtures/compaction-browser-backend';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';

const proof = process.env.O8_COMPACTION_STATUS_PROOF_DIR;
let origin = process.env.O8_COMPACTION_STATUS_ORIGIN;
let server: Server | undefined; let browser: Browser;
let backend: Awaited<ReturnType<typeof startCompactionBrowserBackend>>;
beforeAll(async () => {
  if (proof) {
    if (resolve(proof).startsWith(`${process.cwd()}${sep}`)) throw new Error('Screenshots must be outside the repository.');
    mkdirSync(proof, { recursive: true });
  }
  {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ThemeProvider } from '@/lib/theme/context';
      import { DesktopWebSocketProvider, useSharedDesktopWs, useWsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
      import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
      import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
      import { compactionThread } from '@/components/desktop/thoughts/chat-panel/fixtures/compaction-thread';
      import { deserializeStoredTranscript } from '@/lib/transcripts/history-serde';
      const params = new URL(location.href).searchParams;
      const threadId = params.get('threadId') || 'thoughts-fixture';
      const repoPath = params.get('repoPath') || '/fixture';
      function Surface() {
        const [messages, setMessages] = useState(params.has('threadId') ? [] : compactionThread);
        const connection = useWsConnectionState();
        const load = () => fetch('/api/v2/chat-history?tabId=' + encodeURIComponent(threadId))
          .then(response => response.json()).then(data => setMessages(deserializeStoredTranscript(data.messages)));
        useEffect(() => { if (params.has('threadId')) void load(); }, []);
        useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
          const mutation = event.data?.mutation;
          if (params.has('threadId') && mutation?.surfaceId === threadId && ['completed','failed'].includes(mutation.status)) void load();
        }});
        return <main data-socket-state={connection} style={{display:'flex',flexDirection:'column',height:'100vh',boxSizing:'border-box',padding:12,
          color:'var(--t-text)',background:'var(--t-bg)',fontFamily:'var(--font-sans-system)'}}>
          <section style={{display:'flex',flexDirection:'column',minHeight:0,flex:1,width:'100%',maxWidth:760,margin:'auto',background:'var(--t-chat-surface-bg)'}}>
          <ChatMessageList displayMessages={messages} displayWaiting={params.has('threadId')} isOrchestratorMode activeTargetLabel="Lead"
            activeTargetColor="var(--t-accent)" thoughtsMutedGlass="var(--t-hover)" thoughtsElevatedBorder="none" thoughtsElevatedShadow="none" emptyStateFallback={null}/>
          <ComposerArea literalInput input="Keep the next follow-up visible." onInputChange={()=>{}} isOrchestratorMode displayWaiting={params.has('threadId')}
            chatMessages={messages} sessionRulesThreadId={threadId} repoPath={repoPath} showBrain={false} activeTargetLabel="Lead"
            targetAgentExists thoughtsBodyBackground="transparent" enhancing={false} preEnhanceInput={null} onEnhance={()=>{}} onUndoEnhance={()=>{}}
            onSubmit={()=>{}} onSlashCommand={()=>{}} modelLabel="Default" effort="high" onEffortChange={()=>{}} adaptiveEnabled={false}
            repoLabel="Sample" displayMessagesCount={messages.length} hasAssistantActivity/>
          </section>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<ThemeProvider><DesktopWebSocketProvider><Surface/></DesktopWebSocketProvider></ThemeProvider>);
    ` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@': resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_RUNTIME': '"browser"',
      'process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY': '""' },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty', '.ttf': 'dataurl' }, legalComments: 'none', logLevel: 'silent' });
    const html = `<!doctype html><html><head><style>${readFileSync('src/app/globals.css', 'utf8')}</style></head><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    backend = await startCompactionBrowserBackend(html);
    if (!origin) {
      server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
      await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing browser fixture listener');
      origin = `http://127.0.0.1:${address.port}`;
    }
  }
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for compaction status verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 120_000);
afterAll(async () => {
  await browser?.close(); await backend?.stop();
  await new Promise<void>(done => server ? server.close(() => done()) : done());
});

it('serves the production compaction route instead of HTML for API requests', async () => {
  const response = await fetch(`${backend.origin}/api/orchestrator/compact`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: '/missing-fixture', threadId: 'thoughts-missing-fixture', trigger: 'manual' }) });
  expect(response.headers.get('content-type')).toContain('application/json');
  expect((await response.json()).ok).toBe(false);
});

// This matrix isolates rendering; the production lifecycle journeys follow it.
for (const appearance of ['light', 'dark', 'light-glass', 'dark-glass', 'all-glass']) {
  it.each([390, 900])(`renders status fixtures without composer movement in ${appearance} at %ipx`, async width => {
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

async function productionPage(width: number) {
  const fixture = backend.seed();
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const mutations: RealtimeMutationRecord[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.channel !== 'realtime' || message.event !== 'batch') return;
    for (const event of message.data.events) {
      const mutation = event.data?.mutation as RealtimeMutationRecord | undefined;
      if (mutation?.action === 'orchestrator-compaction' && mutation.surfaceId === fixture.threadId) mutations.push(mutation);
    }
  }));
  await page.addInitScript(() => {
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'on');
    const phases: string[] = [];
    Object.assign(window, { observedCompactionPhases: phases });
    new MutationObserver(() => {
      const phase = document.querySelector('[data-compaction-phase]')?.getAttribute('data-compaction-phase');
      if (phase) phases.push(phase);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-compaction-phase'] });
  });
  const url = `${backend.origin}/?${new URLSearchParams({ threadId: fixture.threadId, repoPath: backend.repoPath })}`;
  const ready = async () => {
    await expect.poll(() => page.locator('[data-socket-state]').getAttribute('data-socket-state')).toBe('connected');
    await page.locator(`[data-o8-message-id="${fixture.ids.at(-1)}"]`).waitFor();
  };
  await page.goto(url); await ready();
  return { page, mutations, errors, ready, ...fixture };
}

async function requestCompaction(page: Page, threadId: string) {
  await page.evaluate(scope => {
    // A reload may abort this browser request; the accepted server operation
    // still owns its durable completion, just as it does in the dashboard.
    void fetch('/api/orchestrator/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, trigger: 'manual' }) }).then(response => response.json()).catch(() => {});
  }, { threadId, repoPath: backend.repoPath });
}

async function activeOperation(view: Awaited<ReturnType<typeof productionPage>>) {
  await expect.poll(() => view.mutations.find(mutation => mutation.status === 'pending')).toBeTruthy();
  const pending = view.mutations.find(mutation => mutation.status === 'pending')!;
  const row = view.page.locator('[data-compaction-status]');
  await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('compacting');
  expect(await row.getAttribute('data-compaction-operation')).toBe(pending.mutationId);
  expect(await row.locator('[role="progressbar"]').getAttribute('aria-valuenow')).toBeNull();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(22);
  expect(await view.page.getByText('Planning next moves', { exact: true }).count()).toBe(0);
  expect(await view.page.getByText(/^(Waiting for response|Working · phase unknown)$/).count()).toBe(1);
  return pending;
}

it('drives active and cleared status through the compact route, real event stream and saved history', async () => {
  const view = await productionPage(900); const { page, threadId } = view;
  const attempt = backend.prepare(threadId);
  try {
    const textarea = page.locator('[data-o8-composer-root] textarea').first();
    const settledBounds = await textarea.boundingBox();
    await requestCompaction(page, threadId);
    await expect.poll(attempt.entered).toBe(true);
    const pending = await activeOperation(view);
    expect(await textarea.boundingBox()).toEqual(settledBounds);
    // Drop polling responses: the terminal frame must settle this mounted UI.
    backend.setUnavailable(threadId, true); attempt.release();
    expect((await attempt.result).status).toBe(200);
    await expect.poll(() => view.mutations.some(mutation => mutation.status === 'completed'
      && mutation.mutationId === pending.mutationId)).toBe(true);
    const row = page.locator('[data-compaction-status]');
    await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('complete');
    const saved = backend.history(threadId);
    for (const id of view.ids) expect(saved.messages.filter(message => message.id === id)).toHaveLength(1);
    const boundary = saved.messages.find(message => message.compaction?.operationId === pending.mutationId)!;
    expect(boundary).toBeDefined();
    await expect.poll(() => page.locator(`[data-o8-message-id="${boundary.id}"]`).count()).toBe(1);
    backend.setUnavailable(threadId, false);
    await page.clock.install(); await page.clock.fastForward(7100);
    await expect.poll(() => row.count()).toBe(0);
    expect(await textarea.boundingBox()).toEqual(settledBounds);
    expect(await textarea.inputValue()).toBe('Keep the next follow-up visible.');
    expect(await page.getByText('Planning next moves', { exact: true }).count()).toBe(0);
    expect(await page.getByText(/^(Waiting for response|Working · phase unknown)$/).count()).toBe(1);
    expect(view.errors).toEqual([]);
  } finally { backend.setUnavailable(threadId, false); attempt.release(); await attempt.result; await page.close(); }
}, 45_000);

it('shows a real compactor failure at narrow width without moving or clearing the composer', async () => {
  const view = await productionPage(390); const { page, threadId } = view;
  const attempt = backend.prepare(threadId, true);
  try {
    const textarea = page.locator('[data-o8-composer-root] textarea').first(); const bounds = await textarea.boundingBox();
    await requestCompaction(page, threadId); const pending = await activeOperation(view);
    backend.setUnavailable(threadId, true); attempt.release();
    expect((await attempt.result).status).toBe(500);
    await expect.poll(() => view.mutations.some(mutation => mutation.status === 'failed'
      && mutation.mutationId === pending.mutationId)).toBe(true);
    const row = page.locator('[data-compaction-status]');
    await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('failed');
    const statusBounds = (await row.boundingBox())!;
    expect(statusBounds.x + statusBounds.width).toBeLessThanOrEqual(390);
    expect(await textarea.boundingBox()).toEqual(bounds);
    expect(await textarea.inputValue()).toBe('Keep the next follow-up visible.');
    expect(backend.history(threadId).messages).toHaveLength(view.ids.length);
    expect(view.errors).toEqual([]);
  } finally { backend.setUnavailable(threadId, false); attempt.release(); await attempt.result; await page.close(); }
}, 45_000);

it.each([390, 900])('keeps a real completed operation settled through reload and delayed readback at %ipx', async width => {
  const view = await productionPage(width); const { page, threadId } = view;
  const attempt = backend.prepare(threadId);
  let delayed: ReturnType<typeof backend.holdNextReadback> | undefined;
  try {
    const textarea = page.locator('[data-o8-composer-root] textarea').first(); const bounds = await textarea.boundingBox();
    await requestCompaction(page, threadId); const pending = await activeOperation(view);
    backend.setUnavailable(threadId, true);
    await page.reload(); await view.ready();
    delayed = backend.holdNextReadback(threadId); backend.setUnavailable(threadId, false);
    expect(await backend.republish(pending)).toBe(true);
    expect((await delayed.captured)?.phase).toBe('compacting');
    backend.setUnavailable(threadId, true); attempt.release();
    expect((await attempt.result).status).toBe(200);
    const row = page.locator('[data-compaction-status]');
    await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('complete');
    delayed.release(); expect(await backend.republish(pending)).toBe(true);
    await new Promise(done => setTimeout(done, 150));
    expect(await row.getAttribute('data-compaction-phase')).toBe('complete');
    expect(await page.evaluate(() => (window as unknown as { observedCompactionPhases: string[] }).observedCompactionPhases)).not.toContain('compacting');
    backend.setUnavailable(threadId, false);
    await page.reload(); await view.ready();
    await expect.poll(() => row.getAttribute('data-compaction-phase')).toBe('complete');
    expect(await page.evaluate(() => (window as unknown as { observedCompactionPhases: string[] }).observedCompactionPhases)).not.toContain('compacting');
    const saved = backend.history(threadId);
    expect(saved.messages.filter(message => message.compaction?.operationId === pending.mutationId)).toHaveLength(1);
    for (const id of view.ids) expect(saved.messages.filter(message => message.id === id)).toHaveLength(1);
    expect(await textarea.boundingBox()).toEqual(bounds);
    expect(await textarea.inputValue()).toBe('Keep the next follow-up visible.');
    expect(view.errors).toEqual([]);
  } finally {
    delayed?.release(); backend.setUnavailable(threadId, false); attempt.release(); await attempt.result; await page.close();
  }
}, 45_000);
