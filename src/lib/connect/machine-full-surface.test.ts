import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { headersIndicateWebMachineRelay } from './web-machine-surface';
import { MachineRelayConnector, type MachineRelayTicket } from './machine-attach';
import {
  attachRelayUpgrade,
  createWebSurfaceApp,
  RelayServer,
} from '../../../tests/fixtures/reference-relay';

const LOCAL_OPERATOR_TOKEN = 'local-ws-token-must-never-cross-the-relay';
const MACHINE_ID = 'machine-full-surface';
const WEB_SESSION_TICKET = 'signed-web-session-ticket-fixture';

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

interface LocalSurface extends RunningServer {
  wsUrl: string;
  requests: Array<{ path: string; authorization: string; webMachine: boolean }>;
  socketPaths: string[];
  bridgeCloses: number;
}

interface WebClient {
  socket: WebSocket;
  messages: string[];
  sent: string[];
  closed: Promise<{ code: number; reason: string }>;
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

function fixtureTicket(): MachineRelayTicket {
  return {
    ticket: 'signed-machine-ticket-fixture',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<RunningServer> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function writeLocalPage(
  req: IncomingMessage,
  response: ServerResponse,
  requests: LocalSurface['requests'],
): void {
  const webMachine = headersIndicateWebMachineRelay((name) => header(req, name));
  requests.push({
    path: req.url ?? '',
    authorization: header(req, 'authorization') ?? '',
    webMachine,
  });
  const tokenMarkup = webMachine
    ? '<meta name="o8-auth-mode" content="web-machine">'
    : `<meta name="ws-token" content="${LOCAL_OPERATOR_TOKEN}">`;

  if (req.url === '/mobile') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(`<!doctype html><html><head>${tokenMarkup}</head><body><script src="/_next/static/chunks/mobile.js"></script></body></html>`);
    return;
  }
  if (req.url === '/_next/static/chunks/mobile.js') {
    const prefix = webMachine ? '/* web machine */' : `/* ${LOCAL_OPERATOR_TOKEN} */`;
    const fullBody = `${prefix}\nwindow.__mobileChunkLoaded=true;\n${'x'.repeat(320 * 1024)}`;
    const ranged = header(req, 'range') === 'bytes=0-1023';
    const body = ranged ? fullBody.slice(0, 1024) : fullBody;
    response.writeHead(ranged ? 206 : 200, {
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
      ...(ranged ? { 'content-range': `bytes 0-1023/${Buffer.byteLength(fullBody)}` } : {}),
      'content-type': 'application/javascript; charset=utf-8',
      etag: '"mobile-fixture"',
    });
    response.end(body);
    return;
  }
  if (req.url === '/api/panel/ws-info') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      wsPort: 47125,
      wsToken: LOCAL_OPERATOR_TOKEN,
    }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
}

async function startLocalSurface(): Promise<LocalSurface> {
  const requests: LocalSurface['requests'] = [];
  const socketPaths: string[] = [];
  let bridgeCloses = 0;
  const server = createServer((req, response) => {
    writeLocalPage(req, response, requests);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local.o8');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== LOCAL_OPERATOR_TOKEN) {
      socket.destroy();
      return;
    }
    socketPaths.push(req.url ?? '');
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        if (raw.toString().includes('request-credential-leak')) {
          ws.send(JSON.stringify({ wsToken: LOCAL_OPERATOR_TOKEN }));
          return;
        }
        ws.send(JSON.stringify({ channel: 'pong', request: raw.toString() }));
      });
      ws.on('close', () => {
        bridgeCloses++;
      });
    });
  });
  const running = await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local surface lost its port');
  const surface: LocalSurface = {
    ...running,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    requests,
    socketPaths,
    get bridgeCloses() {
      return bridgeCloses;
    },
  };
  cleanup.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await surface.close();
  });
  return surface;
}

async function startRelay(ownerAllowed: () => boolean): Promise<{
  running: RunningServer;
  relay: RelayServer;
  surfaceApp: ReturnType<typeof createWebSurfaceApp>;
}> {
  const relay = new RelayServer({
    verifyMachineTicket: async (token) => token === fixtureTicket().ticket
      ? {
          ok: true,
          claims: {
            accountId: 'account-owner',
            machineId: MACHINE_ID,
            installId: 'install-owner',
            exp: Math.floor(Date.now() / 1_000) + 600,
          },
        }
      : { ok: false, reason: 'invalid' },
    verifyWebTicket: async (token) => token === WEB_SESSION_TICKET
      ? {
          ok: true,
          claims: {
            accountId: 'account-owner',
            machineId: MACHINE_ID,
            exp: Math.floor(Date.now() / 1_000) + 600,
          },
        }
      : { ok: false, reason: 'invalid' },
    authorizeWebMachine: async (token, machineId) => (
      ownerAllowed() && token === 'web-account-token' && machineId === MACHINE_ID
    ),
    heartbeatMachine: async () => ({ ok: true, status: 204 }),
    machineHeartbeatMs: 60_000,
  });
  const surfaceApp = createWebSurfaceApp(relay, {
    maxTunnelBytes: 32 * 1024 * 1024,
  });
  const server = createServer((_req, response) => {
    response.writeHead(404);
    response.end();
  });
  attachRelayUpgrade(server, relay);
  const running = await listen(server);
  cleanup.push(async () => {
    relay.stop();
    await running.close();
  });
  return { running, relay, surfaceApp };
}

async function openWebClient(relayUrl: string): Promise<WebClient> {
  const messages: string[] = [];
  const sent: string[] = [];
  const socket = new WebSocket(
    `${relayUrl.replace(/^http/, 'ws')}/web/machine/${MACHINE_ID}`,
    { headers: { authorization: 'Bearer web-account-token' } },
  );
  socket.on('message', (raw: RawData) => {
    messages.push(raw.toString());
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  cleanup.push(() => {
    socket.terminate();
  });
  return { socket, messages, sent, closed };
}

async function openBrowserSurfaceClient(
  relayUrl: string,
  cookie: string,
): Promise<WebClient> {
  const messages: string[] = [];
  const sent: string[] = [];
  const socket = new WebSocket(
    `${relayUrl.replace(/^http/, 'ws')}/web/${MACHINE_ID}/surface/ws`,
    {
      headers: {
        cookie,
        origin: 'https://relay.o8.run',
      },
    },
  );
  socket.on('message', (raw: RawData) => {
    messages.push(raw.toString());
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  cleanup.push(() => {
    socket.terminate();
  });
  return { socket, messages, sent, closed };
}

function sendWeb(client: WebClient, frame: Record<string, unknown>): void {
  const encoded = JSON.stringify(frame);
  client.sent.push(encoded);
  client.socket.send(encoded);
}

function records(messages: string[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    try {
      const value = JSON.parse(message) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for full-surface fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function requestThroughWeb(
  client: WebClient,
  path: string,
  rid: string,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  frameCount: number;
  error?: string;
}> {
  const start = client.messages.length;
  sendWeb(client, { t: 'http-req', rid, method: 'GET', path });
  await waitFor(() => {
    const matching = records(client.messages.slice(start)).filter((frame) => frame.rid === rid);
    return matching.some((frame) => frame.last === true);
  });
  const matching = records(client.messages.slice(start)).filter((frame) => frame.rid === rid);
  const first = matching.find((frame) => frame.t === 'http-res');
  if (!first) throw new Error(`missing response for ${rid}`);
  const parts = matching
    .filter((frame) => frame.t === 'http-res-part')
    .sort((a, b) => Number(a.i) - Number(b.i));
  const encoded = [first, ...parts]
    .map((frame) => typeof frame.bodyB64 === 'string' ? frame.bodyB64 : '')
    .join('');
  return {
    status: Number(first.status),
    headers: first.headers as Record<string, string>,
    body: Buffer.from(encoded, 'base64'),
    frameCount: matching.length,
    ...(typeof first.error === 'string' ? { error: first.error } : {}),
  };
}

describe('web-machine full-surface real path', () => {
  it('terminates the mux into cookie-authenticated HTTP and browser WebSocket routes', async () => {
    const local = await startLocalSurface();
    const { running: relayServer, relay, surfaceApp } = await startRelay(() => true);
    const connector = new MachineRelayConnector({
      machineId: MACHINE_ID,
      relayUrl: relayServer.url.replace(/^http/, 'ws'),
      apiBase: local.url,
      operatorToken: () => LOCAL_OPERATOR_TOKEN,
      ticketProvider: async () => fixtureTicket(),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });
    connector.start();
    cleanup.push(() => connector.stop('test-cleanup'));
    await waitFor(() => relay.stats().machines === 1);

    const session = await surfaceApp.request('/web/session', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WEB_SESSION_TICKET}`,
        origin: 'https://o8.run',
      },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get('access-control-allow-origin')).toBe('https://o8.run');
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    expect(cookie).toBe(`__Host-o8-web-session=${WEB_SESSION_TICKET}`);
    expect(session.headers.get('set-cookie')).toContain('HttpOnly');
    expect(session.headers.get('set-cookie')).toContain('SameSite=Strict');

    const deniedOrigin = await surfaceApp.request(
      `/web/${MACHINE_ID}/surface/mobile`,
      { headers: { cookie, origin: 'https://attacker.example' } },
    );
    expect(deniedOrigin.status).toBe(403);

    const deniedMachine = await surfaceApp.request(
      '/web/another-machine/surface/mobile',
      { headers: { cookie } },
    );
    expect(deniedMachine.status).toBe(403);
    expect(await deniedMachine.json()).toEqual({ error: 'machine_mismatch' });

    const page = await surfaceApp.request(
      `/web/${MACHINE_ID}/surface/mobile`,
      { headers: { cookie } },
    );
    const pageBody = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toContain('https://o8.run');
    expect(pageBody).toContain(
      `/web/${MACHINE_ID}/surface/_next/static/chunks/mobile.js`,
    );
    expect(pageBody).toContain('__O8_WEB_MACHINE_TRANSPORT__');
    expect(pageBody).not.toContain(WEB_SESSION_TICKET);
    expect(pageBody).not.toContain(LOCAL_OPERATOR_TOKEN);

    const asset = await surfaceApp.request(
      `/web/${MACHINE_ID}/surface/_next/static/chunks/mobile.js`,
      { headers: { cookie } },
    );
    const assetBody = Buffer.from(await asset.arrayBuffer());
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('accept-ranges')).toBe('bytes');
    expect(asset.headers.get('etag')).toBe('"mobile-fixture"');
    expect(assetBody.byteLength).toBeGreaterThan(300 * 1024);
    expect(assetBody.includes(Buffer.from(LOCAL_OPERATOR_TOKEN))).toBe(false);

    const range = await surfaceApp.request(
      `/web/${MACHINE_ID}/surface/_next/static/chunks/mobile.js`,
      { headers: { cookie, range: 'bytes=0-1023' } },
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await range.arrayBuffer()).byteLength).toBe(1024);

    // API routes are outside the web-machine allowlist and never reach the Mac.
    const credentialExport = await surfaceApp.request(
      `/web/${MACHINE_ID}/surface/api/panel/ws-info`,
      { headers: { cookie } },
    );
    expect(credentialExport.status).toBe(403);
    expect(
      Buffer.from(await credentialExport.arrayBuffer())
        .includes(Buffer.from(LOCAL_OPERATOR_TOKEN)),
    ).toBe(false);
    expect(local.requests.map((request) => request.path)).not.toContain('/api/panel/ws-info');

    // The browser socket attaches, but no local realtime socket is opened.
    const browser = await openBrowserSurfaceClient(relayServer.url, cookie);
    browser.socket.send(JSON.stringify({ type: 'ping', source: 'browser-bridge' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(records(browser.messages).some((frame) => frame.channel === 'pong')).toBe(false);
    expect(local.socketPaths).toEqual([]);

    connector.stop('fixture-machine-drop');
    expect(await browser.closed).toEqual({
      code: 1012,
      reason: 'machine_disconnected',
    });
  }, 15_000);

  it('proxies token-free documents, large assets, and realtime through the actual relay', async () => {
    let ownsMachine = true;
    const local = await startLocalSurface();
    const { running: relayServer, relay } = await startRelay(() => ownsMachine);
    const connector = new MachineRelayConnector({
      machineId: MACHINE_ID,
      relayUrl: relayServer.url.replace(/^http/, 'ws'),
      apiBase: local.url,
      operatorToken: () => LOCAL_OPERATOR_TOKEN,
      ticketProvider: async () => fixtureTicket(),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });
    connector.start();
    cleanup.push(() => connector.stop('test-cleanup'));
    await waitFor(() => relay.stats().machines === 1);

    const web = await openWebClient(relayServer.url);

    const page = await requestThroughWeb(web, '/mobile', 'page');
    const asset = await requestThroughWeb(
      web,
      '/_next/static/chunks/mobile.js',
      'asset',
    );
    const credentialExport = await requestThroughWeb(
      web,
      '/api/panel/ws-info',
      'credential-export',
    );
    sendWeb(web, { type: 'ping', source: 'browser' });

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body.toString('utf8')).toContain('o8-auth-mode');
    expect(page.body.includes(Buffer.from(LOCAL_OPERATOR_TOKEN))).toBe(false);
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(asset.headers.etag).toBe('"mobile-fixture"');
    expect(asset.frameCount).toBeGreaterThan(1);
    expect(asset.body.byteLength).toBeGreaterThan(300 * 1024);
    expect(asset.body.includes(Buffer.from(LOCAL_OPERATOR_TOKEN))).toBe(false);
    expect(credentialExport).toMatchObject({
      status: 403,
      error: 'web_machine_route_forbidden',
      body: Buffer.alloc(0),
    });
    expect(web.sent.join('')).not.toContain(LOCAL_OPERATOR_TOKEN);
    expect(web.messages.join('')).not.toContain(LOCAL_OPERATOR_TOKEN);
    // Pages and assets are replayed with no local credential; nothing else is.
    expect(local.requests).toEqual([
      { path: '/mobile', authorization: '', webMachine: true },
      { path: '/_next/static/chunks/mobile.js', authorization: '', webMachine: true },
    ]);
    expect(records(web.messages).some((frame) => frame.channel === 'pong')).toBe(false);
    expect(local.socketPaths).toEqual([]);

    connector.stop('fixture-machine-drop');
    const machineDrop = await web.closed;
    expect(local.bridgeCloses).toBe(0);
    expect(machineDrop).toEqual({ code: 1012, reason: 'machine_disconnected' });
    expect(
      records(web.messages).some((frame) => (
        frame.t === 'presence' && frame.machine === 'down'
      )),
    ).toBe(true);

    ownsMachine = false;
    const rejected = await openWebClient(relayServer.url);
    const rejection = await rejected.closed;
    expect(rejection).toEqual({ code: 1008, reason: 'machine_not_owned' });
  }, 10_000);
});
