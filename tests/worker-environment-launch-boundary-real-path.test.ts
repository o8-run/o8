import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn as fixtureSpawn } from 'node:child_process';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.root, migrateDataDirOnce: () => {} }));
state.root = mkdtempSync(join(tmpdir(), 'o8-env-launch-'));
const root = state.root;
const dependencyRequire = createRequire(import.meta.url);
const names = ['AWS_SECRET_ACCESS_KEY', 'APPLE_APP_SPECIFIC_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY', 'SOCIAL_API_TOKEN', 'O8_UNRELATED_EXPORTED_VALUE'];
const canaries = Object.fromEntries(names.map(name => [name, randomBytes(24).toString('base64url')]));
const peer = join(root, 'peer.cjs');
const receipt = join(root, 'receipt.json');
const { managedCommandLaunch } = await import('@/lib/terminal/managed-command-launch');
const { sanitizePtyEnv } = await import('@/lib/ws-server/pty-support');
const { testMcpConnection } = await import('@/lib/mcp/test-connection');
const { insertExternalMcpServer, removeExternalMcpServer } = await import('@/lib/mcp/external-servers');
const { getSymonMcpCatalog } = await import('@/lib/mcp/symon-tools');
const { invalidateSymonMcpToolCache: invalidateSymonMcpCache } = await import('@/lib/mcp/symon-tools-cache');
const { callCodebaseMemoryTool } = await import('@/lib/codebase-memory/mcp-client');
const processBoundary = await import('@/lib/providers/child-process');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { closeDb } = await import('@/lib/db');
const { terminalToolEnv } = await import('@/lib/llm/terminal-tool-env');
const { findNode22Binary } = await import('@/lib/mcp/operator-node22-locator');

beforeAll(() => {
  for (const [name, value] of Object.entries(canaries)) vi.stubEnv(name, value);
  vi.stubEnv('HOME', root);
  vi.stubEnv('O8_WORKER_ENV_ALLOW', '');
  vi.stubEnv('O8_WORKER_ENV_INHERIT', '0');
  vi.stubEnv('O8_MASTER_KEY', randomBytes(32).toString('base64url'));
  writeFileSync(peer, `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({
  leaked:${JSON.stringify(names)}.some(name=>Boolean(process.env[name])),
  service:process.env.FIXTURE_SERVICE_TOKEN==='explicit-service',
  task:process.env.O8_WORKER_TOKEN==='explicit-task',
  ...(process.argv.includes('--provider-capture')?{provider:Boolean(process.env.OPENAI_API_KEY)}:{}),
}));
if(process.argv.includes('--capture'))process.exit(0);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 const result=m.method==='tools/list'?{tools:[{name:'fixture',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'0'}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`, { mode: 0o700 });
});
afterAll(() => { invalidateSymonMcpCache(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function completed(child: import('node:child_process').ChildProcess): Promise<void> {
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  expect(status, 'fixture executable must complete').toBe(0);
}
function observed() { return JSON.parse(readFileSync(receipt, 'utf8')) as { leaked: boolean; service: boolean; task: boolean; provider?: boolean; master?: boolean }; }

describe('shared process environment boundary', () => {
  it.each([false, true])('terminal bridge clears ambient canaries with resolved=%s and keeps task overrides', async resolved => {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(peer)} --capture`;
    const launch = managedCommandLaunch('/bin/sh', command, sanitizePtyEnv(), {
      FIXTURE_SERVICE_TOKEN: 'explicit-service', O8_WORKER_TOKEN: 'explicit-task',
    }, resolved);
    await completed(fixtureSpawn(launch.file, launch.args, { env: launch.env, stdio: 'ignore' }));
    expect(observed()).toEqual({ leaked: false, service: true, task: true });
  });
  it('Check connection does not promote ambient values into explicit server overrides', async () => {
    const result = await testMcpConnection({ transport: 'stdio', command: process.execPath, args: [peer], env: { FIXTURE_SERVICE_TOKEN: 'explicit-service' } }, 3000);
    expect(result.ok).toBe(true);
    expect(observed().service).toBe(true);
    expect(observed().leaked, 'parent canaries must not reach Check connection').toBe(false);
  });
  it('registered MCP discovery keeps explicit service credentials and excludes parent canaries', async () => {
    const id = insertExternalMcpServer({ name: 'fixture', transport: 'stdio', command: process.execPath, args: [peer],
      symonInjection: true, env: { FIXTURE_SERVICE_TOKEN: 'explicit-service' } }).id;
    try {
      const catalog = await getSymonMcpCatalog({ refresh: true });
      expect(catalog.tools.length).toBe(1);
      expect(observed().service).toBe(true);
      expect(observed().leaked, 'parent canaries must not reach registered MCP').toBe(false);
    } finally { removeExternalMcpServer(id); invalidateSymonMcpCache(); }
  });
  it('codebase-memory MCP uses the same ambient boundary', async () => {
    const result = await callCodebaseMemoryTool({ binPath: peer, cwd: root, toolName: 'fixture', timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(observed().leaked, 'parent canaries must not reach memory MCP').toBe(false);
  });
  it.each(['check', 'registered'])('%s MCP keeps service auth but does not authorize explicit provider slots without a runtime owner', async surface => {
    const input = { transport: 'stdio' as const, command: process.execPath, args: [peer, '--provider-capture'],
      env: { FIXTURE_SERVICE_TOKEN: 'explicit-service', OPENAI_API_KEY: 'fixture-explicit-provider' } };
    if (surface === 'check') expect((await testMcpConnection(input, 3000)).ok).toBe(true);
    else {
      const id = insertExternalMcpServer({ ...input, name: 'fixture-provider', symonInjection: true }).id;
      try { expect((await getSymonMcpCatalog({ refresh: true })).tools.length).toBe(1); }
      finally { removeExternalMcpServer(id); invalidateSymonMcpCache(); }
    }
    expect(observed().service).toBe(true);
    expect(observed().provider, 'a provider slot needs runtime billing authority').toBe(false);
    expect(observed().leaked).toBe(false);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const)('%s defaults to an allowlist without runtime identity', async operation => {
    const args = [peer, '--capture'];
    if (operation === 'spawn') await completed(processBoundary.spawn(process.execPath, args, { stdio: 'ignore' }));
    else if (operation === 'spawnSync') expect(processBoundary.spawnSync(process.execPath, args, { stdio: 'ignore' }).status).toBe(0);
    else if (operation === 'execFileSync') processBoundary.execFileSync(process.execPath, args, { stdio: 'ignore' });
    else if (operation === 'execSync') processBoundary.execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(peer)} --capture`, { stdio: 'ignore' });
    else if (operation === 'fork') await completed(processBoundary.fork(peer, ['--capture'], { stdio: 'ignore' }));
    else await new Promise<void>((resolve, reject) => {
      const done = (error: Error | null) => error ? reject(error) : resolve();
      if (operation === 'execFile') processBoundary.execFile(process.execPath, args, done);
      else processBoundary.exec(`${JSON.stringify(process.execPath)} ${JSON.stringify(peer)} --capture`, done);
    });
    expect(observed().leaked, 'parent canaries must not reach any process API').toBe(false);
  });
  it('explicit task inputs survive the shared boundary', async () => {
    await completed(processBoundary.spawn(process.execPath, [peer, '--capture'], {
      env: childEnvironment({ env: { FIXTURE_SERVICE_TOKEN: 'explicit-service', O8_WORKER_TOKEN: 'explicit-task' } }), stdio: 'ignore',
    }));
    expect(observed()).toEqual({ leaked: false, service: true, task: true });
  });
  it('terminal tools select ambient inputs instead of guessing secret names', async () => {
    await completed(processBoundary.spawn(process.execPath, [peer, '--capture'], { env: terminalToolEnv(), stdio: 'ignore' }));
    expect(observed().leaked, 'a parent export with an ordinary name is still unapproved').toBe(false);
  });
  it.each(['probe', 'reexec'].flatMap(mode => ['default', 'inherit', 'allow'].map(setting => [mode, setting])))('Node 22 %s keeps credentials private with %s ambient settings', async (mode, setting) => {
    vi.stubEnv('O8_WORKER_ENV_INHERIT', setting === 'inherit' ? '1' : '0');
    vi.stubEnv('O8_WORKER_ENV_ALLOW', setting === 'allow' ? 'O8_MASTER_KEY,OPENAI_API_KEY' : '');
    vi.stubEnv('OPENAI_API_KEY', randomBytes(24).toString('base64url'));
    const binary = join(root, `node22-${mode}-${setting}`);
    writeFileSync(binary, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({leaked:${JSON.stringify(names)}.some(name=>Boolean(process.env[name])),master:Boolean(process.env.O8_MASTER_KEY),provider:Boolean(process.env.OPENAI_API_KEY),service:process.env.O8_API_TOKEN==='explicit-local-token'}));
if(process.argv.includes('--version'))process.stdout.write('v22.0.0\\n');
`, { mode: 0o700 });
    if (mode === 'probe') expect(findNode22Binary({ env: { O8_NODE_BIN: binary }, homeDir: root })).toBe(binary);
    else {
      const bootstrap = join(root, 'bootstrap.cjs');
      writeFileSync(bootstrap, `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(name==='better-sqlite3'||name.includes('key-store'))throw new Error('Bootstrap loaded native credentials');return load.call(this,name,...args)};Object.defineProperty(process.versions,'node',{value:'20.0.0'});require(${JSON.stringify(dependencyRequire.resolve('tsx/cjs'))});require(${JSON.stringify(join(process.cwd(), 'src/lib/mcp/operator-node22-reexec.ts'))});`);
      await completed(fixtureSpawn(process.execPath, [bootstrap], { env: { ...process.env, O8_NODE_BIN: binary, O8_API_TOKEN: 'explicit-local-token' }, stdio: 'ignore' }));
      expect(observed().service, 'local broker transport must survive reexec').toBe(true);
    }
    expect(observed().master, 'bootstrap must exclude the store master key even with debug extensions').toBe(false);
    expect(observed().provider, 'bootstrap must exclude provider keys even with debug extensions').toBe(false);
    if (setting !== 'inherit') expect(observed().leaked, 'bootstrap must exclude parent canaries').toBe(false);
    vi.stubEnv('O8_WORKER_ENV_INHERIT', '0');
    vi.stubEnv('O8_WORKER_ENV_ALLOW', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
});
