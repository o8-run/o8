import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const proofDir = process.env.O8_COMPACTION_INFERENCE_PROOF_DIR;
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import { createElement, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ThemeProvider } from '@/lib/theme/context';
      import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
      import { compactionThread } from '@/components/desktop/thoughts/chat-panel/fixtures/compaction-thread';
      import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
      const restored = deserializeStoredTranscript(serializeTranscriptForStorage(compactionThread.slice(0, 3)));
      function Surface() {
        const [busy, setBusy] = useState(false);
        window.setBusy = setBusy;
        const [liveCompaction, setLiveCompaction] = useState(false);
        window.setLiveCompaction = setLiveCompaction;
        const item = { id: 'follow-up', sequence: 1, repoPath: '/fixture', threadId: 'thoughts-fixture', intent: 'send-next', status: 'queued',
          reason: null, createdAt: 1, updatedAt: 1, admittedAt: null, payload: { text: 'Keep this follow-up queued.', wireMessage: 'Keep this follow-up queued.',
          images: [], routing: { backend: 'codex', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } } };
        return createElement('main', { style: { display: 'flex', flexDirection: 'column', height: '100vh', boxSizing: 'border-box',
          padding: 24, color: 'var(--t-text)', background: 'var(--t-bg)', fontFamily: 'var(--font-sans-system)' } },
          createElement('section', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, width: '100%', maxWidth: 760,
            marginLeft: 'auto', marginRight: 'auto', background: 'var(--t-chat-surface-bg)' } },
            createElement(ChatMessageList, { displayMessages: restored, displayWaiting: busy, liveCompaction, isOrchestratorMode: true,
              activeTargetLabel: 'Lead', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'var(--t-hover)',
              thoughtsElevatedBorder: 'var(--t-divider-subtle)', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
              composerQueue: { items: [item], canSteer: false, onSteer() {}, onCancel() {} }, logLabel: 'Fixture conversation' })));
      }
      createRoot(document.getElementById('root')).render(createElement(ThemeProvider, null, createElement(Surface)));
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process = { env: { NODE_ENV: "production" }, platform: "browser", versions: {} };' },
    loader: { '.css': 'empty', '.ttf': 'dataurl' }, legalComments: 'none', logLevel: 'silent',
  });
  bundle = built.outputFiles[0].text;
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for compaction status rendering verification.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it.each([
  { palette: 'light', surface: 'solid' }, { palette: 'dark', surface: 'solid' },
  { palette: 'light', surface: 'glass' }, { palette: 'dark', surface: 'glass' },
])('keeps a completed boundary and queued follow-up quiet in $palette $surface', async ({ palette, surface }) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://localhost/compaction-fixture');
    await page.evaluate(({ palette, surface }) => {
      localStorage.setItem('cortex-theme-palette', palette);
      localStorage.setItem('cortex-reduce-transparency', surface === 'solid' ? 'on' : 'off');
    }, { palette, surface });
    await page.addStyleTag({ content: fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8') });
    await page.addScriptTag({ content: bundle });
    const divider = page.locator('[data-compaction-divider]');
    await divider.waitFor({ timeout: 5000 }).catch(() => { throw new Error(`Transcript fixture did not mount: ${JSON.stringify(errors)}`); });
    expect(await page.locator('html').getAttribute('data-palette')).toBe(palette);
    expect(await page.locator('html').getAttribute('data-surface')).toBe(surface);
    const queue = page.getByRole('list', { name: 'Queued messages' });
    const log = page.getByRole('log', { name: 'Fixture conversation' });
    for (const width of [900, 1680]) {
      await page.setViewportSize({ width, height: width === 900 ? 700 : 1050 });
      const idleFrame = await log.boundingBox();
      await page.evaluate(() => (window as unknown as { setBusy: (busy: boolean) => void }).setBusy(true));
      if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `${palette}-${surface}-${width}-before-assert.png`) }); }
      await expect.poll(() => page.getByText('Compaction in progress', { exact: true }).count()).toBe(0);
      await expect.poll(() => page.getByText('Planning next moves', { exact: true }).count()).toBe(1);
      if (proofDir) { fs.mkdirSync(proofDir, { recursive: true }); await page.screenshot({ path: path.join(proofDir, `${palette}-${surface}-${width}.png`) }); }
      expect(await page.getByText('Messages sent now will be queued', { exact: false }).count()).toBe(0);
      expect(await queue.textContent()).toContain('Keep this follow-up queued.');
      expect(await queue.getByRole('status').textContent()).toBe('Queued');
      expect(await page.getByText('Keep this follow-up queued.', { exact: true }).count()).toBe(1);
      const bounds = await queue.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const busyFrame = await log.boundingBox();
      expect(busyFrame!.y).toBeCloseTo(idleFrame!.y, 0);
      expect(busyFrame!.height).toBeCloseTo(idleFrame!.height, 0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(busyFrame!.y + busyFrame!.height);
      await page.evaluate(() => (window as unknown as { setLiveCompaction: (value: boolean) => void }).setLiveCompaction(true));
      const warning = page.getByText('Compaction in progress', { exact: true });
      await expect.poll(() => warning.count()).toBe(1);
      expect(await page.getByText('Messages sent now will be queued', { exact: false }).count()).toBe(1);
      expect(await page.getByText('Planning next moves', { exact: true }).count()).toBe(0);
      await warning.scrollIntoViewIfNeeded();
      const warningBounds = await warning.boundingBox();
      expect(warningBounds!.x).toBeGreaterThanOrEqual(0);
      expect(warningBounds!.x + warningBounds!.width).toBeLessThanOrEqual(width);
      if (proofDir) await page.screenshot({ path: path.join(proofDir, `${palette}-${surface}-${width}-live.png`) });
      await page.evaluate(() => (window as unknown as { setLiveCompaction: (value: boolean) => void }).setLiveCompaction(false));
      await expect.poll(() => warning.count()).toBe(0);
      expect(await page.getByText('Messages sent now will be queued', { exact: false }).count()).toBe(0);
      await divider.getByRole('button').click();
      expect(await divider.textContent()).toContain('The route inspection is complete.');
      await divider.getByRole('button').click();
      await page.evaluate(() => (window as unknown as { setBusy: (busy: boolean) => void }).setBusy(false));
      await expect.poll(() => page.getByText('Planning next moves', { exact: true }).count()).toBe(0);
      expect(await divider.textContent()).toContain('Context compacted');
    }
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
