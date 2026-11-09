import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// A WS-to-Next caller that POSTs must name its method, or the native route
// lookup checks GET, misses a POST-only registration and sends the request to Next.
it('sends the operator MCP POST to the native listener when the native transport is on', async () => {
  const seen: string[] = [];
  const listen = (name: string) => new Promise<Server>((resolve) => {
    const server = createServer((request, response) => {
      seen.push(`${name} ${request.method} ${request.url}`);
      request.resume().on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { from: name } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const port = (server: Server) => (server.address() as AddressInfo).port;
  const next = await listen('next');
  const native = await listen('native');
  const directory = mkdtempSync(join(tmpdir(), 'o8-next-fetch-method-'));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      HOME: directory, CORTEX_IDE_DATA_DIR: directory, WS_TOKEN: 'next-fetch-fixture-token',
      O8_NEXT_O8D: '1', O8_API_PORT: String(port(next)), O8_WS_PORT: String(port(native)),
    });
    delete process.env.NEXT_ORIGIN;
    vi.resetModules();
    const { operatorOverHttp } = await import('@/lib/pi/orchestrator/o8-servers');
    const { buildNextUrl } = await import('@/lib/ws-server/next-fetch');

    await expect(operatorOverHttp('tools/list', {}, new AbortController().signal)).resolves.toEqual({ from: 'native' });
    expect(seen).toEqual(['native POST /api/mcp']);
    // An unregistered POST still reaches Next.
    expect(buildNextUrl('/api/v2/proxy/llm', undefined, 'POST')).toBe(`http://127.0.0.1:${port(next)}/api/v2/proxy/llm`);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await Promise.all([next, native].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(directory, { recursive: true, force: true });
  }
});
