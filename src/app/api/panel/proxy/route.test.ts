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
