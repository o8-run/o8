import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout?.trim();
const tsxImport = import.meta.resolve('tsx');
const cli = new URL('../cli/src/index.ts', import.meta.url).pathname;
const routingKeys = ['O8_API_PORT', 'O8_WS_PORT', 'WS_PORT', 'O8_API_TOKEN', 'O8_WORKER_TOKEN',
  'O8_WORKER_PACKET_ID', 'O8_SPECTATOR_TOKEN', 'O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'NODE_OPTIONS',
  '__NEXT_PRIVATE_STANDALONE_CONFIG', 'O8_PACKAGED_APP', 'NEXT_PHASE'];
const servers: Server[] = [], roots: string[] = [], sockets: string[] = [], children: ChildProcess[] = [];
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) {
    try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function endpoint(version: string, token: string) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the managed-run registration */ }
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'wrong fixture credential' }));
      return;
    }
    requests.push(request.url ?? '');
    response.end(JSON.stringify(request.url === '/api/panel/status' ? { version } : { ok: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return { port: address.port, requests };
}

async function run(bundle: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (value) => { output += value; });
  child.stderr!.on('data', (value) => { output += value; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, output };
}

describe.skipIf(!tmux || process.platform === 'win32')('managed CLI routing through an existing isolated terminal server', () => {
  it.each(['persisted', 'explicit-worker'] as const)('uses %s caller context rather than the stale terminal server', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'o8-route-'));
    roots.push(root);
    const bundle = join(root, 'o8.mjs');
    await build({ entryPoints: [cli], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: JSON.stringify('test-fixture') },
      banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url); globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` } });
    const data = join(root, 'data'), staleData = join(root, 'stale'), bin = join(root, 'bin'), socket = join(root, 'sock');
    for (const dir of [data, staleData, bin]) mkdirSync(dir);
    const disk = await endpoint('persisted-fixture', 'disk-fixture-token');
    const explicit = await endpoint('worker-fixture', 'worker-fixture-token');
    writeFileSync(join(data, 'api-port'), String(disk.port));
    writeFileSync(join(data, 'ws-token'), 'disk-fixture-token');
    writeFileSync(join(staleData, 'api-port'), '1');
    writeFileSync(join(staleData, 'ws-token'), 'stale-fixture-token');
    // Every CLI tmux invocation uses this private socket. Never change the
    // operator's global terminal environment to reproduce inherited state.
    const shim = join(bin, 'tmux');
    writeFileSync(shim, `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`);
    chmodSync(shim, 0o700);
    sockets.push(socket);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keepalive', 'sleep 90']);
    for (const [key, value] of Object.entries({ O8_API_PORT: '1', O8_WS_PORT: '1', WS_PORT: '1',
      O8_API_TOKEN: 'stale-fixture-token', O8_WORKER_TOKEN: 'stale-worker', O8_WORKER_PACKET_ID: 'stale-packet',
      O8_SPECTATOR_TOKEN: 'stale-spectator', O8_DATA_DIR: staleData, CORTEX_IDE_DATA_DIR: staleData,
      __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({ outputFileTracingRoot: join(root, 'deleted-checkout') }),
      O8_PACKAGED_APP: '1', NEXT_PHASE: 'phase-production-server' })) {
      execFileSync(tmux, ['-S', socket, 'set-environment', '-g', key, value]);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of routingKeys) delete env[key];
    env.CORTEX_IDE_DATA_DIR = data;
    if (mode === 'explicit-worker') Object.assign(env, { O8_API_PORT: String(explicit.port),
      O8_WORKER_TOKEN: 'worker-fixture-token', O8_WORKER_PACKET_ID: 'caller-packet', O8_WS_PORT: '49999',
      __NEXT_PRIVATE_STANDALONE_CONFIG: '{"output":"standalone"}', O8_PACKAGED_APP: 'caller', NEXT_PHASE: 'caller-phase' });
    const parent = await run(bundle, ['version'], root, env);
    expect(parent.code, parent.output).toBe(0);
    expect(parent.output).toContain('"serverReachable": true');
    const probe = join(root, 'child.mts');
    const config = new URL('../cli/src/config.ts', import.meta.url).href;
    const version = new URL('../cli/src/commands/version.ts', import.meta.url).href;
    writeFileSync(probe, `
import assert from 'node:assert/strict';
import { resolveConfig } from ${JSON.stringify(config)};
import { runVersion } from ${JSON.stringify(version)};
const config = resolveConfig();
assert.equal(config.workerPacketId, ${JSON.stringify(mode === 'explicit-worker' ? 'caller-packet' : null)});
assert.equal(config.source.token, ${JSON.stringify(mode === 'explicit-worker' ? 'worker' : 'data-dir')});
assert.equal(process.env.O8_SPECTATOR_TOKEN, undefined);
assert.equal(process.env.O8_DATA_DIR, undefined);
assert.equal(process.env.CORTEX_IDE_DATA_DIR, ${JSON.stringify(data)});
assert.equal(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG, ${mode === 'explicit-worker' ? JSON.stringify('{"output":"standalone"}') : 'undefined'});
assert.equal(process.env.O8_PACKAGED_APP, ${mode === 'explicit-worker' ? "'caller'" : 'undefined'});
assert.equal(process.env.NEXT_PHASE, ${mode === 'explicit-worker' ? "'caller-phase'" : 'undefined'});
await runVersion({ human: false, verbose: false });
`);
    const child = await run(bundle, ['run', '--', process.execPath, '--import', tsxImport, probe], root, env);
    expect(child.code, child.output).toBe(0);
    expect(child.output).toContain('"serverReachable": true');
    expect(child.output).toContain(mode === 'persisted' ? 'persisted-fixture' : 'worker-fixture');
    const target = mode === 'persisted' ? disk : explicit;
    expect(target.requests.filter((path) => path === '/api/panel/status')).toHaveLength(2);
    expect(target.requests).toContain('/api/panel/managed-runs');
    const receiptDir = join(data, 'logs', 'run');
    const receipt = readdirSync(receiptDir).find((name) => name.endsWith('.exit'));
    expect(receipt).toBeDefined();
    expect(readFileSync(join(receiptDir, receipt!), 'utf8')).toBe('0');
    // The fix is per child; it does not globally repair or erase server state.
    expect(execFileSync(tmux, ['-S', socket, 'show-environment', '-g', 'O8_API_PORT'], { encoding: 'utf8' }).trim())
      .toBe('O8_API_PORT=1');
  }, 30_000);

  it('retains restart ownership for a detached command when soft registration fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-unregistered-run-'));
    roots.push(root);
    const bundle = join(root, 'o8.mjs');
    await build({ entryPoints: [cli], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: JSON.stringify('test-fixture') },
      banner: { js: `import { createRequire as __o8_createRequire } from 'node:module'; const require = __o8_createRequire(import.meta.url); globalThis.require = require;` } });
    const data = join(root, 'data'), bin = join(root, 'bin'), socket = `/tmp/o8-rg-${process.pid}-${Date.now()}`;
    mkdirSync(data); mkdirSync(bin);
    sockets.push(socket);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keepalive', 'sleep 90']);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`);
    chmodSync(join(bin, 'tmux'), 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of routingKeys) delete env[key];
    delete env.O8_MANAGED_RUN_SETTLEMENT_BINDING;
    delete env.O8_OWNED_RUN_MARKER;
    Object.assign(env, { O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, O8_API_PORT: '1', O8_API_TOKEN: 'unreachable-fixture' });
    const result = await run(bundle, ['run', '--detach', '--', process.execPath, '-e', 'setTimeout(() => {}, 60000)'], root, env);
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ registered: false });
    const leases = readdirSync(join(data, 'work-launches'));
    expect(leases).toHaveLength(1);
    const lease = JSON.parse(readFileSync(join(data, 'work-launches', leases[0]), 'utf8'));
    expect(lease.pid).toBeGreaterThan(0);
    expect(() => process.kill(lease.pid, 0)).not.toThrow();
  }, 30_000);

});
