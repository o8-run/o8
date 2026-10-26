// Real browser/HTTP fixture for the production captureWeb entry point.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureWeb } from '../../scripts/parity/web.mjs';

const { chromium } = createRequire(pathToFileURL(resolve('package.json')))('playwright-core');
const [mode, executablePath, receipt] = process.argv.slice(2);
const counts = { requests: [], upstream: [], overlap: 0, forwarded: 0, blockedForwarded: 0, errors: [], stages: [] };
const started = Date.now();
const stage = name => { counts.stages.push({ name, ms: Date.now() - started }); };
let browser;
let finishing;
const server = createServer((request, response) => {
  if (request.url === '/api/panel/repos') { stage('repos served'); response.end('{"repos":[]}'); return; }
  if (request.url.startsWith('/api/')) {
    counts.upstream.push({ method: request.method, path: request.url, authorized: request.headers.authorization === 'Bearer fixture-route-token' });
    counts.forwarded++;
    if (request.url === '/api/panel/provider/launch') counts.blockedForwarded++;
    const send = () => { response.setHeader('content-type', 'application/json'); response.end('{"fixture":true}'); };
    if (mode === 'pending' && request.method === 'GET') setTimeout(send, 2000).unref();
    else send();
    return;
  }
  stage('document served');
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><html data-palette="dark" data-surface="glass"><body><main data-o8-workspace>Settings fixture</main><script>
    // This fixture tests route ownership, not keyboard focus. Start its traffic
    // during document boot, before capture waits for hydration or rendering.
    void Promise.all([
      fetch('/api/panel/operator-defaults', {cache:'no-store'}),
      fetch('/api/panel/operator-defaults', {cache:'no-store'}),
      fetch('/api/panel/terminal-state', {method:'POST',body:'{}'}),
      fetch('/api/panel/provider/launch', {method:'POST',body:'{}'})
    ]).catch(() => {});
    document.documentElement.dataset.o8DashboardHydrated = '1';
  </script></body></html>`);
});
function finish(code, error) {
  if (error) counts.errors.push(String(error.message ?? error));
  if (finishing) return finishing;
  finishing = (async () => {
    if (error) console.error(error.stack ?? error);
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    writeFileSync(receipt, JSON.stringify(counts));
    process.exit(code);
  })();
  return finishing;
}
process.on('uncaughtException', error => { void finish(1, error); });
process.on('unhandledRejection', error => { void finish(1, error); });
process.once('SIGTERM', () => { void finish(1, new Error('Fixture terminated')); });
setTimeout(() => { void finish(1, new Error(`Fixture deadline expired: ${JSON.stringify(counts.stages)}`)); }, 20_000).unref();

try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  stage('server listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  stage('browser launched');
  const captureBrowser = { newContext: async options => {
    const context = await browser.newContext(options);
    stage('context created');
    if (mode === 'startup') {
      // Cold headless input need not be available for a routing regression.
      await context.addInitScript(() => addEventListener('keydown', event => event.stopImmediatePropagation(), true));
    }
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      stage('page created');
      page.on('domcontentloaded', () => stage('document loaded'));
      const wait = page.waitForFunction.bind(page);
      page.waitForFunction = async (...args) => {
        stage('hydration wait started');
        const result = await wait(...args);
        stage('hydration wait finished');
        return result;
      };
      return page;
    };
    const register = context.route.bind(context);
    let disposed = false;
    const fetch = context.request.fetch.bind(context.request);
    context.request.fetch = async (...args) => {
      if (mode === 'unavailable' && String(args[0]).includes('/api/panel/operator-defaults')) throw new Error('Fixture read unavailable');
      const shouldDispose = mode === 'disposed' && !disposed && String(args[0]).includes('/api/panel/operator-defaults');
      if (shouldDispose) disposed = true;
      const response = await fetch(...args);
      // Fulfill claims the request before discovering this real response body
      // is gone. Keep the actual browser route implementation for this race.
      if (shouldDispose) {
        while (counts.requests.length < 4) await new Promise(done => setTimeout(done, 5));
        await response.dispose();
      }
      return response;
    };
    context.route = async (pattern, handler) => {
      await register(pattern, async route => {
        const request = route.request();
        const entry = { method: request.method(), path: new URL(request.url()).pathname, attempts: 0, fulfilled: 0, continued: 0, status: null };
        counts.requests.push(entry);
        stage('request intercepted');
        const fulfill = route.fulfill.bind(route);
        route.fulfill = async options => {
          entry.attempts++;
          entry.status = options.response?.status() ?? options.status;
          await fulfill(options);
          entry.fulfilled++;
        };
        const proceed = route.continue.bind(route);
        route.continue = async options => { entry.continued++; await proceed(options); };
        await handler(route);
      });
      // The more specific Settings registration delegates to the broad fixture
      // registration. Both match each request, including two identical GETs.
      await register('**/api/panel/**', async route => { counts.overlap++; await route.fallback(); });
      stage('overlapping routes registered');
    };
    return context;
  } };
  await captureWeb(captureBrowser, origin, { origin, token: 'fixture-route-token' },
    { id: 'settings', webRoute: '/dashboard', ...(mode === 'startup' ? { webKeys: 'Control+,' } : {}) },
    [1024, 720], {}, receipt + '.png');
  await finish(0);
} catch (error) { await finish(1, error); }
