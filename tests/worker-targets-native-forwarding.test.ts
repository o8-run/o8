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
  for (const [path, method, handler] of [
    ['/api/tasks/packet-a', 'GET', (r: NextRequest) => task.GET(r, { params: Promise.resolve({ taskId: 'packet-a' }) })],
    ['/api/panel/artifacts', 'GET', artifacts.GET], ['/api/panel/artifacts', 'POST', artifacts.POST],
    ['/api/panel/artifacts/mirror', 'POST', mirror.POST],
    ['/api/panel/managed-runs', 'GET', runs.GET], ['/api/panel/managed-runs', 'POST', runs.POST],
  ] as const) {
    const response = await handler(new NextRequest(`http://localhost:3001${path}`, {
      method, headers: { host: 'localhost:3001', authorization: 'Bearer fixture' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }));
    expect(await response.json()).toEqual({ owner: 'native' });
    expect(fetcher.mock.lastCall?.[0]).toBe(`http://127.0.0.1:39999${path}`);
  }
});
