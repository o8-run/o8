import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.O8_API_PORT = '48123';
process.env.O8_WS_PORT = '48124';

const { GET } = await import('./route');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/browser/proxy redirect policy', () => {
  it('refuses a real upstream redirect whose resolved target is an o8-owned port', async () => {
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1:48123/api/panel/status' },
    }));
    vi.stubGlobal('fetch', upstreamFetch);

    const target = 'http://localhost:39001/start';
    const request = new NextRequest(
      `http://localhost:48123/api/browser/proxy?url=${encodeURIComponent(target)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'redirect target is not permitted by the preview proxy policy',
    });
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(target);
    expect(upstreamFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
