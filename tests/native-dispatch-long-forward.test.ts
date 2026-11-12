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

it('waits for delayed headers after a fetch control times out', async () => {
  const server = createServer((_req, res) => {
    const timer = setTimeout(() => res.end(JSON.stringify({ ok: true, dispatched: 2 })), 3_000);
    res.once('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', String(address.port));
  vi.stubEnv('O8_API_PORT', '1');
  try {
    // This control shows Node's undici-backed fetch timing out; the first test's fetchMock assertion proves dispatch avoids fetch.
    const timedOut = expect(fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(250) })).rejects.toMatchObject({ name: 'TimeoutError' });
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const started = performance.now();
    const response = await POST(new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', { method: 'POST', body: JSON.stringify({ wait: true }) }));
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, dispatched: 2 });
    await timedOut;
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);

it('closes the pending upstream socket when the caller aborts', async () => {
  const sockets = new Set<import('node:net').Socket>();
  let received!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async req => {
    for await (const _chunk of req) { /* Drain the request before holding headers. */ }
    received();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); closed(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', String(address.port));
  vi.stubEnv('O8_API_PORT', '1');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const abort = new AbortController();
    const pending = POST(new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', { method: 'POST', body: JSON.stringify({ wait: true }), signal: abort.signal }));
    await ready;
    expect(sockets.size).toBe(1);
    abort.abort();
    expect((await pending).status).toBe(503);
    await disconnected;
    expect(sockets.size).toBe(0);
  } finally {
    warning.mockRestore();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
