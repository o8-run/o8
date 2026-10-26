import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

// Exercise the production panel, data hooks, file rows and both renderers.
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';
const files = Array.from({ length: 18 }, (_, index) => ({
  path: 'file-' + index + '.txt', status: 'modified', additions: 44, deletions: 40,
}));
const patch = (path, hideWhitespace) => [0, 1, 2, 3].map(hunk => {
  const start = 1 + hunk * 30;
  const additions = hideWhitespace && path === 'file-12.txt' && hunk === 2 ? 8 : 11;
  return '@@ -' + start + ',11 +' + start + ',' + (additions + 1) + ' @@\\n anchor-' + path + '-' + hunk + '\\n'
    + Array.from({ length: 10 }, (_, line) => '-old-' + path + '-' + hunk + '-' + line + ' ' + 'old text '.repeat(28)).join('\\n') + '\\n'
    + Array.from({ length: additions }, (_, line) => '+new-' + path + '-' + hunk + '-' + line + ' ' + 'new text '.repeat(28)).join('\\n');
}).join('\\n');
window.fetch = async input => String(input).includes('/api/review/workspace?')
  ? Response.json({ changedFiles: files, branch: 'main' })
  : String(input).includes('/api/panel/file-diff?')
    ? Response.json({ diff: patch(new URL(String(input), 'http://fixture.invalid').searchParams.get('path'), String(input).includes('ignoreWhitespace=1')) })
    : Response.json({ ok: false, artifacts: [], filePaths: [] });
createRoot(document.getElementById('root')).render(createElement(ReviewPanel, { repoPath: '/fixture/repo' }));
`;
let browser: Browser;
let bundle: string;
let page: Page;
const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const fileRow = () => page.locator('button[title="file-12.txt"][aria-expanded]').locator('..');
const waitForPatches = (exactAddition = true) => page.waitForFunction(exact => {
  const headers = [...document.querySelectorAll('button[title^="file-"][aria-expanded="true"]')];
  const target = document.querySelector('button[title="file-12.txt"][aria-expanded]')?.parentElement;
  return headers.length === 18 && headers.every(button => button.parentElement?.querySelector('[data-review-line="R:102"]'))
    && Boolean(target?.querySelector('[data-review-line="R:70"]')) === exact;
}, exactAddition);

beforeAll(async () => {
  const executablePath = resolveBrowserPath();
  if (!executablePath) throw new Error('A browser executable is required for review layout verification');
  const built = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/src` }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it.each([{ label: 'normal', width: 440, height: 600 }, { label: 'maximized', width: 1280, height: 850 }])
('keeps a wrapped non-top file and hunk through both toolbar mode switches in $label Review', async ({ label, width, height }) => {
  page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="file-12.txt"][aria-expanded]').waitFor();
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    await page.getByText('anchor-file-12.txt-2', { exact: true }).waitFor();
    await page.locator('button[title="file-4.txt"][aria-expanded]').click();
    const header = page.locator('button[title="file-12.txt"][aria-expanded]');
    const contents = await fileRow().textContent();
    const totals = await header.textContent();
    const inspected = () => page.getByText('anchor-file-12.txt-2', { exact: true }).last();
    await inspected().evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    const before = await inspected().boundingBox();
    const fileBefore = await header.boundingBox();
    if (!before || !fileBefore) throw new Error('Inspected hunk missing');
    for (const mode of ['split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await settle();
      const after = await inspected().boundingBox();
      console.info('review-position', JSON.stringify({ panel: label, mode, before: before.y, after: after?.y,
        fileBefore: fileBefore.y, fileAfter: (await header.boundingBox())?.y }));
      expect(after?.y).toBeGreaterThanOrEqual(before.y - 2);
      expect(after?.y).toBeLessThanOrEqual(before.y + 2);
      expect(await header.textContent()).toBe(totals);
      expect(await header.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('button[title="file-4.txt"][aria-expanded]').getAttribute('aria-expanded')).toBe('false');
      // Split places paired replacements next to one another; every source string survives.
      expect((await fileRow().textContent())?.replace(/\s/g, '')).toContain('new-file-12.txt-2-10');
    }
    expect(await fileRow().textContent()).toBe(contents);
  } finally { await page.close(); }
}, 60_000);

it.each([{ label: 'normal', width: 440, height: 600 }, { label: 'maximized', width: 1280, height: 850 }]
  .flatMap(panel => ['R:70', 'L:70'].map(anchor => ({ ...panel, anchor }))))
('keeps the original $anchor side and line through repeated round trips in $label Review', async ({ label, width, height, anchor }) => {
  page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="file-12.txt"][aria-expanded]').waitFor();
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    const inspected = () => fileRow().locator(`[data-review-line="${anchor}"]`);
    await inspected().waitFor();
    await inspected().evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    const before = await inspected().boundingBox();
    if (!before) throw new Error('Inspected addition missing');
    for (let round = 0; round < 3; round += 1) {
      for (const mode of ['split', 'unified']) {
        await page.locator(`button[title="Switch to ${mode} diff"]`).click();
        await settle();
        if (round === 0 && mode === 'split') await page.waitForTimeout(550);
        const after = await inspected().boundingBox();
        console.info('review-round-trip', JSON.stringify({ panel: label, round, mode, anchor, before: before.y, after: after?.y }));
        expect(after?.y).toBeGreaterThanOrEqual(before.y - 2);
        expect(after?.y).toBeLessThanOrEqual(before.y + 2);
      }
    }
    await page.waitForTimeout(550);
    const next = () => fileRow().locator(`[data-review-line="${anchor[0]}:95"]`);
    await next().evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    const moved = await next().boundingBox();
    if (!moved) throw new Error('New reading position missing');
    for (const mode of ['split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await settle();
      const after = await next().boundingBox();
      expect(after?.y).toBeGreaterThanOrEqual(moved.y - 2);
      expect(after?.y).toBeLessThanOrEqual(moved.y + 2);
    }
    await page.waitForTimeout(550);
    await page.setViewportSize({ width: width + 24, height });
    await inspected().evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    const wheeled = await inspected().boundingBox();
    if (!wheeled) throw new Error('Wheel reading position missing');
    for (const mode of ['split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await settle();
      const after = await inspected().boundingBox();
      expect(after?.y).toBeGreaterThanOrEqual(wheeled.y - 2);
      expect(after?.y).toBeLessThanOrEqual(wheeled.y + 2);
    }
  } finally { await page.close(); }
}, 60_000);

it.each(['click', 'Enter', 'Space'])
('replaces a retained anchor after a resize and Files drawer selection by %s', async input => {
  page = await browser.newPage({ viewport: { width: 440, height: 600 } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    await waitForPatches();
    const inspected = page.locator('button[title="file-9.txt"][aria-expanded]').locator('..').locator('[data-review-line="R:70"]');
    await inspected.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    await page.locator('button[title="Switch to split diff"]').click();
    await settle();
    // Resize after the temporary mode-switch observer has relinquished control.
    await page.waitForTimeout(550);
    await page.setViewportSize({ width: 520, height: 650 });
    await page.locator('button[title="Show files"]').click();
    const selected = page.getByRole('complementary', { name: 'Review files' }).locator('button[title="file-2.txt"]');
    if (input === 'click') await selected.click();
    else { await selected.focus(); await selected.press(input); }
    // Wait for the actual smooth selection scroll to reach its requested margin.
    await page.waitForFunction(() => {
      const row = document.querySelector('button[title="file-2.txt"][aria-expanded]')?.parentElement;
      const scroll = row?.parentElement;
      return row && scroll && Math.abs(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top
        - parseFloat(getComputedStyle(row).scrollMarginTop)) < 1;
    });
    await page.getByRole('button', { name: 'Close files drawer' }).click();
    await settle();
    const header = page.locator('button[title="file-2.txt"][aria-expanded]');
    const before = await header.boundingBox();
    if (!before) throw new Error('Selected file missing');
    for (const mode of ['unified', 'split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await settle();
      const after = await header.boundingBox();
      console.info('review-drawer-selection', JSON.stringify({ input, mode, before: before.y, after: after?.y }));
      expect(after?.y).toBeGreaterThanOrEqual(before.y - 2);
      expect(after?.y).toBeLessThanOrEqual(before.y + 2);
    }
  } finally { await page.close(); }
}, 60_000);

it('uses the nearest line on the original side only while the exact addition is absent', async () => {
  page = await browser.newPage({ viewport: { width: 440, height: 600 } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="file-12.txt"][aria-expanded]').waitFor();
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    const line = (key: string) => fileRow().locator(`[data-review-line="${key}"]`);
    await waitForPatches();
    await settle();
    await line('R:70').evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 3;
    });
    await settle();
    const before = await line('R:70').boundingBox();
    if (!before) throw new Error('Inspected addition missing');
    await page.locator('button[title="Switch to split diff"]').click();
    await settle();
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Hide whitespace' }).click();
    // All reloaded rows contribute to the selected line's layout, including earlier files.
    await waitForPatches(false);
    await settle();
    expect(await line('R:70').count()).toBe(0);
    expect(await line('L:70').count()).toBe(1);
    for (const mode of ['unified', 'split']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await settle();
      const fallback = await line('R:69').boundingBox();
      expect(fallback?.y).toBeGreaterThanOrEqual(before.y - 2);
      expect(fallback?.y).toBeLessThanOrEqual(before.y + 2);
    }
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Hide whitespace' }).click();
    await waitForPatches();
    await settle();
    await page.locator('button[title="Switch to unified diff"]').click();
    await settle();
    const exact = await line('R:70').boundingBox();
    expect(exact?.y).toBeGreaterThanOrEqual(before.y - 2);
    expect(exact?.y).toBeLessThanOrEqual(before.y + 2);
  } finally { await page.close(); }
}, 60_000);
