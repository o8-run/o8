import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const root = mkdtempSync(join(tmpdir(), 'o8-desktop-activate-'));
const data = join(root, 'data');
const entry = join(root, 'server/cli/desktop.mjs');
const launches = join(root, 'launches');
const calls = join(root, 'calls');
let window: ChildProcess;
let reference: Awaited<ReturnType<typeof startParityReference>>;
let socket: WebSocket;
const activations: unknown[] = [];

beforeAll(async () => {
  reference = await startParityReference({ startupTimeoutMs: 60_000 });
  mkdirSync(data);
  mkdirSync(join(root, 'server/cli'), { recursive: true });
  cpSync(process.execPath, join(root, 'o8-next'));
  writeFileSync(join(root, 'window.cjs'), `
    require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'window\\n');
    console.log('ready');
    setInterval(() => {}, 1000);
  `);
  writeFileSync(join(root, 'server/cli/o8.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
    if (process.argv.slice(2).join(' ') !== 'serve status') process.exit(9);
    console.log(JSON.stringify({ schema: 'o8/cli/serve-status/v1', running: true, healthy: true, pid: process.pid }));
  `);
  writeFileSync(join(data, 'ws-port'), new URL(reference.url).port);
  writeFileSync(join(data, 'ws-token'), reference.token);
  await build({
    entryPoints: [resolve('cli/src/linux-desktop.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  window = spawn(join(root, 'o8-next'), [join(root, 'window.cjs'), '--app-shell', '--shell-state', join(data, 'next-shell.json')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(window.stdout!, 'data');
  socket = new WebSocket(`${reference.url}?token=${reference.token}`);
  socket.on('message', bytes => {
    const frame = JSON.parse(String(bytes));
    for (const event of frame.data?.events ?? []) {
      if (event.data?.mutation?.action === 'main-window.activate') activations.push(event.data.mutation);
    }
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
}, 90_000);

afterAll(async () => {
  socket?.terminate();
  if (window && window.exitCode === null && window.signalCode === null) {
    const exited = once(window, 'exit');
    window.kill();
    await exited;
  }
  await reference?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function repeatLaunch(env: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, O8_DATA_DIR: data, O8_API_TOKEN: '', O8_WORKER_TOKEN: '', O8_SPECTATOR_TOKEN: '',
      O8_WS_PORT: '', WS_PORT: '', ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close');
  expect(code, stderr).toBe(0);
  expect(readFileSync(launches, 'utf8')).toBe('window\n');
  expect(readFileSync(calls, 'utf8').trim().split('\n').every(call => call === 'serve status')).toBe(true);
}

it.skipIf(process.platform !== 'linux')('repeat launch activates a healthy open window exactly once without starting another window', async () => {
  await repeatLaunch();
  await vi.waitFor(() => expect(activations).toHaveLength(1));
  expect(activations[0]).toMatchObject({ surfaceId: join(data, 'next-shell.json'), source: 'desktop', status: 'completed' });
  expect(readFileSync(calls, 'utf8')).toBe('serve status\n');
});

it.skipIf(process.platform !== 'linux')('an activation send failure still exits successfully without starting anything', async () => {
  const before = activations.length;
  // A wrong existing credential makes the real relay reject this request.
  await repeatLaunch({ O8_API_TOKEN: 'fixture-refused' });
  expect(activations).toHaveLength(before);
});
