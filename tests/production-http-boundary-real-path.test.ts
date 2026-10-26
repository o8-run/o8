import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { NextRequest, NextResponse } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const context = vi.hoisted(() => ({ headers: undefined as Headers | undefined }));
vi.mock('next/headers', () => ({ headers: async () => context.headers }));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/components/NavigationBridge', () => ({ default: () => null }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ O8AuthProvider: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/security/ApiBearerBootstrap', () => ({ ApiBearerBootstrap: () => null }));

const root = mkdtempSync(join(tmpdir(), 'o8-http-boundary-'));
const bearer = randomUUID();
const nativeToken = randomUUID();
const socketPath = join(root, 'native.sock');
const nativeState = { boundaryCount: 0 };
const sockets = new Set<Socket>();
let child: ChildProcess;
let noUpgradeChild: ChildProcess;
let noUpgradePort: number;
let native: Server;
let port: number;
let nativeCalls = 0;
let handlerCalls = 0;
let ready: Promise<void>;

type Forwarded = { id: number; method: string; url: string; headers: Record<string, string>; body: string };

beforeAll(async () => {
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('O8_DATA_DIR', root);
  vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath); vi.stubEnv('TAURI_MCP_AUTH_TOKEN', '');
  writeFileSync(join(root, 'ws-token'), bearer); writeFileSync(`${socketPath}.token`, nativeToken);
  native = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (frame.authToken !== nativeToken) throw new Error('Invalid fixture bridge authentication');
        nativeCalls++;
        const result = runInNewContext(frame.payload.code, nativeState);
        socket.write(JSON.stringify({ id: frame.id, success: true, data: { result: String(result) } }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => native.listen(socketPath, resolve));
  const source = readFileSync('scripts/tauri-export.mjs', 'utf8');
  const start = source.indexOf("writeFileSync(join(server, 'server.js'), ") + "writeFileSync(join(server, 'server.js'), ".length;
  const end = source.indexOf("\nconsole.log('📦 Wrote server.js wrapper", start);
  const template = source.slice(start, end).trim().replace(/\);$/, '');
  const wrapper = runInNewContext(template, Object.fromEntries([
    'RELEASE_ENV_STANZA', 'SENTRY_ENV_STANZA', 'APP_VERSION_STANZA', 'BUILD_GIT_SHA_STANZA', 'BOOT_CAPTURE_STANZA',
  ].map(name => [name, ''])));
  writeFileSync(join(root, 'server.js'), wrapper);
  const policy = 'scripts/lib/http-request-boundary.cjs';
  if (existsSync(policy)) copyFileSync(policy, join(root, 'http-request-boundary.cjs'));
  writeFileSync(join(root, 'server-impl.js'), `
const http = require('node:http');
let next = 0; const responses = new Map();
process.on('message', message => { const res = responses.get(message.id); if (!res) return; responses.delete(message.id); res.writeHead(message.status, message.headers || {}); res.end(message.body); });
const server = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const id = ++next; responses.set(id, res); process.send({ id, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); });
if (!process.env.O8_FIXTURE_NO_UPGRADE) server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n'));
server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: server.address().port }));
`);
  const { panelGateMiddleware, config } = await import('@/middleware');
  const { POST } = await import('@/app/api/mcp/route');
  const { default: RootLayout } = await import('@/app/layout');
  child = spawn(process.execPath, [join(root, 'server.js')], { env: { ...process.env,
    O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let resolveReady!: () => void; ready = new Promise<void>(resolve => { resolveReady = resolve; });
  child.on('message', async (message: Forwarded & { ready?: boolean; port?: number }) => {
    if (message.ready) { port = message.port!; resolveReady(); return; }
    handlerCalls++;
    try {
      const req = new NextRequest(new URL(message.url, `http://127.0.0.1:${port}`), { method: message.method,
        headers: message.headers, ...(message.method === 'POST' ? { body: message.body } : {}) });
      const gated = config.matcher.includes('/:path*') || message.url.startsWith('/api/') || message.url.startsWith('/broadcast');
      const gate = gated ? panelGateMiddleware(req) : NextResponse.next();
      let response: Response = gate;
      if (gate.headers.get('x-middleware-next') === '1') {
        if (message.url === '/api/mcp') response = await POST(req);
        else if (message.url.startsWith('/api/')) response = Response.json({ ok: true });
        else {
          context.headers = new Headers(message.headers);
          response = new Response(renderToStaticMarkup(await RootLayout({ children: null })), { headers: { 'content-type': 'text/html' } });
        }
      }
      child.send({ id: message.id, status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    } catch { child.send({ id: message.id, status: 500, body: 'Fixture route failed' }); }
  });
  await ready;
  noUpgradeChild = spawn(process.execPath, [join(root, 'server.js')], { env: { ...process.env,
    O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, O8_FIXTURE_NO_UPGRADE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  await new Promise<void>(resolve => noUpgradeChild.on('message', (message: { ready?: boolean; port?: number }) => {
    if (message.ready) { noUpgradePort = message.port!; resolve(); }
    else noUpgradeChild.send({ id: (message as { id?: number }).id, status: 500, body: 'Refused request reached the fixture app' });
  }));
  vi.stubEnv('O8_API_PORT', String(port)); vi.stubEnv('PORT', String(port));
}, 60000);

afterAll(async () => {
  for (const serverChild of [child, noUpgradeChild]) {
    if (serverChild?.exitCode === null) { const closed = once(serverChild, 'exit'); serverChild.kill(); await closed; }
  }
  for (const socket of sockets) socket.destroy();
  if (native) await new Promise<void>(resolve => native.close(() => resolve()));
  const { closeDb } = await import('@/lib/db'); closeDb();
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function request(host: string, path = '/', options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host, ...options.headers } }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body })); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode!, body: '' }); });
    req.setTimeout(10000, () => req.destroy(new Error('Fixture request timeout'))); req.on('error', reject); req.end(options.body);
  });
}
function rawRequest(target: string, host: string, upgrade = false, socketPort = port): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPort, '127.0.0.1'); let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('Fixture TCP timeout')));
    socket.on('error', reject); socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: ${upgrade ? 'Upgrade' : 'close'}\r\n${upgrade ? 'Upgrade: websocket\r\n' : ''}\r\n`));
  });
}

it.each(['untrusted.invalid', 'localhost.untrusted.invalid', 'localhost.', '127.1', 'localhost:1', 'localhost:123@untrusted.invalid'])('refuses absolute-form authority %s before app routing over TCP', async authority => {
  const before = handlerCalls;
  const response = await rawRequest(`http://${authority}/`, `127.0.0.1:${port}`);
  expect(response).toMatch(/^HTTP\/1\.1 421 Misdirected Request\r\n/);
  expect(handlerCalls).toBe(before); expect(response).not.toContain(bearer);
});

it.each([['http:untrusted.invalid', 400], ['http:/untrusted.invalid', 400], ['ftp://untrusted.invalid/', 421]] as const)('refuses malformed or unsupported absolute-form target %s', async (target, status) => {
  const before = handlerCalls;
  expect(await rawRequest(target, `127.0.0.1:${port}`)).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
  expect(handlerCalls).toBe(before);
});

it.each(['localhost', '127.0.0.1', '[::1]', 'tauri.localhost'])('retains absolute-form requests to an allowed authority %s', async authority => {
  const response = await rawRequest(`http://${authority}:${port}/`, `127.0.0.1:${port}`);
  expect(response).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
});

it.each([false, true])('answers a refused upgrade authority with HTTP 421 (downstream handler: %s)', async downstreamHandler => {
  const socketPort = downstreamHandler ? port : noUpgradePort;
  const response = await rawRequest('/', `untrusted.invalid:${socketPort}`, true, socketPort);
  expect(response).toMatch(/^HTTP\/1\.1 421 Misdirected Request\r\n/);
  expect(response).toContain('Connection: close\r\n');
});

it.each([false, true])('refuses an absolute-form upgrade authority with an allowed Host (downstream handler: %s)', async downstreamHandler => {
  const socketPort = downstreamHandler ? port : noUpgradePort;
  const response = await rawRequest('http://untrusted.invalid/', `127.0.0.1:${socketPort}`, true, socketPort);
  expect(response).toMatch(/^HTTP\/1\.1 421 Misdirected Request\r\n/);
});

const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name: 'o8_view_eval', arguments: { code: 'globalThis.boundaryCount += 1; globalThis.boundaryCount' },
} });

it.each(['untrusted.invalid', 'sub.localhost', 'localhost.untrusted.invalid', '127.0.0.1.untrusted.invalid', 'localhost.', 'localhost:1', '[::1]:1', 'localhost:123:456', 'localhost:123@untrusted.invalid'])('refuses unapproved Host %s before any app handler', async host => {
  const before = handlerCalls;
  const response = await request(host);
  expect(response.status).toBe(421); expect(response.body.includes(bearer)).toBe(false); expect(handlerCalls).toBe(before);
});

it.each(['localhost', '127.0.0.1', '[::1]'])('serves loopback Host %s at the app port', async host => {
  const response = await request(`${host}:${port}`);
  expect(response.status).toBe(200); expect(response.body.includes(bearer)).toBe(true);
});

it('checks Host before an upgrade reaches its handler', async () => {
  const options = { headers: { connection: 'Upgrade', upgrade: 'websocket' } };
  expect((await request(`untrusted.invalid:${port}`, '/', options)).status).toBe(421);
  expect((await request(`127.0.0.1:${port}`, '/', options)).status).toBe(101);
});

it('serves the exact shell host without injecting the operator bearer', async () => {
  const response = await request('tauri.localhost');
  expect(response.status).toBe(200); expect(response.body.includes(bearer)).toBe(false);
});

it.each(['/api/mcp', '/api/fixture-write'])('refuses foreign or missing browser origins for %s before dispatch', async path => {
  for (const origin of ['https://untrusted.invalid', `http://localhost:${port + 1}`, 'null', undefined]) {
    const before = nativeCalls;
    const response = await request(`127.0.0.1:${port}`, path, { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site',
      ...(origin === undefined ? {} : { origin }),
    }, body: call });
    expect(response.status).toBe(403); expect(nativeCalls).toBe(before);
  }
});

it('retains authenticated native and same-origin browser MCP calls', async () => {
  const callers: Record<string, string>[] = [{}, { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, { origin: 'tauri://localhost' }];
  for (const headers of callers) {
    const before = nativeState.boundaryCount;
    const response = await request(`127.0.0.1:${port}`, '/api/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers,
    }, body: call });
    expect(response.status).toBe(200); expect(nativeState.boundaryCount).toBe(before + 1);
  }
});

it('preserves the relay-forward marker and keeps its page free of the bearer', async () => {
  const response = await request(`127.0.0.1:${port}`, '/', { headers: { 'x-o8-relay-forward': '1', 'x-o8-relay-surface': 'web-machine' } });
  expect(response.status).toBe(200); expect(response.body.includes(bearer)).toBe(false);
  expect(response.body.includes('web-machine')).toBe(true);
  const before = nativeState.boundaryCount;
  const forwarded = await request(`127.0.0.1:${port}`, '/api/mcp', { method: 'POST', headers: {
    authorization: `Bearer ${bearer}`, 'x-o8-relay-forward': '1', 'content-type': 'application/json',
    'sec-fetch-mode': 'cors', 'user-agent': 'node',
  }, body: call });
  expect(forwarded.status).toBe(200); expect(nativeState.boundaryCount).toBe(before + 1);
});

it('checks Host and browser origins in middleware even without the wrapper', async () => {
  const { panelGateMiddleware } = await import('@/middleware');
  const forged = new NextRequest(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST', headers: {
    host: `untrusted.invalid:${port}`, 'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${bearer}`,
  }, body: call });
  expect(panelGateMiddleware(forged).status).toBe(421);
  const missing = new NextRequest(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST', headers: {
    host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', authorization: `Bearer ${bearer}`,
  }, body: call });
  expect(panelGateMiddleware(missing).status).toBe(403);
});

it('keeps the legacy MCP route origin check ahead of tool dispatch', async () => {
  const { POST } = await import('@/app/api/mcp/route'); const before = nativeCalls;
  const response = await POST(new Request(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST', headers: {
    host: `127.0.0.1:${port}`, origin: 'https://untrusted.invalid', authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
  }, body: call }));
  expect(response.status).toBe(403); expect(nativeCalls).toBe(before);
});

it('does not bootstrap a bearer for a foreign Host with a loopback peer stamp', async () => {
  const { default: RootLayout } = await import('@/app/layout');
  context.headers = new Headers({ host: `untrusted.invalid:${port}`, 'x-o8-client-addr': '127.0.0.1' });
  const html = renderToStaticMarkup(await RootLayout({ children: null }));
  expect(html.includes(bearer)).toBe(false);
});
