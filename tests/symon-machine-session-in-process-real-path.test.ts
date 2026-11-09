import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startParityReference } from './fixtures/ws-parity-server';

// When a Symon session ends, the WS server clears its machine session in the desktop webview's
// bridge. It now does that itself instead of asking Next, so the cleanup still runs with Next
// stopped, and an absent bridge answers desktop_unavailable at once.
interface Frame { id: string; command: string; authToken?: string; payload: { code?: string } }
const bridgeToken = 'symon-machine-session-bridge-token';
let root: string;
let socketRoot: string;
let socketPath: string;
let bridge: Server;
let bridgeState = 'done';
const frames: Frame[] = [];
const sockets = new Set<Socket>();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-symon-machine-')));
  // A Unix socket path must stay short (104 bytes on macOS), so the bridge lives under /tmp.
  socketRoot = mkdtempSync('/tmp/o8sm-');
  socketPath = join(socketRoot, 'bridge.sock');
  writeFileSync(`${socketPath}.token`, bridgeToken);
  vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
  vi.stubEnv('TAURI_MCP_AUTH_TOKEN', '');
  bridge = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, end)) as Frame;
        buffer = buffer.slice(end + 1);
        if (frame.authToken !== bridgeToken) {
          socket.write(`${JSON.stringify({ id: frame.id, success: false, error: 'Authentication failed: invalid or missing auth token' })}\n`);
          continue;
        }
        frames.push(frame);
        const data = frame.command === 'execute_js'
          ? { result: JSON.stringify({ state: bridgeState, removed: true }) }
          : { app: { name: 'o8' } };
        socket.write(`${JSON.stringify({ id: frame.id, success: true, data })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(socketRoot, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('clears the machine session from the WS server with Next stopped (#5576)', async () => {
  const directory = join(root, 'data');
  mkdirSync(directory);
  const sessionId = 'symon-machine-fixture-session';
  const server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
  try {
    await server.stopNext();
    // The operator's phone holds a scope grant for this Symon session.
    await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      const { persistSymonScopeGrant, SYMON_SCOPE_VERSION } = require('./src/lib/mobile/symon-agent-registry.ts');
      persistSymonScopeGrant({ sessionId: ${JSON.stringify(sessionId)}, subject: 'operator', deviceId: null, workspaceMode: 'o8',
        toolPack: 'o8', repoId: null, repoPath: null, allowedTools: ['symon_watch'], issuedAt: Date.now(), scopeVersion: SYMON_SCOPE_VERSION });
    `], { env: { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory } });
    const socket = new WebSocket(`${server.url}?token=${encodeURIComponent(server.token)}`);
    await once(socket, 'open');
    socket.send(JSON.stringify({ channel: 'symon', type: 'symon-agent-status', sessionId, status: 'live' }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    socket.send(JSON.stringify({ channel: 'symon', type: 'symon-stop', sessionId }));
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.command === 'execute_js'
        && frame.payload.code?.includes(`const sessionId = ${JSON.stringify(sessionId)}`))).toBe(true);
    }, { timeout: 10_000, interval: 50 });
    socket.close();
  } finally {
    await server.stop();
  }
}, 180_000);

it('answers desktop_unavailable at once when no machine bridge is mounted', async () => {
  const { endSymonMachineSession } = await import('@/lib/mobile/symon-machine-session');
  const reset = () => { delete (globalThis as { __o8SymonMachineSessionClient?: unknown }).__o8SymonMachineSessionClient; };

  reset();
  bridgeState = 'no_bridge';
  expect(await endSymonMachineSession('symon-machine-unmounted')).toMatchObject({ status: 503, body: { error: 'desktop_unavailable' } });

  // No desktop webview at all, as with o8 next and Next stopped.
  reset();
  vi.stubEnv('O8_TAURI_MCP_SOCKET', join(socketRoot, 'absent.sock'));
  const started = Date.now();
  expect(await endSymonMachineSession('symon-machine-absent')).toMatchObject({ status: 503, body: { error: 'desktop_unavailable' } });
  expect(Date.now() - started).toBeLessThan(1_000);
  vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
  reset();
  bridgeState = 'done';
});
