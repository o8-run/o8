import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), auth: vi.fn(), invalidate: vi.fn(), entitlement: vi.fn() }));
vi.mock('@/lib/cortex/knowledge/index', () => { throw new Error('Next loaded the knowledge index'); });
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), getRuntimeAuthSnapshot: fixture.auth, invalidateRuntimeAuthCache: fixture.invalidate }));
vi.mock('@/lib/entitlement/store', async original => { const originalStore = await original<typeof import('@/lib/entitlement/store')>(); fixture.entitlement.mockImplementation(originalStore.getEntitlementSync); return { ...originalStore, getEntitlementSync: fixture.entitlement }; });
vi.mock('@/lib/providers/child-process', async original => ({ ...await original<typeof import('@/lib/providers/child-process')>(), spawn: fixture.spawn }));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-owner-')));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('O8_NEXT_O8D', '1');
vi.stubEnv('O8_NEXT_WINDOW_OWNER', undefined);
vi.stubEnv('O8_NEXT_BIN', undefined);
vi.stubEnv('O8_PACKAGED_APP', undefined);
vi.stubEnv('O8_NEXT_MAIN_WINDOW', undefined);
const route = await import('@/app/api/panel/operator-defaults/route');
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let nextOrigin: string;
let child: ReturnType<typeof fakeChild>;
function fakeChild() {
  const process = Object.assign(new EventEmitter(), { pid: 0x7ffffffe, exitCode: null as number | null, signalCode: null as string | null,
    stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  process.kill.mockImplementation(() => { process.exitCode = 0; queueMicrotask(() => process.emit('exit', 0)); return true; });
  return process;
}
const next = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.startsWith('/api/panel/operator-defaults')) { res.writeHead(404); res.end(); return; }
    const request = new NextRequest(`${nextOrigin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await (req.method === 'POST' ? route.POST(request) : route.GET(request));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch { res.writeHead(500); res.end('fixture failed'); }
});
function call(body?: unknown, path = '/api/panel/operator-defaults?include=native', target = nextOrigin) {
  return fetch(`${target}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  await new Promise<void>(resolve => next.listen(0, '127.0.0.1', resolve));
  nextOrigin = `http://127.0.0.1:${(next.address() as { port: number }).port}`;
  const preload = join(directory, 'window-state-probe.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
    globalThis.__o8NativeWindow = new Proxy({ error: null, queue: Promise.resolve() }, {
      set(state, key, value) {
        if (key === 'child' || key === 'error') fs.appendFileSync(${JSON.stringify(join(directory, 'ws-window-actions'))}, String(key) + String.fromCharCode(10));
        return Reflect.set(state, key, value);
      }
    });`);
  server = await startParityReference({ o8d: true, nativeHttp: true, directory, nextOrigin, preload });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  vi.stubEnv('O8_API_PORT', new URL(origin).port); vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  vi.stubEnv('O8_PACKAGED_APP', '1');
  // An owned dummy file is checked for access; spawn below returns streams only.
  const dummy = join(directory, 'stub-window'); writeFileSync(dummy, 'stub only', { mode: 0o700 });
  vi.stubEnv('O8_NEXT_BIN', dummy);
  fixture.spawn.mockImplementation(() => { child = fakeChild(); queueMicrotask(() => child.stdout.write('o8-next-ready\n')); return child; });
}, 120_000);
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  await server?.stop(); await new Promise<void>(resolve => next.close(() => resolve()));
  vi.unstubAllEnvs();
});

it('keeps structured and TOML window changes and rollback in Next with native transport and no owner flag', async () => {
  for (const kind of ['fields', 'toml']) {
    const before = await (await call()).json();
    const enabled = await call({ settingsTomlRevision: before.settingsToml.revision,
      ...(kind === 'fields' ? { experimentalNext: true } : { settingsToml: '[experimental]\nnext_enabled = true\n' }) });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    expect(fixture.spawn).toHaveBeenCalledTimes(kind === 'fields' ? 1 : 3);
    const runtime = globalThis as typeof globalThis & { __o8NativeWindow?: { child?: unknown; error: string | null } };
    expect(runtime.__o8NativeWindow?.child).toBe(child);
    const current = await (await call()).json();
    expect(current.values.experimentalNext).toBe(true);
    // A stale save fails after closing, then the main transaction restores the window.
    const refused = await call({ experimentalNext: false, settingsTomlRevision: 'stale-revision' });
    expect(refused.status).toBe(409);
    expect(runtime.__o8NativeWindow?.child).toBe(child);
    const disabled = await call({ experimentalNext: false, settingsTomlRevision: current.settingsToml.revision });
    expect(disabled.status).toBe(200);
    expect(runtime.__o8NativeWindow?.child).toBeUndefined();
  }
  vi.stubEnv('O8_NEXT_BIN', undefined);
  const before = await (await call()).json();
  expect((await call({ experimentalNext: true, settingsTomlRevision: before.settingsToml.revision })).status).toBe(400);
  expect((await (await call()).json()).values.experimentalNext).toBe(false);
  const nextRead = await (await call(undefined, '/api/panel/operator-defaults?include=values')).json();
  const nativeRead = await (await call(undefined, '/api/panel/operator-defaults?include=values', origin)).json();
  expect(nextRead.nextWindowError).toContain('unavailable');
  expect(nativeRead.nextWindowError).toBe(nextRead.nextWindowError);
  // Even native callers return to Next; a WS window attempt cannot spawn this stub.
  expect((await call({ experimentalNext: true, settingsTomlRevision: before.settingsToml.revision }, '/api/panel/operator-defaults?include=native', origin)).status).toBe(400);
  expect(fixture.spawn).toHaveBeenCalledTimes(4);
  expect(existsSync(join(directory, 'ws-window-actions'))).toBe(false);
  const loop = await fetch(`${origin}/api/panel/operator-defaults?include=values`, { headers: { authorization: `Bearer ${server.token}`, 'x-o8-settings-window-owner-hop': '1' } });
  expect(loop.status).toBe(503);
});

it('keeps knowledge state in WS and reads shared receipts, entitlements and runtime refresh there', async () => {
  const { recordRoleRoutingReceipt } = await import('@/lib/operator/role-routing-ledger');
  const receipt = recordRoleRoutingReceipt({ role: 'brain', requested: { backend: null, runtime: null, model: null, effort: null, label: 'Fixture' },
    sources: { backend: 'default', runtime: 'default', model: 'default', effort: 'default' }, reason: 'Window owner fixture', status: 'selected' });
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-notes-')));
  try {
    const before = await (await call()).json();
    const source = { id: crypto.randomUUID(), path: folder, name: 'Fixture notes', include: ['**/*.md'], exclude: [] };
    const saved = await call({ experimentalNext: false, knowledgeSources: [source], settingsTomlRevision: before.settingsToml.revision });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const sources = await fetch(`${origin}/api/cortex/sources`, { headers: { authorization: `Bearer ${server.token}` } });
    expect((await sources.json()).sources).toContainEqual(expect.objectContaining({ id: source.id }));
    fixture.auth.mockClear(); fixture.invalidate.mockClear(); fixture.entitlement.mockClear();
    writeFileSync(join(directory, 'entitlement.json'), JSON.stringify({ plan: 'free' }));
    const free = await (await call(undefined, '/api/panel/operator-defaults?refresh=runtime')).json();
    expect(free.recentRoleReceipts).toContainEqual(expect.objectContaining({ id: receipt.id }));
    expect(free.cliAuth.statuses).toBeTypeOf('object');
    writeFileSync(join(directory, 'entitlement.json'), JSON.stringify({ plan: 'founder' }));
    const paid = await (await call(undefined, '/api/panel/operator-defaults')).json();
    const { projectAgentRoleRoutes } = await import('@/lib/operator/role-routing');
    expect(free.roleRoutes).toEqual(projectAgentRoleRoutes({ values: free.values, sources: free.sources, dispatchableRuntimes: free.dispatchableRuntimes, managedBrainEligible: false }));
    expect(paid.roleRoutes).toEqual(projectAgentRoleRoutes({ values: paid.values, sources: paid.sources, dispatchableRuntimes: paid.dispatchableRuntimes, managedBrainEligible: true }));
    expect(fixture.auth).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.entitlement).not.toHaveBeenCalled();
  } finally { rmdirSync(folder); }
});

it('orders concurrent source writes behind a Next window save without blocking its WS reconciliation', async () => {
  const folders = [0, 1].map(() => realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-concurrent-notes-'))));
  const before = await (await call()).json();
  const source = { id: crypto.randomUUID(), path: folders[0], name: 'First', include: ['**/*.md'], exclude: [] };
  const originalFetch = globalThis.fetch;
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input === 'string' && input.endsWith('/api/cortex/sources') && typeof init?.body === 'string'
      && JSON.parse(init.body).action === 'reconcile') { entered = true; await held; }
    return originalFetch(input, init);
  });
  try {
    const saved = call({ experimentalNext: false, knowledgeSources: [source], settingsTomlRevision: before.settingsToml.revision });
    await expect.poll(() => entered).toBe(true);
    let addSettled = false;
    const added = originalFetch(`${origin}/api/cortex/sources`, { method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', path: folders[1] }), signal: AbortSignal.timeout(5_000),
    }).then(response => { addSettled = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(addSettled).toBe(false);
    release();
    const responses = await Promise.all([saved, added]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const sources = await (await originalFetch(`${origin}/api/cortex/sources`, { headers: { authorization: `Bearer ${server.token}` } })).json();
    expect(sources.sources.map((entry: { path: string }) => entry.path).sort()).toEqual([...folders].sort());
  } finally { release(); vi.unstubAllGlobals(); folders.forEach(folder => rmdirSync(folder)); }
});

it('serves the plain settings save from Next and keeps it when index reconciliation fails', async () => {
  const dummy = join(directory, 'stub-window');
  vi.stubEnv('O8_NEXT_BIN', dummy);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-plain-notes-')));
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input === 'string' && input.endsWith('/api/cortex/sources') && typeof init?.body === 'string'
      && JSON.parse(init.body).action === 'reconcile') return new Response('{}', { status: 503 });
    return originalFetch(input, init);
  });
  try {
    const spawned = fixture.spawn.mock.calls.length;
    const before = await (await call()).json();
    const source = { id: crypto.randomUUID(), path: folder, name: 'Plain notes', include: ['**/*.md'], exclude: [] };
    // The Settings UI posts without include=native and expects the full payload back.
    const enabled = await call({ experimentalNext: true, knowledgeSources: [source], settingsTomlRevision: before.settingsToml.revision },
      '/api/panel/operator-defaults');
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const payload = await enabled.json();
    expect(payload.values.experimentalNext).toBe(true);
    expect(payload.cliAuth).toBeTypeOf('object');
    expect(payload.roleRoutes).toBeTruthy();
    expect(fixture.spawn).toHaveBeenCalledTimes(spawned + 1);
    const runtime = globalThis as typeof globalThis & { __o8NativeWindow?: { child?: unknown } };
    expect(runtime.__o8NativeWindow?.child).toBe(child);
    const current = await (await call()).json();
    const disabled = await call({ experimentalNext: false, knowledgeSources: [], settingsTomlRevision: current.settingsToml.revision },
      '/api/panel/operator-defaults');
    expect(disabled.status).toBe(200);
    expect(runtime.__o8NativeWindow?.child).toBeUndefined();
    expect(existsSync(join(directory, 'ws-window-actions'))).toBe(false);
  } finally { vi.unstubAllGlobals(); rmdirSync(folder); }
});
