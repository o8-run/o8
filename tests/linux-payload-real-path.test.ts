import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
function events(env: NodeJS.ProcessEnv): string[] {
  try { return readFileSync(env.O8_FIXTURE_LAUNCHES!, 'utf8').trim().split('\n'); } catch { return []; }
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

beforeAll(() => {
  mkdirSync(join(server, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  cpSync(process.execPath, join(runtime, 'bin/node'));
  writeFileSync(join(runtime, 'LICENSE'), 'fixture runtime license');
  const cli = command(process.execPath, ['cli/esbuild.config.mjs']);
  expect(cli.status, cli.stderr).toBe(0);
  cpSync('cli/dist/o8.mjs', join(server, 'bin/o8.mjs'));
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: server });
  writeFileSync(join(server, 'package.json'), '{"type":"commonjs"}');
  // Fixture at the display edge; daemon lifecycle, bundled CLI, staging and launcher are real.
  writeFileSync(join(server, 'server.js'), `
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    let app;
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ product: 'o8' }));
    }).listen(Number(process.env.PORT), '127.0.0.1', () => {
      if (process.env.O8_PACKAGED_APP === '1' && process.env.O8_NEXT_MAIN_WINDOW === '1') {
        app = spawn(process.env.O8_NEXT_BIN, ['--enable-next', '--app-shell', '--server',
          'http://127.0.0.1:' + process.env.PORT, '--shell-state',
          require('node:path').join(process.env.O8_DATA_DIR, 'next-shell.json')],
          { stdio: 'ignore', env: { ...process.env, O8_NEXT_PARENT_PIPE: '1' } });
      }
    });
    process.on('SIGTERM', () => { app?.kill(); process.exit(0); });
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
      fprintf(log, "\\n"); fclose(log);
      if (getenv("O8_FIXTURE_FAIL_SERVER_WINDOW") && getenv("O8_NEXT_PARENT_PIPE")) {
        usleep(500000); return 2;
      }
      for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--shell-state")) {
        FILE *state = fopen(argv[i + 1], "w"); fputs("{}", state); fclose(state);
      }
      for (;;) pause();
    }
  `);
  const compile = command('cc', [source, '-o', binary]);
  expect(compile.status, compile.stderr).toBe(0);
}, 60_000);

afterAll(async () => {
  await Promise.all(children.map(stop));
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
