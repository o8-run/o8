import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleNativeHttp } from '@/lib/ws-server/native-http-routes';

it('measures the existing public composer body boundary without executing a turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-composer-body-limit-'));
  const token = 'isolated-body-limit-operator';
  writeFileSync(join(root, 'ws-token'), token);
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('O8_NEXT_API_TOKEN', token); vi.stubEnv('O8_API_FRONT_DOOR', '1');
  const server = createServer((req, res) => {
    void handleNativeHttp(req, res, req.socket.localPort, false, req.socket.remoteAddress ?? null)
      .then(handled => { if (!handled) res.writeHead(404).end(); })
      .catch(() => res.writeHead(500).end());
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/orchestrator/composer-queue`;
    // Malformed JSON exercises body admission without admitting or dispatching work.
    for (const bytes of [16 * 1024 * 1024 - 1, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
      const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: ' '.repeat(bytes) });
      expect(response.status, `${bytes} public request bytes`).toBe(bytes > 16 * 1024 * 1024 ? 413 : 400);
      const body = await response.json();
      if (response.status === 413) expect(body).toEqual({ error: 'Request exceeds 16 MiB' });
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
