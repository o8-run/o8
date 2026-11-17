import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

type RouteCase = { path: string; method: string; body?: unknown };
type Handler = (request: NextRequest) => Response | Promise<Response>;
const cases: RouteCase[] = [
  { path: '/api/lanes/touches?path=src/fixture.ts', method: 'GET' },
  { path: '/api/mcp', method: 'GET' },
  { path: '/api/panel/supervisor-inbox', method: 'POST', body: { action: 'dismiss', id: 'fixture-inbox' } },
  { path: '/api/v2/files', method: 'POST', body: { path: 'notes.txt', content: 'saved through original handler\n' } },
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
  repo = join(directory, 'nonphone-workspace');
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
  const { countInboxItems } = await import('@/lib/supervisor/inbox');
  countInboxItems('human_required');
  const sqlite = getSqlite();
  // WS startup already owns getDb(), lane registry, supervisor inbox and repo registry.
  // Observe that route requests reuse this existing owner rather than add handles/watchers.
  await import('@/lib/repos/registry');
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
  const seedTime = '2026-11-17T00:00:00.000Z';
  reset = () => {
    sqlite.prepare('DELETE FROM supervisor_inbox').run();
    sqlite.prepare(`INSERT INTO supervisor_inbox
      (id,project_id,incident_key,repo_path,packet_id,kind,payload,created_at,last_seen_at,repeat_count,status,resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run('fixture-inbox', 'fixture-project', 'fixture-incident', repo, null,
        'outside_human_waiting', '{}', seedTime, seedTime, 1, 'human_required');
    writeFileSync(join(repo, 'notes.txt'), 'existing saved content\n');
  };
  snapshot = () => ({
    inbox: sqlite.prepare('SELECT * FROM supervisor_inbox ORDER BY id').all(),
    file: readFileSync(join(repo, 'notes.txt'), 'utf8'),
  });
  const { panelGateMiddleware } = await import('@/middleware');
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  const handlers: Record<string, Handler> = {
    'GET /api/lanes/touches': (await import('@/app/api/lanes/touches/route')).GET,
    'GET /api/mcp': (await import('@/lib/mcp/operator-mcp-get')).GET,
    'POST /api/panel/supervisor-inbox': (await import('@/app/api/panel/supervisor-inbox/route')).POST,
    'POST /api/v2/files': (await import('@/app/api/v2/files/route')).POST,
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T01:00:00.000Z'));
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
  const principals = [
    { name: 'operator', token: operator }, { name: 'paired phone', token: phone },
    { name: 'worker', token: worker }, { name: 'anonymous', token: undefined },
    { name: 'wrong bearer', token: 'wrong-fixture-bearer' },
    { name: 'operator relay', token: operator, extra: { 'x-o8-relay-forward': '1' } },
    { name: 'phone relay', token: phone, extra: { 'x-o8-relay-forward': '1' } },
    { name: 'worker relay', token: worker, extra: { 'x-o8-relay-forward': '1' } },
  ];
  for (const principal of principals) {
    const expected = await send(reference, route, principal.token, principal.extra);
    const actual = await send(native, route, principal.token, principal.extra);
    expect(actual, `${route.path}: ${principal.name}`).toEqual(expected);
    if (principal.name === 'operator') {
      expect(actual.status).toBe(route.path === '/api/mcp' ? 405 : 200);
      if (route.path === '/api/mcp') expect(actual.allow).toBe('POST, DELETE');
      if (route.path.includes('supervisor-inbox')) expect(actual.state).toMatchObject({ inbox: [{ status: 'dismissed' }] });
      if (route.path.includes('v2/files')) expect(actual.state).toMatchObject({ file: 'saved through original handler\n' });
    }
  }
  checkOwnership();
}, 90_000);
