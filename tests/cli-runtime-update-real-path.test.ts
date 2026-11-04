import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({
  unavailable: [], active: { lanes: [], ownedSessions: [], managedRuns: [], terminalSessions: [] },
}) }));

const root = mkdtempSync(join(tmpdir(), 'o8-runtime-update-'));
const prefix = join(root, 'prefix');
const bin = join(prefix, 'bin');
const data = join(root, 'data');
const entry = join(root, 'o8.mjs');
const calls = join(root, 'argv.jsonl');
const fail = join(root, 'fail');
const requests: string[] = [];
let server: Server;
let port = 0;
let devices: Array<{ machineId: string; appVersion: string }> = [];
let registryOk = true;
let appStatus = 202;

function executable(file: string, source: string) {
  writeFileSync(file, `#!${process.execPath}\n${source}\n`);
  chmodSync(file, 0o700);
}

function installFixture(name: string, command: string) {
  const directory = join(prefix, 'lib/node_modules', name);
  mkdirSync(join(directory, 'bin'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, bin: { [command]: `bin/${command}` } }));
  executable(join(directory, 'bin', command), `console.log(require('node:fs').readFileSync(${JSON.stringify(join(root, `${command}.version`))}, 'utf8'));`);
  symlinkSync(join(directory, 'bin', command), join(bin, command));
}

async function runCli(args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: 'fixture-operator', O8_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true }); mkdirSync(data);
  writeFileSync(join(data, 'ws-token'), 'fixture-operator');
  vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  installFixture('@anthropic-ai/claude-code', 'claude');
  installFixture('@google/gemini-cli', 'gemini');
  executable(join(bin, 'magnitude'), 'console.log("2.0.1");');
  const npmRoot = join(prefix, 'lib/node_modules/npm');
  mkdirSync(join(npmRoot, 'bin'), { recursive: true });
  writeFileSync(join(npmRoot, 'package.json'), '{"name":"npm"}');
  executable(join(npmRoot, 'bin/npm-cli.js'), `
    const fs = require('node:fs');
    if (process.argv[2] === '--version') { console.log('11.21.1'); process.exit(0); }
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
    const pkg = args.at(-1);
    if (fs.existsSync(${JSON.stringify(fail)}) && pkg.startsWith('@anthropic-ai/')) process.exit(1);
    const command = pkg.startsWith('@anthropic-ai/') ? 'claude' : 'gemini';
    fs.writeFileSync(${JSON.stringify(root)} + '/' + command + '.version', '2.0.2');
  `);
  symlinkSync(join(npmRoot, 'bin/npm-cli.js'), join(bin, 'npm'));
  // Build the shipped parser and command dispatcher into this test's private output.
  execFileSync(process.execPath, ['cli/esbuild.config.mjs', '--worker-output', entry], { stdio: 'pipe' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '2.0.2' })));
  const route = await import('@/app/api/setup/cli-updates/route');
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://localhost');
      requests.push(`${request.method} ${url.pathname}`);
      let result: Response;
      if (url.pathname === '/api/setup/cli-updates') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const forwarded = new Request(url, { method: request.method, headers: request.headers as HeadersInit,
          ...(request.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {}) });
        result = request.method === 'POST' ? await route.POST(forwarded) : await route.GET(forwarded);
      } else if (url.pathname === '/api/panel/update/apply') {
        result = Response.json(request.method === 'GET'
          ? { currentVersion: '0.1.1', state: { version: '0.1.2' } }
          : { ok: appStatus === 202, requested: appStatus === 202, state: { version: '0.1.2' },
            ...(appStatus === 409 ? { error: { code: 'app_busy', message: 'Wait for active work.' } } : {}) },
        { status: request.method === 'GET' ? 200 : appStatus });
      } else if (url.pathname === '/api/panel/connect') {
        result = Response.json({ ok: registryOk, currentMachineId: 'current', devices,
          ...(!registryOk ? { error: { message: 'Registry unavailable.' } } : {}) });
      } else result = Response.json({ error: 'missing fixture route' }, { status: 404 });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500); response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  port = address.port;
});

beforeEach(async () => {
  requests.length = 0; devices = []; registryOk = true; appStatus = 202;
  for (const file of [calls, fail]) rmSync(file, { force: true });
  for (const command of ['claude', 'gemini']) writeFileSync(join(root, `${command}.version`), '2.0.1');
  const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
  for (const runtime of ['claude-code', 'gemini', 'magnitude', 'npm']) invalidateCliCache(runtime);
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime updates through the shipped CLI and real installer route', () => {
  it('plans against fake CLIs on PATH without invoking any installer or app mutation', async () => {
    const result = await runCli(['update', '--dry-run', '--runtimes', 'claude,gemini,magnitude']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, results: [
      { name: 'claude-code', before: '2.0.1', after: '2.0.1', status: 'planned', manager: 'npm' },
      { name: 'gemini', before: '2.0.1', after: '2.0.1', status: 'planned', manager: 'npm' },
      { name: 'magnitude', before: '2.0.1', after: '2.0.1', status: 'manual-update' },
      { name: 'o8', before: '0.1.1', after: '0.1.1', status: 'planned' },
    ] });
    expect(requests.every(request => request.startsWith('GET '))).toBe(true);
    expect(existsSync(calls)).toBe(false);
  });

  it('records the matching installer argv and continues after one runtime fails', async () => {
    writeFileSync(fail, 'fail first runtime');
    const result = await runCli(['update', 'apply', '--runtimes', 'claude,gemini']);
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, results: [
      { name: 'claude-code', before: '2.0.1', after: '2.0.1', status: 'failed' },
      { name: 'gemini', before: '2.0.1', after: '2.0.2', status: 'succeeded' },
      { name: 'o8', status: 'requested', after: null },
    ] });
    const argv = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(argv).toHaveLength(2);
    expect(argv[0]).toEqual(expect.arrayContaining(['install', '--global', '--prefix', prefix, '@anthropic-ai/claude-code@2.0.2']));
    expect(argv[1]).toEqual(expect.arrayContaining(['install', '--global', '--prefix', prefix, '@google/gemini-cli@2.0.2']));
    expect(requests.at(-1)).toBe('POST /api/panel/update/apply');
  });

  it('prints a clear local-only row when the registry is empty', async () => {
    const result = await runCli(['update', '--dry-run', '--machines', '--runtimes=gemini']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).results).toContainEqual(expect.objectContaining({
      name: 'machines', machine: 'local', status: 'local-only', message: expect.stringContaining('No registered machines'),
    }));
  });

  it('reports registered remote execution as unavailable instead of claiming success', async () => {
    devices = [{ machineId: 'current', appVersion: '0.1.1' }, { machineId: 'remote', appVersion: '0.1.1' }];
    const result = await runCli(['update', '--machines', '--dry-run', '--runtimes=gemini']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).results).toContainEqual(expect.objectContaining({ machine: 'remote', status: 'unavailable' }));
    expect(requests.every(request => request.startsWith('GET '))).toBe(true);
  });

  it('reports registry failures while still planning local updates', async () => {
    registryOk = false;
    const result = await runCli(['update', '--dry-run', '--machines', '--runtimes=gemini']);
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'machines', status: 'failed', message: 'Registry unavailable.' }),
      expect.objectContaining({ name: 'gemini', status: 'planned' }),
    ]));
    expect(requests.every(request => request.startsWith('GET '))).toBe(true);
  });

  it('renders a current runtime in human output without invoking its installer', async () => {
    writeFileSync(join(root, 'gemini.version'), '2.0.2');
    const result = await runCli(['update', '--runtimes', 'gemini', '--dry-run', '--human']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('local\tgemini\t2.0.2\t2.0.2\tcurrent');
    expect(existsSync(calls)).toBe(false);
  });

  it('rejects an unknown runtime before mutating anything', async () => {
    const result = await runCli(['update', 'apply', '--runtimes=not-a-runtime']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('unknown_update_runtime');
    expect(requests.every(request => request.startsWith('GET '))).toBe(true);
  });

  it('preserves an app refusal after completing installed runtime updates', async () => {
    appStatus = 409;
    const result = await runCli(['update', 'apply', '--runtimes=gemini']);
    expect(result.code, result.stderr).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'app_busy' }, results: [
      { name: 'gemini', status: 'succeeded', after: '2.0.2' }, { name: 'o8', status: 'failed' },
    ] });
  });
});
