import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-terminal-wait-'));
const tmuxServer = `o8-wait-${process.pid}`;
const session = dashSessionNameForOwnerKey(`workspace:terminal-output-wait-${process.pid}`)!;
const token = randomUUID();
const cli = join(dataDir, 'o8.mjs');
const failedSnapshotShim = join(dataDir, 'fail-snapshot.mjs');
let api: Server;
let wsProcess: ChildProcess;
let apiPort: number;
let wsPort: number;
let serverOutput = '';

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', tmuxServer, ...args], { encoding: 'utf8' });
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Wait fixture timed out: ${serverOutput.slice(-1500)}`);
}

function cliEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    O8_DATA_DIR: dataDir,
    O8_API_PORT: String(apiPort),
    O8_WS_PORT: String(wsPort),
    O8_API_TOKEN: token,
  };
  delete env.O8_WORKER_TOKEN;
  return env;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, 'terminal', ...args], {
    env: cliEnv(), encoding: 'utf8', timeout: 10_000,
  });
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  await build({
    alias: cliBundleAlias, entryPoints: ['cli/src/index.ts'], outfile: cli, bundle: true,
    platform: 'node', format: 'esm', target: 'node22',
    define: { __O8_CLI_VERSION__: '"test"' },
    banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url); globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` },
  });
  writeFileSync(failedSnapshotShim, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input).includes('/terminal-snapshot')
  ? Promise.reject(new Error('simulated snapshot failure')) : originalFetch(input, init);\n`);
  apiPort = await freePort();
  wsPort = await freePort();
  api = createServer((_request, response) => { response.writeHead(200); response.end('{}'); });
  api.listen(apiPort, '127.0.0.1');
  await once(api, 'listening');
  tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '30');
  wsProcess = spawn(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: { ...cliEnv(), O8_PERSISTENT_TERMINALS: '1', O8_DASH_TMUX_SERVER_NAME: tmuxServer,
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; }
  }, 30_000);
}, 45_000);

afterAll(async () => {
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (api?.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
  try { tmux('kill-server'); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('terminal output wait through the bundled CLI and live terminal host', () => {
  it('matches existing and later output without taking the writer or changing the shell', async () => {
    tmux('send-keys', '-t', session, "printf 'O8_WAIT_'; printf 'ALREADY\\n'", 'Enter');
    await waitFor(() => tmux('capture-pane', '-p', '-t', session).includes('O8_WAIT_ALREADY'));
    const existing = run(['wait', session, '--match', 'O8_WAIT_ALREADY', '--timeout', '3000']);
    expect(existing.status, existing.stderr).toBe(0);
    expect(JSON.parse(existing.stdout).line).toContain('O8_WAIT_ALREADY');

    const later = spawn(process.execPath, [cli, 'terminal', 'wait', session, '--match', 'O8_WAIT_LATER', '--timeout', '5000'], {
      env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    later.stdout?.on('data', (chunk) => { output += String(chunk); });
    later.stderr?.on('data', (chunk) => { error += String(chunk); });
    await new Promise((resolve) => setTimeout(resolve, 350));
    tmux('send-keys', '-t', session, "printf 'O8_WAIT_'; printf 'LATER\\n'", 'Enter');
    const [exit] = await once(later, 'exit');
    expect(exit, error).toBe(0);
    expect(JSON.parse(output).line).toContain('O8_WAIT_LATER');

    const liveAfterSnapshotFailure = spawn(process.execPath, [
      `--import=${failedSnapshotShim}`, cli, 'terminal', 'wait', session,
      '--match', 'O8_WAIT_STREAM_ONLY', '--timeout', '5000',
    ], { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let streamed = '';
    let streamError = '';
    liveAfterSnapshotFailure.stdout?.on('data', (chunk) => { streamed += String(chunk); });
    liveAfterSnapshotFailure.stderr?.on('data', (chunk) => { streamError += String(chunk); });
    await new Promise((resolve) => setTimeout(resolve, 350));
    tmux('send-keys', '-t', session, "printf 'O8_WAIT_'; printf 'STREAM_ONLY\\n'", 'Enter');
    const [streamExit] = await once(liveAfterSnapshotFailure, 'exit');
    expect(streamExit, streamError).toBe(0);
    expect(JSON.parse(streamed).source).toBe('stream');
    expect(JSON.parse(streamed).line).toContain('O8_WAIT_STREAM_ONLY');

    const timeout = run(['wait', session, '--match', 'O8_WAIT_NEVER', '--timeout', '300']);
    expect(timeout.status).toBe(5);
    expect(JSON.parse(timeout.stderr).error.code).toBe('wait_timeout');
    expect(tmux('has-session', '-t', session)).toBe('');
    expect(run(['wait', 'cortex-dash-missing', '--match', 'x', '--timeout', '100']).status).toBe(4);
  }, 30_000);
});
