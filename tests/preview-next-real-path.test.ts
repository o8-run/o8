import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { PREVIEW_DOCUMENT_CSP } from '@/lib/panel/preview-proxy-security';
import { createHmac } from 'node:crypto';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const routes = ['/api/browser/proxy', '/api/panel/proxy'];
const token = 'preview-next-fixture-operator-token';
const root = mkdtempSync(join(tmpdir(), 'o8-preview-next-'));
const cookies: string[] = [];
const servers: Server[] = [];
let app: ChildProcess;
let browser: Browser;
let base: string;
let upstream: string;
let socketBase: string;
let otherUpstream: string;
let socketConnections = 0;
let output = '';

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}

async function embed(page: Page, src: string, receipt = true) {
  await page.goto(`${base}/fixture-parent`);
  await page.evaluate(src => {
    localStorage.setItem('preview-canary', 'kept');
    const frame = document.createElement('iframe');
    frame.id = 'preview';
    frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups');
    frame.src = src;
    document.body.append(frame);
  }, src);
  if (receipt) await page.waitForFunction(() => Boolean((window as unknown as { receipt: unknown }).receipt));
  else await page.frameLocator('#preview').locator('body[data-preview-ready]').waitFor();
}

describe('preview security through Next response handling', () => {
  beforeAll(async () => {
    const reservation = createServer();
    base = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    socketBase = await listen(createServer());
    const sockets = new WebSocketServer({
      server: servers.at(-1),
      verifyClient: (info: { req: IncomingMessage }) => new URL(info.req.url!, socketBase).searchParams.get('token') === token,
    });
    sockets.on('connection', socket => { socketConnections++; socket.close(); });
    otherUpstream = await listen(createServer((_req, res) => res.end('other preview')));
    upstream = await listen(createServer((req, res) => {
      cookies.push(req.headers.cookie ?? '');
      res.setHeader('set-cookie', ['preview-canary=replaced; Path=/', 'preview-http-only=; Max-Age=0; Path=/']);
      res.setHeader('clear-site-data', '"cookies", "storage"');
      if (req.url === '/interactive') {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><button id="count" onclick="this.textContent=1">0</button><script type="module" src="./module.js"></script>');
        return;
      }
      if (req.url === '/module.js' || req.url === '/nested.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(req.url === '/nested.js' ? 'export const ready = "ready"' : 'import { ready } from "./nested.js"; document.body.dataset.module = ready; fetch("/fixture-data").then(r => r.text()).then(value => document.body.dataset.data = value);');
        return;
      }
      if (req.url === '/fixture-data') {
        res.setHeader('content-type', 'text/plain');
        res.end('ready');
        return;
      }
      if (req.url === '/redirect-resource') {
        res.writeHead(302, { location: `${otherUpstream}/outside` }).end();
        return;
      }
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location: '/document.html' }).end();
        return;
      }
      const script = `
        (async () => {
          const result = { token: false, storage: false, write: false, mcp: false, socket: false };
          try { result.token = !!parent.document.querySelector('meta[name="ws-token"]').content; } catch {}
          try { result.storage = parent.localStorage.getItem('preview-canary') === 'kept'; } catch {}
          try { result.write = (await parent.fetch('/api/leases', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({action:'acquire',resource:'preview-canary',owner:{id:'preview-fixture',label:'preview-fixture',pid:${process.pid}},claimToken:'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'}) })).ok; } catch {}
          try { result.mcp = (await parent.fetch('/api/mcp', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).ok; } catch {}
          try {
            const ws = new parent.WebSocket('${socketBase.replace('http:', 'ws:')}/ws?token=' + parent.document.querySelector('meta[name="ws-token"]').content);
            result.socket = await new Promise(resolve => { ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false); });
          } catch {}
          parent.postMessage(result, '*');
        })();`;
      const svg = req.url?.endsWith('.svg');
      res.setHeader('content-type', svg ? 'image/svg+xml' : req.url?.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html');
      res.end(svg
        ? `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[${script}]]></script><text>Preview</text></svg>`
        : `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Preview</title></head><body data-preview-ready="true"><script>${req.url?.endsWith('.xhtml') ? `//<![CDATA[\n${script}\n//]]>` : script}</script></body></html>`);
    }));
    const parentFile = join(root, 'parent.html');
    writeFileSync(join(root, 'ws-token'), token);
    writeFileSync(parentFile, `<!doctype html><meta name="ws-token" content="${token}">${renderToStaticMarkup(createElement(ApiBearerBootstrap, { source: 'meta' }))}<script>addEventListener('message', e => window.receipt = e.data)</script>`);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, PORT: new URL(base).port, O8_API_PORT: new URL(base).port, O8_WS_PORT: new URL(socketBase).port, WS_TOKEN: token, PREVIEW_PARENT_FILE: parentFile };
    for (const key of Object.keys(env)) if (key.includes('CLERK') || key.startsWith('O8_WORKER')) delete env[key];
    app = spawn(process.execPath, ['tests/fixtures/preview-next-server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout?.on('data', chunk => { output += chunk; });
    app.stderr?.on('data', chunk => { output += chunk; });
    await vi.waitFor(() => {
      if (app.exitCode !== null) throw new Error(output);
      expect(output).toContain('preview-next-ready');
    }, { timeout: 90_000, interval: 100 });
    const executablePath = resolveBrowserPath();
    if (!executablePath) throw new Error('Browser required for preview security test');
    browser = await chromium.launch({ executablePath, headless: true });
    // Compile the actual proxy entry points before browser assertions.
    for (const route of routes) await fetch(`${base}${route}?url=${encodeURIComponent(`${upstream}/image.svg`)}`);
  }, 120_000);

  afterAll(async () => {
    writeFileSync(join(process.env.O8_PREVIEW_RECEIPTS || root, 'next.log'), output);
    await browser?.close();
    if (app && app.exitCode === null) {
      const exited = new Promise(resolve => app.once('exit', resolve));
      app.kill('SIGTERM');
      await exited;
    }
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(root, { recursive: true, force: true });
  });

  it.each(routes.flatMap(route => ['image.svg', 'document.html', 'document.xhtml', 'fixture-data'].map(path => [route, path])))('%s sends the sandbox policy on actual %s responses', async (route, path) => {
    const response = await fetch(`${base}${route}?url=${encodeURIComponent(`${upstream}/${path}`)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(PREVIEW_DOCUMENT_CSP);
  });

  it.each(routes)('%s preserves interactive HTML, nested modules and data loads', async route => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/fixture-parent`);
      await page.evaluate(src => {
        const frame = document.createElement('iframe');
        frame.id = 'preview';
        frame.sandbox.add('allow-scripts', 'allow-same-origin');
        frame.src = src;
        document.body.append(frame);
      }, `${route}?url=${encodeURIComponent(`${upstream}/interactive`)}`);
      await page.frameLocator('#preview').locator('body[data-module="ready"][data-data="ready"]').waitFor();
      await page.frameLocator('#preview').locator('#count').click();
      expect(await page.frameLocator('#preview').locator('#count').textContent()).toBe('1');
    } finally { await page.close(); }
  });

  it('confines opaque resource access through the real middleware and proxy', async () => {
    const response = await fetch(`${base}/api/panel/proxy?url=${encodeURIComponent(`${upstream}/interactive`)}`);
    const document = await response.text();
    const match = /src="([^"]+)"/.exec(document);
    expect(match).not.toBeNull();
    const asset = new URL(match![1].replaceAll('&amp;', '&'));
    const access = asset.searchParams.get('previewResource')!;
    const headers = { origin: 'null', 'sec-fetch-site': 'cross-site' };
    const allowed = await fetch(asset, { headers });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('*');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    expect(allowed.headers.get('set-cookie')).toBeNull();
    const sameOrigin = new URL(asset);
    sameOrigin.searchParams.set('url', `${upstream}/fixture-data`);
    expect(await (await fetch(sameOrigin, { headers })).text()).toBe('ready');
    for (const presented of ['', access.slice(0, -1) + (access.endsWith('0') ? '1' : '0')]) {
      const refused = new URL(asset);
      refused.searchParams.set('previewResource', presented);
      expect((await fetch(refused, { headers })).status).toBe(401);
    }
    const expired = String(Date.now() - 1000);
    const expiredSignature = createHmac('sha256', token).update(JSON.stringify(['preview-resource', new URL(upstream).origin, expired])).digest('hex');
    const refused = new URL(asset);
    refused.searchParams.set('previewResource', `${expired}.${expiredSignature}`);
    expect((await fetch(refused, { headers })).status).toBe(401);
    refused.searchParams.set('previewResource', access);
    for (const target of [otherUpstream, socketBase, base]) {
      refused.searchParams.set('url', `${target}/fixture-data`);
      expect((await fetch(refused, { headers })).status).toBe(401);
    }
    expect((await fetch(asset, { headers: { ...headers, origin: 'https://example.invalid' } })).status).toBe(401);
    expect((await fetch(asset, { method: 'POST', headers })).status).toBe(401);
    expect((await fetch(asset, { headers: { ...headers, 'x-o8-client-addr': '192.0.2.1' } })).status).toBe(401);
    const otherApi = new URL('/api/leases', base);
    otherApi.search = asset.search;
    expect((await fetch(otherApi, { headers })).status).toBe(401);
    const redirect = new URL(asset);
    redirect.searchParams.set('url', `${upstream}/redirect-resource`);
    const redirectResponse = await fetch(redirect, { headers, redirect: 'manual' });
    expect(redirectResponse.status).toBe(400);
    expect(await redirectResponse.json()).toEqual({ error: 'preview resource redirect changes origin' });
  });

  it.each(routes.flatMap(route => ['image.svg', 'document.html', 'document.xhtml'].map(path => [route, path])))('%s isolates active %s from token, storage, writes, MCP and authenticated sockets', async (route, path) => {
    const page = await browser.newPage();
    const before = socketConnections;
    try {
      await embed(page, `${route}?url=${encodeURIComponent(`${upstream}/${path}`)}`);
      expect(await page.evaluate(() => (window as unknown as { receipt: unknown }).receipt)).toEqual({ token: false, storage: false, write: false, mcp: false, socket: false });
      expect(socketConnections).toBe(before);
      const leases = await (await fetch(`${base}/api/leases`, { headers: { authorization: `Bearer ${token}` } })).json();
      expect(leases.leases).toEqual([]);
      expect(await page.evaluate(() => localStorage.getItem('preview-canary'))).toBe('kept');
    } finally { await page.close(); }
  });

  it.each(routes)('%s keeps redirecting HTML cookieless and preserves app cookies', async route => {
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'preview-canary', value: 'kept', url: base },
      { name: 'preview-http-only', value: 'kept', url: base, httpOnly: true },
    ]);
    cookies.length = 0;
    const page = await context.newPage();
    try {
      await embed(page, `${route}?url=${encodeURIComponent(`${upstream}/redirect-one`)}`, false);
      expect(cookies.length).toBeGreaterThanOrEqual(2);
      expect(cookies.every(value => !value.includes('preview-canary') && !value.includes('preview-http-only'))).toBe(true);
      expect((await context.cookies(base)).filter(cookie => cookie.name.startsWith('preview-')).map(cookie => [cookie.name, cookie.value]).sort()).toEqual([['preview-canary', 'kept'], ['preview-http-only', 'kept']]);
    } finally { await context.close(); }
  });
});
