import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout?.trim();
const roots: string[] = [], sockets: string[] = [], servers: Server[] = [];
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-receipts-')));
  roots.push(root);
  const home = join(root, 'home'), data = join(home, '.o8'), temp = join(root, 'tmp');
  const cwd = join(root, '.cortex-worktrees', 'packet-review');
  const profiles = join(data, 'session', 'runs'), bin = join(root, 'bin');
  for (const dir of [data, temp, cwd, profiles, bin]) mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', cwd]);
  const bundle = join(root, 'o8.mjs');
  await build({ alias: cliBundleAlias, entryPoints: ['cli/src/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { __O8_CLI_VERSION__: JSON.stringify('test-fixture') },
    banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url); globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` } });
  // macOS Unix socket names have a 104-byte limit; the isolated test data
  // root can exceed it before a fixture name is appended.
  const socketRoot = mkdtempSync('/tmp/o8-rr-');
  roots.push(socketRoot);
  const socket = join(socketRoot, 'sock');
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`);
  chmodSync(join(bin, 'tmux'), 0o700);
  sockets.push(socket);
  execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keepalive', 'sleep 90']);
  const registrations: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/api/lanes')) {
      response.end(JSON.stringify({ lanes: [{ id: 'review-lane', packetId: 'review', worktreePath: cwd }] }));
    } else {
      if (body.action === 'register') registrations.push(body);
      response.end(JSON.stringify({ ok: true }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const marker = '1792655458237-1234abcd';
  const env = { ...process.env, HOME: home, TMPDIR: temp, PATH: `${bin}:${process.env.PATH}`,
    O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, O8_API_PORT: String(address.port),
    O8_API_TOKEN: '', O8_WORKER_TOKEN: 'fixture-worker', O8_WORKER_PACKET_ID: 'review',
    O8_OWNED_RUN_MARKER: marker, NODE_OPTIONS: '' };
  const prepared = await prepareWorkerSandbox({ runId: marker, profileDir: profiles, cwd, repoPath: cwd,
    binary: process.execPath, args: [], homeDir: home, tmpDir: temp, enforceReadOnly: true });
  async function invoke(args: string[], overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const child = spawn(prepared.binary, [...prepared.args, bundle, ...args], {
      cwd, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk; });
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    return { code, stdout, stderr };
  }
  return { root, cwd, data, temp, marker, env, prepared, registrations, invoke };
}

describe.skipIf(process.platform !== 'darwin' || !tmux)('read-only reviewer managed-run receipts through production sandbox', () => {
  it.each(['stream', 'detach'])('executes a %s check and retains sandbox-writable receipts', async (mode) => {
    const f = await fixture();
    const result = await f.invoke(['run', ...(mode === 'detach' ? ['--detach'] : []), '--', process.execPath, '-e', 'process.exit(0)']);
    expect(result.code, result.stderr).toBe(0);
    const directory = join(f.temp, 'o8-worker-runs', f.marker, 'logs', 'run');
    const names = readdirSync(directory);
    const metadata = names.find((name) => name.endsWith('.json'))!;
    const receipt = JSON.parse(readFileSync(join(directory, metadata), 'utf8'));
    // Detached runs return before the wrapper has necessarily exited.
    await expect.poll(() => existsSync(join(directory, `${receipt.id}.exit`))).toBe(true);
    expect(readFileSync(join(directory, `${receipt.id}.exit`), 'utf8')).toBe('0');
    await expect.poll(() => readFileSync(join(directory, `${receipt.id}.log`), 'utf8')).toContain('started-at');
    expect(receipt).toMatchObject({ cwd: f.cwd, mode });
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]).toMatchObject({ packetId: 'review', laneId: 'review-lane' });
    const last = await f.invoke(['run', '--last']);
    expect(last.code, last.stderr).toBe(0);
    expect(JSON.parse(last.stdout).run).toMatchObject({ id: receipt.id, exitStatus: '0', logPath: join(directory, `${receipt.id}.log`) });
    const otherRun = await f.invoke(['run', '--last'], { O8_OWNED_RUN_MARKER: '1792655458238-1234abcd' });
    expect(otherRun.code, otherRun.stderr).toBe(0);
    expect(JSON.parse(otherRun.stdout).run).toBeNull();
    expect(existsSync(join(f.data, 'logs', 'run'))).toBe(false);
    for (const target of [join(f.cwd, 'forbidden'), join(f.cwd, '.git', 'forbidden'), join(f.data, 'forbidden')]) {
      const probe = spawnSync(f.prepared.binary, [...f.prepared.args, '-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'bad')`],
        { cwd: f.cwd, env: f.env, encoding: 'utf8' });
      expect(probe.status).not.toBe(0);
      expect(probe.stderr).toMatch(/EPERM|EACCES/);
      expect(existsSync(target)).toBe(false);
    }
  }, 30_000);

  it.each(['ordinary', 'worker'])('reports one %s receipt tooling fault with its path before starting the command', async (context) => {
    const f = await fixture();
    // Missing launch context or a denied worker temp root must fail visibly,
    // before the command starts, without silently skipping checks or falling back.
    mkdirSync(join(f.data, 'logs', 'run'), { recursive: true });
    const started = join(f.temp, 'command-started');
    const result = await f.invoke(['run', '--', process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'bad')`], context === 'ordinary'
      ? { O8_OWNED_RUN_MARKER: '' }
      : { TMPDIR: f.data });
    expect(result.code).toBe(1);
    const fault = JSON.parse(result.stderr);
    expect(fault.error.code).toBe('run_receipt_init_failed');
    const receiptRoot = context === 'ordinary' ? f.data : join(f.data, 'o8-worker-runs', f.marker);
    expect(fault.error.message).toContain(join(receiptRoot, 'logs', 'run'));
    expect(fault.error.hint).toContain('Tooling fault');
    expect(result.stderr.match(/run_receipt_init_failed/g)).toHaveLength(1);
    expect(result.stdout).toBe('');
    expect(f.registrations).toHaveLength(0);
    expect(existsSync(started)).toBe(false);
  }, 30_000);
});
