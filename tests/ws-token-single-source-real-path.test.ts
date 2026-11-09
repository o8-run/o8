import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startParityReference } from './fixtures/ws-parity-server';

// The operator credential has one source. Every client (the desktop shell, o8d, the MCP
// servers) reads <data dir>/ws-token, so the middleware gate, the request handlers and the WS
// upgrade must accept that token even when WS_TOKEN in the server's environment says otherwise.
// A split here locked the operator out of every handler-checked route with Next stopped.
it.skipIf(process.platform === 'win32')('accepts the stored operator token at the gate, the handlers and the WS upgrade when WS_TOKEN differs (#5576)', async () => {
  const envToken = 'ws-token-divergent-environment-credential';
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, envToken, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const stored = readFileSync(join(server.directory, 'ws-token'), 'utf8').trim();
    expect(stored).toBe(server.token);
    expect(stored).not.toBe(envToken);
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const digest = (bearer: string) => fetch(`${origin}/api/orchestrator/digest`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}' });
    const avatar = (bearer: string) => fetch(`${origin}/api/panel/account/avatar`, { headers: { authorization: `Bearer ${bearer}` } });
    const upgrade = (token: string) => new Promise<number>((resolve) => {
      const socket = new WebSocket(`${server!.url}?token=${encodeURIComponent(token)}`);
      socket.once('open', () => { socket.close(); resolve(101); });
      socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); socket.terminate(); });
      socket.once('error', () => resolve(0));
    });

    // The stored token passes the gate AND each handler check: requirePanelAuth stops at the
    // missing field (400), and principal resolution names the operator (204, no identity yet).
    expect((await digest(stored)).status).toBe(400);
    expect((await avatar(stored)).status).toBe(204);
    expect(await upgrade(stored)).toBe(101);

    // The divergent environment value is no credential anywhere.
    expect((await digest(envToken)).status).toBe(401);
    expect((await avatar(envToken)).status).toBe(401);
    expect(await upgrade(envToken)).not.toBe(101);
  } finally {
    await server?.stop();
  }
}, 180_000);
