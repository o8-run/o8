import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));

type Frame = { id: string; command: string; authToken?: string; payload: { code?: string } };
type Result = { isError?: boolean; content: Array<{ text: string }> };
let root: string;
let socketPath: string;
let expectedToken: string;
let http: HttpServer;
let bridge: Server;
let url: string;
let session: string;
let bearer: string;
let frames: Frame[];
let dispatched: Frame[];
let fault: string | null;
let beforeAuth: ((frame: Frame) => void) | undefined;
let dropAfterDispatch: boolean;
const sockets = new Set<Socket>();
const state = { document: { readyState: 'complete', querySelectorAll: () => [] },
  window: { location: { pathname: '/dashboard', search: '', hash: '' } } };

async function rpc(method: string, params?: unknown, authenticated = true) {
  const response = await fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}),
    ...(session ? { 'Mcp-Session-Id': session } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  signal: AbortSignal.timeout(5000) });
  return response;
}
async function call(name = 'o8_view_eval', args: Record<string, unknown> = { code: 'document.readyState' }): Promise<Result> {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  return (await response.json()).result;
}
function payload(result: Result) { return JSON.parse(result.content[0].text); }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'o8-http-view-'));
  socketPath = join(root, 'bridge.sock');
  expectedToken = randomUUID();
  bearer = randomUUID();
  writeFileSync(`${socketPath}.token`, expectedToken);
  writeFileSync(join(root, 'ws-token'), bearer);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
  vi.stubEnv('TAURI_MCP_AUTH_TOKEN', '');
  frames = []; dispatched = []; fault = null; beforeAuth = undefined; dropAfterDispatch = false; session = '';
  bridge = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, end)) as Frame;
        buffer = buffer.slice(end + 1); frames.push(frame); beforeAuth?.(frame);
        if (frame.authToken !== expectedToken) {
          socket.write(JSON.stringify({ id: frame.id, success: false,
            error: 'Authentication failed: invalid or missing auth token' }) + '\n');
          continue;
        }
        dispatched.push(frame);
        if (dropAfterDispatch) { socket.destroy(); continue; }
        const data = fault ? null : frame.command === 'execute_js'
          ? { result: String(runInNewContext(frame.payload.code!, state)) }
          : { app: { name: 'o8' } };
        socket.write(JSON.stringify({ id: frame.id, success: !fault, data, error: fault }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
  const { panelGateMiddleware } = await import('@/middleware');
  const { POST } = await import('@/app/api/mcp/route');
  http = createHttpServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new NextRequest(url, { method: 'POST',
        headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString() });
      const gate = panelGateMiddleware(request);
      const response = gate.headers.get('x-middleware-next') === '1' ? await POST(request) : gate;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}/api/mcp`;
  const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'o8-test', version: '1' } });
  expect(initialized.status).toBe(200);
  session = initialized.headers.get('Mcp-Session-Id')!;
  expect(session).toBeTruthy();
});

beforeEach(async () => {
  expectedToken = randomUUID();
  writeFileSync(`${socketPath}.token`, expectedToken);
  vi.stubEnv('TAURI_MCP_AUTH_TOKEN', '');
  frames = []; dispatched = []; fault = null; beforeAuth = undefined; dropAfterDispatch = false;
  if (!bridge.listening) await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
});

afterAll(async () => {
  http?.closeAllConnections();
  if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  if (bridge) await new Promise<void>((resolve) => bridge.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('authenticated POST /api/mcp webview reads', () => {
  it('requires real operator authentication before the bridge dispatch', async () => {
    expect((await rpc('tools/call', { name: 'o8_view_eval', arguments: { code: 'document.readyState' } }, false)).status).toBe(401);
    expect(frames).toHaveLength(0);
  });

  it.each(['o8_view_eval', 'o8_view_surface_state'])('reports a missing bridge selection for %s', async (name) => {
    vi.stubEnv('O8_TAURI_MCP_SOCKET', '');
    try {
      const result = await call(name, name === 'o8_view_eval' ? { code: 'document.readyState' } : {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(payload(result))).toContain('webview_socket_unconfigured');
      expect(JSON.stringify(payload(result))).toContain('O8_TAURI_MCP_SOCKET');
    } finally { vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath); }
  });

  it('uses current bridge authentication over a stale inherited token for both reads', async () => {
    const { O8WebviewClient } = await import('@/lib/mcp/o8-webview-client');
    const native = new O8WebviewClient();
    try {
      // Control reads use the same authenticated socket as the HTTP tools.
      expect((await native.getAppInfo()).app?.name).toBe('o8');
      expect((await native.evalJs('document.readyState')).result).toBe('complete');
    } finally { native.dispose(); }
    vi.stubEnv('TAURI_MCP_AUTH_TOKEN', randomUUID());
    expect(payload(await call())).toEqual({ ok: true, value: 'complete' });
    expect(payload(await call('o8_view_surface_state', {}))).toMatchObject({ route: '/dashboard' });
  });

  it('refreshes rotated authentication on an already connected HTTP host', async () => {
    expect((await call()).isError).not.toBe(true);
    expectedToken = randomUUID(); writeFileSync(`${socketPath}.token`, expectedToken);
    expect(payload(await call())).toEqual({ ok: true, value: 'complete' });
    expect(payload(await call('o8_view_surface_state', {}))).toMatchObject({ route: '/dashboard' });
    expect(frames).toHaveLength(3);
  });

  it('does not replay eval when authentication rotates between file read and dispatch', async () => {
    beforeAuth = () => { beforeAuth = undefined; expectedToken = randomUUID(); writeFileSync(`${socketPath}.token`, expectedToken); };
    expect(payload(await call())).toMatchObject({ error: { code: 'webview_auth_rejected' } });
    expect(frames).toHaveLength(1);
    expect(dispatched).toHaveLength(0);
    expect(payload(await call())).toEqual({ ok: true, value: 'complete' });
  });

  it.each(['o8_view_eval', 'o8_view_surface_state'])('bounds stale-auth recovery for %s and returns sanitized guidance', async (name) => {
    expectedToken = randomUUID();
    const result = await call(name, name === 'o8_view_eval' ? { code: 'document.readyState' } : {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(payload(result))).toContain('webview_auth_rejected');
    expect(JSON.stringify(payload(result))).toContain('authentication');
    expect(JSON.stringify(result)).not.toContain(readFileSync(`${socketPath}.token`, 'utf8'));
    expect(frames).toHaveLength(1); expect(dispatched).toHaveLength(0);
  });

  it('does not replay an auth-looking error returned after dispatch', async () => {
    fault = 'Authentication failed: invalid or missing auth token';
    expect((await call()).isError).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });

  it('reports missing bridge authentication before sending an unauthenticated command', async () => {
    rmSync(`${socketPath}.token`);
    const result = await call();
    expect(payload(result)).toMatchObject({ error: { code: 'webview_auth_missing', message: expect.stringContaining('authentication') } });
    expect(frames).toHaveLength(0);
  });

  it('supports explicit authentication when no bridge token file is published', async () => {
    rmSync(`${socketPath}.token`); vi.stubEnv('TAURI_MCP_AUTH_TOKEN', expectedToken);
    expect(payload(await call())).toEqual({ ok: true, value: 'complete' });
  });

  it.each([
    ['Window not found: private-window', 'webview_window_missing'],
    ['mcp_result not allowed. Permissions associated with this command: private-permission', 'webview_permission_denied'],
    ['Timeout waiting for execute_js response', 'webview_bridge_unresponsive'],
    ['private-exception-detail', 'webview_command_failed'],
  ])('returns an actionable sanitized error for %s', async (message, code) => {
    fault = message;
    const result = await call();
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: { code, message: expect.not.stringContaining('o8 operation failed') } });
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it.each(['o8_view_eval', 'o8_view_surface_state'].flatMap(name =>
    ['Webview window not found', 'Webview window not found: private-window'].map(message => [name, message] as const),
  ))('preserves the missing-window diagnosis for %s (%s)', async (name, message) => {
    fault = message;
    const result = await call(name, name === 'o8_view_eval' ? { code: 'document.readyState' } : {});
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(name === 'o8_view_eval' ? body.error.code : body.code).toBe('webview_window_missing');
    expect(JSON.stringify(body)).toContain('No target app window');
    expect(JSON.stringify(result)).not.toContain(message);
    expect(frames).toHaveLength(1);
  });

  it('keeps scroll acknowledgement timeout handling without replay', async () => {
    fault = 'Timeout waiting for scroll_page response';
    const result = await call('o8_view_scroll', { direction: 'down' });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({ ok: true, warning: expect.stringContaining('avoid duplicate') });
    expect(dispatched).toHaveLength(1);
  });

  it('reports a missing native bridge through HTTP', async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await call();
    expect(payload(result)).toMatchObject({ error: { code: 'webview_bridge_missing', message: expect.stringContaining('bridge') } });
  });

  it('never replays execute_js after a dispatched action loses its response', async () => {
    dropAfterDispatch = true;
    const result = await call('o8_view_eval', { code: 'window.actionCount = (window.actionCount || 0) + 1' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: { code: 'webview_outcome_unknown' } });
    expect(dispatched).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });
});
