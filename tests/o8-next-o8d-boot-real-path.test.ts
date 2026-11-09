import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Receipt (b) for the Next-stopped switch (#5576): the real o8 next binary boots against the real
// WS process with the native transport on and Next stopped, through its own app-shell entry point.
// Every HTTP request the binary makes goes through a recording relay, so the receipt names each
// route it used and the status the WS listener gave it. Run it on Linux inside a private Xvfb
// display with O8_NEXT_BINARY set to a release build from this checkout:
//   xvfb-run -a -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br' \
//     env O8_NEXT_BINARY=... npx vitest run tests/o8-next-o8d-boot-real-path.test.ts
const binary = process.env.O8_NEXT_BINARY;
const runnable = process.platform === 'linux' && !!binary && !!process.env.DISPLAY;

// The root of a dedicated display, as scripts/next/linux-headless.mjs reads it: more than 32
// colours means a window has painted.
function painted(file: string, env: NodeJS.ProcessEnv) {
  execFileSync('import', ['-window', 'root', `png:${file}`], { env, stdio: 'pipe', timeout: 3000 });
  return Number(execFileSync('identify', ['-format', '%k', file], { env, encoding: 'utf8', timeout: 3000 })) > 32;
}
async function until(read: () => boolean, child: ChildProcess, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`o8 next exited before: ${label}`);
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

it.skipIf(!runnable)('boots o8 next against the WS process with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-o8d-boot-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-o8d-boot-shell-')));
  const requests: string[] = [];
  // Every request from the moment it starts, so a read that never answers is still seen.
  const inflight = new Map<number, { line: string; started: number }>();
  let sequence = 0;
  const path = (url: string | undefined) => new URL(url ?? '/', 'http://relay.invalid').pathname;
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let app: ChildProcess | undefined;
  let target = 0;
  // The window runs in its tunnel mode (O8_NEXT_TUNNEL_HOST, O8_NEXT_WS_PORT), as a machine window
  // does: it names the listener's own host on each request and opens its live socket on this
  // relay's port, so the relay forwards both unchanged and records each status.
  const relay = createServer((request, response) => {
    const id = sequence++;
    const line = `${request.method} ${path(request.url)}`;
    inflight.set(id, { line, started: Date.now() });
    response.on('close', () => inflight.delete(id));
    const upstream = forward({ host: '127.0.0.1', port: target, path: request.url, method: request.method, headers: request.headers }, reply => {
      requests.push(`${line} ${reply.statusCode}`);
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => { requests.push(`${line} relay-error`); response.destroy(); });
    request.pipe(upstream);
  });
  relay.on('upgrade', (request, socket, head) => {
    const line = `UPGRADE ${path(request.url)}`;
    const upstream = connect(target, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      // The listener's status line decides the handshake; record it before relaying the bytes.
      upstream.once('data', first => {
        requests.push(`${line} ${/^HTTP\/1\.1 (\d{3})/.exec(first.toString('latin1'))?.[1] ?? 'unparsed'}`);
        socket.write(first);
        upstream.pipe(socket);
      });
      socket.pipe(upstream);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', () => { requests.push(`${line} relay-error`); close(); });
    socket.on('error', close);
  });
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    target = Number(new URL(server.url.replace('ws:', 'http:')).port);
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const address = relay.address();
    if (!address || typeof address === 'string') throw new Error('relay has no port');
    const origin = `http://127.0.0.1:${address.port}`;

    // The shell's window environment only: no inherited credentials or data paths.
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', O8_NEXT_API_TOKEN: server.token, XDG_CACHE_HOME: join(scratch, 'cache'),
      O8_NEXT_TUNNEL_HOST: `127.0.0.1:${target}`, O8_NEXT_WS_PORT: String(address.port) };
    for (const key of ['PATH', 'TMPDIR', 'LD_LIBRARY_PATH', 'DISPLAY', 'XAUTHORITY', 'VK_DRIVER_FILES', 'VK_ICD_FILENAMES',
      'LIBGL_ALWAYS_SOFTWARE', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH']) if (process.env[key]) env[key] = process.env[key];
    const image = join(scratch, 'display.png');
    expect(painted(image, env)).toBe(false);
    const state = join(scratch, 'linux-shell.json');
    app = spawn(binary!, ['--enable-next', '--app-shell', '--server', origin, '--shell-state', state], { env, stdio: 'ignore' });
    app.on('error', () => {});
    const started = performance.now();
    await until(() => {
      // Bare Xvfb has no window manager to expose a newly mapped inactive window.
      execFileSync('xrefresh', ['-none'], { env, stdio: 'pipe', timeout: 3000 });
      return painted(image, env);
    }, app, 'first frame');
    const firstFrameMs = Math.round(performance.now() - started);
    // The window's first data read: the orchestrator thread list, answered by the WS process.
    await until(() => requests.some(line => line.startsWith('GET /api/mobile/orchestrator/threads 2')), app, 'thread list read');
    // The live socket must be open, then let the startup reads settle with the window still up.
    await until(() => requests.some(line => line.startsWith('UPGRADE /ws ')), app, 'live socket handshake');
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(app.exitCode).toBeNull();
    expect(painted(image, env)).toBe(true);

    const routes = [...new Set(requests)].sort();
    console.log(JSON.stringify({ receipt: 'o8d-boot', firstFrameMs, shellState: existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : null, routes }, null, 2));
    // Next is gone, so every route the window used must be native and answered: no 404
    // fall-through, no 405 for an unported method, no refusal of the operator, no 5xx and no
    // relay failure.
    // One designed refusal: with no voice host heartbeat the realtime broker answers 503
    // VOICE_HOST_UNAVAILABLE, as it does behind Next. Its body says `available: false`; the
    // route's own relay failure gives the same code without it, so read the body to tell them apart.
    const voice = await fetch(`http://127.0.0.1:${target}/api/next/voice-host`, { headers: { authorization: `Bearer ${server.token}` } });
    expect([voice.status, await voice.json()]).toEqual([503, { ok: false, available: false, code: 'VOICE_HOST_UNAVAILABLE' }]);
    const designed = new Set(['GET /api/next/voice-host 503']);
    // A read open now and still open 6 s later is a stuck route, even if the window keeps working
    // around it (its own read timeout is 45 s).
    const open = new Map(inflight);
    await new Promise(resolve => setTimeout(resolve, 6_000));
    expect([...open.keys()].filter(id => inflight.has(id)).map(id => open.get(id)!.line)).toEqual([]);
    // Tunnel mode dials the relay instead of ws-info's port, so check that port here: a normal launch
    // dials exactly what ws-info reports, which must be this listener.
    const info = await (await fetch(`http://127.0.0.1:${target}/api/panel/ws-info`, { headers: { authorization: `Bearer ${server.token}` } })).json() as { wsPort: number; wsToken: string };
    expect([info.wsPort, info.wsToken.length > 0]).toEqual([target, true]);
    expect(routes).toContain('UPGRADE /ws 101');
    expect(routes.filter(line => / (4\d\d|5\d\d|relay-error|unparsed)$/.test(line) && !designed.has(line))).toEqual([]);
    // The window's boot reads, each answered natively.
    for (const read of ['GET /api/mobile/orchestrator/threads 200', 'GET /api/panel/ws-info 200', 'GET /api/panel/operator-defaults 200']) {
      expect(routes).toContain(read);
    }
  } finally {
    console.log(JSON.stringify({ receipt: 'o8d-boot-requests', requests }));
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit');
      app.kill('SIGTERM');
      const force = setTimeout(() => app?.kill('SIGKILL'), 1_500);
      await exited;
      clearTimeout(force);
    }
    relay.closeAllConnections();
    if (relay.listening) await new Promise<void>(resolve => relay.close(() => resolve()));
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
