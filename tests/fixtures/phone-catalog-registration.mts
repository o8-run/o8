import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const directory = process.env.CORTEX_IDE_DATA_DIR!;
const operator = 'fixture-catalog-operator';
const worker = 'fixture-catalog-worker';
const device = 'fixture-catalog-device';
writeFileSync(join(directory, 'ws-token'), operator);
writeFileSync(join(directory, 'worker-token'), worker);
writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
mkdirSync(join(directory, '.openclaw'));
mkdirSync(join(directory, '.codex'));
const config = join(directory, '.openclaw/openclaw.json');
const discovery = join(directory, '.codex/models_cache.json');
writeFileSync(config, JSON.stringify({ mcp: { servers: { o8: {} } }, agents: { list: [{ id: 'first', name: 'First' }] } }));
const { CODEX_MODEL_IDS } = require('../../src/lib/models.ts') as typeof import('../../src/lib/models');
writeFileSync(discovery, JSON.stringify({ models: [{ slug: CODEX_MODEL_IDS[0] }] }));
const { NextRequest } = require('next/server') as typeof import('next/server');
const { panelGateMiddleware } = require('../../src/middleware.ts') as typeof import('../../src/middleware');
const { handleNativeHttp } = require('../../src/lib/ws-server/native-http-routes.ts') as typeof import('../../src/lib/ws-server/native-http-routes');
const routes = {
  '/api/mobile/orchestrator/models': require('../../src/app/api/mobile/orchestrator/models/route.ts').GET,
  '/api/mobile/orchestrator/openclaw-agents': require('../../src/app/api/mobile/orchestrator/openclaw-agents/route.ts').GET,
  '/api/mobile/orchestrator/openclaw-availability': require('../../src/app/api/mobile/orchestrator/openclaw-availability/route.ts').GET,
} as Record<string, (request: Request) => Response | Promise<Response>>;
const servers: ReturnType<typeof createServer>[] = [];
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res).catch(error => { console.error(error); res.writeHead(500).end(); }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
try {
  const native = await listen(async (req, res) => {
    if (!await handleNativeHttp(req, res, req.socket.localPort, false, req.socket.remoteAddress ?? null)) res.writeHead(404).end();
  });
  const reference = await listen(async (req, res) => {
    const headers = new Headers(req.headers as Record<string, string>);
    headers.set('x-o8-client-addr', req.headers['x-o8-relay-forward'] === '1' ? 'o8-relay-forward' : req.socket.remoteAddress ?? '');
    const request = new NextRequest(`http://${req.headers.host}${req.url}`, { headers });
    const gate = panelGateMiddleware(request);
    const response = gate.headers.get('x-middleware-next') === '1' ? await routes[req.url!](request) : gate;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const read = async (origin: string, path: string, headers: Record<string, string>) => {
    const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.text() };
  };
  let authComparisons = 0;
  for (const path of Object.keys(routes)) {
    assert.equal((await read(native, path, { authorization: `Bearer ${operator}` })).status, 200, path);
    for (const token of [operator, device, worker, 'wrong', '']) for (const relay of [false, true]) {
      const headers: Record<string, string> = { authorization: token ? `Bearer ${token}` : '', 'x-o8-client-addr': '127.0.0.9',
        'x-o8d-bridge': 'forged', ...(relay ? { 'x-o8-relay-forward': '1' } : {}) };
      assert.deepEqual(await read(native, path, headers), await read(reference, path, headers), path);
      authComparisons++;
    }
  }
  writeFileSync(config, JSON.stringify({ agents: { list: [{ id: 'second', name: 'Second' }] } }));
  const auth = { authorization: `Bearer ${operator}` };
  assert.deepEqual(JSON.parse((await read(native, '/api/mobile/orchestrator/openclaw-agents', auth)).body), { agents: [{ id: 'second', name: 'Second' }] });
  assert.equal(JSON.parse((await read(native, '/api/mobile/orchestrator/openclaw-availability', auth)).body).available, false);
  writeFileSync(discovery, JSON.stringify({ models: [{ slug: CODEX_MODEL_IDS[1] }] }));
  const models = JSON.parse((await read(native, '/api/mobile/orchestrator/models', auth)).body);
  assert.deepEqual(models.agents.find((agent: { id: string }) => agent.id === 'codex').models.map((model: { id: string }) => model.id), [CODEX_MODEL_IDS[1]]);
  const loadedOpenclawOwner = Object.keys(require.cache).some(path => /orchestrator-backends\/(openclaw|openclaw-profile|openclaw-gateway)\.ts$/.test(path));
  assert.equal(loadedOpenclawOwner, false, 'Catalogue initialized the OpenClaw session/profile/gateway owner');
  const databaseFiles = readdirSync(directory).filter(name => /\.db(?:-|$)/.test(name));
  assert.deepEqual(databaseFiles, [], 'Catalogue opened a database owner');
  const watchers = process.getActiveResourcesInfo().filter(name => /FSEvent|StatWatcher/.test(name)).length;
  assert.equal(watchers, 0);
  writeFileSync(process.argv[2], JSON.stringify({ routes: 3, authComparisons, liveUpdates: true, loadedOpenclawOwner, databaseFiles, watchers }));
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
process.exit(0);
