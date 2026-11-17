import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it('owns the advertised API socket without the legacy flag and forwards unknown requests to Next', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-api-front-door-')));
  const token = 'front-door-fixture-operator';
  const requests: Array<{ method: string; path: string; host: string; body: string }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const record = { method: req.method!, path: req.url!, host: req.headers.host!, body: Buffer.concat(chunks).toString('base64') };
    if (req.url?.startsWith('/api/fixture/') || req.url === '/api/setup/identity') requests.push(record);
    res.writeHead(207, { 'Content-Type': 'application/json', 'Set-Cookie': ['fixture-a=1; HttpOnly', 'fixture-b=2; SameSite=Strict'] });
    res.end(JSON.stringify(record));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const nextPort = (upstream.address() as { port: number }).port;
  const apiPort = await freePort(), oldWsPort = await freePort();
  writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
  mkdirSync(join(directory, 'fixture-bin'));
  for (const command of ['gh', 'claude', 'codex', 'tmux', 'lsof', 'ps', 'pi', 'opencode']) {
    writeFileSync(join(directory, 'fixture-bin', command), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  execFileSync('git', ['init', '-q', directory]);
  const child = spawn(process.execPath, ['--require=./scripts/next/brain-runtime.cjs',
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: join(directory, 'fixture-bin') + ':/usr/bin:/bin', HOME: directory, USERPROFILE: directory,
      NODE_ENV: 'test', LANG: 'C.UTF-8', CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      CORTEX_IDE_REVIEW_REPO_ROOT: directory, O8_API_PORT: String(apiPort), PORT: String(apiPort),
      O8_WS_PORT: String(oldWsPort), WS_PORT: String(oldWsPort), NEXT_ORIGIN: `http://127.0.0.1:${nextPort}`,
      O8_API_FRONT_DOOR: '1', O8_NEXT_O8D: '0', O8_WS_O8D: '0', O8D_NATIVE_SESSION_READS: '0',
      O8_TTS_PYTHON: join(directory, 'no-python'), CORTEX_REALTIME_INTERNAL_ORIGIN: `http://127.0.0.1:${apiPort}` },
  });
  let stderr = '';
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
    requests.length = 0;
    let registered: Response;
    try { registered = await fetch(origin + '/api/setup/identity', { signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error('Advertised API port was not taken over with O8_API_FRONT_DOOR=1 and O8_NEXT_O8D=0'); }
    expect(registered.status).toBe(200);
    expect(requests).toEqual([]);
    expect(await registered.json()).toMatchObject({ apiPort, wsPort: apiPort });

    const bytes = Buffer.from([0, 255, 10, 128, 1]);
    const forwarded = await fetch(origin + '/api/fixture/unregistered?repeat=a&repeat=b&text=%E9%9B%AA', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    expect(forwarded.status).toBe(207);
    expect(forwarded.headers.getSetCookie()).toEqual(['fixture-a=1; HttpOnly', 'fixture-b=2; SameSite=Strict']);
    expect(await forwarded.json()).toEqual({ method: 'POST', path: '/api/fixture/unregistered?repeat=a&repeat=b&text=%E9%9B%AA',
      host: `127.0.0.1:${apiPort}`, body: bytes.toString('base64') });
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const nativeOnly = await fetch(origin + '/api/setup/identity', { signal: AbortSignal.timeout(5000) });
    expect(nativeOnly.status).toBe(200);
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
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
