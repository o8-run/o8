/** Browser measurements always come from DOM geometry and computed styles. */
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureError, isAppBundle } from './health.mjs';

export async function captureWeb(browser, origin, fixture, scenario, size, elements, output) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1,
    locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const missing = [];
  const routes = new Map();
  const errors = [];
  const pending = new Set();
  const surfacePath = new URL(scenario.webRoute, origin).pathname;
  try {
    const handleApi = async route => {
      const request = route.request();
      const url = new URL(request.url());
      // Capture is read-only. Never start a worker, create a terminal or publish a decision.
      const viewState = request.method() === 'POST' && url.pathname === '/api/panel/terminal-state';
      let reply = { status: 405, json: { error: 'Parity capture is read-only' } };
      if (request.method() === 'GET' || viewState) {
        try {
          const response = await context.request.fetch(fixture.origin + url.pathname + url.search,
            { method: request.method(), data: request.postData() ?? undefined,
              headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, timeout: 10_000 });
          routes.set(url.pathname, response.status());
          reply = { response };
        } catch { reply = { status: 503, json: { error: 'Fixture unavailable' } }; }
      }
      // A dispatch failure may already have consumed the route. Only fetch
      // failures get a 503; never retry fulfill or continue after dispatch.
      await route.fulfill(reply);
    };
    await context.route('**/api/**', route => {
      const handling = handleApi(route);
      pending.add(handling);
      return handling.finally(() => pending.delete(handling));
    });
    // Existing fixtures use replay peers; the browser may not discover a real runtime.
    await context.routeWebSocket(url => url.pathname === '/ws', socket => {
      socket.onMessage(raw => {
        try { if (JSON.parse(String(raw)).type === 'ping') socket.send(JSON.stringify({ channel: 'pong', event: 'pong' })); } catch { /* Ignore other subscriptions. */ }
      });
    });
    const repoResponse = await context.request.get(fixture.origin + '/api/panel/repos',
      { headers: { authorization: `Bearer ${fixture.token}` } });
    const repos = repoResponse.ok() ? await repoResponse.json() : {};
    const selectedRepo = repos.repos?.find(repo => repo.localPath === fixture.parityWorkspace);
    await context.exposeBinding('__o8ParityReportBoundary', () => errors.push(new CaptureError('browser error boundary')));
    await context.addInitScript(repoId => {
      if (repoId) sessionStorage.setItem('cortex-global-repo-id', repoId);
      localStorage.setItem('cortex-theme-palette', 'dark');
      localStorage.setItem('cortex-reduce-transparency', 'off');
      localStorage.setItem('cortex-workspace-glass', 'true');
      // Latch caught render failures, including a boundary that is later reset.
      window.__o8ParityBoundaryError = false;
      const inspect = records => {
        if (records.some(record => record.attributeName === 'data-o8-mount-error' && record.oldValue === '1')
          || document.querySelector('[data-o8-mount-error="1"], [data-error-boundary], [data-nextjs-error]')
          || !document.querySelector('[data-o8-workspace]') && [...document.querySelectorAll('h1, h2, strong')].some(node => /^(?:(?:Dashboard|o8) failed to mount|Something went wrong|Application error: a client-side exception)/.test(node.textContent?.trim() ?? ''))) {
          if (!window.__o8ParityBoundaryError) void window.__o8ParityReportBoundary().catch(() => {});
          window.__o8ParityBoundaryError = true;
        }
      };
      new MutationObserver(inspect).observe(document, { subtree: true, childList: true,
        attributes: true, attributeFilter: ['data-o8-mount-error', 'data-error-boundary', 'data-nextjs-error'], attributeOldValue: true });
    }, selectedRepo?.id ?? null);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(new CaptureError('uncaught browser page error', error.stack ?? error.message)));
    page.on('console', message => {
      if (message.type() === 'error' && isAppBundle(message.location().url, origin)) {
        errors.push(new CaptureError('application console error', message.text()));
      }
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.status() >= 400 && (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
        || url.origin === origin && url.pathname === surfacePath)) {
        errors.push(new CaptureError(`surface route HTTP ${response.status()}`));
      }
    });
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    const healthy = async () => {
      if (crashed) throw new CaptureError('browser renderer crashed');
      if (errors.length) throw errors[0];
      const boundary = await page.evaluate(() => window.__o8ParityBoundaryError
        || Boolean(document.querySelector('[data-o8-mount-error="1"], [data-error-boundary], [data-nextjs-error]')));
      if (crashed) throw new CaptureError('browser renderer crashed');
      if (errors.length) throw errors[0];
      if (boundary) throw new CaptureError('browser error boundary');
    };
    const response = await page.goto(origin + scenario.webRoute, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    if (!response?.ok()) throw new CaptureError(`surface route HTTP ${response?.status() ?? 'unavailable'}`);
    await healthy();
    await page.waitForFunction(() => document.documentElement.dataset.o8DashboardHydrated === '1', null, { timeout: 30_000 }).catch(async error => {
      await page.screenshot({ path: output });
      const text = await page.locator('body').innerText();
      await healthy();
      throw new CaptureError('workspace did not hydrate', `${error.message}\nVisible: ${text.slice(0, 2000)}`);
    });
    if (scenario.webKeys) await page.keyboard.press(scenario.webKeys);
    if (scenario.webEvent) {
      await delay(500);
      await page.evaluate(({ name, detail }) => window.dispatchEvent(new CustomEvent(name, { detail })),
        { name: scenario.webEvent, detail: scenario.webDetail ?? {} });
    }
    if (scenario.webClick) {
      const control = page.locator(scenario.webClick).filter({ visible: true }).first();
      if (await control.count()) {
        await control.click({ timeout: 3000 });
        if (scenario.webText) {
          const target = page.getByText(scenario.webText, { exact: true }).filter({ visible: true }).first();
          if (await target.count()) await target.click({ timeout: 3000 });
          else missing.push('Current UI surface choice unavailable');
        }
      } else missing.push('Current UI surface opener unavailable');
    }
    await page.evaluate(() => document.fonts.ready);
    await delay(scenario.id === 'session' ? 3000 : 700);
    if (scenario.id === 'session' && ![...routes.keys()].some(path => path === '/api/v2/chat-history' || path === '/api/mobile/history')) {
      missing.push('Current UI did not read the selected history; equivalent transcript state remains unverified');
    }
    await healthy();
    const measured = await page.evaluate(spec => {
      const result = {};
      for (const [name, selector] of Object.entries(spec)) {
        const node = [...document.querySelectorAll(selector.web)].find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
        if (!node) { result[name] = null; continue; }
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const numeric = value => Number.isFinite(parseFloat(value)) ? Math.round(parseFloat(value) * 100) / 100 : null;
        result[name] = { x: numeric(box.x), y: numeric(box.y), width: numeric(box.width), height: numeric(box.height),
          fontSize: numeric(style.fontSize), fontWeight: numeric(style.fontWeight),
          paddingTop: numeric(style.paddingTop), paddingRight: numeric(style.paddingRight),
          paddingBottom: numeric(style.paddingBottom), paddingLeft: numeric(style.paddingLeft),
          color: style.color, background: style.backgroundColor, backdropFilter: style.backdropFilter };
      }
      return result;
    }, elements);
    // Development tooling is outside the desktop UI being compared.
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    const theme = await page.locator('html').evaluate(node => ({ palette: node.dataset.palette, surface: node.dataset.surface }));
    if (theme.palette !== 'dark' || theme.surface !== 'glass') missing.push('Current UI did not resolve to dark All Glass');
    await page.screenshot({ path: output, animations: 'disabled' });
    await healthy();
    return { measured, missing, routes: [...routes].map(([path, status]) => ({ path, status })), theme };
  } finally {
    // Unregistering can release in-flight requests to the network. Drain our
    // handlers first, while their fetched response bodies are still alive.
    try {
      while (pending.size) await Promise.allSettled([...pending]);
      await context.unrouteAll({ behavior: 'wait' });
    }
    finally { await context.close(); }
    if (errors.length) throw errors[0];
  }
}
