import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/panel/api-port', () => ({ getWsBase: () => 'ws://127.0.0.1:39999' }));
vi.mock('@/lib/tasks/detail-route', () => { throw new Error('loaded local task state'); });
vi.mock('@/lib/artifacts/ingest-route', () => { throw new Error('loaded local artifact state'); });
vi.mock('@/lib/artifacts/mirror-route', () => { throw new Error('loaded local mirror state'); });
vi.mock('@/lib/runtimes/managed-runs/http-route', () => { throw new Error('loaded local run state'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('forwards each Next entry without loading owner state', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ owner: 'native' }));
  vi.stubGlobal('fetch', fetcher);
  const task = await import('@/app/api/tasks/[taskId]/route');
  const artifacts = await import('@/app/api/panel/artifacts/route');
  const mirror = await import('@/app/api/panel/artifacts/mirror/route');
  const runs = await import('@/app/api/panel/managed-runs/route');
  const body = Buffer.from(' {\n"label":"exact bytes: é"}\n', 'utf8');
  for (const [path, method, handler] of [
    ['/api/tasks/packet-a?projectId=project%2Fa', 'GET', (r: NextRequest) => task.GET(r, { params: Promise.resolve({ taskId: 'packet-a' }) })],
    ['/api/panel/artifacts?packetId=packet%2Da', 'GET', artifacts.GET], ['/api/panel/artifacts', 'POST', artifacts.POST],
    ['/api/panel/artifacts/mirror', 'POST', mirror.POST],
    ['/api/panel/managed-runs', 'GET', runs.GET], ['/api/panel/managed-runs', 'POST', runs.POST],
  ] as const) {
    const response = await handler(new NextRequest(`http://localhost:3001${path}`, {
      method, headers: { host: 'localhost:3001', authorization: 'Bearer fixture', 'content-type': 'application/json; charset=utf-8' },
      ...(method === 'POST' ? { body } : {}),
    }));
    expect(await response.json()).toEqual({ owner: 'native' });
    expect(fetcher.mock.lastCall?.[0]).toBe(`http://127.0.0.1:39999${path}`);
    const forwarded = fetcher.mock.lastCall![1];
    const headers = new Headers(forwarded.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture');
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    if (method === 'POST') expect(Buffer.from(forwarded.body as ArrayBuffer)).toEqual(body);
    else expect(forwarded.body).toBeUndefined();
  }
});
