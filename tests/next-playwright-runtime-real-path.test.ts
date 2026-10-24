import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';

const fixture = mkdtempSync(join(tmpdir(), 'o8-playwright-runtime-'));
const checkout = join(fixture, 'checkout');
const root = join(fixture, 'checkout-link');
mkdirSync(checkout);
// Model platforms whose temporary directory is exposed through an alias.
symlinkSync(checkout, root, 'junction');
execFileSync('git', ['init', '-q', '-b', 'main', root]);
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let viewport = { width: 728, height: 800 };
const page = {
  goto: vi.fn(async () => undefined), url: () => 'https://93.184.216.34/fixture',
  title: async () => 'Fixture page', isClosed: () => false, setDefaultTimeout() {},
  screenshot: vi.fn(async () => image), setContent: vi.fn(async () => undefined),
  on() {}, waitForFunction: async () => undefined,
  setViewportSize: async (value: typeof viewport) => { viewport = value; },
  locator: () => ({ evaluate: async () => undefined }),
  evaluate: async (fn: unknown) => {
    const source = String(fn);
    if (source.includes('.visualLayout')) return { width: viewport.width, height: 200, overflow: 0 };
    if (source.includes('=>') && source.includes('.visualHeight') && !source.includes('addEventListener')) return 200;
    return undefined;
  },
};
const context = {
  route: vi.fn(async () => undefined), routeWebSocket: vi.fn(async () => undefined),
  newPage: async () => page, close: vi.fn(async () => undefined),
};
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined), on() {} };
// The runtime package is real; only its browser-process boundary is a fixture.
const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as unknown as Browser);
const { closeDb } = await import('@/lib/db');
afterAll(() => { launch.mockRestore(); closeDb(); rmSync(fixture, { recursive: true, force: true }); });

it('keeps Playwright available for browser-engine actions and live-view frames', async () => {
  const { POST } = await import('@/app/api/browser/engine/act/route');
  const { GET } = await import('@/app/api/browser/engine/view/route');
  const request = (action: string) => new NextRequest('http://localhost/api/browser/engine/act', {
    method: 'POST', body: JSON.stringify({ action, url: page.url(), scope: 'fixture' }),
    headers: { 'content-type': 'application/json' },
  });
  try {
    expect(await (await POST(request('open'))).json()).toMatchObject({ ok: true, surface: 'engine', title: 'Fixture page' });
    const frame = await GET(new NextRequest('http://localhost/api/browser/engine/view?scope=fixture'));
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await frame.arrayBuffer())).toEqual(image);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chrome', headless: true }));
    expect(context.route).toHaveBeenCalled();
    expect(context.routeWebSocket).toHaveBeenCalled();
  } finally {
    await POST(request('close'));
  }
});

it('keeps Playwright available for authenticated visualization screenshot previews', async () => {
  const { addRepo } = await import('@/lib/repos/registry');
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  const { POST } = await import('@/app/api/visualizations/preview/route');
  const repo = await addRepo(root);
  const response = await POST(new Request('http://localhost/api/visualizations/preview', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ repoPath: repo.localPath, threadId: 'thoughts-preview-fixture', html: '<h1>Fixture chart</h1>', width: 728 }),
  }));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({ ok: true, result: {
    image: image.toString('base64'), mimeType: 'image/png', width: 728, height: 200,
    layouts: [320, 480, 728, 1024].map(width => ({ width, height: 200, overflow: 0 })),
  } });
  expect(page.setContent).toHaveBeenCalledWith(expect.stringContaining('sandbox="allow-scripts"'));
  expect(context.close).toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalled();
});
