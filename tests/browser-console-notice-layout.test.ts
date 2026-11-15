import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const requestHeaders = vi.hoisted(() => vi.fn(async () => new Headers({
  host: '127.0.0.1', 'x-o8-client-addr': '127.0.0.1',
})));
const operatorToken = vi.hoisted(() => vi.fn(() => 'fixture-operator-token'));
vi.mock('next/headers', () => ({ headers: requestHeaders }));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: operatorToken }));
vi.mock('@/components/NavigationBridge', () => ({ default: () => null }));
vi.mock('@/components/auth/O8AuthProvider', () => ({
  O8AuthProvider: ({ children }: { children: unknown }) => children,
}));

const { default: RootLayout } = await import('@/app/layout');
const notices = [
  ['/', (await import('@/app/page')).default],
  ['/dashboard', (await import('@/app/dashboard/page')).default],
  ['/mobile', (await import('@/app/mobile/page')).default],
] as const;

it.each(notices)('serves %s without reading or bootstrapping operator credentials on loopback', async (_path, Page) => {
  requestHeaders.mockClear();
  operatorToken.mockClear();
  const html = renderToStaticMarkup(await RootLayout({ children: createElement(Page) }));
  expect(html).toContain('The browser console has been removed');
  expect(html).not.toContain('fixture-operator-token');
  expect(html).not.toContain('ws-token');
  expect(html).not.toContain('__O8_WS_PORT__');
  expect(html).not.toContain('serviceWorker');
  expect(html).not.toContain('<script');
  expect(requestHeaders).not.toHaveBeenCalled();
  expect(operatorToken).not.toHaveBeenCalled();
});
