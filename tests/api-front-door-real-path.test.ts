import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { O8_WEB_MACHINE_SURFACE } from '../src/lib/connect/web-machine-surface';
import { bundleServers } from '../scripts/lib/server-bundles.mjs';
import { stagePackagedNativeAddons } from './helpers/packaged-native-addons';
import WebSocket, { WebSocketServer } from 'ws';

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const target = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(target, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
const bundleRoot = mkdtempSync(join(tmpdir(), 'o8-front-door-bundle-'));
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
beforeAll(async () => {
  const { stdout } = await promisify(execFile)('df', ['-Pk', '/']);
  if (Number(stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]) < 15 * 1024 * 1024) throw new Error('15 GiB free required for fixture build');
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml',
    '--features', 'experimental-session-reads', '--target-dir', target], { env: { ...process.env, RUSTC_WRAPPER: '' }, maxBuffer: 32 * 1024 * 1024 });
  // Use the actual packaged entry once for both launches. This also avoids
  // retranspiling the complete source graph in each isolated child process.
  bundleServers({ root: process.cwd(), outDir: bundleRoot });
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: bundleRoot });
  copyFileSync('src/lib/lane/orchestrator.md', join(bundleRoot, 'orchestrator.md'));
}, 900_000);

it.each([false, true])('owns the advertised API socket and forwards with legacy flag off (o8d=%s)', async rust => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-api-front-door-')));
  const token = 'front-door-fixture-operator';
  const requests: Array<{ method: string; path: string; host: string; body: string }> = [];
  const upstreamSockets = new Set<Socket>();
  let abortedUpstream: (() => void) | undefined;
  const upstreamAborted = new Promise<void>(resolve => { abortedUpstream = resolve; });
  const upstreamWebSockets = new WebSocketServer({ noServer: true });
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const record = { method: req.method!, path: req.url!, host: req.headers.host!, body: Buffer.concat(chunks).toString('base64') };
    if (req.url?.startsWith('/api/fixture/') || req.url === '/api/setup/identity') requests.push(record);
    if (req.url === '/fixture/abort') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: open\n\n');
      res.on('close', () => abortedUpstream?.()); return;
    }
    if (req.url === '/fixture/redirect') { res.writeHead(302, { Location: '/fixture/destination' }).end(); return; }
    if (req.url === '/fixture/redirect-absolute') {
      res.writeHead(302, { Location: `http://${req.headers.host}/fixture/destination?public=1` }).end(); return;
    }
    if (req.url === '/fixture/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 20); return;
    }
    if (req.method === 'HEAD') { res.writeHead(202, { 'Content-Length': '7', 'X-Fixture': 'head' }).end(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, { Allow: 'GET, POST' }).end(); return; }
    if (req.url === '/api/fixture/peer') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ address: req.headers['x-o8-client-addr'],
        relay: req.headers['x-o8-relay-forward'] ?? null, surface: req.headers['x-o8-relay-surface'] ?? null,
        peer: req.headers['x-o8d-peer'] ?? null, bridge: req.headers['x-o8d-bridge'] ?? null })); return;
    }
    res.writeHead(207, { 'Content-Type': 'application/json', 'Set-Cookie': ['fixture-a=1; HttpOnly', 'fixture-b=2; SameSite=Strict'] });
    res.end(JSON.stringify(record));
  });
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url === '/fixture/websocket') {
      upstreamWebSockets.handleUpgrade(req, socket, head, ws => ws.on('message', bytes => ws.send(bytes))); return;
    }
    if (req.url === '/fixture/upgrade-refused') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nX-Fixture: denied\r\n\r\ndenied'); return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\nfixture-upgrade');
    if (head.length) socket.write(head);
    socket.on('error', () => {}); socket.on('data', bytes => socket.write(bytes));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const nextPort = (upstream.address() as { port: number }).port;
  const apiPort = await freePort(), oldWsPort = await freePort();
  writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
  // The old file can still name a listening process during launcher handoff.
  writeFileSync(join(directory, 'ws-port'), String(nextPort));
  mkdirSync(join(directory, 'fixture-bin'));
  for (const command of ['gh', 'claude', 'codex', 'tmux', 'lsof', 'ps', 'pi', 'opencode']) {
    writeFileSync(join(directory, 'fixture-bin', command), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  execFileSync('git', ['init', '-q', directory]);
  const child = spawn(process.execPath, ['--require=./scripts/next/brain-runtime.cjs',
    join(bundleRoot, 'ws-server.mjs')], {
    cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: join(directory, 'fixture-bin') + ':/usr/bin:/bin', HOME: directory, USERPROFILE: directory,
      NODE_ENV: 'test', LANG: 'C.UTF-8', CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      CORTEX_IDE_REVIEW_REPO_ROOT: directory, O8_API_PORT: String(apiPort), PORT: String(apiPort),
      O8_WS_PORT: String(oldWsPort), WS_PORT: String(oldWsPort), NEXT_ORIGIN: `http://127.0.0.1:${nextPort}`,
      O8_API_FRONT_DOOR: '1', O8_NEXT_O8D: '0', O8_WS_O8D: rust ? '1' : '0', O8D_BINARY: binary,
      O8_TTS_PYTHON: join(directory, 'no-python'), CORTEX_REALTIME_INTERNAL_ORIGIN: `http://127.0.0.1:${apiPort}` },
  });
  let stderr = '';
  child.stdout?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const origin = `http://127.0.0.1:${apiPort}`;
  try {
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && child.exitCode === null) {
      for (const port of [apiPort, oldWsPort]) {
        try { ready ||= (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* boot */ }
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(ready, 'WS startup failed: ' + stderr).toBe(true);
    if (rust) {
      const health = await (await fetch(origin + '/health')).json();
      expect(health.delivery.transport).toBe('o8d');
    }
    requests.length = 0;
    let registered: Response;
    try { registered = await fetch(origin + '/api/setup/identity', { signal: AbortSignal.timeout(30_000) }); }
    catch (error) { throw new Error('Advertised API port was not ready with O8_API_FRONT_DOOR=1 and O8_NEXT_O8D=0: ' + (error instanceof Error ? error.name : 'unknown')); }
    expect(registered.status).toBe(200);
    expect(requests).toEqual([]);
    expect(await registered.json()).toMatchObject({ apiPort, wsPort: apiPort });
    if (rust) {
      // Session readers stay off behind the front door (#6453), but identity is an
      // o8d-owned startup read (#6500), served natively through the real bridge.
      const admitted = await fetch(origin + '/api/setup/identity', { headers: { authorization: 'Bearer ' + token } });
      expect(admitted.headers.get('x-o8d-native')).toBe('1');
      expect(await admitted.json()).toMatchObject({ apiPort, wsPort: apiPort });
    }
    const wsInfo = await fetch(origin + '/api/panel/ws-info', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000) });
    expect(wsInfo.status).toBe(200);
    if (rust) expect(wsInfo.headers.get('x-o8d-native')).toBe('1');
    expect(await wsInfo.json()).toMatchObject({ wsPort: apiPort });
    const websocket = new WebSocket(`ws://127.0.0.1:${apiPort}/ws?token=${token}`);
    const wsDeadline = setTimeout(() => websocket.terminate(), 30_000);
    try { await once(websocket, 'open'); }
    catch (error) { throw new Error('WS upgrade failed: ' + String(error) + '\n' + stderr); }
    finally { clearTimeout(wsDeadline); websocket.terminate(); }

    const bytes = Buffer.from([0, 255, 10, 128, 1]);
    const forwarded = await fetch(origin + '/api/fixture/unregistered?repeat=a&repeat=b&text=%E9%9B%AA', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    expect(forwarded.status).toBe(207);
    expect(forwarded.headers.getSetCookie()).toEqual(['fixture-a=1; HttpOnly', 'fixture-b=2; SameSite=Strict']);
    expect(await forwarded.json()).toEqual({ method: 'POST', path: '/api/fixture/unregistered?repeat=a&repeat=b&text=%E9%9B%AA',
      host: `127.0.0.1:${apiPort}`, body: bytes.toString('base64') });
    for (const [path, method] of [['/api/setup/identity', 'POST'], ['/api/lanes/reap', 'GET'],
      ['/api/automations/connected', 'PUT']]) {
      const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token } });
      expect(response.status, path).toBe(207); expect((await response.json()).path).toBe(path);
    }
    const redirect = await fetch(origin + '/fixture/redirect', { redirect: 'manual' });
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/fixture/destination']);
    const absoluteRedirect = await fetch(origin + '/fixture/redirect-absolute', { redirect: 'manual' });
    expect([absoluteRedirect.status, absoluteRedirect.headers.get('location')])
      .toEqual([302, origin + '/fixture/destination?public=1']);
    const head = await fetch(origin + '/fixture/head', { method: 'HEAD' });
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([202, '7', '']);
    const options = await fetch(origin + '/fixture/options', { method: 'OPTIONS' });
    expect([options.status, options.headers.get('allow')]).toEqual([204, 'GET, POST']);
    const stream = await fetch(origin + '/fixture/stream');
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.text()).toBe('data: first\n\ndata: second\n\n');
    const controller = new AbortController();
    const aborting = await fetch(origin + '/fixture/abort', { signal: controller.signal });
    const reader = aborting.body!.getReader(); await reader.read(); controller.abort();
    await Promise.race([upstreamAborted, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Aborted proxy left upstream open')), 5000); timer.unref();
    })]);
    for (const path of ['/', '/mobile', '/dashboard']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200); expect(await response.text()).toContain('Use the desktop app');
    }
    for (const headers of [{ 'x-o8-client-addr': '127.0.0.9', 'x-o8d-bridge': 'forged' },
      { 'x-o8-client-addr': '127.0.0.9', 'x-o8-relay-forward': '1', 'x-o8d-bridge': 'forged' }] as Record<string, string>[]) {
      const response = await fetch(origin + '/api/fixture/peer', { headers });
      expect(await response.json()).toEqual({ address: headers['x-o8-relay-forward'] ? 'o8-relay-forward' : '127.0.0.1',
        relay: headers['x-o8-relay-forward'] ? '1' : null, surface: null, peer: null, bridge: null });
    }
    expect((await fetch(origin + '/api/setup/status')).status).toBe(401);
    expect((await fetch(origin + '/api/setup/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(origin + '/api/setup/status', { headers: { authorization: 'Bearer ' + token } })).status).toBe(200);
    // Bind the client to a real non-loopback interface: headers cannot simulate this boundary.
    const remoteAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    expect(remoteAddress, 'real remote-peer proof requires a non-loopback IPv4 interface').toBeTruthy();
    for (const relay of [false, true]) {
      const remoteCall = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const call = request(origin + path, { localAddress: remoteAddress, headers: {
          'x-o8-relay-surface': O8_WEB_MACHINE_SURFACE,
          'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'forged',
          ...(relay ? { 'x-o8-relay-forward': '1' } : {}),
        } }, response => {
          let body = ''; response.on('data', bytes => { body += bytes; });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        }); call.setTimeout(5000, () => call.destroy(new Error('Remote request timeout'))); call.on('error', reject); call.end();
      });
      expect((await remoteCall('/api/setup/status')).status).toBe(401);
      const fallback = await remoteCall('/api/fixture/peer');
      expect(fallback.status).toBe(200);
      expect(JSON.parse(fallback.body)).toEqual({ address: remoteAddress, relay: '1', surface: null, peer: null, bridge: null });
    }
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(origin + '/api/fixture/unknown', { headers: { Host: 'untrusted.invalid' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      }); call.on('error', reject); call.end();
    });
    expect(badHost).toBe(421);
    expect((await fetch(origin + '/api/fixture/unknown', { method: 'POST', headers: { origin: 'https://untrusted.invalid' } })).status).toBe(403);
    const socket = connect(apiPort, '127.0.0.1');
    const upgradeDeadline = setTimeout(() => socket.destroy(new Error('Forwarded upgrade timed out')), 10_000);
    try {
      await once(socket, 'connect');
      socket.write(`GET /fixture/upgrade HTTP/1.1\r\nHost: 127.0.0.1:${apiPort}\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n`);
      let data = '';
      for await (const chunk of socket) { data += chunk.toString(); if (data.includes('fixture-upgrade')) break; }
      expect(data).toContain('HTTP/1.1 101'); expect(data).toContain('fixture-upgrade');
    } finally { clearTimeout(upgradeDeadline); socket.destroy(); }
    const refusedUpgrade = connect(apiPort, '127.0.0.1');
    const refusedDeadline = setTimeout(() => refusedUpgrade.destroy(new Error('Upgrade refusal timed out')), 10_000);
    try {
      await once(refusedUpgrade, 'connect');
      refusedUpgrade.write(`GET /fixture/upgrade-refused HTTP/1.1\r\nHost: 127.0.0.1:${apiPort}\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n`);
      let raw = ''; for await (const chunk of refusedUpgrade) raw += chunk.toString();
      expect(raw).toContain('HTTP/1.1 401 Unauthorized'); expect(raw).toContain('X-Fixture: denied'); expect(raw).toMatch(/\r\n\r\ndenied$/);
    } finally { clearTimeout(refusedDeadline); refusedUpgrade.destroy(); }
    const forwardedWs = new WebSocket(origin.replace('http:', 'ws:') + '/fixture/websocket');
    const forwardedWsDeadline = setTimeout(() => forwardedWs.terminate(), 30_000);
    try {
      await once(forwardedWs, 'open'); const echoed = once(forwardedWs, 'message');
      forwardedWs.send('next-websocket-frame'); expect((await echoed)[0].toString()).toBe('next-websocket-frame');
    } finally { clearTimeout(forwardedWsDeadline); forwardedWs.terminate(); }
    console.info('[api-front-door] forwarding, notices, refusal and upgrade checks complete');
    for (const connection of upstreamSockets) connection.destroy();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const nativeOnly = await fetch(origin + '/api/setup/identity', { signal: AbortSignal.timeout(5000) });
    expect(nativeOnly.status).toBe(200);
    const broadcast = await fetch(origin + '/broadcast');
    expect(broadcast.status).toBe(200);
    expect(await broadcast.text()).toContain('broadcast-root');
    console.info('[api-front-door] registered route remains available with Next stopped');
  } finally {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* already exited */ }
    const timer = setTimeout(() => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ }
    }, 5000);
    await closed; clearTimeout(timer);
    for (const ws of upstreamWebSockets.clients) ws.terminate();
    upstreamWebSockets.close();
    upstream.closeAllConnections();
    for (const connection of upstreamSockets) connection.destroy();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

it.each([undefined, '0'])('preserves main non-/ws upgrade refusal byte-for-byte with front door %s', async flag => {
  const upstream = createServer();
  upstream.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nX-Fixture: denied\r\n\r\ndenied'));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const child = spawn(binary, ['--experimental-ws', '--listen', `127.0.0.1:${port}`, '--app-upstream',
    `127.0.0.1:${(upstream.address() as { port: number }).port}`], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'test', PATH: process.env.PATH, O8D_BRIDGE_KEY: 'fixture-key', O8D_EPOCH: 'fixture-epoch',
      ...(flag === undefined ? {} : { O8_API_FRONT_DOOR: flag }) } });
  try {
    await once(child.stdout!, 'data');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/fixture/websocket`);
    const response = new Promise<string>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => {
        let body = ''; res.on('data', bytes => { body += bytes; });
        res.on('end', () => resolve(`HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`
          + res.rawHeaders.reduce((raw, value, index) => raw + value + (index % 2 ? '\r\n' : ': '), '') + '\r\n' + body));
      }); ws.on('error', reject);
    });
    try { expect(await response).toBe('HTTP/1.1 401 Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
    finally { ws.terminate(); }
  } finally {
    const closed = once(child, 'close'); child.kill(); await closed;
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 15_000);
