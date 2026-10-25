import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { stringify } from 'smol-toml';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
const root = mkdtempSync(join(tmpdir(), 'o8-mcp-transport-payer-'));
state.dir = root;
vi.stubEnv('HOME', root);
const key = `fixture/${randomUUID()}+=`;
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { spawn } = await import('@/lib/providers/child-process');
const { testMcpConnection } = await import('@/lib/mcp/test-connection');
const { insertExternalMcpServer, removeExternalMcpServer } = await import('@/lib/mcp/external-servers');
const { getSymonMcpCatalog } = await import('@/lib/mcp/symon-tools');
const { ensureMcpConfig } = await import('@/lib/lane/claude-orchestrator-mcp-config');
const { atomicWriteConfig } = await import('@/lib/mcp/claude-desktop-config-io');
const { copyRuntimeConfigFile } = await import('@/lib/providers/runtime-config');
const binary = join(root, 'claude');
let url = '';
let received = false;
let leaked = false;
const server = createServer((request, response) => {
  received = true;
  const authorization = request.headers.authorization ?? '';
  const basic = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString() : '';
  leaked ||= authorization.includes(key) || basic.includes(key) || new URL(request.url!, url).searchParams.get('token') === key;
  let body = '';
  request.on('data', chunk => { body += String(chunk); });
  request.on('end', () => {
    let message: { id?: number; method?: string } = {};
    try { message = JSON.parse(body); } catch { /* The fake CLI sends an empty request. */ }
    const result = message.method === 'tools/list' ? { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] } : {};
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    const sse = new URL(request.url!, url).searchParams.has('token');
    response.setHeader('content-type', sse ? 'text/event-stream' : 'application/json');
    response.end(sse ? `data: ${payload}\n\n` : payload);
  });
});

beforeAll(async () => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 49).toString('base64url'));
  vi.stubEnv('HOME', root);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
(async()=>{
 const i=process.argv.indexOf('--mcp-config');
 const servers=i>=0?JSON.parse(fs.readFileSync(process.argv[i+1],'utf8')).mcpServers:
  require(${JSON.stringify(createRequire(import.meta.url).resolve('smol-toml'))}).parse(fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8')).mcp_servers;
 for(const entry of Object.values(servers)) await fetch(entry.url,{headers:entry.headers||entry.http_headers});
})().catch(()=>{process.exitCode=1});
`, { mode: 0o700 });
});
beforeEach(() => {
  received = false;
  leaked = false;
  mutateProviderKey('ANTHROPIC_API_KEY', { key, enabled: true });
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function remote(type: string, carrier: string, value = key): {
  type: string; url: string; headers?: Record<string, string>; http_headers?: Record<string, string>;
} {
  return { type, url: carrier === 'query' ? `${url}?token=${encodeURIComponent(value)}` : url,
    ...(carrier === 'query' ? {} : { [carrier === 'http_headers' ? 'http_headers' : 'headers']: {
      Authorization: carrier.startsWith('basic') ? `${carrier === 'basic-whitespace' ? ' ' : ''}Basic ${Buffer.from(`fixture:${value}`).toString('base64')}${carrier === 'basic-whitespace' ? ' ' : ''}` : `Bearer ${value}`,
    } }) };
}
async function launch(format: 'json' | 'toml', entry: object, runtimeId: string) {
  const configPath = join(root, 'mcp.json');
  const home = join(root, 'codex');
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ mcpServers: { remote: entry } }));
  writeFileSync(join(home, 'config.toml'), stringify({ mcp_servers: { remote: entry } }));
  const env = childEnvironment({ runtimeId, env: format === 'toml' ? { CODEX_HOME: home } : {} });
  let blocked = false;
  let diagnostics = '';
  try {
    const child = spawn(binary, format === 'json' ? ['--mcp-config', configPath] : [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { diagnostics += String(chunk); });
    child.stderr!.on('data', chunk => { diagnostics += String(chunk); });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('fixture CLI failed'))); });
  } catch (error) { blocked = true; diagnostics += String(error); }
  expect(diagnostics.includes(key)).toBe(false);
  return blocked;
}

for (const type of ['http', 'sse']) for (const carrier of ['headers', 'query', 'basic']) {
  it.each(['subscription', 'api', 'removed', 'disabled'] as const)(`JSON ${type} ${carrier} obeys %s payer before transmission`, async mode => {
    saveRuntimeBillingMode('claude-code', mode === 'subscription' ? 'subscription' : 'api');
    if (mode === 'removed') mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
    if (mode === 'disabled') mutateProviderKey('ANTHROPIC_API_KEY', { enabled: false });
    const blocked = await launch('json', remote(type, carrier), 'claude-code');
    expect(blocked).toBe(mode !== 'api');
    expect(received).toBe(mode === 'api');
    expect(leaked).toBe(mode === 'api');
  });
}
for (const type of ['http', 'sse']) for (const carrier of ['http_headers', 'query', 'basic']) {
  it(`Codex TOML ${type} ${carrier} rejects a retired saved key`, async () => {
    saveRuntimeBillingMode('codex', 'subscription');
    mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
    expect(await launch('toml', remote(type, carrier), 'codex')).toBe(true);
    expect(received).toBe(false);
    expect(leaked).toBe(false);
  });
}
it.each(['http', 'sse'])('preserves an unrelated %s service credential', async type => {
  saveRuntimeBillingMode('claude-code', 'subscription');
  expect(await launch('json', remote(type, 'headers', 'fixture-service'), 'claude-code')).toBe(false);
  expect(received).toBe(true);
  expect(leaked).toBe(false);
});
for (const writer of ['orchestrator', 'desktop', 'runtime-copy']) for (const carrier of ['headers', 'query']) {
  it.each(['subscription', 'api', 'removed'] as const)(`${writer} ${carrier} refuses an unauthorized config write: %s`, mode => {
    saveRuntimeBillingMode('claude-code', mode === 'subscription' ? 'subscription' : 'api');
    if (mode === 'removed') mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
    const config = { mcpServers: { remote: remote('http', carrier) } };
    const dir = join(root, 'mcp');
    rmSync(dir, { recursive: true, force: true });
    const path = join(root, 'desktop.json');
    rmSync(path, { force: true });
    let blocked = false;
    let diagnostic = '';
    try {
      if (writer === 'runtime-copy') {
        const source = join(root, 'source.json');
        writeFileSync(source, JSON.stringify(config));
        copyRuntimeConfigFile(source, path, 'claude-code');
      } else if (writer === 'desktop') atomicWriteConfig(path, config);
      else ensureMcpConfig(root, 'full', config as Parameters<typeof ensureMcpConfig>[2]);
    } catch (error) { blocked = true; diagnostic = String(error); }
    expect(blocked).toBe(mode !== 'api');
    const files = writer !== 'orchestrator' ? [path] : existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
    expect(files.some(file => existsSync(file))).toBe(mode === 'api');
    expect(files.some(file => existsSync(file) && readFileSync(file, 'utf8').includes(key))).toBe(mode === 'api' && carrier === 'headers');
    expect(diagnostic.includes(key)).toBe(false);
  });
}

it('the Codex bridge spec writer refuses saved HTTP credentials before writing', async () => {
  saveRuntimeBillingMode('codex', 'subscription');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
  const { writeCodexAppBridgeSpec } = await import('@/lib/codex/app-bridge-spec');
  const dir = join(root, 'specs');
  mkdirSync(dir, { recursive: true });
  let blocked = false;
  try {
    writeCodexAppBridgeSpec({ codexBin: binary, cwd: root, threadId: null, developerInstructions: null,
      message: 'fixture', imagePaths: [], model: 'fixture', effort: 'low', serviceTier: null, sandbox: 'read-only',
      config: { mcp_servers: { remote: remote('http', 'headers') } } }, dir);
  } catch { blocked = true; }
  expect(blocked).toBe(true);
  expect(readdirSync(dir).length).toBe(0);
});

for (const consumer of ['probe', 'catalog']) for (const carrier of ['headers', 'query', 'basic', 'basic-whitespace']) {
  if (consumer === 'catalog' && carrier.startsWith('basic')) continue;
  it.each(['saved', 'disabled', 'removed', 'api'] as const)(`direct ${consumer} ${carrier} rejects a %s provider key`, async mode => {
    saveRuntimeBillingMode('claude-code', mode === 'api' ? 'api' : 'subscription');
    if (mode === 'removed') mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
    if (mode === 'disabled') mutateProviderKey('ANTHROPIC_API_KEY', { enabled: false });
    const entry = remote('http', carrier);
    let output: unknown;
    if (consumer === 'probe') {
      const result = await testMcpConnection({ transport: 'http', url: entry.url, headers: entry.headers });
      output = result;
      expect(result.ok).toBe(false);
    } else {
      const id = insertExternalMcpServer({ name: 'direct_fixture', transport: 'http', command: entry.url,
        url: entry.url, oauthToken: carrier === 'headers' ? key : null, symonInjection: true }).id;
      try { const result = await getSymonMcpCatalog({ refresh: true }); output = result; expect(result.tools.length).toBe(0); }
      finally { removeExternalMcpServer(id); }
    }
    expect(received).toBe(false);
    expect(leaked).toBe(false);
    expect(JSON.stringify(output).includes(key)).toBe(false);
  });
}

it('URL query fields are checked independently of a malformed escape in another field', async () => {
  saveRuntimeBillingMode('claude-code', 'subscription');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: null });
  const entry = remote('http', 'query');
  entry.url += '&other=%ZZ';
  expect(await launch('json', entry, 'claude-code')).toBe(true);
  expect(received).toBe(false);
  expect(leaked).toBe(false);
});
