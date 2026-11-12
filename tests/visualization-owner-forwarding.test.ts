import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/visualizations/publish-route', () => { throw new Error('Next loaded publication state'); });
vi.mock('@/lib/visualizations/preview-route', () => { throw new Error('Next loaded preview state'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('forwards both POST methods without loading preview or publication state in Next', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  const calls = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', calls);
  const publish = await import('@/app/api/visualizations/route');
  const preview = await import('@/app/api/visualizations/preview/route');
  for (const [path, handler] of [['/api/visualizations', publish.POST], ['/api/visualizations/preview', preview.POST]] as const) {
    expect((await handler(new Request(`http://localhost${path}`, { method: 'POST',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' }, body: '{}' }))).status).toBe(200);
    const [url, options] = calls.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe(path);
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
    expect(new Headers(options.headers).has('x-o8-client-addr')).toBe(false);
  }
});
