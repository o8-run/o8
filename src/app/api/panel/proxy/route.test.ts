import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as parse5 from 'parse5';
import { neutralizePreviewRefresh } from '@/lib/panel/neutralize-preview-refresh';

vi.mock('parse5', async importOriginal => {
  const actual = await importOriginal<typeof import('parse5')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

vi.mock('@/lib/panel/api-port', () => ({
  resolvePortInfo: () => ({ apiPort: 47100, wsPort: 47105, source: 'default' }),
}));

const { GET } = await import('./route');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(parse5.parse).mockReset();
});

function refreshCount(document: string): number {
  let count = 0;
  const visit = (node: parse5.DefaultTreeAdapterTypes.Node) => {
    if ('tagName' in node && node.tagName === 'meta'
      && node.attrs.some(attr => attr.name === 'http-equiv' && attr.value.trim().toLowerCase() === 'refresh')) count++;
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('content' in node) visit(node.content);
  };
  visit(parse5.parse(document));
  return count;
}

describe('preview refresh neutralizer idempotence', () => {
  const refresh = '<meta http-equiv="refresh" content="0;url=/a">';
  const joined = `<${refresh}meta http-equiv="refresh" content="0;url=/b">`;
  const nested = `<${joined}meta http-equiv="refresh" content="0;url=/c">`;

  it.each([
    ['blocks refresh span joining', joined],
    ['blocks twice-nested refresh span joining', nested],
    ['blocks refresh span joining in template content', `<template>${joined}</template>`],
  ])('%s', async (_name, head) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<html><head>${head}</head><body>x</body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`,
    ));
    expect(response.status).toBe(200);
    const document = await response.text();
    expect(document).toContain('<body>x</body>');
    expect(refreshCount(document)).toBe(0);
  });

  it('leaves zero refresh elements for generated boundary inputs', () => {
    const fragments = [refresh, joined, nested, `${refresh}${refresh}`];
    const boundaries = [
      ['', ''],
      ['<', 'meta http-equiv="refresh" content="0;url=/b">'],
      ['<meta ', 'http-equiv="refresh" content="0;url=/b">'],
      ['<meta http-', 'equiv="refresh" content="0;url=/b">'],
      ['<meta http-equiv="re', 'fresh" content="0;url=/b">'],
      ['<meta http-equiv=refresh content="', '0;url=/b">'],
    ];
    for (const fragment of fragments) {
      for (const [before, after] of boundaries) {
        for (const stray of ['', '<', '<<']) {
          for (const template of [false, true]) {
            const content = `${before}${stray}${fragment}${after}`;
            const document = `<html><head>${template ? `<template>${content}</template>` : content}</head><body>x</body></html>`;
            const result = neutralizePreviewRefresh(document, false);
            expect(refreshCount(result), document).toBe(0);
            expect(neutralizePreviewRefresh(result, false), document).toBe(result);
          }
        }
      }
    }
  });

  it('fails closed with a structured error when refresh parsing does not converge', async () => {
    // Force every parse to report a refresh, even after its span is replaced.
    const refreshTree = parse5.parse(refresh, { sourceCodeLocationInfo: true });
    const parser = vi.mocked(parse5.parse).mockReturnValue(refreshTree);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(refresh, {
      headers: { 'content-type': 'text/html', refresh: '0;url=/b', 'set-cookie': '__session=replaced; HttpOnly; Path=/' },
    })));
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`,
    ));
    expect(response.status).toBe(502);
    expect(response.headers.get('refresh')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: 'Proxy error: Preview refresh neutralization did not converge' });
    expect(parser.mock.calls.length).toBeGreaterThan(1);
    expect(parser.mock.calls.length).toBeLessThanOrEqual(10);
  });
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
