import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

type RouteCase = { path: string; method: string; body?: unknown };
type Handler = (request: NextRequest) => Response | Promise<Response>;
const cases: RouteCase[] = [
  { path: '/api/panel/mobile-network', method: 'GET' },
  { path: '/api/panel/mobile-network', method: 'POST', body: { enabled: false } },
  { path: '/api/panel/mobile-network', method: 'POST', body: { enabled: true } },
  { path: '/api/panel/mobile-network', method: 'POST', body: { enabled: 'invalid' } },
];
const servers: Server[] = [];
let reference: string;
let native: string;
let repo: string;
let operator: string;
const worker = 'fixture-nonphone-worker-0123456789abcdef';
const phone = 'fixture-nonphone-paired-device-0123456789abcdef';
let reset: () => void;
let snapshot: () => unknown;
let checkOwnership: () => void;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.writeHead(500).end()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  const { getDataDir } = await import('@/lib/data-dir-migration');
  const directory = getDataDir();
  vi.stubEnv('O8_DATA_DIR', directory);
  vi.stubEnv('O8_PACKAGED_APP', '1');
  vi.stubEnv('O8_LAN_ACCESS', undefined);
  repo = directory;
  mkdirSync(repo, { recursive: true });
  vi.stubEnv('CORTEX_IDE_REVIEW_REPO_ROOT', repo);
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8D_NATIVE_SESSION_READS', '0');
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  operator = getOrCreateWsToken();
  writeFileSync(join(directory, 'worker-token'), worker);
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(phone).digest('hex'));
  const { resolveRequestPrincipalContext } = await import('@/lib/auth/principal');
  for (const [token, role] of [[operator, 'operator'], [phone, 'device'], [worker, 'worker']]) {
    expect(resolveRequestPrincipalContext(new NextRequest('http://127.0.0.1/api/mcp', {
      headers: { authorization: `Bearer ${token}` },
    })).role).toBe(role);
  }
  const { getSqlite } = await import('@/lib/db');
  const sqlite = getSqlite();
  // WS startup already opens this DB and imports the port resolver. The
  // network handler adds no DB, cache or watcher owner.
  await import('@/lib/panel/api-port');
  const databaseDescriptors = () => existsSync('/proc/self/fd')
    ? readdirSync('/proc/self/fd').flatMap(fd => {
      try {
        const target = readlinkSync(`/proc/self/fd/${fd}`);
        return target === sqlite.name || target === `${sqlite.name}-wal` || target === `${sqlite.name}-shm` ? [target] : [];
      } catch { return []; }
    }).sort() : null;
  const watchers = () => process.getActiveResourcesInfo().filter(name => /FSEvent|StatWatcher/.test(name)).sort();
  const initialDescriptors = databaseDescriptors();
  if (process.platform === 'linux') expect(initialDescriptors?.length).toBeGreaterThan(0);
  const initialWatchers = watchers();
  checkOwnership = () => {
    expect(getSqlite()).toBe(sqlite);
    expect(databaseDescriptors()).toEqual(initialDescriptors);
    expect(watchers()).toEqual(initialWatchers);
  };
  reset = () => writeFileSync(join(directory, 'phone-network'), 'on\n');
  snapshot = () => readFileSync(join(directory, 'phone-network'), 'utf8');
  const { panelGateMiddleware } = await import('@/middleware');
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  const network = await import('@/app/api/panel/mobile-network/route');
  const handlers: Record<string, Handler> = {
    'GET /api/panel/mobile-network': network.GET,
    'POST /api/panel/mobile-network': network.POST,
  };
  // Only these two Node HTTP listeners exist. No Next server or fallback is started.
  reference = await listen(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    // Same peer/relay stamp as the packaged Next entry, independent of WS dispatch.
    headers.set('x-o8-client-addr', req.headers['x-o8-relay-forward'] === '1'
      ? 'o8-relay-forward' : req.socket.remoteAddress ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new NextRequest(url, { method: req.method, headers,
      ...(body.length ? { body } : {}) });
    const gate = panelGateMiddleware(request);
    const response = gate.headers.get('x-middleware-next') === '1'
      ? await handlers[`${req.method} ${url.pathname}`](request) : gate;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  native = await listen(async (req, res) => {
    if (!await handleNativeHttp(req, res, undefined, false, req.socket.remoteAddress ?? null)) {
      res.writeHead(404).end();
    }
  });
  const port = new URL(native).port;
  vi.stubEnv('O8_API_PORT', port);
  vi.stubEnv('O8_WS_PORT', port);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
  vi.unstubAllEnvs();
});

async function send(origin: string, route: RouteCase, token?: string, extra: Record<string, string> = {}) {
  reset();
  const response = await fetch(origin + route.path, { method: route.method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(route.body ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(route.body ? { body: JSON.stringify(route.body) } : {}) });
  return { status: response.status, allow: response.headers.get('allow'),
    body: await response.text(), state: snapshot() };
}

it.each(cases)('serves $method $path without Next with original auth and stored state', async route => {
  const principals: Array<{ name: string; token?: string; extra?: Record<string, string> }> = [
    { name: 'operator', token: operator }, { name: 'paired phone', token: phone },
    { name: 'worker', token: worker }, { name: 'anonymous', token: undefined },
    { name: 'wrong bearer', token: 'wrong-fixture-bearer' },
    { name: 'operator relay', token: operator, extra: { 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.1' } },
    { name: 'phone relay', token: phone, extra: { 'x-o8-relay-forward': '1' } },
    { name: 'worker relay', token: worker, extra: { 'x-o8-relay-forward': '1' } },
  ];
  for (const principal of principals) {
    const expected = await send(reference, route, principal.token, principal.extra);
    const actual = await send(native, route, principal.token, principal.extra);
    expect(actual, `${route.path}: ${principal.name}`).toEqual(expected);
    if (principal.name === 'operator') {
      const invalid = route.method === 'POST' && typeof (route.body as { enabled: unknown }).enabled !== 'boolean';
      expect(actual.status).toBe(invalid ? 400 : 200);
      const enabled = route.method === 'GET' || invalid || (route.body as { enabled: boolean }).enabled;
      expect(actual.state).toBe(enabled ? 'on\n' : 'off\n');
      if (!invalid) expect(JSON.parse(actual.body)).toMatchObject({ ok: true, enabled, running: false, overridden: false });
    }
    if (principal.name === 'operator relay') expect(actual.status).toBe(403);
  }
  checkOwnership();
}, 90_000);

it('observes file changes and refuses unpackaged callers without Next', async () => {
  writeFileSync(join(repo, 'phone-network'), 'off\n');
  const headers = { authorization: `Bearer ${operator}` };
  const off = await fetch(native + '/api/panel/mobile-network', { headers });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ enabled: false });
  writeFileSync(join(repo, 'phone-network'), 'on\n');
  const on = await fetch(native + '/api/panel/mobile-network', { headers });
  expect(await on.json()).toMatchObject({ enabled: true });
  vi.stubEnv('O8_PACKAGED_APP', '0');
  try {
    const denied = await fetch(native + '/api/panel/mobile-network', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(denied.status).toBe(403);
    expect(readFileSync(join(repo, 'phone-network'), 'utf8')).toBe('on\n');
  } finally { vi.stubEnv('O8_PACKAGED_APP', '1'); }
  checkOwnership();
});
