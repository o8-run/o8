import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it('signs the public front-door ports for credential-free phone recovery through the dispatcher', async () => {
  const oldWs = createServer();
  const server = createServer((req, res) => {
    void import('../src/lib/ws-server/native-http-routes').then(async ({ handleNativeHttp }) => {
      if (!await handleNativeHttp(req, res, req.socket.localPort, false, req.socket.remoteAddress ?? null)) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  try {
    await new Promise<void>(resolve => oldWs.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('O8_API_FRONT_DOOR', '1');
    vi.stubEnv('O8_NEXT_O8D', '0');
    vi.stubEnv('O8_MOBILE_E2EE', '1');
    vi.stubEnv('PORT', String(port));
    vi.stubEnv('O8_API_PORT', String(port));
    vi.stubEnv('O8_WS_PORT', String((oldWs.address() as { port: number }).port));
    const origin = 'http://127.0.0.1:' + port;
    const nonce = 'owned-paired-phone-nonce';
    const response = await fetch(origin + '/api/mobile/pairing-discovery?nonce=' + nonce, {
      headers: { 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.9', 'x-o8d-bridge': 'forged' },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['apiPort', 'nonce', 'signature', 'v', 'wsPort']);
    expect(body).toMatchObject({ v: 1, nonce, apiPort: port, wsPort: port });
    const { pairingDiscoveryTranscript } = await import('../src/lib/mobile/pairing-discovery');
    const { verifyDetached } = await import('../src/lib/mobile/e2ee-crypto');
    const { getServerIdentity } = await import('../src/lib/mobile/e2ee-identity');
    const publicKey = getServerIdentity().publicKeyB64;
    expect(verifyDetached(pairingDiscoveryTranscript(nonce, port, port), body.signature, publicKey)).toBe(true);
    expect(verifyDetached(pairingDiscoveryTranscript('another-paired-phone-nonce', port, port), body.signature, publicKey)).toBe(false);
    expect((await fetch(origin + '/api/mobile/pairing-discovery')).status).toBe(400);
    vi.stubEnv('O8_MOBILE_E2EE', '0');
    expect((await fetch(origin + '/api/mobile/pairing-discovery?nonce=' + nonce)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => oldWs.close(() => resolve()));
  }
}, 30_000);

it('keeps Ask POST JSON validation behind the existing bearer gate on WS', async () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  vi.stubEnv('O8_NEXT_O8D', '0');
  const { getOrCreateWsToken } = await import('../src/lib/ws-auth');
  const token = getOrCreateWsToken();
  const server = createServer((req, res) => {
    void import('../src/lib/ws-server/native-http-routes').then(async ({ handleNativeHttp }) => {
      if (!await handleNativeHttp(req, res, req.socket.localPort, false, req.socket.remoteAddress ?? null)) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const call = (body: string, bearer = token) => fetch(origin + '/api/mobile/genui/stream', {
      method: 'POST', body, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json',
        'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.9' }, signal: AbortSignal.timeout(10_000),
    });
    expect((await call('{}', 'wrong')).status).toBe(401);
    const missing = await call('{}');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { message: 'messages array is required.' } });
    expect((await call('{')).status).toBe(400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
