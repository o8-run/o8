import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, symlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let host: ChildProcess;
let origin = '';
let configDir = '';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-shell-launch-')));
const token = 'fixture-shell-operator';
beforeAll(async () => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { stdio: 'pipe' });
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--shell'], { env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: host.stdout! });
  for await (const line of lines) {
    try {
      const data = JSON.parse(line) as { origin?: string; configDir?: string };
      origin = data.origin || origin;
      configDir = data.configDir || configDir;
    } catch { continue; }
    if (origin && configDir) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
  expect(configDir).toBeTruthy();
}, 30_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
  rmSync(root, { recursive: true, force: true });
});

function launcherProbe(receipt: string) {
  const binary = join(root, 'native-probe.cjs');
  // Probe only the launcher/native process seam; GPUI tests exercise the real native shell.
  writeFileSync(binary, `#!${process.execPath}\n(async () => {
    const args = process.argv.slice(2);
    const server = args[args.indexOf('--server') + 1];
    const response = await fetch(server + '/api/mobile/orchestrator/threads?limit=500', {
      headers: { authorization: 'Bearer ' + process.env.O8_NEXT_API_TOKEN }
    });
    const body = await response.json();
    require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, status: response.status, sessions: body.threads?.length, desktopSession: Boolean(process.env.O8_NEXT_CLERK_SESSION_TOKEN), tokenFile: process.env.O8_NEXT_TOKEN_FILE || null, tokenOrigin: process.env.O8_NEXT_TOKEN_ORIGIN || null, tokenFiles: process.env.O8_NEXT_TOKEN_FILES ? JSON.parse(process.env.O8_NEXT_TOKEN_FILES) : null }));
  })().catch(() => process.exit(1));\n`);
  chmodSync(binary, 0o700);
  return binary;
}

it('built CLI help describes the default binary, startup, override and stop command', () => {
  const help = execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--help'], { encoding: 'utf8' });
  expect(help).toContain('/Applications/o8.app/Contents/MacOS/o8-next');
  expect(help).toContain('--binary ABSOLUTE_PATH');
  expect(help).toContain('starts o8 serve');
  expect(help).toContain('o8 serve stop');
});

it('built CLI resolves the existing local config and authenticates production fixture routes without typed secrets', () => {
  const receipt = join(root, 'receipt.json');
  const binary = launcherProbe(receipt);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir, O8_NEXT_CLERK_SESSION_TOKEN: 'fixture-desktop-session' };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--binary', binary], { env, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(receipt, 'utf8')) as { args: string[]; status: number; sessions: number; desktopSession: boolean };
  expect(result.status).toBe(200);
  expect(result.desktopSession).toBe(true);
  expect(result.sessions).toBeGreaterThanOrEqual(3);
  expect(result.args).toContain(origin);
  expect(result.args).toContain(join(configDir, 'next-shell.json'));
  expect(result.args.join(' ')).not.toContain(token);
}, 30_000);

it('refuses to forward the local credential to an explicit foreign origin', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir };
  expect(() => execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', process.execPath,
    '--app-shell', '--server', 'https://example.test'], { env, stdio: 'pipe' })).toThrow();
});


it('keeps worker authority instead of replacing it with the local operator token', () => {
  const receipt = join(root, 'worker-receipt.json');
  const binary = launcherProbe(receipt);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir, O8_WORKER_TOKEN: 'fixture-invalid-worker', O8_NEXT_CLERK_SESSION_TOKEN: 'fixture-desktop-session' };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary, '--app-shell'], { env, stdio: 'pipe' });
  expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe(401);
  expect(JSON.parse(readFileSync(receipt, 'utf8')).desktopSession).toBe(false);
});

it('does not upgrade a mixed worker and native environment to operator authority', () => {
  const receipt = join(root, 'mixed-receipt.json');
  const binary = launcherProbe(receipt);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir,
    O8_WORKER_TOKEN: 'fixture-invalid-worker', O8_NEXT_API_TOKEN: token };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary, '--app-shell'], { env, stdio: 'pipe' });
  expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe(401);
});


it('suppresses inherited native operator credentials for a worker selecting another loopback origin', async () => {
  const listener = createServer();
  await new Promise<void>(ready => listener.listen(0, '127.0.0.1', ready));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const receipt = join(root, 'other-origin-receipt.json');
  const binary = launcherProbe(receipt);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir, O8_API_PORT: String(address.port),
    O8_WORKER_TOKEN: 'fixture-invalid-worker', O8_NEXT_API_TOKEN: token };
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary,
    '--app-shell', '--server', origin], { env, stdio: 'pipe' });
  expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe(401);
});


it('does not forward the desktop account session to a different explicit loopback origin', () => {
  const receipt = join(root, 'foreign-session.json');
  const binary = launcherProbe(receipt);
  const url = new URL(origin);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir,
    O8_API_PORT: String(Number(url.port) === 65535 ? 65534 : Number(url.port) + 1),
    O8_NEXT_API_TOKEN: token, O8_NEXT_CLERK_SESSION_TOKEN: 'fixture-desktop-session' };
  delete env.O8_WORKER_TOKEN;
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary,
    '--app-shell', '--server', origin], { env, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(receipt, 'utf8')) as { status: number; desktopSession: boolean };
  expect(result.status).toBe(200);
  expect(result.desktopSession).toBe(false);
});


it('resolves token and state configuration through a directory alias using canonical paths', () => {
  const alias = join(root, 'config-alias');
  symlinkSync(configDir, alias, 'junction');
  const receipt = join(root, 'alias-receipt.json');
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: alias };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', launcherProbe(receipt), '--app-shell'], { env, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(receipt, 'utf8')) as { args: string[]; status: number };
  expect(result.status).toBe(200);
  expect(realpathSync(dirname(result.args[result.args.indexOf('--shell-state') + 1]))).toBe(realpathSync(configDir));
});

it('forwards reloadable token-file authority only for the configured local origin', () => {
  const receipt = join(root, 'reloadable.json');
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN']) delete env[key];
  const launch = (source: NodeJS.ProcessEnv) => {
    execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', launcherProbe(receipt), '--app-shell', '--server', origin], { env: source, stdio: 'pipe' });
    return JSON.parse(readFileSync(receipt, 'utf8'));
  };
  for (const missing of [false, true]) {
    try {
      if (missing) rmSync(join(configDir, 'ws-token'));
      const result = launch(env);
      expect(result.tokenFile).toBe(join(configDir, 'ws-token'));
      expect(result.tokenFiles).toEqual([join(configDir, 'ws-token')]);
      expect(result.tokenOrigin).toBe(origin);
    } finally { writeFileSync(join(configDir, 'ws-token'), token); }
  }
  const inherited = { ...env, O8_NEXT_TOKEN_FILE: join(configDir, 'ws-token'), O8_NEXT_TOKEN_FILES: JSON.stringify([join(configDir, 'ws-token')]), O8_NEXT_TOKEN_ORIGIN: origin };
  for (const source of [{ ...inherited, O8_WORKER_TOKEN: 'fixture-invalid-worker' },
    { ...inherited, O8_API_TOKEN: token },
    { ...inherited, O8_NEXT_API_TOKEN: token },
    { ...inherited, O8_API_PORT: String(Number(new URL(origin).port) === 65535 ? 65534 : Number(new URL(origin).port) + 1) }]) {
    const result = launch(source);
    expect(result.tokenFile).toBeNull();
    expect(result.tokenFiles).toBeNull();
    expect(result.tokenOrigin).toBeNull();
  }
});

it('reloads a legacy token when the port is in the current profile directory', () => {
  const profile = join(root, 'split-profile');
  const current = join(profile, '.o8');
  const legacy = join(profile, '.cortex-ide');
  mkdirSync(current, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(current, 'api-port'), new URL(origin).port);
  writeFileSync(join(legacy, 'ws-token'), token);
  const receipt = join(root, 'split-profile.json');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: profile, USERPROFILE: profile };
  for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', launcherProbe(receipt), '--app-shell'], { env, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(receipt, 'utf8')) as { status: number; tokenFiles: string[] | null };
  expect(result.status).toBe(200);
  expect(result.tokenFiles).toEqual([join(current, 'ws-token'), join(legacy, 'ws-token')]);
});

it('makes explicitly relative token candidates absolute at the native process boundary', () => {
  const receipt = join(root, 'relative-source.json');
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: relative(process.cwd(), configDir) };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', launcherProbe(receipt),
    '--app-shell', '--shell-state', join(root, 'relative-state.json')], { env, stdio: 'pipe' });
  const result = JSON.parse(readFileSync(receipt, 'utf8')) as { status: number; tokenFiles: string[] };
  expect(result.status).toBe(200);
  expect(result.tokenFiles.every(file => isAbsolute(file))).toBe(true);
  expect(realpathSync(dirname(result.tokenFiles[0]))).toBe(realpathSync(configDir));
});

it('built CLI starts one detached serve daemon and reuses it after the native child exits', () => {
  const packaged = join(root, 'standalone-server');
  const dataDir = join(root, 'standalone-profile');
  mkdirSync(join(packaged, 'cli'), { recursive: true });
  mkdirSync(dataDir);
  // This fixture supplies its native payload. Installed-bundle acceptance must
  // separately verify the shipped addon's lookup layout.
  mkdirSync(join(packaged, 'build', 'Release'), { recursive: true });
  copyFileSync(resolve('node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    join(packaged, 'build', 'Release', 'better_sqlite3.node'));
  writeFileSync(join(packaged, 'package.json'), JSON.stringify({ name: 'o8-standalone-fixture' }));
  const cli = join(packaged, 'cli', 'o8.mjs');
  copyFileSync('cli/dist/o8.mjs', cli);
  // Only the server payload and native renderer are fixtures. The bundled CLI,
  // serve ownership records, detached processes, health checks and stop are real.
  writeFileSync(join(packaged, 'server.js'), `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/setup/identity') return res.end(JSON.stringify({product:'o8'}));
      if (req.headers.authorization !== 'Bearer ' + process.env.WS_TOKEN) return res.writeHead(401).end('{}');
      res.end(JSON.stringify({threads:[{id:'fixture-thread'}]}));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `);
  writeFileSync(join(packaged, 'ws-server.mjs'), `
    import { createServer } from 'node:net';
    createServer(socket => socket.end()).listen(Number(process.env.WS_PORT), '127.0.0.1');
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: dataDir, O8_REVIEW_MODE: 'manual' };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN',
    'O8_SPECTATOR_TOKEN', 'O8_NEXT_PARENT_PIPE', 'O8_SERVE_SUPERVISOR_PID', 'O8_SERVE_GENERATION']) delete env[key];
  const invoke = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  const status = () => JSON.parse(invoke('serve', 'status')) as { pid: number; healthy: boolean; running: boolean };
  expect(status().running).toBe(false);
  try {
    const receipt = join(root, 'standalone-launch.json');
    const binary = launcherProbe(receipt);
    invoke('next', '--binary', binary);
    const first = status();
    expect(first.healthy).toBe(true);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe(200);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).sessions).toBe(1);
    invoke('next', '--binary', binary);
    expect(status()).toMatchObject({ pid: first.pid, healthy: true, running: true });
    expect(JSON.parse(readFileSync(join(dataDir, 'serve-state.json'), 'utf8')).children).toHaveLength(2);
  } finally {
    invoke('serve', 'stop');
  }
  expect(status().running).toBe(false);
}, 60_000);
