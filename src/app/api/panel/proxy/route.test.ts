import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
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
const { parse: freshParse } = await vi.importActual<typeof import('parse5')>('parse5');
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window };
};

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

describe('preview bootstrap final document', () => {
  const refresh = '<meta http-equiv=refresh content=0;url=/end>';
  const pageScript = '<script>window.previewBootstrapFirst = window.fetch !== window.originalFetch;</script>';
  const contexts = [
    ['script string', `<script>window.marker = "<head>${refresh}";</script>`],
    ['comment', `<!--<head>${refresh}-->`],
    ['attribute value', '<div data-note="<head>"></div>'],
    ['textarea', `<textarea><head>${refresh}</textarea>`],
    ['title', `<title><head>${refresh}</title>`],
  ];

  async function rewrite(document: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(document, {
      headers: { 'content-type': 'text/html' },
    })));
    const response = await GET(new NextRequest(
      `http://localhost:47100/api/panel/proxy?url=${encodeURIComponent('http://localhost:39001/')}`,
    ));
    expect(response.status).toBe(200);
    return response.text();
  }

  function verifiedScripts(document: string) {
    const scripts: string[] = [];
    let refreshElements = 0;
    const visit = (node: parse5.DefaultTreeAdapterTypes.Node) => {
      if ('tagName' in node) {
        if (node.tagName === 'meta' && node.attrs.some(attr =>
          attr.name === 'http-equiv' && attr.value.trim().toLowerCase() === 'refresh')) refreshElements++;
        if (node.tagName === 'script') {
          scripts.push(node.childNodes.map(child => 'value' in child ? child.value : '').join(''));
        }
      }
      if ('childNodes' in node) node.childNodes.forEach(visit);
      if ('content' in node) visit(node.content);
    };
    // Bypass the mocked parser: verify exactly what a fresh consumer receives.
    visit(freshParse(document));
    expect(refreshElements).toBe(0);
    const bootstraps = scripts.filter(script => script.includes('const nativeFetch = window.fetch.bind(window);'));
    expect(bootstraps).toHaveLength(1);
    expect(scripts[0]).toBe(bootstraps[0]);
    return scripts;
  }

  it.each([
    ['doctype without a head', '<!doctype html>', '<title>x</title><p>y</p>', 'CSS1Compat'],
    ['uppercase doctype', '<!DOCTYPE html>', '<title>x</title><p>y</p>', 'CSS1Compat'],
    ['leading whitespace', ' \n\t<!doctype html>\n ', '<title>x</title><p>y</p>', 'CSS1Compat'],
    ['leading BOM and whitespace', '\uFEFF \n<!doctype html>\n ', '<title>x</title><p>y</p>', 'CSS1Compat'],
    ['leading comments', '<!--before-->\n<!doctype html>\n<!--after--> \n', '<html><title>x</title><p>y</p></html>', 'CSS1Compat'],
    ['implied html and leading comments', '<!doctype html><!--kept-->\n', '<title>x</title><p>y</p>', 'CSS1Compat'],
    ['explicit html without a head', '<!doctype html>\n', '<html><title>x</title><p>y</p></html>', 'CSS1Compat'],
    ['explicit head', '<!doctype html><html><head>', '<title>x</title></head><body>y</body></html>', 'CSS1Compat'],
    ['explicit head without a doctype', '<html><head>', '<title>x</title></head><body>y</body></html>', 'BackCompat'],
    ['no doctype', '', '<title>x</title><p>y</p>', 'BackCompat'],
    ['no doctype with a leading comment', ' \n', '<!--kept--><title>x</title><p>y</p>', 'BackCompat'],
  ])('preserves bootstrap placement and document mode with %s', async (_name, prefix, content, mode) => {
    const output = await rewrite(prefix + content);
    // The route's UTF-8 Response decoder consumes an initial BOM.
    expect(output.startsWith(prefix.replace(/^\uFEFF/, '') + '<script>')).toBe(true);
    expect(output).toContain('</script>' + content);
    expect(verifiedScripts(output)).toHaveLength(1);
    const dom = new JSDOM(output);
    try {
      expect(dom.window.document.compatMode).toBe(mode);
    } finally {
      dom.window.close();
    }
  });

  it.each(contexts)('keeps head-like text in a %s inert without a real head', async (_name, content) => {
    const document = await rewrite(`${content}${pageScript}`);
    verifiedScripts(document);
    expect(document).toContain(content);
  });

  it.each([
    ['comment before the head', '<!--<head>--><html><head></head><body></body></html>'],
    ['attribute before the head', '<html data-note="<head>"><head></head><body></body></html>'],
    ['quoted delimiter in the head', '<html><head data-note=">"></head><body></body></html>'],
  ])('uses the parsed head boundary with a %s', async (_name, content) => {
    const document = await rewrite(content.replace('</head>', `${pageScript}</head>`));
    verifiedScripts(document);
    expect(document).toContain(content.slice(0, content.indexOf('</head>')));
  });

  it.each([
    ['real head', `<html><head>${pageScript}</head><body></body></html>`],
    ['implied head', pageScript],
    ['empty document', ''],
    ['leading doctype and comment', `<!doctype html><!--kept-->${pageScript}`],
    ['implied head and trailing document comment', `${pageScript}</html><!--trailing-->`],
    ['late ignored head', `<body><head>${pageScript}</head></body>`],
    ...contexts.map(([name, content]) => [`real head with ${name}`, `<html><head>${content}${pageScript}</head></html>`]),
  ])('runs the bootstrap first in a document with %s', async (_name, content) => {
    const scripts = verifiedScripts(await rewrite(content));
    const nativeFetch = () => Promise.resolve(new Response('fixture'));
    const window = { fetch: nativeFetch, originalFetch: nativeFetch, previewBootstrapFirst: false };
    class XMLHttpRequest { open() {} }
    for (const script of scripts) runInNewContext(script, { window, XMLHttpRequest, Request, URL });
    if (content.includes(pageScript)) expect(window.previewBootstrapFirst).toBe(true);
    expect(scripts).toHaveLength(1 + (content.includes(pageScript) ? 1 : 0) + (content.includes('window.marker') ? 1 : 0));
  });

  it('leaves zero refresh elements and exactly one bootstrap for generated full rewrite outputs', async () => {
    const joined = `<${refresh}meta http-equiv=refresh content=0;url=/joined>`;
    const nested = `<${joined}meta http-equiv=refresh content=0;url=/nested>`;
    for (const [, content] of contexts) {
      for (const realHead of [false, true]) {
        for (const metadata of [refresh, joined, nested, `<template>${joined}</template>`]) {
          for (const leading of ['', '<!doctype html><!--<head>-->']) {
            const body = `${content}${metadata}${pageScript}`;
            const input = leading + (realHead ? `<html><head>${body}</head></html>` : body);
            verifiedScripts(await rewrite(input));
          }
        }
      }
    }
  });
});

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
