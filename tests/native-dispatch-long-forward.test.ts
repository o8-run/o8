import { createServer } from 'node:http';
import { once } from 'node:events';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
it('keeps wait dispatch on an abortable HTTP hop without the fetch header deadline', async () => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ wait: true });
    expect(req.headers['x-o8-worker-packet-id']).toBeUndefined();
    res.end(JSON.stringify({ ok: true, dispatched: 1 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', String(address.port));
  vi.stubEnv('O8_API_PORT', '1');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch header timeout'));
  try {
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const response = await POST(new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', { method: 'POST', headers: { 'x-o8-worker-packet-id': 'untrusted' }, body: JSON.stringify({ wait: true }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, dispatched: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
