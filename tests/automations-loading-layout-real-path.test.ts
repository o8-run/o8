import { build, stop } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

it('keeps the footer anchored through an eight-second cold schedule read in both palettes', async () => {
  const output = process.env.O8_AUTOMATIONS_LAYOUT_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'o8-automation-layout-'));
  const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { AutomationsPage } from './src/components/desktop/AutomationsPage';
      import { ThemeProvider } from './src/lib/theme/context';
      window.fetch = async input => {
        if (String(input) === '/api/automations/connected') {
          await new Promise(resolve => setTimeout(resolve, 8000));
          return Response.json({ ok: true, available: true, jobs: [{ id: 'job', name: 'Delayed schedule',
            agentId: 'agent', enabled: true, schedule: { kind: 'every', everyMs: 3600000 }, nextRunAt: null, lastRunAt: null }] });
        }
        return Response.json({ automations: [], repos: [] });
      };
      createRoot(document.getElementById('root')).render(<ThemeProvider><AutomationsPage currentOwner="operator" /></ThemeProvider>);
    ` } }).finally(stop);
  const executablePath = resolveBrowserPath() ?? chromium.executablePath();
  const html = `<html><head><style>${readFileSync(resolve('src/app/globals.css'), 'utf8')}</style></head><body style="margin:0"><div id="root" style="height:760px"></div><script src="/fixture.js"></script></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/fixture.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].text);
    else if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  let browser: Browser | undefined;
  const observations = [];
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const palette of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
      try {
        await page.addInitScript(value => {
          localStorage.setItem('cortex-theme-palette', value);
          localStorage.setItem('cortex-reduce-transparency', 'on');
          localStorage.setItem('cortex-workspace-glass', 'false');
        }, palette);
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.getByRole('status').filter({ hasText: 'Reading connected schedules' }).waitFor();
        expect(await page.locator('html').getAttribute('data-palette')).toBe(palette);
        const background = await page.locator('#root > div').evaluate(element => getComputedStyle(element).backgroundColor);
        const footer = page.getByText('Automations refresh every 15 seconds while this page is open.');
        const before = (await footer.boundingBox())!.y;
        await page.screenshot({ path: join(output, `${palette}-pending.png`) });
        await page.getByText('Delayed schedule', { exact: true }).waitFor({ timeout: 12_000 });
        const after = (await footer.boundingBox())!.y;
        await page.screenshot({ path: join(output, `${palette}-loaded.png`) });
        observations.push({ palette, background, before, after, shiftPx: after - before });
        expect.soft(Math.abs(after - before), `${palette} footer moved after schedules arrived`).toBeLessThanOrEqual(1);
      } finally { await page.close(); }
    }
    expect(observations[0].background).not.toBe(observations[1].background);
    console.log(JSON.stringify({ check: 'cold-schedule-footer', observations }));
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(observations, null, 2));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    if (!process.env.O8_AUTOMATIONS_LAYOUT_EVIDENCE) rmSync(output, { recursive: true, force: true });
  }
}, 60_000);
