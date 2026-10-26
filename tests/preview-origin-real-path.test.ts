import { createServer, type Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { panelGateMiddleware } from '@/middleware';
import { GET as browserProxy } from '@/app/api/browser/proxy/route';
import { GET as panelProxy } from '@/app/api/panel/proxy/route';

const executablePath = resolveBrowserPath();
const servers: Server[] = [];
let upstream: string;
let base: string;
let browser: Browser;
let authorizedReads = 0;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener unavailable');
  return `http://127.0.0.1:${address.port}`;
}

describe.skipIf(!executablePath)('local preview document authority', () => {
  beforeAll(async () => {
    upstream = await listen(createServer((req, res) => {
      if (req.url === '/module.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end("document.body.dataset.module = 'ready'; fetch('/fixture-data').then(r => r.text()).then(value => document.body.dataset.data = value);");
        return;
      }
      if (req.url === '/fixture-data') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: base }).end();
        return;
      }
      const script = `
        let parentRead = false;
        try {
          parentRead = !!parent.document.querySelector('meta[name="ws-token"]').content;
          parent.fetch('/api/private-preview-fixture').catch(() => {});
        } catch {}
        parent.postMessage({ fixture: 'preview-ready', parentRead }, '*');
      `;
      res.writeHead(200, {
        'content-type': req.url === '/image.svg' ? 'image/svg+xml' : 'text/html',
        'clear-site-data': '"cookies", "storage"',
        'set-cookie': 'o8-preview-fixture=replaced; Path=/',
      }).end(req.url === '/image.svg'
        ? `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[${script}]]></script><text>fixture</text></svg>`
        : `<!doctype html><button id="count">0</button><script type="module" src="./module.js"></script><script>
          document.querySelector('#count').onclick = e => e.target.textContent = '1';
          ${script}
        </script>`);
    }));
    base = await listen(createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', base);
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta name="ws-token" content="${getOrCreateWsToken()}">
          ${renderToStaticMarkup(createElement(ApiBearerBootstrap, { source: 'meta' }))}
          <script>window.receipts = []; addEventListener('message', e => { if (e.data?.fixture === 'preview-ready') window.receipts.push(e.data); });</script>`);
        return;
      }
      const request = new NextRequest(url, { headers: req.headers as Record<string, string> });
      if (url.pathname === '/api/private-preview-fixture') {
        const gate = panelGateMiddleware(request);
        const allowed = gate.headers.get('x-middleware-next') === '1';
        if (allowed) authorizedReads++;
        res.writeHead(allowed ? 200 : gate.status).end();
        return;
      }
      const response = await (url.pathname === '/api/browser/proxy' ? browserProxy : panelProxy)(request);
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    }));
    vi.stubEnv('O8_API_PORT', new URL(base).port);
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it.each([
    ['/api/browser/proxy', '/'], ['/api/panel/proxy', '/'],
    ['/api/browser/proxy', '/image.svg'], ['/api/panel/proxy', '/image.svg'],
  ])('%s isolates %s from app authority', async (route, path) => {
    const page = await browser.newPage();
    authorizedReads = 0;
    try {
      await page.goto(base);
      await page.evaluate(src => {
        localStorage.setItem('o8-preview-fixture', 'kept');
        document.cookie = 'o8-preview-fixture=kept; Path=/';
        const frame = document.createElement('iframe');
        frame.id = 'preview';
        frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups');
        frame.src = src;
        document.body.append(frame);
      }, `${route}?url=${encodeURIComponent(upstream + path)}`);
      await page.waitForFunction(() => (window as unknown as { receipts: unknown[] }).receipts.length > 0);
      if (path === '/') {
        await page.frameLocator('#preview').locator('#count').click();
        expect(await page.frameLocator('#preview').locator('#count').textContent()).toBe('1');
        await page.frameLocator('#preview').locator('body[data-module="ready"][data-data="ready"]').waitFor();
      }
      const receipt = await page.evaluate(() => (window as unknown as { receipts: { parentRead: boolean }[] }).receipts[0]);
      expect(receipt.parentRead).toBe(false);
      expect(authorizedReads).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem('o8-preview-fixture'))).toBe('kept');
      if (path === '/image.svg') expect(await page.evaluate(() => document.cookie)).toContain('o8-preview-fixture=kept');
    } finally {
      await page.close();
    }
  });

  it.each(['/api/browser/proxy', '/api/panel/proxy'])('%s refuses redirects into the app', async route => {
    const response = await (route.includes('/browser/') ? browserProxy : panelProxy)(new NextRequest(
      `${base}${route}?url=${encodeURIComponent(`${upstream}/redirect`)}`,
    ));
    expect(response.status).toBe(400);
  });
});
