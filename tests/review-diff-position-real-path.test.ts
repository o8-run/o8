import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

// Real panel, data hooks, toolbar, expanded files and both diff renderers.
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
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

beforeAll(async () => {
  const executablePath = resolveBrowserPath()
    ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined);
  if (!executablePath) throw new Error('Browser required for Review layout regression');
  const built = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/src` }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it.each([900, 1680].flatMap(width => ['light', 'dark'].flatMap(theme =>
  ['old', 'new'].map(side => ({ width, height: width === 900 ? 700 : 1050, theme, side })))))
('keeps a deep wrapped $side source line across repeated diff switches at $width in $theme', async ({ width, height, theme, side }) => {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.setDefaultTimeout(10_000);
  try {
    await page.setContent(`<html style="color-scheme:${theme};--t-bg:${theme === 'light' ? '#fff' : '#111'};--t-text:${theme === 'light' ? '#111' : '#eee'}"><body style="margin:0"><div id="root" style="width:${width === 900 ? '440px' : '100vw'};height:100vh;margin-left:auto"></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="file-12.txt"][aria-expanded]').waitFor();
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    // All earlier files must have their real geometry before choosing the deep anchor.
    await expect.poll(() => page.getByText('anchor-file-', { exact: false }).count()).toBe(72);
    await frames(page);
    const header = page.locator('button[title="file-12.txt"][aria-expanded]');
    const totals = await header.textContent();
    const row = header.locator('..');
    const contents = await row.textContent();
    const source = (line: number) => row.getByText(`${side === 'old' ? '-' : '+'}${side}-file-12.txt-2-${line} ` + `${side} text `.repeat(28), { exact: true });
    const inspected = source(8);
    const position = async () => (await inspected.boundingBox())!.y;
    await inspected.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 7;
    });
    await frames(page);
    const before = await position();
    expect(before).toBeGreaterThan(40);
    expect(before).toBeLessThan(100);
    for (let round = 0; round < 5; round += 1) {
      for (const mode of ['split', 'unified']) {
        await page.locator(`button[title="Switch to ${mode} diff"]`).click();
        await frames(page);
        await page.waitForTimeout(120);
        const after = await position();
        console.info('review-anchor', JSON.stringify({ width, theme, side, round, mode, before, after }));
        expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
        expect(await header.textContent()).toBe(totals);
        expect(await header.getAttribute('aria-expanded')).toBe('true');
        expect(await page.locator('button[title^="file-"][aria-expanded="true"]').count()).toBe(18);
        if (mode === 'unified') expect(await row.textContent()).toBe(contents);
        expect(await row.getByText('anchor-file-12.txt-2', { exact: true }).count()).toBeGreaterThan(0);
      }
    }
    // User scrolling must replace the retained source anchor, including programmatic navigation.
    const moved = source(2);
    await moved.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 7;
    });
    await frames(page);
    const movedBefore = (await moved.boundingBox())!.y;
    for (const mode of ['split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await frames(page);
      expect(Math.abs((await moved.boundingBox())!.y - movedBefore)).toBeLessThanOrEqual(2);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60_000);

it('restores the original source after whitespace refetch and honors a later Files drawer selection', async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(10_000);
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    await expect.poll(() => page.getByText('anchor-file-', { exact: false }).count()).toBe(72);
    const row = page.locator('button[title="file-12.txt"][aria-expanded]').locator('..');
    const target = row.getByText('+new-file-12.txt-2-8 ' + 'new text '.repeat(28), { exact: true });
    await target.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 7;
    });
    await frames(page);
    const before = (await target.boundingBox())!.y;
    await page.locator('button[title="Switch to split diff"]').click();
    await frames(page);
    // Force an actual empty/loading phase, then stagger earlier-file completion.
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (String(args[0]).includes('/api/panel/file-diff?')) {
          const path = new URL(String(args[0]), 'http://fixture.invalid').searchParams.get('path')!;
          await new Promise(resolve => setTimeout(resolve, path === 'file-12.txt' ? 30 : 150));
        }
        return response;
      };
    });
    const whitespace = async () => {
      await page.locator('button[title="View options"]').click();
      await page.getByRole('menuitem', { name: 'Hide whitespace' }).click();
      await expect.poll(() => page.getByText('anchor-file-', { exact: false }).count()).toBe(144);
      await frames(page);
    };
    await whitespace();
    expect(await target.count()).toBe(0);
    const nearest = row.getByText('+new-file-12.txt-2-7 ' + 'new text '.repeat(28), { exact: true });
    expect(Math.abs((await nearest.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
    await whitespace();
    expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
    await page.locator('button[title="Switch to unified diff"]').click();
    await frames(page);
    expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 960, height: 700 });
    await frames(page);
    await page.locator('button[title="Show files"]').click();
    await page.locator('button[title="file-2.txt"]:not([aria-expanded])').click();
    const selected = page.locator('button[title="file-2.txt"][aria-expanded]');
    const selectedOffset = () => selected.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      return node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
    await expect.poll(selectedOffset, { timeout: 5_000 }).toBeCloseTo(46, 0);
    await frames(page);
    for (const mode of ['split', 'unified', 'split', 'unified']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await frames(page);
      expect(Math.abs(await selectedOffset() - 46)).toBeLessThanOrEqual(2);
    }
  } finally { await page.close(); }
}, 60_000);

it.each(['unified', 'split'])('keeps the final source line at its viewport offset at the scroll limit starting in %s', async startMode => {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:100vw;height:100vh"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    await expect.poll(() => page.getByText('anchor-file-', { exact: false }).count()).toBe(72);
    if (startMode === 'split') {
      await page.locator('button[title="Switch to split diff"]').click();
      await frames(page);
    }
    const target = page.locator('[data-review-file="file-17.txt"] [data-review-line~="R:102"]');
    const before = await target.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && (getComputedStyle(scroll).overflowY !== 'auto' || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop = scroll.scrollHeight;
      return node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
    await frames(page);
    for (const mode of startMode === 'unified' ? ['split', 'unified', 'split', 'unified'] : ['unified', 'split', 'unified', 'split']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await frames(page);
      await page.waitForTimeout(120);
      const after = await target.evaluate(node => {
        let scroll = node.parentElement;
        while (scroll && (getComputedStyle(scroll).overflowY !== 'auto' || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;
        if (!scroll) throw new Error('Review scroller missing');
        const rect = node.getBoundingClientRect(), view = scroll.getBoundingClientRect();
        return { offset: rect.top - view.top, visible: rect.top < view.bottom && rect.bottom > view.top };
      });
      expect(after.visible).toBe(true);
      expect(Math.abs(after.offset - before)).toBeLessThanOrEqual(2);
    }
  } finally { await page.close(); }
}, 60_000);

it('keeps a partially scrolled wrapped L70 anchored through split and unified round trips', async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.setContent('<html><body style="margin:0"><div id="root" style="width:440px;height:100vh;margin-left:auto"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.locator('button[title="View options"]').click();
    await page.getByRole('menuitem', { name: 'Expand all' }).click();
    await expect.poll(() => page.getByText('anchor-file-', { exact: false }).count()).toBe(72);
    await page.locator('button[title="Switch to split diff"]').click();
    await frames(page);
    const target = page.locator('[data-review-file="file-12.txt"] [data-review-line~="L:70"]');
    const before = await target.evaluate(node => {
      let scroll = node.parentElement;
      while (scroll && (getComputedStyle(scroll).overflowY !== 'auto' || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;
      if (!scroll) throw new Error('Review scroller missing');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 140;
      const rect = node.getBoundingClientRect(), top = scroll.getBoundingClientRect().top;
      return { offset: rect.top - top, fraction: (top + 8 - rect.top) / rect.height };
    });
    expect(Math.abs(before.offset + 140)).toBeLessThanOrEqual(1);
    expect(before.fraction).toBeLessThan(1);
    await frames(page);
    for (const mode of ['unified', 'split', 'unified', 'split']) {
      await page.locator(`button[title="Switch to ${mode} diff"]`).click();
      await frames(page);
      await page.waitForTimeout(120);
      const after = await target.evaluate((node, fraction) => {
        let scroll = node.parentElement;
        while (scroll && (getComputedStyle(scroll).overflowY !== 'auto' || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;
        if (!scroll) throw new Error('Review scroller missing');
        const rect = node.getBoundingClientRect(), view = scroll.getBoundingClientRect();
        return { point: rect.top + fraction * rect.height - view.top, offset: rect.top - view.top,
          visible: rect.bottom > view.top && rect.top < view.bottom };
      }, before.fraction);
      expect(after.visible).toBe(true);
      expect(Math.abs(after.point - 8)).toBeLessThanOrEqual(2);
      if (mode === 'split') expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2);
    }
  } finally { await page.close(); }
}, 60_000);
