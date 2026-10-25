import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceState } from '@/lib/devices/types';
import { stageDeviceViewerHelper } from './fixtures/device-viewer-helper';

const root = mkdtempSync(join(tmpdir(), 'o8-device-tools-'));
const dataDir = join(root, 'data');
const bin = join(root, 'bin');
const control = join(root, 'control.json');
const receipts = join(root, 'receipts.jsonl');
const source = join(root, 'hub-fixture.mjs');
const hubPackage = join(root, 'hub-package');
const token = 'fixture-device-token-01234567890123456789';
const previous = { PATH: process.env.PATH, O8_DATA_DIR: process.env.O8_DATA_DIR, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, WS_TOKEN: process.env.WS_TOKEN };
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.WS_TOKEN = 'fixture-local-operator-01234567890123456789';
process.env.PATH = `${bin}:${dirname(process.execPath)}`;

let route: typeof import('@/app/api/panel/devices/route');
let manager: ReturnType<typeof import('@/lib/devices/service').getDeviceManager>;
let external: ChildProcess;

function request(body?: unknown, headers?: Record<string, string>): Request {
  return new Request('http://127.0.0.1:3001/api/panel/devices', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${process.env.WS_TOKEN}`, host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001', 'x-o8-client-addr': '127.0.0.1', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function records(): Array<Record<string, unknown>> {
  return existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function configure(value: Record<string, unknown> = {}): void { writeFileSync(control, JSON.stringify(value)); }

async function waitState(phase: DeviceState['phase']): Promise<DeviceState> {
  let value: DeviceState | undefined;
  await expect.poll(async () => {
    const response = await route.GET(request());
    value = await response.json() as DeviceState;
    return value.phase;
  }, { timeout: 8_000, interval: 50 }).toBe(phase);
  return value!;
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  configure();
  stageDeviceViewerHelper(hubPackage, join(root, 'manual.jsonl'), control);
  writeFileSync(source, `import { createServer } from 'node:http';
import './index.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'));
const record = (value) => appendFileSync(${JSON.stringify(receipts)}, JSON.stringify(value) + '\\n');
record({ kind: 'start', pid: process.pid, args, operatorTokenPresent: !!process.env.WS_TOKEN, nodeEnv: process.env.NODE_ENV });
const token = ${JSON.stringify(token)};
if (config.fail) { console.error('secret=' + token); process.exit(4); }
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const server = createServer((req, res) => {
  if (req.url === '/readyz') { res.end('ready'); return; }
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'fixture_hub_access=' + token + '; HttpOnly; SameSite=Lax; Path=/' }); res.end(); return;
  }
  const cookie = req.headers.cookie === 'fixture_hub_access=' + token;
  const cookieAllowed = req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-dest'] === 'iframe';
  const authenticated = req.headers.authorization === 'Bearer ' + token || cookie && cookieAllowed;
  if (!authenticated && !config.unsafe) { res.writeHead(401); res.end('token required'); return; }
  if (req.url === '/api/devices') {
    if (config.refreshFails && authenticated) { res.writeHead(502); res.end('secret=' + token); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ simulators: [{ id: 'ios-1', name: 'Fixture phone', platform: 'ios', booted: true, version: 'iOS fixture' }], emulators: [] }));
    return;
  }
  res.end('device dashboard');
});
server.listen(port, host, () => {
  const publish = () => console.log('  Local:   http://' + (config.printIp ? '127.0.0.1' : 'localhost') + ':' + port + '/?token=' + token);
  if (config.delay) setTimeout(publish, config.delay); else publish();
});
process.on('SIGTERM', () => { record({ kind: 'stop', pid: process.pid }); server.close(() => process.exit(0)); });
`);
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ kind: 'install', args }) + '\\n');
if (config.installFails) process.exit(3);
const target = args[args.indexOf('--prefix') + 1]; const pinned = args.at(-1); const split = pinned.lastIndexOf('@');
const name = pinned.slice(0, split); const version = pinned.slice(split + 1);
const pkg = path.join(target, 'node_modules', name); const entry = name === 'expo-device-hub' ? 'dist/server/cli.mjs' : 'bin/agent-device.mjs';
fs.mkdirSync(path.dirname(path.join(pkg, entry)), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: config.wrongVersion ? '0.0.0' : version, type: 'module' }));
if (name === 'expo-device-hub') fs.cpSync(${JSON.stringify(hubPackage)}, pkg, { recursive: true });
fs.copyFileSync(${JSON.stringify(source)}, path.join(pkg, entry));
`);
  chmodSync(join(bin, 'npm'), 0o755);
  route = await import('@/app/api/panel/devices/route');
  manager = (await import('@/lib/devices/service')).getDeviceManager();
  external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve) => external.once('spawn', resolve));
});

beforeEach(async () => { await manager.stop(); configure(); });

afterAll(async () => {
  await manager.stop();
  if (external?.pid) {
    const exited = new Promise<void>((resolve) => external.once('exit', () => resolve()));
    external.kill('SIGTERM');
    await exited;
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('local device helper route and processes', () => {
  it('requires operator identity, socket loopback and a trusted page origin before inspection or actions', async () => {
    const refused: Array<Record<string, string>> = [
      { authorization: '' }, { authorization: 'Bearer unknown' },
      { 'x-o8-client-addr': '192.0.2.1' }, { origin: 'https://untrusted.example' },
      { origin: 'http://evil.localhost:3001' }, { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of refused) {
      expect((await route.GET(request(undefined, headers))).status).toBe(403);
      expect((await route.POST(request({ action: 'start' }, headers))).status).toBe(403);
    }
    expect(records()).toEqual([]);
  });

  it('accepts the browser Host when Next normalizes the request URL, without accepting other hosts or ports', async () => {
    const normalized = (host: string, origin: string) => new Request('http://localhost:3001/api/panel/devices', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.WS_TOKEN}`, host, origin, 'x-o8-client-addr': '127.0.0.1', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ action: 'refresh' }),
    });
    expect((await route.POST(normalized('127.0.0.1:3001', 'http://127.0.0.1:3001'))).status).toBe(200);
    for (const [host, origin] of [
      ['127.0.0.1:3001', 'http://localhost:3001'],
      ['127.0.0.1:3002', 'http://127.0.0.1:3002'],
      ['evil.localhost:3001', 'http://evil.localhost:3001'],
      ['127.0.0.1:3001/path', 'http://127.0.0.1:3001'],
      ['user@127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ]) expect((await route.POST(normalized(host, origin))).status).toBe(403);
    expect(records()).toEqual([]);
  });

  it('GET reports missing tools without installing, launching or exposing an embed link', async () => {
    const state = await (await route.GET(request())).json();
    expect(state).toMatchObject({ phase: 'idle', tools: { hub: { installed: false, version: null, requiredVersion: '0.15.3' }, agent: { installed: false } } });
    expect(state.embedUrl).toBeUndefined();
    expect(records()).toEqual([]);
    expect((await route.POST(request({ action: 'start' }))).status).toBe(202);
    const missing = await waitState('error');
    expect(missing.error).toMatch(/Install the device dashboard helper/);
    expect(records()).toEqual([]);
  });

  it('refuses arbitrary commands, paths, origins and invalid install targets', async () => {
    for (const body of [{ action: 'start', command: 'anything' }, { action: 'install', tool: '../bad' }, { action: 'start', origin: 'https://untrusted.example' }, { action: 'proxy', path: '/api/devices' }, [], null]) {
      expect((await route.POST(request(body))).status).toBe(400);
    }
    expect(records()).toEqual([]);
  });

  it('installs only after the explicit action, verifies versions and publishes completed staging atomically', async () => {
    configure({ wrongVersion: true });
    expect((await route.POST(request({ action: 'install', tool: 'hub' }))).status).toBe(202);
    expect((await waitState('error')).tools.hub.installed).toBe(false);
    expect(existsSync(join(dataDir, 'devices/tools/expo-device-hub/0.15.3/.install-complete'))).toBe(false);
    configure();
    expect((await route.POST(request({ action: 'install', tool: 'all' }))).status).toBe(202);
    const state = await waitState('idle');
    expect(state.tools).toMatchObject({ hub: { installed: true, version: '0.15.3' }, agent: { installed: true, version: '0.21.23' } });
    expect(state.agentCommand).toEqual([process.execPath, join(dataDir, 'devices/tools/agent-device/0.21.23/node_modules/agent-device/bin/agent-device.mjs')]);
    expect(records().filter((record) => record.kind === 'install').map((record) => (record.args as string[]).at(-1))).toEqual(['expo-device-hub@0.15.3', 'expo-device-hub@0.15.3', 'agent-device@0.21.23']);
    expect(records().filter((record) => record.kind === 'start')).toHaveLength(0);
  });

  it('coalesces concurrent starts and verifies the real authenticated HTTP endpoint before exposing its token', async () => {
    configure({ delay: 150 });
    const before = records().filter((record) => record.kind === 'start').length;
    const replies = await Promise.all([route.POST(request({ action: 'start' })), route.POST(request({ action: 'start' }))]);
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    for (const reply of replies) expect((await reply.json()).embedUrl).toBeUndefined();
    const state = await waitState('running');
    expect(state.devices).toEqual([{ id: 'ios-1', name: 'Fixture phone', platform: 'ios', state: 'running', version: 'iOS fixture' }]);
    const url = new URL(state.embedUrl!);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.searchParams.get('token')).toBe(token);
    expect((await fetch(`${url.origin}/api/devices`)).status).toBe(401);
    expect((await fetch(`${url.origin}/api/devices`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    const bootstrap = await fetch(state.embedUrl!, { redirect: 'manual', headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get('location')).toBe('/');
    expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(`${url.origin}/`, { headers: { cookie, 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' } })).status).toBe(200);
    expect((await fetch(`${url.origin}/api/devices`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    const starts = records().filter((record) => record.kind === 'start');
    expect(starts).toHaveLength(before + 1);
    expect(starts.at(-1)).toMatchObject({ operatorTokenPresent: false, nodeEnv: 'production' });
    expect(starts.at(-1)?.args).toEqual(['--host', '127.0.0.1', '--port', url.port, '--require-token', '--frame-ancestor', 'http://127.0.0.1:3001']);
    expect((await route.GET(request(undefined, { authorization: '' }))).status).toBe(403);
    expect((await route.POST(request({ action: 'stop' }))).status).toBe(200);
    expect((await route.GET(request())).headers.get('cache-control')).toBe('no-store');
    expect((await waitState('idle')).embedUrl).toBeUndefined();
    expect(() => process.kill(external.pid!, 0)).not.toThrow();
    await expect(fetch(`${url.origin}/readyz`)).rejects.toThrow();
  });

  it('stops an unsafe or failed child and keeps tokens out of errors', async () => {
    for (const config of [{ unsafe: true }, { fail: true }]) {
      configure(config);
      await route.POST(request({ action: 'start' }));
      const state = await waitState('error');
      expect(state.embedUrl).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain(token);
      const pid = records().filter((record) => record.kind === 'start').at(-1)?.pid as number;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => process.kill(external.pid!, 0)).not.toThrow();
    }
  });

  it('cancels startup without leaking an owned child and can restart afterward', async () => {
    configure({ delay: 5_000 });
    const before = records().filter((record) => record.kind === 'start').length;
    await route.POST(request({ action: 'start' }));
    await expect.poll(() => records().filter((record) => record.kind === 'start').length).toBe(before + 1);
    const pid = records().filter((record) => record.kind === 'start').at(-1)?.pid as number;
    const replies = await Promise.all([route.POST(request({ action: 'stop' })), route.POST(request({ action: 'stop' }))]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    expect((await waitState('idle')).embedUrl).toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();
    configure({ printIp: true });
    await route.POST(request({ action: 'start' }));
    await waitState('running');
  });

  it('keeps localhost embedding on the same site and refuses unsupported shell embedding', async () => {
    expect((await route.POST(request({ action: 'start' }, { origin: 'tauri://localhost' }))).status).toBe(409);
    const local = new Request('http://localhost:3001/api/panel/devices', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.WS_TOKEN}`, host: 'localhost:3001', origin: 'http://localhost:3001', 'x-o8-client-addr': '127.0.0.1' },
      body: JSON.stringify({ action: 'start' }),
    });
    expect((await route.POST(local)).status).toBe(202);
    const state = await waitState('running');
    expect(new URL(state.embedUrl!).hostname).toBe('localhost');
    expect(records().filter((record) => record.kind === 'start').at(-1)?.args).toContain('http://localhost:3001');
    expect((await route.POST(request({ action: 'start' }))).status).toBe(409);
  });

  it('keeps ownership while refreshing singleton methods after a module reload', async () => {
    await route.POST(request({ action: 'start' }));
    const before = await waitState('running');
    vi.resetModules();
    const reloaded = await import('@/lib/devices/service');
    const current = reloaded.getDeviceManager();
    expect(current).toBe(manager);
    // An older route can survive the module reload too. It must not downgrade methods.
    expect((await route.GET(request())).status).toBe(200);
    expect(Object.getPrototypeOf(current)).toBe(reloaded.DeviceManager.prototype);
    expect((await current.state()).embedUrl).toBe(before.embedUrl);
    await current.stop();
    expect((await current.state()).phase).toBe('idle');
    expect(external.exitCode).toBeNull();
  });

});
