import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import templates from '../crates/o8d/route-templates.json';
import { registeredFrontDoorRoute, forwardToNext } from '@/lib/ws-server/api-front-door';
import { handleNativeHttp } from '@/lib/ws-server/native-http-routes';

it.each([
  ['GET', '/api/panel/app/install-info'],
  ['POST', '/api/panel/targets/dispatch'],
  ['POST', '/api/setup/pi/cache-warming'],
  ['GET', '/api/runtime/threecode-models'],
  ['POST', '/api/panel/prs/7/repair'],
  ['POST', '/api/setup/gemini'],
  ['POST', '/api/panel/entitlement/bootstrap'],
  ['GET', '/api/runtime/billing'],
  ['POST', '/api/runtime/billing'],
  ['GET', '/api/runtime/claude-code-profile'],
  ['POST', '/api/runtime/claude-code-profile'],
  ['PATCH', '/api/runtime/claude-code-profile'],
  ['GET', '/api/runtime/session-summary?sessionKey=codex-owned%3Aretired-fixture'],
])('retires %s %s while preserving its unmatched Next-off response', async (method, path) => {
  const absent = createServer();
  await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
  const next = new URL(`http://127.0.0.1:${(absent.address() as { port: number }).port}`);
  await new Promise<void>(resolve => absent.close(() => resolve()));
  const listener = createServer((req, res) => {
    void (async () => {
      const port = req.socket.localPort!;
      if (registeredFrontDoorRoute(path, method) && await handleNativeHttp(req, res, port, false, req.socket.remoteAddress ?? null)) return;
      forwardToNext(req, res, next, port, req.socket.remoteAddress ?? null);
    })().catch(error => res.writeHead(500).end(String(error)));
  });
  try {
    vi.stubEnv('O8_API_FRONT_DOOR', '1'); vi.stubEnv('O8_NEXT_O8D', '0');
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(listener.address() as { port: number }).port}${path}`, { method });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Next upstream unavailable' });
    expect(registeredFrontDoorRoute(path, method)).toBe(false);
    expect(templates).not.toContain(new URL(path, 'http://fixture.invalid').pathname.replace('/prs/7/', '/prs/[number]/'));
  } finally {
    listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
