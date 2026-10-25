import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, status: response.status, sessions: body.threads?.length, desktopSession: Boolean(process.env.O8_NEXT_CLERK_SESSION_TOKEN) }));
  })().catch(() => process.exit(1));\n`);
  chmodSync(binary, 0o700);
  return binary;
}

it('built CLI resolves the existing local config and authenticates production fixture routes without typed secrets', () => {
  const receipt = join(root, 'receipt.json');
  const binary = launcherProbe(receipt);
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: configDir, O8_NEXT_CLERK_SESSION_TOKEN: 'fixture-desktop-session' };
  for (const key of ['O8_API_PORT', 'O8_API_TOKEN', 'O8_NEXT_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  execFileSync(process.execPath, ['cli/dist/o8.mjs', 'next', '--enable-next', '--binary', binary, '--app-shell'], { env, stdio: 'pipe' });
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
