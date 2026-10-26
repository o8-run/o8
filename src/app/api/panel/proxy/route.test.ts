import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/panel/api-port', () => ({
  resolvePortInfo: () => ({ apiPort: 47100, wsPort: 47105, source: 'default' }),
}));

const { GET } = await import('./route');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel preview proxy confinement', () => {
  it.each([47100, 47105])('refuses to proxy an o8-owned port: %s', async (port) => {
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent(`http://localhost:${port}/api/secret`)}`,
    ));
    expect(response.status).toBe(400);
  });

  it('does not forward operator credentials or o8 identity headers to preview servers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('<html><head></head><body>ok</body></html>', {
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:3005/')}`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
          cookie: 'session=operator-secret',
          'x-o8-worker-packet-id': 'packet-secret',
          accept: 'text/html',
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('<body>ok</body>');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-o8-worker-packet-id')).toBeNull();
  });
});

describe('panel preview refresh navigation policy', () => {
  it.each([
    ['text/html', '<meta data-note=">" content="0;url=http://localhost:39002/end" HTTP-EQUIV="r&#101;fresh">'],
    ['text/html', '<base data="><meta http-equiv=refresh content=0;url=http://localhost:39002/end>">'],
    ['application/xhtml+xml', '<h:meta xmlns:h="http://www.w3.org/1999/xhtml" http-equiv="refresh" content="0;url=http://localhost:39002/end"/>'],
    ['application/xhtml+xml', '<script/><meta http-equiv="refresh" content="0;url=http://localhost:39002/end"/>'],
  ])('neutralizes refresh metadata in %s without forwarding or accepting app cookies: %s', async (contentType, meta) => {
    const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head>${meta}</head><body>kept</body></html>`,
      { headers: { 'content-type': contentType, 'set-cookie': '__session=replaced; HttpOnly; Path=/' } },
    ));
    vi.stubGlobal('fetch', upstream);
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`,
      { headers: { cookie: '__session=kept' } },
    ));
    expect(response.status).toBe(200);
    expect((upstream.mock.calls[0][1]?.headers as Headers).get('cookie')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<body>kept</body>');
    expect(html).not.toMatch(/http-equiv/i);
  });

  it.each(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/plain'])('drops Refresh headers and cookies on %s responses', async contentType => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>fixture</body></html>', {
      headers: { 'content-type': contentType, refresh: '0;url=http://localhost:39002/end', 'set-cookie': '__session=replaced; HttpOnly; Path=/' },
    })));
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`,
      { headers: { cookie: '__session=kept' } },
    ));
    expect(response.headers.get('refresh')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

it('preserves standard XHTML named entities while neutralizing refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>fixture</title><meta http-equiv="refresh" content="0;url=/end"/></head><body>&nbsp;kept</body></html>',
    { headers: { 'content-type': 'application/xhtml+xml' } },
  )));
  const response = await GET(new NextRequest(`http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`));
  expect(response.status).toBe(200);
  const document = await response.text();
  expect(document).toContain('<body>&nbsp;kept</body>');
  expect(document).not.toContain('http-equiv');
});

it('fails closed on unparseable XHTML without accepting cookies or Refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><unclosed>', {
    headers: { 'content-type': 'application/xhtml+xml', refresh: '0;url=/end', 'set-cookie': '__session=replaced; HttpOnly; Path=/' },
  })));
  const response = await GET(new NextRequest(`http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`));
  expect(response.status).toBe(502);
  expect(response.headers.get('refresh')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
});


it.each(['text/html', 'application/xhtml+xml'])('uses UTF-8 for sanitized %s documents', async contentType => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>kept</body></html>', {
    headers: { 'content-type': `${contentType}; charset=iso-2022-jp` },
  })));
  const response = await GET(new NextRequest(`http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(`${contentType}; charset=utf-8`);
  expect(await response.text()).toContain('<body>kept</body>');
});
