import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stagePackagedNativeAddons } from './helpers/packaged-native-addons';

const root = mkdtempSync(join(tmpdir(), 'o8-linux-payload-'));
const server = join(root, 'server');
const runtime = join(root, 'runtime');
const binary = join(root, 'o8-next');
const stage = resolve('scripts/linux/stage-payload.mjs');
const children: ChildProcess[] = [];
const pausedWorkers = new Set<number>();
const profiles: Array<{ launcher: string; env: NodeJS.ProcessEnv }> = [];

function command(file: string, args: string[], env = process.env) {
  return spawnSync(file, args, { env, encoding: 'utf8', timeout: 60_000 });
}
async function until(check: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  throw new Error('Packaged entry point did not reach the expected state');
}
async function launchUnlocked(data: string, env: NodeJS.ProcessEnv) {
  // A PID/launch receipt appears before the launcher releases its lock. A
  // concurrent click intentionally returns success without inspecting status.
  await until(() => command('flock', ['--nonblock', join(data, 'linux-desktop.lock'), '/usr/bin/true'], env).status === 0);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
function launch(launcher: string, env: NodeJS.ProcessEnv) {
  const child = spawn(launcher, [], { env, stdio: 'ignore' });
  children.push(child);
  return child;
}
function captureLaunch(launcher: string, env: NodeJS.ProcessEnv) {
  const child = spawn(launcher, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return { child, closed: once(child, 'close'), stdout: () => stdout, stderr: () => stderr };
}
function events(env: NodeJS.ProcessEnv): string[] {
  try { return readFileSync(env.O8_FIXTURE_LAUNCHES!, 'utf8').trim().split('\n'); } catch { return []; }
}
function visibleWindows(relocated: string): string[] {
  return readdirSync('/proc').filter(pid => {
    try {
      return readlinkSync(`/proc/${pid}/exe`) === join(relocated, 'usr/lib/o8/o8-next')
        && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('--offscreen');
    } catch { return false; }
  });
}
function installation(name: string) {
  const output = join(root, name);
  const result = command(process.execPath, [stage, '--server', server, '--node-root', runtime,
    '--next-binary', binary, '--output', output]);
  expect(result.status, result.stderr).toBe(0);
  const relocated = `${output} relocated`;
  cpSync(output, relocated, { recursive: true });
  rmSync(output, { recursive: true });
  const data = join(root, `${name}-data`);
  const env = { ...process.env, HOME: root, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    PATH: '/usr/bin:/bin', O8_FIXTURE_LAUNCHES: join(root, `${name}-launches`),
    O8_SERVE_STARTUP_TIMEOUT_MS: '15000' };
  for (const key of ['O8_PACKAGED_APP', 'O8_NEXT_BIN', 'O8_NEXT_MAIN_WINDOW', 'O8_API_PORT',
    'O8_WS_PORT', 'O8_SERVE_ROOT', 'O8_NEXT_PARENT_PIPE']) delete env[key as keyof typeof env];
  const launcher = join(relocated, 'usr/bin/o8');
  profiles.push({ launcher, env });
  return { launcher, env, relocated, data };
}

beforeAll(async () => {
  mkdirSync(join(server, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  cpSync(process.execPath, join(runtime, 'bin/node'));
  writeFileSync(join(runtime, 'LICENSE'), 'fixture runtime license');
  const cli = command(process.execPath, ['cli/esbuild.config.mjs']);
  expect(cli.status, cli.stderr).toBe(0);
  const bundledCli = readFileSync('cli/dist/o8.mjs', 'utf8').replace(/^#![^\n]*\n/, '');
  writeFileSync(join(server, 'bin/o8.mjs'), `
    if (process.env.O8_FIXTURE_CLI_WARNING) process.stderr.write('fixture runtime warning\\n');
    if (process.env.O8_FIXTURE_STATUS_JSON && process.argv.includes('status')) {
      process.stdout.write(process.env.O8_FIXTURE_STATUS_JSON); process.exit(0);
    }
    if (process.env.O8_FIXTURE_SERVE_ERROR && process.argv.slice(2).join(' ') === 'serve') {
      process.stdout.write(JSON.stringify({ schema: 'o8/cli/error/v1',
        error: { code: process.env.O8_FIXTURE_SERVE_ERROR, message: 'fixture serve failure' } }));
      process.exit(7);
    }
    ${bundledCli}
  `);
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: server });
  writeFileSync(join(server, 'package.json'), '{"type":"commonjs"}');
  // Exercise app-window's actual readiness handshake, timeout and child reap.
  // Only the surrounding server services and display executable are fixtures.
  await build({
    entryPoints: [resolve('src/lib/next/app-window.ts')], outfile: join(server, 'native-window.cjs'),
    bundle: true, platform: 'node', format: 'cjs', plugins: [{
      name: 'server-services', setup(build) {
        const services: Record<string, string> = {
          '@/lib/data-dir-migration': 'exports.getDataDir = () => process.env.O8_DATA_DIR;',
          '@/lib/operator/defaults': 'exports.getOperatorDefaults = async () => ({ values: {} });',
          '@/lib/panel/api-port': 'exports.getApiBase = () => "http://127.0.0.1:" + process.env.PORT;',
          '@/lib/providers/child-process': 'module.exports = require("node:child_process");',
          '@/lib/providers/spawn-environment': 'exports.childEnvironment = ({env}) => ({...process.env, ...env});',
          '@/lib/ws-auth': 'exports.getOrCreateWsToken = () => "fixture";',
          './browser-pipe': 'exports.bindNextBrowserPipe = () => {};',
          'node:fs': `
            const fs = require('fs');
            module.exports = { ...fs, renameSync(from, to) {
              const result = fs.renameSync(from, to);
              if (process.env.O8_FIXTURE_PAUSE_CLAIM && to.endsWith('/claimed')) {
                fs.writeFileSync(process.env.O8_DATA_DIR + '/window-claim-paused.json', JSON.stringify({ pid: process.pid }));
                process.kill(process.pid, 'SIGSTOP');
              }
              return result;
            } };
          `,
        };
        build.onResolve({ filter: /.*/ }, args => args.path in services
          ? { path: args.path, namespace: 'fixture' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: services[args.path] }));
      },
    }],
  });
  writeFileSync(join(server, 'window-bootstrap.cjs'), `
    process.on('SIGTERM', () => process.exit(0));
    void require('./native-window.cjs').restoreNextWindow().then(() => {
      require('node:fs').writeFileSync(process.env.O8_DATA_DIR + '/window-bootstrap-finished', 'done');
    });
  `);
  // Fixture at the display edge; daemon lifecycle, bundled CLI, staging and launcher are real.
  writeFileSync(join(server, 'server.js'), `
    const http = require('node:http');
    const fs = require('node:fs');
    let windowWorker;
    http.createServer((req, res) => {
      if (fs.existsSync(process.env.O8_DATA_DIR + '/fixture-unhealthy')) {
        res.statusCode = 503;
        fs.writeFileSync(process.env.O8_DATA_DIR + '/health-probe-failed', 'done');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ product: 'o8' }));
    }).listen(Number(process.env.PORT), '127.0.0.1', () => {
      if (process.env.O8_PACKAGED_APP === '1' && process.env.O8_NEXT_MAIN_WINDOW === '1'
        && !process.env.O8_FIXTURE_SKIP_WINDOW_BOOTSTRAP) {
        setTimeout(async () => {
          if (process.env.O8_FIXTURE_PAUSE_CLAIM) {
            // Keep HTTP independent while pausing the real claim-to-spawn hook.
            windowWorker = require('node:child_process').spawn(process.execPath,
              [__dirname + '/window-bootstrap.cjs'], { stdio: 'ignore', env: process.env });
            return;
          }
          await require('./native-window.cjs').restoreNextWindow();
          require('node:fs').writeFileSync(process.env.O8_DATA_DIR + '/window-bootstrap-finished', 'done');
        },
          Number(process.env.O8_FIXTURE_BOOT_DELAY_MS || 0));
      }
    });
    process.on('SIGTERM', () => {
      windowWorker?.kill('SIGCONT');
      windowWorker?.kill('SIGTERM');
      process.exit(0);
    });
  `);
  writeFileSync(join(server, 'ws-server.mjs'), `
    import { createServer } from 'node:net';
    createServer(s => s.end()).listen(Number(process.env.O8_WS_PORT), '127.0.0.1');
  `);
  const source = join(root, 'next.c');
  writeFileSync(source, `
    #include <stdio.h>
    #include <stdlib.h>
    #include <unistd.h>
    #include <string.h>
    int main(int argc, char **argv) {
      FILE *log = fopen(getenv("O8_FIXTURE_LAUNCHES"), "a");
      for (int i = 0; i < argc; i++) fprintf(log, "%s%s", i ? "|" : "", argv[i]);
      // Server-owned windows inherit the parent pipe; CLI fallback windows do not.
      fprintf(log, "%s\\n", getenv("O8_NEXT_PARENT_PIPE") ? "|<parent-pipe>" : ""); fclose(log);
      if (getenv("O8_FIXTURE_FAIL_SERVER_WINDOW") && getenv("O8_NEXT_PARENT_PIPE")) {
        usleep(500000); return 2;
      }
      if (getenv("O8_FIXTURE_UNPAINTED_SERVER_WINDOW") && getenv("O8_NEXT_PARENT_PIPE")) {
        for (;;) pause();
      }
      if (getenv("O8_FIXTURE_PAINT_DELAY_MS") && getenv("O8_NEXT_PARENT_PIPE")) {
        usleep(atoi(getenv("O8_FIXTURE_PAINT_DELAY_MS")) * 1000);
      }
      for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--shell-state")) {
        FILE *state = fopen(argv[i + 1], "w"); fputs("{}", state); fclose(state);
      }
      fputs("o8-next-ready\\n", stdout); fflush(stdout);
      for (;;) pause();
    }
  `);
  const compile = command('cc', [source, '-o', binary]);
  expect(compile.status, compile.stderr).toBe(0);
}, 60_000);

afterAll(async () => {
  for (const pid of pausedWorkers) {
    try { process.kill(pid, 'SIGCONT'); } catch { /* Worker already exited. */ }
  }
  await Promise.all(children.map(stop));
  for (const { env } of profiles) rmSync(join(env.O8_DATA_DIR!, 'fixture-unhealthy'), { force: true });
  const stopped = profiles.filter(({ env }) => existsSync(join(env.O8_DATA_DIR!, 'serve-state.json'))
    || existsSync(join(env.O8_DATA_DIR!, 'serve.pid')))
    .map(({ launcher, env }) => command(launcher, ['serve', 'stop'], env));
  if (stopped.some(result => result.status !== 0)) throw new Error('Daemon cleanup failed; fixture ownership state retained.');
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'linux')('stages a relocatable payload, desktop entry and bundled runtime without a source checkout', () => {
  const f = installation('layout');
  const cli = command(f.launcher, ['version'], f.env);
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout).toContain('0.1.');
  const desktop = readFileSync(join(f.relocated, 'usr/share/applications/o8.desktop'), 'utf8');
  expect(desktop).toContain('Exec=/usr/bin/o8\n');
  expect(desktop).toContain('Terminal=false');
  expect(existsSync(join(f.relocated, 'usr/share/icons/hicolor/256x256/apps/o8.png'))).toBe(true);
  expect(readFileSync(join(f.relocated, 'usr/share/doc/o8/node-LICENSE'), 'utf8')).toContain('fixture runtime');
  const link = join(root, 'o8 link');
  symlinkSync(f.launcher, link);
  expect(command(link, ['version'], f.env).status).toBe(0);
  expect(command(join(f.relocated, 'AppRun'), ['version'], f.env).status).toBe(0);
});

it.skipIf(process.platform !== 'linux')('starts packaged serve once, reuses its window and reopens after that window closes', async () => {
  const f = installation('fresh');
  const first = launch(f.launcher, f.env);
  await until(() => events(f.env).length === 1);
  await until(() => first.exitCode === 0);
  const status = command(f.launcher, ['serve', 'status'], f.env);
  const daemon = JSON.parse(status.stdout);
  expect(daemon.healthy).toBe(true);
  expect(daemon.mode).toBe('packaged');
  const again = command(f.launcher, [], f.env);
  expect(again.status, again.stderr).toBe(0);
  expect(events(f.env)).toHaveLength(1);
  // Close the server-owned window without changing the healthy daemon.
  const { readdirSync } = await import('node:fs');
  for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args[0] === join(f.relocated, 'usr/lib/o8/o8-next')) process.kill(Number(pid), 'SIGTERM');
    } catch { /* process exited */ }
  }
  await delay(100);
  const reopened = launch(f.launcher, f.env);
  await until(() => events(f.env).length === 2);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], f.env).stdout).pid).toBe(daemon.pid);
  await stop(reopened);
}, 60_000);

it.skipIf(process.platform !== 'linux')('attaches to a terminal-started daemon and opens exactly one fallback window on concurrent launch', async () => {
  const f = installation('terminal');
  const serve = command(f.launcher, ['serve'], f.env);
  expect(serve.status, serve.stderr).toBe(0);
  expect(events(f.env)).toHaveLength(0);
  const daemon = JSON.parse(command(f.launcher, ['serve', 'status'], f.env).stdout);
  const app = launch(f.launcher, f.env);
  const concurrent = launch(f.launcher, f.env);
  await until(() => events(f.env).length === 1);
  await until(() => app.exitCode === 0 || concurrent.exitCode === 0);
  await launchUnlocked(f.data, f.env);
  expect(events(f.env)[0]).toContain(`--server|http://127.0.0.1:${daemon.apiPort}`);
  expect(events(f.env)[0]).toContain(`--shell-state|${f.data}/next-shell.json`);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], f.env).stdout).pid).toBe(daemon.pid);
  expect(command(f.launcher, ['serve', 'stop'], f.env).status).toBe(0);
  const stopped = command(f.launcher, [], f.env);
  expect(stopped.status).toBe(1);
  expect(stopped.stderr).toContain('server is not healthy');
  expect(events(f.env)).toHaveLength(1);
  await Promise.all([stop(app), stop(concurrent)]);
}, 60_000);

it.skipIf(process.platform !== 'linux')('falls back when a fresh server window exits during display startup', async () => {
  const f = installation('display-failure');
  const env = { ...f.env, O8_FIXTURE_FAIL_SERVER_WINDOW: '1' };
  const app = launch(f.launcher, env);
  await until(() => events(env).length === 2 && existsSync(join(f.data, 'next-shell.json')), 30_000);
  expect(app.exitCode).toBe(null);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], env).stdout).healthy).toBe(true);
  await stop(app);
}, 60_000);

it.skipIf(process.platform !== 'linux')('waits for delayed server bootstrap instead of racing a fallback window', async () => {
  const f = installation('delayed-bootstrap');
  const env = { ...f.env, O8_FIXTURE_BOOT_DELAY_MS: '18000' };
  const app = launch(f.launcher, env);
  await until(() => events(env).length > 0, 25_000);
  await delay(3_000);
  expect(events(env)).toHaveLength(1);
  expect(app.exitCode).toBe(0);
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  expect(existsSync(join(f.data, 'next-shell.json'))).toBe(true);
}, 60_000);

it.skipIf(process.platform !== 'linux')('waits for a delayed live-but-unpainted server window to be reaped before fallback', async () => {
  const f = installation('unpainted');
  const env = { ...f.env, O8_FIXTURE_BOOT_DELAY_MS: '2000', O8_FIXTURE_UNPAINTED_SERVER_WINDOW: '1' };
  const app = launch(f.launcher, env);
  await until(() => events(env).length === 2 && existsSync(join(f.data, 'next-shell.json')), 25_000);
  expect(app.exitCode).toBe(null);
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], env).stdout).healthy).toBe(true);
  await stop(app);
}, 60_000);

it.skipIf(process.platform !== 'linux')('keeps CLI warnings separate from daemon status and already-running JSON', async () => {
  const f = installation('warnings');
  const env = { ...f.env, O8_FIXTURE_CLI_WARNING: '1' };
  expect(command(f.launcher, ['serve'], env).status).toBe(0);
  const app = launch(f.launcher, env);
  await until(() => events(env).length === 1);
  await launchUnlocked(f.data, env);
  const repeat = command(f.launcher, [], env);
  expect(repeat.status, repeat.stderr).toBe(0);
  for (const status of ['null', '[]', '{"healthy":"true"}', '{"running":true,"healthy":true}', 'not-json']) {
    const invalid = command(f.launcher, [], { ...env, O8_FIXTURE_STATUS_JSON: status });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('server is not healthy');
  }
  expect(events(env)).toHaveLength(1);
  await stop(app);
}, 60_000);

it.skipIf(process.platform !== 'linux')('does not reuse an offscreen app-shell process as the desktop window', async () => {
  const f = installation('offscreen');
  mkdirSync(f.data, { recursive: true });
  const hidden = spawn(join(f.relocated, 'usr/lib/o8/o8-next'),
    ['--app-shell', '--offscreen', '--shell-state', join(f.data, 'next-shell.json')], { env: f.env, stdio: 'ignore' });
  children.push(hidden);
  // An offscreen host may share persisted shell state with the desktop.
  await until(() => events(f.env).length === 1);
  const app = launch(f.launcher, f.env);
  await until(() => events(f.env).length === 2);
  await until(() => app.exitCode === 0);
  expect(events(f.env).filter(args => !args.includes('--offscreen'))).toHaveLength(1);
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  await stop(hidden);
}, 60_000);

it.skipIf(process.platform !== 'linux')('bounds a never-published startup result, releases the lock and permits a retry', async () => {
  const f = installation('missing-result');
  const env = { ...f.env, O8_FIXTURE_SKIP_WINDOW_BOOTSTRAP: '1' };
  const app = captureLaunch(f.launcher, env);
  await app.closed; // Old launcher hangs here until this test's outer deadline.
  expect(app.child.exitCode).toBe(1);
  expect(app.stderr()).toContain('did not report its window startup result within 60 seconds');
  await launchUnlocked(f.data, env);
  expect(events(env)).toHaveLength(0);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], env).stdout).healthy).toBe(true);
  const retry = launch(f.launcher, env);
  await until(() => events(env).length === 1);
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  await stop(retry);
}, 80_000);

it.skipIf(process.platform !== 'linux')('cancels a timed-out server attempt before late bootstrap can duplicate a retry window', async () => {
  const f = installation('expired-bootstrap');
  const env = { ...f.env, O8_FIXTURE_BOOT_DELAY_MS: '70000' };
  const app = captureLaunch(f.launcher, env);
  await app.closed;
  expect(app.child.exitCode).toBe(1);
  expect(app.stderr()).toContain('did not report its window startup result within 60 seconds');
  await launchUnlocked(f.data, env);
  expect(events(env)).toHaveLength(0);
  const bootstrapFinished = join(f.data, 'window-bootstrap-finished');
  expect(existsSync(bootstrapFinished)).toBe(false);
  expect(readdirSync(f.data).filter(name => name.startsWith('linux-window-startup-'))).toEqual([]);
  const daemon = JSON.parse(command(f.launcher, ['serve', 'status'], env).stdout);
  const retry = launch(f.launcher, env);
  await until(() => events(env).length > 0);
  // Prove the retry opened while the original server attempt was still pending.
  expect(existsSync(bootstrapFinished)).toBe(false);
  await until(() => existsSync(bootstrapFinished), 30_000);
  expect(events(env)).toHaveLength(1);
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  const status = JSON.parse(command(f.launcher, ['serve', 'status'], env).stdout);
  expect(status.healthy).toBe(true);
  expect(status.pid).toBe(daemon.pid);
  await stop(retry);
}, 100_000);

it.skipIf(process.platform !== 'linux')('waits for a server attempt claimed just before the deadline instead of erroring or racing a retry', async () => {
  const f = installation('claimed-bootstrap');
  // The server claims and spawns at ~57 s; its window paints at ~65 s, after
  // the launcher's 60-second deadline but within app-window's 15-second one.
  const env = { ...f.env, O8_FIXTURE_BOOT_DELAY_MS: '57000', O8_FIXTURE_PAINT_DELAY_MS: '8000' };
  const app = captureLaunch(f.launcher, env);
  await app.closed;
  expect(app.stderr()).toBe('');
  expect(app.child.exitCode).toBe(0);
  // One server-owned window and no CLI fallback window.
  expect(events(env)).toHaveLength(1);
  expect(events(env)[0]).toContain('|<parent-pipe>');
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  expect(readdirSync(f.data).filter(name => name.startsWith('linux-window-startup-'))).toEqual([]);
  // A later click reuses that window.
  const again = captureLaunch(f.launcher, env);
  await again.closed;
  expect(again.child.exitCode).toBe(0);
  expect(events(env)).toHaveLength(1);
}, 110_000);

it.skipIf(process.platform !== 'linux')('retains ownership through a health failure while claimed and a concurrent retry', async () => {
  const f = installation('claimed-health-failure');
  const env = { ...f.env, O8_FIXTURE_PAUSE_CLAIM: '1', O8_FIXTURE_BOOT_DELAY_MS: '2000' };
  const app = captureLaunch(f.launcher, env);
  const paused = join(f.data, 'window-claim-paused.json');
  await until(() => existsSync(paused));
  const { pid } = JSON.parse(readFileSync(paused, 'utf8'));
  pausedWorkers.add(pid);
  writeFileSync(join(f.data, 'fixture-unhealthy'), 'unhealthy');
  await until(() => existsSync(join(f.data, 'health-probe-failed')));
  await delay(2_000); // Let the launcher's failed status probe settle.
  rmSync(join(f.data, 'fixture-unhealthy'));
  const retry = captureLaunch(f.launcher, env);
  await until(() => retry.child.exitCode !== null || events(env).length > 0);
  process.kill(pid, 'SIGCONT');
  await until(() => existsSync(join(f.data, 'window-bootstrap-finished')));
  await app.closed;
  expect(events(env)).toHaveLength(1);
  expect(events(env)[0]).toContain('|<parent-pipe>');
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  expect(app.child.exitCode).toBe(0);
  await stop(retry.child);
}, 60_000);

it.skipIf(process.platform !== 'linux')('honors a live claim held beyond the grace on a later launch', async () => {
  const f = installation('claimed-past-grace');
  const env = { ...f.env, O8_FIXTURE_PAUSE_CLAIM: '1', O8_FIXTURE_BOOT_DELAY_MS: '2000' };
  const app = captureLaunch(f.launcher, env);
  const paused = join(f.data, 'window-claim-paused.json');
  await until(() => existsSync(paused));
  const { pid } = JSON.parse(readFileSync(paused, 'utf8'));
  pausedWorkers.add(pid);
  await app.closed; // 60-second startup wait plus the 20-second claim grace.
  expect(app.child.exitCode).toBe(1);
  await launchUnlocked(f.data, env);
  const retry = captureLaunch(f.launcher, env);
  await until(() => retry.child.exitCode !== null || events(env).length > 0);
  process.kill(pid, 'SIGCONT');
  await until(() => existsSync(join(f.data, 'window-bootstrap-finished')));
  expect(events(env)).toHaveLength(1);
  expect(events(env)[0]).toContain('|<parent-pipe>');
  expect(visibleWindows(f.relocated)).toHaveLength(1);
  const again = captureLaunch(f.launcher, env);
  await again.closed;
  expect(again.child.exitCode).toBe(0);
  expect(readdirSync(f.data).filter(name => name.startsWith('linux-window-startup-'))).toEqual([]);
  expect(events(env)).toHaveLength(1);
  await stop(retry.child);
}, 120_000);

it.skipIf(process.platform !== 'linux')('preserves unrelated serve failures with a healthy daemon and reuses only allowed error codes', async () => {
  const f = installation('serve-failures');
  expect(command(f.launcher, ['serve'], f.env).status).toBe(0);
  const env = { ...f.env, O8_REVIEW_MODE: 'invalid-fixture-mode' };
  const rejected = command(f.launcher, ['serve'], env);
  expect(rejected.status).not.toBe(0);
  const app = captureLaunch(f.launcher, env);
  await until(() => app.child.exitCode !== null, 5_000);
  await app.closed;
  expect(app.child.exitCode).toBe(rejected.status);
  expect(app.stderr()).toBe(rejected.stderr);
  expect(app.stdout()).toBe(rejected.stdout);
  expect(events(f.env)).toHaveLength(0);
  for (const [index, code] of ['serve_already_running', 'serve_desktop_owns_data_dir'].entries()) {
    const allowed = launch(f.launcher, { ...f.env, O8_FIXTURE_SERVE_ERROR: code, O8_FIXTURE_CLI_WARNING: '1' });
    await until(() => events(f.env).length === index + 1);
    await launchUnlocked(f.data, f.env);
    expect(visibleWindows(f.relocated)).toHaveLength(1);
    await stop(allowed);
    await until(() => visibleWindows(f.relocated).length === 0);
  }
  const denied = captureLaunch(f.launcher, { ...f.env,
    O8_FIXTURE_SERVE_ERROR: 'serve_unexpected', O8_FIXTURE_CLI_WARNING: '1' });
  await until(() => denied.child.exitCode !== null, 5_000);
  await denied.closed;
  expect(denied.child.exitCode).toBe(7);
  expect(JSON.parse(denied.stdout()).error.code).toBe('serve_unexpected');
  expect(denied.stderr()).toContain('fixture runtime warning');
  expect(events(f.env)).toHaveLength(2);
  expect(JSON.parse(command(f.launcher, ['serve', 'status'], f.env).stdout).healthy).toBe(true);
}, 60_000);

it.skipIf(process.platform !== 'linux')('refuses to overwrite an existing stage or accept a non-ELF runtime', () => {
  const occupied = join(root, 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep'), 'owned elsewhere');
  const result = command(process.execPath, [stage, '--server', server, '--node-root', runtime,
    '--next-binary', binary, '--output', occupied]);
  expect(result.status).toBe(1);
  expect(readFileSync(join(occupied, 'keep'), 'utf8')).toBe('owned elsewhere');
  const badRuntime = join(root, 'bad-runtime');
  mkdirSync(join(badRuntime, 'bin'), { recursive: true });
  writeFileSync(join(badRuntime, 'LICENSE'), 'fixture');
  writeFileSync(join(badRuntime, 'bin/node'), '#!/bin/sh\necho bad-runtime\n');
  chmodSync(join(badRuntime, 'bin/node'), 0o755);
  const bad = command(process.execPath, [stage, '--server', server, '--node-root', badRuntime,
    '--next-binary', binary, '--output', join(root, 'bad-stage')]);
  expect(bad.status).toBe(1);
  expect(existsSync(join(root, 'bad-stage'))).toBe(false);
});
