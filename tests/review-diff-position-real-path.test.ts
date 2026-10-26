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
const patch = path => [0, 1, 2, 3].map(hunk => {
  const start = 1 + hunk * 30;
  return '@@ -' + start + ',11 +' + start + ',12 @@\\n anchor-' + path + '-' + hunk + '\\n'
    + Array.from({ length: 10 }, (_, line) => '-old-' + path + '-' + hunk + '-' + line + ' ' + 'old text '.repeat(28)).join('\\n') + '\\n'
    + Array.from({ length: 11 }, (_, line) => '+new-' + path + '-' + hunk + '-' + line + ' ' + 'new text '.repeat(28)).join('\\n');
}).join('\\n');
window.fetch = async input => String(input).includes('/api/review/workspace?')
  ? Response.json({ changedFiles: files, branch: 'main' })
  : String(input).includes('/api/panel/file-diff?')
    ? Response.json({ diff: patch(new URL(String(input), 'http://fixture.invalid').searchParams.get('path')) })
    : Response.json({ ok: false, artifacts: [], filePaths: [] });
createRoot(document.getElementById('root')).render(createElement(ReviewPanel, { repoPath: '/fixture/repo' }));
`;
let browser: Browser;
let bundle: string;
let page: Page;
const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const fileRow = () => page.locator('button[title="file-12.txt"][aria-expanded]').locator('..');

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
