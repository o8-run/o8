import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

// The native owner receives each request; the Next wrappers never load local state.
vi.mock('@/lib/devices/agent-route', () => { throw new Error('Next loaded the MCP host'); });
vi.mock('@/lib/tasks/report-route', () => { throw new Error('Next loaded task state'); });
vi.mock('@/lib/tasks/block-route', () => { throw new Error('Next loaded task state'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('forwards worker routes before importing their stateful implementations', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  const calls = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', calls);
  const devices = await import('@/app/api/devices/agent/route');
  const report = await import('@/app/api/tasks/[taskId]/report/route');
  const block = await import('@/app/api/tasks/[taskId]/block/route');
  for (const [path, handler] of [
    ['/api/devices/agent', devices.POST],
    ['/api/tasks/packet-a/report', report.POST],
    ['/api/tasks/packet-a/block', block.POST],
  ] as const) {
    const request = new NextRequest(`http://localhost${path}`, { method: 'POST',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1' }, body: '{}' });
    const response = await handler(request, { params: Promise.resolve({ taskId: 'packet-a' }) });
    expect(response.status).toBe(200);
    const [url, options] = calls.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe(path);
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
    expect(new Headers(options.headers).has('x-o8-client-addr')).toBe(false);
  }
});
