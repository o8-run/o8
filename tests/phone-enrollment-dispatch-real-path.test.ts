import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { beforeAll, expect, it, vi } from 'vitest';

let getOrCreateWsToken: typeof import('../src/lib/ws-auth').getOrCreateWsToken;
let getSqlite: typeof import('../src/lib/db').getSqlite;
let handleNativeHttp: typeof import('../src/lib/ws-server/native-http-routes').handleNativeHttp;

beforeAll(async () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  vi.stubEnv('O8_NEXT_O8D', '0');
  vi.stubEnv('O8_MOBILE_E2EE', '1');
  const { getDataDir } = await import('../src/lib/data-dir-migration');
  vi.stubEnv('O8_LAUNCHER_SOCKET', join(getDataDir(), 'fixture-no-launcher.sock'));
  ({ getOrCreateWsToken } = await import('../src/lib/ws-auth'));
  ({ getSqlite } = await import('../src/lib/db'));
  ({ handleNativeHttp } = await import('../src/lib/ws-server/native-http-routes'));
  await import('../src/app/api/panel/mobile-pairing/route');
  await import('../src/app/api/mobile/enroll/route');
}, 120_000);

it('consumes the WS pairing code once and mints only the existing scoped device credential', async () => {
  const operator = getOrCreateWsToken();
  const sqlite = getSqlite();
  const before = (sqlite.prepare('SELECT COUNT(*) AS n FROM mobile_devices').get() as { n: number }).n;
  const server = createServer((req, res) => {
    void (async () => {
      if (!await handleNativeHttp(req, res, req.socket.localPort, false, req.socket.remoteAddress ?? null)) res.writeHead(404).end();
    })().catch(() => res.writeHead(500).end());
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('PORT', String(port));
    vi.stubEnv('O8_API_PORT', String(port));
    const origin = 'http://127.0.0.1:' + port;
    const qrResponse = await fetch(origin + '/api/panel/mobile-pairing', {
      headers: { authorization: 'Bearer ' + operator }, signal: AbortSignal.timeout(10_000),
    });
    expect(qrResponse.status).toBe(200);
    const qr = await qrResponse.json();
    expect(qr.enroll).toMatch(/^[a-f0-9]{32}$/);
    const identityPublicKey = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64');
    const body = JSON.stringify({ enroll: qr.enroll, identityPublicKey, deviceLabel: 'owned-phone-fixture' });
    const enroll = () => fetch(origin + '/api/mobile/enroll', { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-o8-relay-forward': '1' },
      signal: AbortSignal.timeout(10_000) });
    const enrolled = await enroll();
    expect(enrolled.status).toBe(200);
    const credential = await enrolled.json();
    expect(credential.serverIdentityPublicKey).toBe(qr.sIdent);
    expect(credential.deviceToken).not.toBe(operator);
    const row = sqlite.prepare('SELECT token_hash FROM mobile_devices WHERE identity_public_key = ?').get(identityPublicKey) as { token_hash: string };
    expect(row.token_hash).toBe(createHash('sha256').update(credential.deviceToken).digest('hex'));
    expect(row.token_hash).not.toBe(credential.deviceToken);
    expect((await enroll()).status).toBe(403);
    const count = (sqlite.prepare('SELECT COUNT(*) AS n FROM mobile_devices').get() as { n: number }).n;
    expect(count).toBe(before + 1);
    expect(getSqlite()).toBe(sqlite);
    const refresh = await fetch(origin + '/api/panel/mobile-pairing', {
      headers: { authorization: 'Bearer ' + credential.deviceToken, 'x-o8-relay-forward': '1' },
      signal: AbortSignal.timeout(10_000),
    });
    expect(refresh.status).toBe(200);
    const scoped = await refresh.json();
    expect(scoped.token).toBe('');
    expect(scoped).not.toHaveProperty('enroll');
    expect(scoped).not.toHaveProperty('sIdent');
    for (const [path, message] of [
      ['/api/mobile/orchestrator/threads', 'repoPath is required'],
      ['/api/mobile/terminal-input', 'sessionName and text are required'],
    ]) {
      const response = await fetch(origin + path, { method: 'POST', body: '{}',
        headers: { authorization: 'Bearer ' + operator, 'content-type': 'application/json', 'x-o8-relay-forward': '1' },
        signal: AbortSignal.timeout(10_000) });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: message });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    sqlite.close();
    vi.unstubAllEnvs();
  }
}, 30_000);
