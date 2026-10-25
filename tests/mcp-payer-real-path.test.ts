import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-payer-'));
const savedKey = `fixture-${randomUUID()}`;
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
state.dir = root;
const receipt = join(root, 'receipt.json');
const script = join(root, 'peer.cjs');
const kinds = [
  { kind: 'absolute runtime CLI', command: () => join(root, 'claude'), args: ['mcp', 'serve'], api: true },
  { kind: 'PATH runtime CLI', command: () => 'claude', args: ['mcp', 'serve'], api: true },
  { kind: 'generic node stdio', command: () => process.execPath, args: [script], api: false },
  { kind: 'generic npx stdio', command: () => join(root, 'npx'), args: ['fixture-mcp'], api: false },
  { kind: 'generic uvx stdio', command: () => join(root, 'uvx'), args: ['fixture-mcp'], api: false },
];
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { insertExternalMcpServer, removeExternalMcpServer } = await import('@/lib/mcp/external-servers');
const { getSymonMcpCatalog, callSymonMcpTool } = await import('@/lib/mcp/symon-tools');
const { testMcpConnection } = await import('@/lib/mcp/test-connection');
let serverId: string | undefined;

beforeAll(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 94).toString('base64url'));
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
  vi.stubEnv('O8_UNAPPROVED_AMBIENT', 'ambient-must-not-travel');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: savedKey });
  // A configured service token remains explicit. Recording only booleans keeps
  // assertion errors, logs and telemetry free of credential values.
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  key: !!process.env.ANTHROPIC_API_KEY,
  alias: !!process.env.ANTHROPIC_AUTH_TOKEN,
  carrier: !!process.env.CARRIER,
  ambient: !!process.env.O8_UNAPPROVED_AMBIENT,
  service: process.env.FIXTURE_SERVICE_TOKEN === 'fixture-service',
}));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (!m.id) return;
 const result = m.method === 'tools/list' ? {tools:[{name:'echo',inputSchema:{type:'object'}}]} : {content:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result})+'\\n');
});
`);
  for (const binary of ['claude', 'npx', 'uvx']) {
    writeFileSync(join(root, binary), readFileSync(script));
    chmodSync(join(root, binary), 0o700);
  }
});
afterEach(() => {
  if (serverId) removeExternalMcpServer(serverId);
  serverId = undefined;
  rmSync(receipt, { force: true });
});
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each(['subscription', 'api'] as const)('worker MCP serialization uses the child CLI payer under %s', async mode => {
  saveRuntimeBillingMode('claude-code', mode);
  serverId = insertExternalMcpServer({ name: 'worker_payer', transport: 'stdio', command: join(root, 'claude'),
    args: ['mcp', 'serve'], workerInjection: true, env: { ANTHROPIC_API_KEY: savedKey, FIXTURE_SERVICE_TOKEN: 'fixture-service' } }).id;
  const { resolveWorkerMcpInjection } = await import('@/lib/mcp/worker-injection');
  const { servers } = await resolveWorkerMcpInjection({ packetId: 'fixture', branch: 'fixture', worktreePath: root });
  expect(servers.length).toBe(1);
  // Simulate the external CLI consuming the actual serialized config, without
  // the application wrapper masking a leak in the emitted child environment.
  const server = JSON.parse(JSON.stringify(servers[0]));
  const result = spawnSync(server.command, server.args, { input: '', env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: savedKey, ...server.env } });
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(receipt, 'utf8')).key).toBe(mode === 'api');
});

it.each(['event', 'disk'])('does not reuse an API-authenticated MCP session after payer changes via %s', async via => {
  saveRuntimeBillingMode('claude-code', 'api');
  serverId = insertExternalMcpServer({ name: 'reuse', transport: 'stdio', command: join(root, 'claude'), symonInjection: true }).id;
  const catalog = await getSymonMcpCatalog({ refresh: true });
  expect(JSON.parse(readFileSync(receipt, 'utf8')).key).toBe(true);
  if (via === 'event') saveRuntimeBillingMode('claude-code', 'subscription');
  else writeFileSync(join(root, 'runtime-billing', 'claude-code.json'), JSON.stringify({mode:'subscription'}));
  await callSymonMcpTool(catalog.tools[0].name, {});
  expect(JSON.parse(readFileSync(receipt, 'utf8')).key).toBe(false);
});

it.each(['subscription', 'api'] as const)('standalone helper uses the shared payer boundary under %s', mode => {
  saveRuntimeBillingMode('claude-code', mode);
  const helper = pathToFileURL(join(process.cwd(), 'scripts/lib/runtime-payer.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {spawnSync,childEnvironment}=await import(${JSON.stringify(helper)});
    const child=spawnSync(${JSON.stringify(join(root, 'claude'))},['mcp','serve'],{input:'',env:childEnvironment({runtimeId:'claude-code'})});
    process.exit(child.status ?? 1);
  `], { env: { NODE_ENV:'test', PATH: process.env.PATH, HOME: root, CORTEX_IDE_DATA_DIR: root,
    O8_MASTER_KEY: process.env.O8_MASTER_KEY, ANTHROPIC_API_KEY: savedKey } });
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(receipt, 'utf8')).key).toBe(mode === 'api');
});

it.each(['disabled', 'removed'] as const)('a configured CLI cannot reuse a %s saved key or explicit copy', async action => {
  saveRuntimeBillingMode('claude-code', 'api');
  mutateProviderKey('ANTHROPIC_API_KEY', action === 'disabled' ? {enabled:false} : {key:null});
  try {
    const result = await testMcpConnection({ transport:'stdio', command:join(root,'claude'),
      env:{ANTHROPIC_API_KEY:savedKey, CARRIER:savedKey} });
    expect(result.ok).toBe(true);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(observed.key).toBe(false);
    expect(observed.carrier).toBe(false);
  } finally { mutateProviderKey('ANTHROPIC_API_KEY', {key:savedKey, enabled:true}); }
});

it.each(['json', 'toml'].flatMap(format => ['subscription', 'removed'].map(action => [format, action])))('a prepared %s MCP file fails closed after the nested CLI policy becomes %s', async (format, action) => {
  saveRuntimeBillingMode('claude-code', 'api');
  const config = join(root, 'prepared-mcp.json');
  const codexHome = join(root, 'prepared-codex');
  mkdirSync(codexHome, {recursive:true});
  const childConfig = {command:join(root,'claude'),env:{ANTHROPIC_API_KEY:savedKey}};
  writeFileSync(config, JSON.stringify({mcpServers:{fixture:childConfig}}));
  writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.fixture]\ncommand=${JSON.stringify(childConfig.command)}\n[mcp_servers.fixture.env]\nANTHROPIC_API_KEY=${JSON.stringify(savedKey)}\n`);
  const { execFileSync } = await import('@/lib/providers/child-process');
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const parent = childEnvironment({runtimeId:'codex', env: format === 'toml' ? {CODEX_HOME:codexHome} : {}});
  try {
    if (action === 'subscription') saveRuntimeBillingMode('claude-code', 'subscription');
    else mutateProviderKey('ANTHROPIC_API_KEY', {key:null});
    let blocked = false;
    try { execFileSync(process.execPath, ['-e','process.exit(0)','--',...(format === 'json' ? ['--mcp-config',config] : [])], {env:parent}); } catch { blocked = true; }
    expect(blocked).toBe(true);
  } finally { mutateProviderKey('ANTHROPIC_API_KEY', {key:savedKey,enabled:true}); }
});

it.each(['api','subscription'] as const)('Codex MCP overrides recheck the nested payer at launch: %s', async mode => {
  saveRuntimeBillingMode('claude-code','api');
  const { stringify } = await import('smol-toml');
  const { bindDeferredCodexMcpLaunch } = await import('@/lib/providers/deferred-mcp-arguments');
  const { childEnvironment, configuredMcpEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const server = {name:'fixture',command:join(root,'claude'),env:configuredMcpEnvironment(join(root,'claude'),{},false)};
  const prepared = stringify({mcp_servers:{fixture:{env:server.env}}});
  const env = childEnvironment({runtimeId:'codex'});
  const invocation = bindDeferredCodexMcpLaunch(env,['-e','process.exit(0)','--','-c',prepared],[server],args=>({command:process.execPath,args}));
  saveRuntimeBillingMode('claude-code',mode);
  let blocked = false;
  try { execFileSync(invocation.command,invocation.args,{env}); } catch { blocked = true; }
  expect(blocked).toBe(mode === 'subscription');
});

it.each(['api', 'subscription', 'during initialize'])('app-server spec rechecks nested MCP payer: %s', async mode => {
  saveRuntimeBillingMode('claude-code', mode === 'subscription' ? 'subscription' : 'api');
  const binary = join(root, 'fake-app-server');
  const observed = join(root, 'rpc-receipt.json');
  rmSync(observed, {force:true});
  const payerFile = join(root, 'runtime-billing', 'claude-code.json');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({received:false,key:false}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if (!m.id) return;
 if (m.method==='initialize' && ${JSON.stringify(mode)}==='during initialize') fs.writeFileSync(${JSON.stringify(payerFile)}, JSON.stringify({mode:'subscription'}));
 if (m.method==='thread/start') {
  fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({received:true,key:!!m.params.config.mcp_servers.fixture.env.ANTHROPIC_API_KEY}));
  process.exit(0);
 }
 process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
});
`, {mode:0o700});
  const spec = join(root, 'app-spec.json');
  writeFileSync(spec, JSON.stringify({codexBin:binary,cwd:root,threadId:null,developerInstructions:null,
    message:'fixture',imagePaths:[],model:'fixture',effort:'low',sandbox:'read-only',config:{mcp_servers:{fixture:{
      command:join(root,'claude'),env:{ANTHROPIC_API_KEY:savedKey},
    }}}}));
  const result = spawnSync(process.execPath, ['--import','tsx',join(process.cwd(),'src/lib/codex/app-server-exec-bridge.ts'),spec], {
    cwd:process.cwd(), timeout:5000,
    env:{NODE_ENV:'test',PATH:process.env.PATH,HOME:root,CORTEX_IDE_DATA_DIR:root,O8_MASTER_KEY:process.env.O8_MASTER_KEY},
  });
  const output = existsSync(observed) ? JSON.parse(readFileSync(observed,'utf8')) : {received:false,key:false};
  expect(output.received).toBe(mode === 'api');
  expect(output.key).toBe(mode === 'api');
  expect(String(result.stderr).includes(savedKey)).toBe(false);
  expect(String(result.stdout).includes(savedKey)).toBe(false);
});

it('rejects provider material in configured argv before worker serialization', async () => {
  saveRuntimeBillingMode('claude-code', 'subscription');
  serverId = insertExternalMcpServer({ name:'arg_payer', transport:'stdio', command:join(root,'claude'),
    args:['--header',savedKey], workerInjection:true }).id;
  const { resolveWorkerMcpInjection } = await import('@/lib/mcp/worker-injection');
  const result = await resolveWorkerMcpInjection({packetId:'fixture',branch:'fixture',worktreePath:root});
  expect(result.servers.length).toBe(0);
  expect(Boolean(result.error)).toBe(true);
  expect(JSON.stringify(result).includes(savedKey)).toBe(false);
});

it('generic CLI checks do not inherit or explicitly forward provider credentials', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', savedKey);
  const config = join(root, 'ci.json');
  writeFileSync(config, JSON.stringify({schema:'o8/ci/v1',repoPath:root,checks:[{
    name:'fixture',command:[join(root,'claude'),'mcp','serve'],env:{ANTHROPIC_AUTH_TOKEN:savedKey,FIXTURE_SERVICE_TOKEN:'fixture-service'},
  }]}));
  const { runCi } = await import('../cli/src/commands/ci');
  const output = vi.spyOn(process.stdout,'write').mockImplementation(() => true);
  try { expect(await runCi({human:false,verbose:false},['--config',config])).toBe(0); } finally { output.mockRestore(); }
  const observed = JSON.parse(readFileSync(receipt,'utf8'));
  expect(observed.key).toBe(false);
  expect(observed.alias).toBe(false);
  expect(observed.ambient).toBe(false);
  expect(observed.service).toBe(true);
});

it('the native opt-in CLI forwards its server token without ambient provider credentials', async () => {
  const binary = join(root,'fake-next');
  writeFileSync(binary, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({key:!!process.env.ANTHROPIC_API_KEY,
 ambient:!!process.env.O8_UNAPPROVED_AMBIENT,token:process.env.O8_NEXT_API_TOKEN==='fixture-next'}));
`,{mode:0o700});
  vi.stubEnv('ANTHROPIC_API_KEY',savedKey);
  vi.stubEnv('O8_NEXT_API_TOKEN','fixture-next');
  const {runNext} = await import('../cli/src/commands/next');
  expect(await runNext(['--enable-next','--binary',binary,'--server','http://127.0.0.1:1','--offscreen'])).toBe(0);
  expect(JSON.parse(readFileSync(receipt,'utf8'))).toEqual({key:false,ambient:false,token:true});
});

it('never returns provider material in MCP diagnostics', async () => {
  saveRuntimeBillingMode('claude-code', 'api');
  const bad = join(root, 'bad.cjs');
  writeFileSync(bad, `process.stderr.write(${JSON.stringify(savedKey)}); process.exit(1);`);
  const result = await testMcpConnection({ transport: 'stdio', command: process.execPath, args: [bad] });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result).includes(savedKey)).toBe(false);
});

describe.sequential('configured MCP payer policy through real launches', () => {
  for (const mode of ['subscription', 'api'] as const) {
    for (const item of kinds) {
      it.each(['catalog', 'connection probe'])(`${item.kind}, ${mode}, %s`, async seam => {
        saveRuntimeBillingMode('claude-code', mode);
        const input = {
          transport: 'stdio' as const, command: item.command(), args: item.args,
          env: { FIXTURE_SERVICE_TOKEN: 'fixture-service', ANTHROPIC_API_KEY: savedKey,
            ANTHROPIC_AUTH_TOKEN: savedKey, CARRIER: savedKey },
        };
        if (seam === 'catalog') {
          serverId = insertExternalMcpServer({ ...input, name: 'payer-fixture', enabled: true, symonInjection: true }).id;
          const catalog = await getSymonMcpCatalog({ refresh: true });
          expect(catalog.tools.length).toBe(1);
          await callSymonMcpTool(catalog.tools[0].name, {});
        } else {
          expect((await testMcpConnection(input)).ok).toBe(true);
        }
        const observed = JSON.parse(readFileSync(receipt, 'utf8'));
        expect(observed.key).toBe(mode === 'api' && item.api);
        expect(observed.alias).toBe(mode === 'api' && item.api);
        expect(observed.carrier).toBe(mode === 'api' && item.api);
        expect(observed.ambient).toBe(false);
        expect(observed.service).toBe(true);
      });
    }
    it(`HTTP transport uses only configured headers, ${mode}`, async () => {
      saveRuntimeBillingMode('claude-code', mode);
      const observations: boolean[] = [];
      const peer = createServer(async (req, res) => {
        observations.push(Object.values(req.headers).some(value => String(value).includes(savedKey)));
        let raw = ''; for await (const chunk of req) raw += String(chunk);
        const m = JSON.parse(raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method === 'tools/list' ? {tools:[{name:'echo'}]} : {}}));
      });
      await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
      try {
        const address = peer.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
        const url = `http://127.0.0.1:${address.port}`;
        serverId = insertExternalMcpServer({ name: 'http-payer', transport: 'http', command: url, symonInjection: true }).id;
        expect((await getSymonMcpCatalog({ refresh: true })).tools.length).toBe(1);
        expect((await testMcpConnection({ transport: 'http', url })).ok).toBe(true);
        expect(observations.length > 1).toBe(true);
        expect(observations.some(Boolean)).toBe(false);
      } finally { peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve())); }
    });
  }
});
