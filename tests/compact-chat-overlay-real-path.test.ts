// Production column, theme provider, chat rows and CSS over a fixture transcript.
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const source = resolve('src/components/desktop/shell/ChatListColumn.tsx');
const proof = process.env.O8_CHAT_OVERLAY_PROOF_DIR;
const baseline = process.env.O8_CHAT_OVERLAY_SOURCE_FILE;
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatListCard } from '@/app/dashboard/ChatListCard';
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { ChatListColumn } from '@/components/desktop/shell/ChatListColumn';
import { HistoryChatRow } from '@/components/desktop/repo-focus/tabs/chats/HistoryRows';
function Shell() {
  const [visible, setVisible] = useState(true);
  const [wide, setWide] = useState(innerWidth > 1000);
  const [selected, select] = useState('chat-1');
  const { workspaceGlass, surface } = useTheme();
  window.fixtureToggle = () => setVisible(value => !value);
  window.fixtureWide = value => setWide(value);
  const glass = workspaceGlass || surface === 'glass';
  return <main style={{ position: 'relative', display: 'flex', width: '100vw', height: '100vh', background: 'var(--t-bg-gradient)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <nav aria-label="Fixture rail" style={{ width: 60, flexShrink: 0 }} />
    <ChatListColumn visible={visible} width={320} overlay={!wide} onClose={() => setVisible(false)}>
      <div style={{ height: 40, flexShrink: 0, paddingLeft: 12, display: 'flex', alignItems: 'center' }}>Chats</div>
      <ChatListCard glass={glass} joined={!workspaceGlass} overlay={!wide}>
        <div data-list-scroll style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {Array.from({ length: 72 }, (_, index) => {
            const id = 'chat-' + index;
            return <HistoryChatRow key={id} item={{ tabId: id, title: index % 2 ? 'Review saved workspace state' : 'Investigate terminal output', modifiedAt: '2026-10-24T00:00:00Z', savedAt: '2026-10-24T00:00:00Z', pinned: false, starred: false, empty: false, messageCount: 3 }}
              compact active={selected === id} disabled={false} onOpen={() => select(id)} />;
          })}
        </div>
        <textarea aria-label="Fixture draft" defaultValue="Keep my unsent draft" style={{ marginTop: 8, color: 'var(--t-text)', background: 'var(--t-input-bg)' }} />
      </ChatListCard>
    </ChatListColumn>
    <section aria-label="Fixture transcript" style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: 'var(--t-chat-surface-bg)', color: 'var(--t-chat-surface-text)', fontSize: 18, lineHeight: '36px' }}>
      {Array.from({ length: 50 }, (_, index) => <div key={index}>Workspace transcript {index}: preserve the current request and its saved context.</div>)}
    </section>
  </main>;
}
createRoot(document.getElementById('root')).render(<ThemeProvider><Shell /></ThemeProvider>);
`;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': resolve('src') },
    plugins: baseline ? [{ name: 'baseline-column', setup(plugin) {
      plugin.onLoad({ filter: /ChatListColumn\.tsx$/ }, (args) => args.path === source
        ? { contents: readFileSync(baseline, 'utf8'), loader: 'tsx', resolveDir: dirname(source) } : undefined);
    } }] : [],
    legalComments: 'none', logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
  if (proof) mkdirSync(proof, { recursive: true });
}, 30_000);

for (const engine of ['chromium', 'webkit'] as const) describe.runIf(engine === 'webkit'
  ? existsSync(webkit.executablePath()) : Boolean(resolveBrowserPath()))(`compact chat overlay in ${engine}`, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = engine === 'webkit' ? await webkit.launch({ headless: true })
      : await chromium.launch({ executablePath: resolveBrowserPath() ?? undefined, headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });
  for (const appearance of ['light', 'dark', 'light-glass', 'dark-glass', 'all-glass'] as const) {
    for (const width of [900, 1680]) it(`preserves backing, fit and list state in ${appearance} at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 900 ? 700 : 1050 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.route('**/*', (route) => route.request().url() === 'http://overlay.fixture/'
          // Supply a dark host backdrop for glass; this is not native vibrancy.
          ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${readFileSync('src/app/globals.css', 'utf8')}</style></head><body style="margin:0"><div id="root" style="background:var(--t-panel-solid)"></div></body></html>` })
          : route.abort());
        await page.addInitScript((mode) => {
          Object.assign(window, { __O8_HOST_PLATFORM__: 'macos' });
          localStorage.setItem('cortex-theme-palette', mode.startsWith('light') ? 'light' : 'dark');
          localStorage.setItem('cortex-workspace-glass', String(mode === 'all-glass'));
          localStorage.setItem('cortex-reduce-transparency', mode.includes('glass') ? 'off' : 'on');
        }, appearance);
        await page.goto('http://overlay.fixture/');
        await page.addScriptTag({ content: bundle });
        const column = page.locator('#o8-chat-list');
        await column.waitFor();
        const original = await column.elementHandle();
        await page.locator('textarea').fill('Retain the changed draft');
        await page.locator('[data-list-scroll]').evaluate((element) => { element.scrollTop = 180; });
        const measure = await column.evaluate((element) => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return { background: style.background, filter: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
            painted: style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)',
            right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom, position: style.position };
        });
        if (proof) await page.screenshot({ path: join(proof, `${engine}-${appearance}-${width}.png`) });
        expect(measure.width).toBe(width === 900 ? 300 : 320);
        expect(measure.right).toBeLessThanOrEqual(width);
        expect(measure.top).toBeGreaterThanOrEqual(0);
        expect(measure.bottom).toBeLessThanOrEqual(width === 900 ? 700 : 1050);
        if (width === 900) {
          expect(measure.position).toBe('absolute');
          expect(measure.painted).toBe(true);
          if (appearance === 'all-glass') expect(measure.filter).toContain('blur(24px)');
          else expect(measure.filter).toBe('none');
          // The production card must inherit the overlay's palette ink,
          // rather than the in-flow chrome scope's forced white variables.
          expect(await page.locator('[data-list-scroll]').evaluate((element) => getComputedStyle(element).getPropertyValue('--t-text').trim()))
            .toBe(await column.evaluate((element) => getComputedStyle(element).getPropertyValue('--t-text').trim()));
        } else expect(measure.position).toBe('relative');
        await page.locator('textarea').press('Escape');
        await expect.poll(() => column.isVisible()).toBe(false);
        await page.evaluate(() => (window as unknown as { fixtureToggle(): void }).fixtureToggle());
        await column.waitFor();
        await expect.poll(() => page.locator('textarea').inputValue()).toBe('Retain the changed draft');
        expect(await page.locator('[data-list-scroll]').evaluate((element) => element.scrollTop)).toBe(180);
        expect(await original!.evaluate((element) => element === document.getElementById('o8-chat-list'))).toBe(true);
        await page.evaluate(() => (window as unknown as { fixtureWide(value: boolean): void }).fixtureWide(innerWidth <= 1000));
        await expect.poll(() => column.evaluate((element) => element.style.position)).toBe(width === 900 ? 'relative' : 'absolute');
        expect(await page.locator('textarea').inputValue()).toBe('Retain the changed draft');
        expect(await page.locator('[data-list-scroll]').evaluate((element) => element.scrollTop)).toBe(180);
        expect(errors).toEqual([]);
        if (appearance === 'all-glass' && width === 900) {
          await page.evaluate(() => (window as unknown as { fixtureWide(value: boolean): void }).fixtureWide(false));
          await expect.poll(() => column.evaluate((element) => element.style.position)).toBe('absolute');
          await column.evaluate((element) => {
            // Verify the backing itself, without foreground rows or CSS blur.
            (element as HTMLElement).style.backdropFilter = 'none';
            (element as HTMLElement).style.setProperty('-webkit-backdrop-filter', 'none');
            for (const child of element.children) (child as HTMLElement).style.visibility = 'hidden';
          });
          const pixel = async (background: string) => {
            await page.locator('section').evaluate((element, value) => { element.replaceChildren(); element.style.background = value; }, background);
            const png = await page.screenshot({ clip: { x: 200, y: 300, width: 1, height: 1 } });
            return page.evaluate((encoded) => new Promise<number[]>((resolve, reject) => {
              const image = new Image();
              image.onload = () => {
                const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
                const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
                resolve([...context.getImageData(0, 0, 1, 1).data].slice(0, 3));
              };
              image.onerror = () => reject(new Error('Could not decode fixture pixel'));
              image.src = 'data:image/png;base64,' + encoded;
            }), png.toString('base64'));
          };
          const black = await pixel('rgb(0, 0, 0)'); const white = await pixel('rgb(255, 255, 255)');
          // At least 90% of the high-contrast workspace is blocked even when
          // WebKit cannot composite backdrop blur through the native layout.
          expect(Math.max(...black.map((value, index) => Math.abs(value - white[index])))).toBeLessThanOrEqual(26);
        }
      } finally { await page.close(); }
    });
  }
});
