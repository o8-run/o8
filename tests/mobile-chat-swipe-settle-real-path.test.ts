import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

// Render the production chat list, SwipeActions and gesture hook. Only the HTTP
// boundary is held so we can observe confirmation, refusal and pending requests.
const title = 'A long conversation title '.repeat(12);
let browser: Browser;
let page: Page;
let bundle: string;
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'o8-mobile-chat-swipe-'));

beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
        import { ChatListView } from './src/app/mobile/mobile-approvals-chat-list-view';
        import { getMobilePalette } from './src/app/mobile/mobile-approvals-shared';
        window.probe = { requests: [], selected: [], refreshes: 0 };
        window.fetch = (url, init) => new Promise((resolve, reject) => {
          window.probe.requests.push({ url, method: init.method, body: JSON.parse(init.body) });
          window.reply = (status) => resolve(Response.json({ error: 'Conversation is still running.' }, { status }));
          window.fail = () => reject(new Error('Offline'));
        });
        function App() {
          const runtime = useLocalRuntime({ async *run() {} });
          return <AssistantRuntimeProvider runtime={runtime}>
            <ChatListView conversations={[{
              tabId: 'mobile-chat-fixture', title: ${JSON.stringify(title)},
              lastMessage: '', updatedAt: new Date().toISOString(),
              model: 'fixture-model',
            }]} loading={false} palette={getMobilePalette(location.hash.slice(1))}
              onSelect={id => window.probe.selected.push(id)} onNewChat={() => {}}
              onRefresh={() => { window.probe.refreshes++; }} />
          </AssistantRuntimeProvider>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: process.cwd(), outdir: tempDir,
  }).finally(() => esbuild.stop());
  bundle = result.outputFiles[0].text;
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('Chromium is required for the phone layout regression.');
  browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); rmSync(tempDir, { recursive: true, force: true }); });

async function render(width = 320, theme = 'dark') {
  page = await browser.newPage({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true });
  await page.goto(`about:blank#${theme}`);
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>body { margin: 0 } * { box-sizing: border-box }</style><div id="root" style="padding:16px;display:flex;height:100vh"></div>');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: title, exact: false }).waitFor();
}

function row() { return page.getByRole('button', { name: title, exact: false }); }
async function probe() {
  return page.evaluate(() => (window as unknown as { probe: {
    requests: Array<{ url: string; method: string; body: unknown }>;
    selected: string[]; refreshes: number;
  } }).probe);
}

async function drag(dx: number, dy = 0) {
  const box = (await row().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

async function touchDrag(dx: number) {
  const box = (await row().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + dx * step / 6, y }],
      });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

async function confirmStrip() {
  await page.getByRole('alertdialog', { name: 'Confirm settle' }).waitFor({ timeout: 2_000 });
  return page.getByRole('alertdialog', { name: 'Confirm settle' });
}

describe('mobile chat swipe to settle (#5298)', () => {
  it.each([{ width: 320, theme: 'light', dx: -105 }, { width: 390, theme: 'dark', dx: 105 }])(
    'confirms the existing settle request at $width in $theme', async ({ width, theme, dx }) => {
      await render(width, theme);
      await touchDrag(dx);
      const strip = await confirmStrip();
      expect(await probe()).toEqual({ requests: [], selected: [], refreshes: 0 });
      const geometry = await strip.evaluate(element => {
        const wrapper = element.parentElement!.getBoundingClientRect();
        return [...element.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect();
          return { height: box.height, fits: box.left >= wrapper.left && box.right <= wrapper.right
            && box.top >= wrapper.top && box.bottom <= wrapper.bottom,
          reachable: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
        });
      });
      expect(geometry).toHaveLength(2);
      for (const button of geometry) {
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.fits).toBe(true);
        expect(button.reachable).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Let the browser finish the touch gesture and snap animation before
      // starting a separate confirmation tap.
      await page.waitForTimeout(500);
      await strip.getByRole('button', { name: 'Confirm settle' }).tap();
      await expect.poll(async () => (await probe()).requests).toEqual([{
        url: '/api/v2/chat-history', method: 'PATCH', body: { tabId: 'mobile-chat-fixture', inboxAction: 'settle' },
      }]);
      expect(await row().getAttribute('aria-busy')).toBe('true');
      await drag(-dx);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
      expect((await probe()).requests).toHaveLength(1);
      await page.evaluate(() => (window as unknown as { reply: (status: number) => void }).reply(200));
      await expect.poll(async () => (await probe()).refreshes).toBe(1);
      expect((await probe()).selected).toEqual([]);
      await expect.poll(() => row().getAttribute('aria-busy')).toBe('false');
      expect(await page.getByRole('status').textContent()).toBe('Conversation settled.');
    },
  );

  it('cancels, snaps back on short or vertical drags, and retains tap and long press', async () => {
    await render();
    await drag(-105);
    await (await confirmStrip()).getByRole('button', { name: 'Cancel' }).tap();
    await drag(-30);
    await drag(5, 35);
    expect(await page.getByRole('alertdialog').count()).toBe(0);
    expect(await probe()).toEqual({ requests: [], selected: [], refreshes: 0 });
    await row().focus();
    await page.keyboard.press('Enter');
    expect((await probe()).selected).toEqual(['mobile-chat-fixture']);
    await row().tap();
    expect((await probe()).selected).toEqual(['mobile-chat-fixture', 'mobile-chat-fixture']);
    const box = (await row().boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + 28);
    await page.mouse.down();
    await page.getByRole('button', { name: 'Rename', exact: true }).waitFor({ timeout: 2_000 });
    await page.mouse.up();
    expect((await probe()).requests).toEqual([]);
    expect((await probe()).selected).toHaveLength(2);
  });

  it.each(['refusal', 'offline'])('shows %s without refresh and allows retry', async failure => {
    await render();
    await drag(105);
    await (await confirmStrip()).getByRole('button', { name: 'Confirm settle' }).tap();
    await page.evaluate(failure => {
      const fixture = window as unknown as { reply: (status: number) => void; fail: () => void };
      if (failure === 'refusal') fixture.reply(409);
      else fixture.fail();
    }, failure);
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toBe(
      failure === 'refusal' ? 'Conversation is still running.' : 'Offline',
    );
    expect((await probe()).refreshes).toBe(0);
    expect((await probe()).selected).toEqual([]);
    expect(await row().isEnabled()).toBe(true);
    await drag(-105);
    await (await confirmStrip()).getByRole('button', { name: 'Confirm settle' }).tap();
    expect((await probe()).requests).toHaveLength(2);
    await page.evaluate(() => (window as unknown as { reply: (status: number) => void }).reply(200));
    await expect.poll(async () => (await probe()).refreshes).toBe(1);
  });
});
