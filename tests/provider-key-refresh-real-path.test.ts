import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.dir, migrateDataDirOnce: () => {} }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.dir }));
fixture.dir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-key-refresh-')));
const master = Buffer.alloc(32, 83).toString('base64url');
const first = 'fixture-refresh-initial';
const second = 'fixture-refresh-rotated';
const fingerprint = (value: string | null) => value ? createHash('sha256').update(value).digest('hex') : null;
const keys = await import('@/app/api/v2/keys/route');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const request = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/v2/keys', {
  method, headers: { host: 'localhost' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', master);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('CODEX_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  writeFileSync(join(fixture.dir, '.env.local'), '');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(fixture.dir, { recursive: true, force: true });
});

it.each([429, 500, 503])('reports an unavailable authenticated provider check (%s) without claiming verification', async status => {
  const fetch = vi.fn(async () => Response.json({ error: 'synthetic upstream failure' }, { status }));
  vi.stubGlobal('fetch', fetch);
  const result = await keys.POST(request({ provider: 'anthropic', key: first }));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ success: true, warning: expect.stringMatching(/validation unavailable.*saved without verification/i) });
  expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ 'x-api-key': first, 'anthropic-version': '2023-06-01' }),
    signal: expect.any(AbortSignal),
  }));
});

it.each([401, 403])('refuses a rejected authenticated key (%s) without replacing the saved credential', async status => {
  expect((await keys.POST(request({ provider: 'anthropic', key: first }))).status).toBe(200);
  const saved = readFileSync(join(fixture.dir, '.env.local'), 'utf8');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
  expect((await keys.POST(request({ provider: 'anthropic', key: second }))).status).toBe(400);
  expect(readFileSync(join(fixture.dir, '.env.local'), 'utf8')).toBe(saved);
});

it.each([200, 400])('preserves the existing authenticated message-check result (%s)', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
  const result = await keys.POST(request({ provider: 'anthropic', key: first }));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ success: true });
  const inventory = await keys.GET(new NextRequest('http://localhost/api/v2/keys', { headers: { host: 'localhost' } }));
  expect((await inventory.json()).providers.find((p: { id: string }) => p.id === 'anthropic').configured).toBe(true);
});

it('reports transport failure without exposing the submitted credential', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(first); }));
  const result = await keys.POST(request({ provider: 'anthropic', key: first }));
  const body = await result.json();
  expect(result.status).toBe(200);
  expect(body.warning).toMatch(/could not validate.*saved anyway/i);
  expect(JSON.stringify(body)).not.toContain(first);
});

/** A long-lived sibling reads the real store, inventory route and launch boundary. */
async function sibling(providerUrl: string) {
  const consumer = `
    const http = require('node:http');
    const agent = new http.Agent({ keepAlive: true });
    const hash = value => value ? require('node:crypto').createHash('sha256').update(value).digest('hex') : null;
    require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
      const request = http.get(process.env.O8_TEST_PROVIDER_URL, { agent,
        headers: process.env.OPENAI_API_KEY ? { authorization: 'Bearer ' + process.env.OPENAI_API_KEY } : {} }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => {
          process.stdout.write(JSON.stringify({ key: hash(process.env.OPENAI_API_KEY), alias: hash(process.env.CODEX_API_KEY),
            master: !!process.env.O8_MASTER_KEY, pid: process.pid, ...JSON.parse(body) }) + '\\n');
        });
      });
      request.on('error', error => process.stdout.write(JSON.stringify({ error: error.message }) + '\\n'));
    });
  `;
  const script = `
    import { createInterface } from 'node:readline';
    import { createHash } from 'node:crypto';
    import { once } from 'node:events';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => process.env.O8_DATA_DIR;
    syncBuiltinESMExports();
    const unwrap = m => m.default ?? m;
    const store = unwrap(await import('./src/lib/providers/key-store.ts'));
    const env = unwrap(await import('./src/lib/providers/spawn-environment.ts'));
    const cp = unwrap(await import('./src/lib/providers/child-process.ts'));
    const route = unwrap(await import('./src/app/api/v2/keys/route.ts'));
    const { NextRequest } = unwrap(await import('next/server'));
    const hash = value => value ? createHash('sha256').update(value).digest('hex') : null;
    const held = cp.spawn(process.execPath, ['-e', ${JSON.stringify(consumer)}],
      { env: env.childEnvironment({ runtimeId: 'opencode' }), stdio: ['pipe', 'pipe', 'pipe'] });
    const heldLines = createInterface({ input: held.stdout });
    const readHeld = async () => {
      const response = once(heldLines, 'line'); held.stdin.write('{}\\n');
      return JSON.parse((await response)[0]);
    };
    process.once('SIGTERM', async () => {
      if (held.exitCode === null && held.signalCode === null) {
        const exited = once(held, 'exit'); held.kill('SIGTERM'); await exited;
      }
      process.exit(0);
    });
    const retained = await readHeld();
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    send({ ready: true, connected: retained.key, connectionPid: retained.pid,
      providerFingerprint: retained.providerFingerprint, providerConnection: retained.providerConnection });
    createInterface({ input: process.stdin }).on('line', async () => {
      try {
        const response = await route.GET(new NextRequest('http://localhost/api/v2/keys', { headers: { host: 'localhost' } }));
        const inventory = await response.json();
        const launched = JSON.parse(cp.execFileSync(process.execPath, ['-e',
          "const h=v=>v?require('node:crypto').createHash('sha256').update(v).digest('hex'):null;process.stdout.write(JSON.stringify({key:h(process.env.OPENAI_API_KEY),alias:h(process.env.CODEX_API_KEY),master:!!process.env.O8_MASTER_KEY}));"],
          { env: env.childEnvironment({ runtimeId: 'opencode' }), encoding: 'utf8' }));
        const connection = await readHeld();
        send({ connected: connection.key, connectionPid: connection.pid,
          providerFingerprint: connection.providerFingerprint, providerConnection: connection.providerConnection,
          current: hash(store.resolveProviderKey('OPENAI_API_KEY')), launched,
          configured: inventory.providers.find(p => p.id === 'openai').configured });
      } catch (error) { send({ error: error.message }); }
    });
  `;
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
    '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', O8_DATA_DIR: fixture.dir,
      CORTEX_IDE_DATA_DIR: fixture.dir, CORTEX_IDE_DB_PATH: join(fixture.dir, 'cortex-ide.db'),
      O8_MASTER_KEY: master, OPENAI_API_KEY: first, CODEX_API_KEY: first, O8_TEST_PROVIDER_URL: providerUrl },
  });
  const messages: Array<Record<string, unknown>> = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { messages.push(JSON.parse(line)); } catch { /* unrelated startup output */ } });
  const next = async () => {
    await vi.waitFor(() => expect(messages.length, `sibling exit=${child.exitCode}; ${stderr}`).toBeGreaterThan(0), { timeout: 20_000 });
    return messages.shift()!;
  };
  return {
    ready: next,
    read: () => { child.stdin.write('{}\n'); return next(); },
    close: async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
    },
  };
}

it('refreshes rotated and deleted keys across siblings while retaining an existing connection', async () => {
  saveRuntimeBillingMode('opencode', 'api');
  expect((await keys.POST(request({ provider: 'openai', key: first }))).status).toBe(200);
  const connections = new WeakMap<object, number>();
  let nextConnection = 0;
  const provider = createServer((incoming, response) => {
    const key = incoming.headers.authorization?.replace(/^Bearer /, '') ?? null;
    if (!connections.has(incoming.socket)) connections.set(incoming.socket, ++nextConnection);
    response.writeHead(key === first || key === second ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ providerFingerprint: fingerprint(key), providerConnection: connections.get(incoming.socket) }));
  });
  provider.keepAliveTimeout = 60_000;
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture provider did not listen.');
  const providerUrl = `http://127.0.0.1:${address.port}`;
  const peer = await sibling(providerUrl);
  try {
    const ready = await peer.ready();
    expect(ready).toMatchObject({ ready: true, connected: fingerprint(first), connectionPid: expect.any(Number) });
    const connectionPid = ready.connectionPid;
    const retained = { providerFingerprint: fingerprint(first), providerConnection: ready.providerConnection };
    expect(await peer.read()).toMatchObject({ current: fingerprint(first), configured: true,
      connectionPid, ...retained,
      launched: { key: fingerprint(first), alias: fingerprint(first), master: false } });
    expect((await keys.POST(request({ provider: 'openai', key: second }))).status).toBe(200);
    expect(await peer.read()).toEqual({ connected: fingerprint(first), connectionPid, ...retained, current: fingerprint(second), configured: true,
      launched: { key: fingerprint(second), alias: fingerprint(second), master: false } });
    expect((await keys.DELETE(request({ provider: 'openai' }, 'DELETE'))).status).toBe(200);
    expect(await peer.read()).toEqual({ connected: fingerprint(first), connectionPid, ...retained, current: null, configured: false,
      launched: { key: null, alias: null, master: false } });
    expect(readFileSync(join(fixture.dir, '.env.local'), 'utf8')).not.toMatch(/^OPENAI_API_KEY=/m);
    const fresh = await sibling(providerUrl);
    try {
      expect(await fresh.ready()).toMatchObject({ ready: true, connected: null });
      expect(await fresh.read()).toMatchObject({ current: null, configured: false,
        launched: { key: null, alias: null, master: false } });
    } finally { await fresh.close(); }
  } finally {
    await peer.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 60_000);
