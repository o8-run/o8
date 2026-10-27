import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8p-')));
const socketPath = join(root, 'm.sock');
const values: Record<string, string | null> = {
  'cortex-theme-palette': 'light', 'cortex-theme': null, 'cortex-reduce-transparency': 'on',
  'cortex-workspace-glass': 'false', 'o8:sidebar:visible': 'true', 'o8:sidebar:width': '384',
};
const reads: Array<{ command: string; payload: Record<string, unknown> }> = [];
const defaults = { ...values };
let mode = 'normal';
let peerOS = 'macos';
let themeReads = 0;
const api = httpServer((_request, response) => response.end('{}'));
function handlePeer(socket: Socket) {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      reads.push({ command: request.command, payload: request.payload });
      if (mode === 'timeout') continue;
      let data: unknown;
      if (request.command === 'get_app_info') data = { os: { os: peerOS }, windows: [{ label: 'main', size: { width: 1800, height: 1400 }, scaleFactor: 2 }] };
      else if (request.command === 'list_windows') data = { windows: [{ label: 'main', innerSize: { width: 1800, height: 1400 }, scaleFactor: 2 }] };
      else if (request.command === 'manage_local_storage' && request.payload.action === 'get' && typeof request.payload.key === 'string') {
        data = values[request.payload.key] ?? null;
        if (request.payload.key === 'cortex-theme-palette' && ++themeReads === 2 && mode === 'race') data = 'dark';
      } else { socket.end(JSON.stringify({ id: request.id, success: false, error: 'Read-only fixture' }) + '\n'); continue; }
      socket.write(JSON.stringify({ id: request.id, success: request.authToken === 'fixture-preference-auth', data }) + '\n');
    }
  });
}
const peer = createServer(handlePeer);
let port = 0;
beforeAll(async () => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { stdio: 'pipe' });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const address = api.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing'); port = address.port;
  peer.listen(socketPath); await once(peer, 'listening');
  writeFileSync(socketPath + '.token', 'fixture-preference-auth', { mode: 0o600 });
  writeFileSync(join(root, 'api-port'), String(port));
  writeFileSync(join(root, 'ws-token'), 'fixture-preference-api', { mode: 0o600 });
}, 30_000);
beforeEach(() => { reads.length = 0; themeReads = 0; mode = 'normal'; peerOS = 'macos'; Object.assign(values, defaults); });
afterAll(async () => {
  await Promise.all([new Promise<void>(resolve => peer.close(() => resolve())), new Promise<void>(resolve => api.close(() => resolve()))]);
  rmSync(root, { recursive: true, force: true });
});
async function launch(extra: Partial<NodeJS.ProcessEnv> = {}, server?: string) {
  const receipt = join(root, 'native.json');
  const binary = join(root, 'native.cjs');
  writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ preferences: process.env.O8_NEXT_PREFERENCES ? JSON.parse(process.env.O8_NEXT_PREFERENCES) : null }));\n${mode === 'timeout' ? 'setTimeout(() => {}, 250);' : ''}\n`);
  chmodSync(binary, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: root, O8_TAURI_MCP_SOCKET: socketPath };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_NEXT_PREFERENCES']) delete env[key];
  await execute(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary, '--app-shell', '--shell-state', join(root, 'next-shell.json'), ...(server ? ['--server', server] : [])], {
    env: { ...env, ...extra }, timeout: 10_000,
  });
  return JSON.parse(readFileSync(receipt, 'utf8')).preferences;
}

it('built launcher reads only named preferences from the running peer and forwards a matching bounded snapshot', async () => {
  const before = readFileSync(join(root, 'ws-token'), 'utf8');
  expect(await launch()).toEqual({ version: 1, palette: 'light', glass: false, allGlass: false, sidebarWidth: 384, sidebarVisible: true, windowSize: [900, 700] });
  expect(readFileSync(join(root, 'ws-token'), 'utf8')).toBe(before);
  expect(reads.length).toBeGreaterThan(6);
  expect(reads.every(read => ['get_app_info', 'list_windows'].includes(read.command) || read.command === 'manage_local_storage' && read.payload.action === 'get' && Object.hasOwn(values, String(read.payload.key)))).toBe(true);
});

it('refuses a torn preference snapshot while the user changes theme', async () => {
  mode = 'race';
  expect(await launch()).toBeNull();
});

it('mirrors All Glass and collapsed sidebar through the same read routes', async () => {
  values['cortex-theme-palette'] = null;
  values['cortex-theme'] = 'midnight';
  values['cortex-workspace-glass'] = 'true';
  values['o8:sidebar:visible'] = 'false';
  expect(await launch()).toMatchObject({ palette: 'dark', glass: true, allGlass: true, sidebarVisible: false });
});

it('uses the source app solid fallback outside macOS and bounds invalid sidebar widths', async () => {
  peerOS = 'linux';
  values['cortex-workspace-glass'] = 'true';
  values['cortex-reduce-transparency'] = 'off';
  values['o8:sidebar:width'] = '90000';
  expect(await launch()).toMatchObject({ palette: 'light', glass: false, allGlass: false, sidebarWidth: 300 });
});

it('drops inherited preferences and performs no desktop reads for workers or foreign origins', async () => {
  const inherited = { O8_NEXT_PREFERENCES: '{"version":1,"palette":"light"}' };
  expect(await launch({ ...inherited, O8_WORKER_TOKEN: 'fixture-worker' })).toBeNull();
  expect(await launch({ ...inherited, O8_SPECTATOR_TOKEN: 'fixture-spectator' })).toBeNull();
  expect(await launch(inherited, `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}`)).toBeNull();
  expect(reads).toEqual([]);
});

it('does not discover the installed webview socket when an explicit profile has no bridge selection', async () => {
  expect(await launch({ O8_TAURI_MCP_SOCKET: '' })).toBeNull();
  expect(reads).toEqual([]);
});

it('requires an explicit bridge selector for an environment-selected API port', async () => {
  // Fixture the default discovery boundary so this can never contact an
  // installed account, even if the guard regresses during macOS review.
  const username = 'fixture-' + randomBytes(8).toString('hex');
  const fallback = '/tmp/tauri-mcp-o8-' + username + '.sock';
  const preload = join(root, 'profile.cjs');
  writeFileSync(preload, `const os = require('node:os');
os.userInfo = () => ({username:${JSON.stringify(username)},homedir:${JSON.stringify(root)},uid:1000,gid:1000,shell:null});
os.homedir = () => ${JSON.stringify(root)};
require('node:module').syncBuiltinESMExports();\n`);
  const fixture = createServer(handlePeer);
  fixture.listen(fallback); await once(fixture, 'listening');
  writeFileSync(fallback + '.token', 'fixture-preference-auth', { mode: 0o600 });
  try {
    expect(await launch({ O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: undefined, O8_API_PORT: String(port),
      O8_API_TOKEN: 'fixture-preference-api', O8_TAURI_MCP_SOCKET: '',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require', JSON.stringify(preload)].filter(Boolean).join(' ') })).toBeNull();
    expect(reads).toEqual([]);
  } finally {
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    rmSync(fallback, { force: true }); rmSync(fallback + '.token', { force: true });
  }
});

it('times out a stalled peer and launches with retained defaults without changing source preferences', async () => {
  mode = 'timeout';
  const started = Date.now();
  expect(await launch()).toBeNull();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(reads).toHaveLength(1);
});
