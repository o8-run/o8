import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
// @ts-expect-error jsdom is a test dependency without bundled declarations
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { BroadcastEvent, BroadcastSnapshot } from '../src/lib/broadcast/types';
import { serveBroadcastPage } from '../src/lib/ws-server/broadcast-page';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it('serves the standalone broadcast document and assets over HTTP with Next absent', async () => {
  const requests: string[] = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (!serveBroadcastPage(req, res)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const token = 'fixture-spectator-secret';
  const response = await fetch(`${origin}/broadcast#token=${token}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  const html = await response.text();
  expect(html).toContain('Broadcast');
  expect(html).not.toContain(token);
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)![1];
  const cssPath = html.match(/<link[^>]+href="([^"]+)"/)![1];
  for (const [path, contentType] of [['/broadcast', 'text/html'], [scriptPath, 'text/javascript'], [cssPath, 'text/css']]) {
    const get = await fetch(origin + path);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain(contentType);
    const head = await fetch(origin + path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const refused = await fetch(origin + path, { method });
      expect(refused.status).toBe(405);
      expect(refused.headers.get('allow')).toBe('GET, HEAD');
    }
  }
  expect((await fetch(origin + '/broadcast/unknown')).status).toBe(404);
  const javascript = await (await fetch(origin + scriptPath)).text();
  const calls: { url: string; authorization: string }[] = [];
  const logs: string[] = [];
  const console = new VirtualConsole();
  for (const kind of ['log', 'warn', 'error', 'jsdomError'] as const) console.on(kind, (...args: unknown[]) => logs.push(args.join(' ')));
  const dom = new JSDOM(html, { url: `${origin}/broadcast?theme=dark#token=${token}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  dom.window.fetch = ((url: string, options: RequestInit) => {
    calls.push({ url, authorization: (options.headers as Record<string, string>).Authorization });
    return Promise.resolve({ status: 403, ok: false });
  }) as typeof fetch;
  try {
    dom.window.eval(javascript);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5000 });
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('ACCESS REVOKED'), { timeout: 5000 });
    expect(calls).toContainEqual({ url: '/api/broadcast/snapshot?events=40', authorization: `Bearer ${token}` });
    expect(dom.window.location.hash).toBe(`#token=${token}`);
    expect(dom.window.localStorage.getItem('o8.broadcast.spectator-token')).toBe(token);
    expect(dom.window.document.body.textContent).toContain('ACCESS REVOKED');
    expect(dom.window.document.querySelector('main')?.getAttribute('data-broadcast-theme')).toBe('dark');
    expect(dom.window.document.documentElement.outerHTML).not.toContain(token);
    expect(JSON.stringify([...requests, ...calls.map(call => call.url), ...logs])).not.toContain(token);
    expect(logs).toEqual([]);

    // Re-navigate the same document, exercising the real production bundle's
    // hashchange recovery, snapshot, live feed, and truth form without Next.
    const nextToken = 'rotated-fixture-secret';
    const event: BroadcastEvent = {
      schema: 'o8/broadcast.event/v1', id: 'event-one', source: 'broadcast', kind: 'commentary',
      laneId: null, packetId: null, repo: null, actor: 'operator', title: 'Safe live update',
      detail: null, payload: { privateDetail: 'unrendered-payload-secret' }, timestamp: new Date().toISOString(),
    };
    const snapshot: BroadcastSnapshot = {
      schema: 'o8/broadcast.snapshot/v1', generatedAt: new Date().toISOString(),
      lanes: [], packets: [], activeAgents: [], pendingApprovals: { count: 0, items: [] },
      focus: { title: 'Snapshot focus', goal: null, issue: null, startedAt: new Date().toISOString() },
      recentEvents: [], cursor: 'initial-cursor',
    };
    let eventPolls = 0;
    dom.window.fetch = ((url: string, options: RequestInit) => {
      calls.push({ url, authorization: (options.headers as Record<string, string>).Authorization });
      if (url.includes('/events') && eventPolls++ > 0) return new Promise(() => {});
      const payload = url.includes('/snapshot') ? snapshot
        : url.includes('/events') ? { events: [event], cursor: 'next-cursor' }
          : { error: { message: 'Truth scope fixture refusal' } };
      return Promise.resolve({ status: url.includes('/truth') ? 403 : 200, ok: !url.includes('/truth'), json: async () => payload });
    }) as typeof fetch;
    dom.window.location.hash = `token=${nextToken}`;
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('Safe live update'), { timeout: 5000 });
    expect(dom.window.document.body.textContent).toContain('Snapshot focus');
    expect(dom.window.document.body.textContent).toContain('Safe live update');
    expect(calls).toContainEqual({ url: '/api/broadcast/events?wait=25000&limit=50&cursor=initial-cursor', authorization: `Bearer ${nextToken}` });
    const form = dom.window.document.querySelector<HTMLFormElement>('[aria-label="Packet truth query"]')!;
    const input = form.querySelector('input')!;
    // Use the native setter so React receives a real input change.
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'packet-fixture');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('Truth scope fixture refusal'), { timeout: 5000 });
    expect(calls.some(call => call.url.startsWith('/api/orchestrator/truth?') && call.authorization === `Bearer ${nextToken}`)).toBe(true);
    expect(dom.window.document.body.textContent).toContain('Truth scope fixture refusal');
    const rendered = dom.window.document.documentElement.outerHTML;
    expect(rendered).not.toContain(nextToken);
    expect(rendered).not.toContain('unrendered-payload-secret');
    expect(JSON.stringify([...requests, ...calls.map(call => call.url), ...logs])).not.toContain(nextToken);
    expect(logs).toEqual([]);
  } finally {
    dom.window.close();
  }
});
