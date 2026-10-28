// Opt in on Linux with Xvfb, xauth, xdotool, zenity and kdialog installed:
// O8_NATIVE_PICKER_X11=1 npx vitest run tests/native-picker-x11-real-path.test.ts
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { pickNativePath } from '@/lib/desktop/native-picker';

let root: string | undefined;
let server: ChildProcess | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server && server.exitCode === null) {
    const closed = new Promise(resolve => server!.once('close', resolve));
    server.kill();
    await closed;
  }
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture(authenticated: boolean) {
  root = mkdtempSync(join(tmpdir(), 'o8-picker-x11-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const calls = join(root, 'calls');
  const diagnostics = join(root, 'stderr');
  writeFileSync(calls, '');
  writeFileSync(diagnostics, '');
  const display = `:${randomInt(20000, 60000)}`;
  const authority = join(root, 'non-default.Xauthority');
  writeFileSync(authority, '', { mode: 0o600 });
  execFileSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
  server = spawn('Xvfb', [display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp',
    ...(authenticated ? ['-auth', authority] : ['-ac'])], { stdio: 'ignore' });
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: authority };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      execFileSync('xdotool', ['getdisplaygeometry'], { env, stdio: 'ignore' });
      ready = true;
      break;
    } catch { await delay(50); }
  }
  expect(ready, 'Xvfb must accept the non-default authority').toBe(true);
  if (authenticated) {
    expect(() => execFileSync('xdotool', ['getdisplaygeometry'], {
      env: { ...env, XAUTHORITY: authority + '.missing' }, stdio: 'ignore',
    })).toThrow();
  }
  for (const command of ['zenity', 'kdialog']) {
    // Trace real programs without replacing their GUI, diagnostics or exit code.
    writeFileSync(join(bin, command), `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(command + '\n')});
const child = spawn('/usr/bin/${command}', process.argv.slice(2), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.on('data', data => { fs.appendFileSync(${JSON.stringify(diagnostics)}, data); process.stderr.write(data); });
child.once('error', error => { process.stderr.write(error.message); process.exit(2); });
process.once('SIGTERM', () => child.kill());
child.once('close', (code, signal) => { process.exit(code ?? (signal ? 2 : 0)); });
`, { mode: 0o755 });
  }
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  vi.stubEnv('DISPLAY', display);
  vi.stubEnv('XAUTHORITY', authority);
  vi.stubEnv('XDG_RUNTIME_DIR', runtime);
  vi.stubEnv('WAYLAND_DISPLAY', undefined);
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
  vi.stubEnv('O8_WORKER_ENV_INHERIT', undefined);
  vi.stubEnv('O8_WORKER_ENV_ALLOW', undefined);
  return { env, calls, diagnostics };
}

it.skipIf(process.platform !== 'linux' || process.env.O8_NATIVE_PICKER_X11 !== '1').each([
  [true, 'folder'], [true, 'file'], [false, 'folder'], [false, 'file'],
] as const)('cancels one real X11 picker (authenticated=%s, kind=%s)', async (authenticated, kind) => {
  for (const program of ['Xvfb', 'xauth', 'xdotool', 'zenity', 'kdialog']) {
    expect(existsSync(`/usr/bin/${program}`), `${program} is required`).toBe(true);
  }
  const { env, calls, diagnostics } = await fixture(authenticated);
  const title = `o8-picker-${randomBytes(8).toString('hex')}`;
  let settled = false;
  let sawWindow = false;
  const picking = pickNativePath(kind, title, { timeoutMs: 10_000 }).finally(() => { settled = true; });
  // Escape every visible chooser, including the erroneous fallback on the old head.
  while (!settled) {
    try {
      const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--name', title], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n');
      sawWindow = true;
      for (const window of windows) execFileSync('xdotool', ['key', '--window', window, 'Escape'], { env, stdio: 'ignore' });
    } catch { /* The chooser may not have mapped yet, or may just have closed. */ }
    await delay(100);
  }
  const result = await picking;
  const stderr = readFileSync(diagnostics, 'utf8');
  expect(result, stderr).toEqual({ path: null });
  expect(sawWindow, 'Escape must reach a visible chooser').toBe(true);
  expect(readFileSync(calls, 'utf8').trim().split('\n'), stderr).toEqual(['zenity']);
  expect(stderr).toMatch(/session bus|dconf/i);
}, 30_000);
