import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs'); const p = process.getBuiltinModule('node:path');
  return { root: fs.realpathSync.native(fs.mkdtempSync(p.join(process.getBuiltinModule('node:os').tmpdir(), 'o8-npx-registry-'))) };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => f.root, migrateDataDirOnce: () => {} }));
const { POST } = await import('@/app/api/panel/mcp-test/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const token = getOrCreateWsToken();
const registryToken = randomBytes(24).toString('hex');
const blocked = ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'npm_config__authToken',
  'NPM_CONFIG_UNRELATED_SECRET', 'NPM_CONFIG_NODE_OPTIONS', 'O8_UNRELATED_EXPORTED_SECRET'];
const settings = ['userconfig', 'globalconfig', 'registry', 'cache', 'prefix', 'proxy', 'https_proxy', 'noproxy',
  'ca', 'cafile', 'strict_ssl', 'fetch_retries', 'fetch_retry_factor', 'fetch_retry_mintimeout',
  'fetch_retry_maxtimeout', 'fetch_timeout', 'offline', 'prefer_offline', 'prefer_online'];
const requests: Array<{ url: string; authenticated: boolean; status: number }> = [];
let registry: string;
let archive: Buffer;
let sequence = 0;
const server = createServer((req, res) => {
  const authenticated = req.headers.authorization === `Bearer ${registryToken}`;
  const url = req.url ?? '';
  const status = !authenticated || !url.startsWith('/registry/') ? 401 : 200;
  requests.push({ url, authenticated, status });
  if (status === 401) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('private fixture requires authentication'); return; }
  if (url === '/registry/check-connection-1.0.0.tgz') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archive); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    name: '@o8-fixture/check-connection', 'dist-tags': { latest: '1.0.0' },
    time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: { '1.0.0': { name: '@o8-fixture/check-connection', version: '1.0.0',
      bin: { 'o8-registry-mcp': 'peer.cjs' }, dist: { tarball: `${registry}check-connection-1.0.0.tgz`,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } } },
  }));
});
beforeAll(async () => {
  const pkg = path.join(f.root, 'package'); mkdirSync(pkg);
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@o8-fixture/check-connection', version: '1.0.0', bin: { 'o8-registry-mcp': 'peer.cjs' } }));
  writeFileSync(path.join(pkg, 'peer.cjs'), `#!${process.execPath}
const fs=require('node:fs');
const names=${JSON.stringify(settings.map(name => `npm_config_${name}`))};
fs.writeFileSync(process.env.O8_FIXTURE_RECEIPT,JSON.stringify({
 config:Object.fromEntries(Object.entries(process.env).filter(([name])=>names.includes(name.toLowerCase())).map(([name,value])=>[name.toLowerCase(),value])),
 blockedPresent:${JSON.stringify(blocked)}.some(name=>name in process.env),
}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 const result=m.method==='tools/list'?{tools:[{name:'private_registry_fixture',inputSchema:{type:'object'}}]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'private-fixture',version:'1.0.0'}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`, { mode: 0o700 });
  const tarball = path.join(f.root, 'fixture.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', f.root, 'package']); archive = readFileSync(tarball);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing registry fixture port');
  registry = `http://127.0.0.1:${address.port}/registry/`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); rmSync(f.root, { recursive: true, force: true }); });

function fixture() {
  const root = path.join(f.root, String(++sequence)); mkdirSync(root);
  for (const name of Object.keys(process.env).filter(name => /^npm_config_/i.test(name))) vi.stubEnv(name, undefined);
  vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('O8_WORKER_ENV_INHERIT', '0'); vi.stubEnv('O8_WORKER_ENV_ALLOW', '');
  vi.stubEnv('NO_PROXY', '127.0.0.1,localhost'); vi.stubEnv('no_proxy', '127.0.0.1,localhost');
  for (const name of blocked) vi.stubEnv(name, 'fixture-unapproved-parent-value');
  const userconfig = path.join(root, 'user.npmrc'), globalconfig = path.join(root, 'global.npmrc');
  const auth = `//${new URL(registry).host}/:_authToken=${registryToken}\n`;
  // Every fallback is loopback too, so losing the registry setting cannot reach npmjs.
  const fallback = `registry=${registry.replace('/registry/', '/denied/')}\n`;
  writeFileSync(userconfig, fallback + auth, { mode: 0o600 }); writeFileSync(globalconfig, '', { mode: 0o600 });
  writeFileSync(path.join(root, 'ca.pem'), '');
  requests.length = 0;
  return { root, userconfig, globalconfig, auth, receipt: path.join(root, 'receipt.json') };
}
async function check(receipt: string, env: Record<string, string> = {}, explicitRegistry = true) {
  const response = await POST(new NextRequest('http://localhost/api/panel/mcp-test', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inline: { transport: 'stdio', command: 'npx',
      args: ['--yes', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', '--fetch-retries=0', '--fetch-timeout=5000',
        ...(explicitRegistry ? [`--registry=${registry}`] : []), '--package=@o8-fixture/check-connection@1.0.0', 'o8-registry-mcp'],
      env: { O8_FIXTURE_RECEIPT: receipt, ...env } } }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ok: boolean; toolCount?: number; stderr?: string; error?: string }>;
}
function successful(result: { ok: boolean; toolCount?: number; stderr?: string; error?: string }, receipt: string) {
  expect(result.ok, result.stderr ?? result.error).toBe(true); expect(result.toolCount).toBe(1);
  expect(requests.some(req => req.url.endsWith('.tgz') && req.authenticated)).toBe(true);
  expect(requests.every(req => req.status === 200)).toBe(true);
  const observed = JSON.parse(readFileSync(receipt, 'utf8')) as { config: Record<string, string>; blockedPresent: boolean };
  expect(observed.blockedPresent, 'unapproved parent values reached the npx-launched MCP server').toBe(false);
  return observed;
}

it('uses explicit npm configuration to authenticate a real npx Check connection', async () => {
  const f = fixture(); successful(await check(f.receipt, { NPM_CONFIG_USERCONFIG: f.userconfig }), f.receipt);
}, 30_000);

it.each(['NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'NPM_CONFIG_GLOBALCONFIG', 'npm_config_globalconfig'])(
  'keeps ambient %s for a real private-registry npx Check connection', async name => {
    const f = fixture();
    if (/globalconfig/i.test(name)) { writeFileSync(f.userconfig, ''); writeFileSync(f.globalconfig, f.auth, { mode: 0o600 }); }
    vi.stubEnv(name, /globalconfig/i.test(name) ? f.globalconfig : f.userconfig);
    successful(await check(f.receipt), f.receipt);
  }, 30_000,
);

it.each(['NPM_CONFIG_REGISTRY', 'npm_config_registry'])(
  'keeps ambient %s instead of the denied loopback fallback', async name => {
    const f = fixture(); vi.stubEnv(name, registry);
    successful(await check(f.receipt, { NPM_CONFIG_USERCONFIG: f.userconfig }, false), f.receipt);
  }, 30_000,
);

it('keeps npm cache, prefix, proxy, CA and fetch settings without allowing arbitrary npm exports', async () => {
  const f = fixture();
  const values: Record<string, string> = { userconfig: f.userconfig, globalconfig: f.globalconfig, registry,
    cache: path.join(f.root, 'cache'), prefix: path.join(f.root, 'prefix'),
    proxy: registry, https_proxy: registry, noproxy: '127.0.0.1', ca: '', cafile: path.join(f.root, 'ca.pem'), strict_ssl: 'true',
    fetch_retries: '0', fetch_retry_factor: '2', fetch_retry_mintimeout: '10', fetch_retry_maxtimeout: '20', fetch_timeout: '5000',
    offline: 'false', prefer_offline: 'false', prefer_online: 'true' };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, value);
  const observed = successful(await check(f.receipt), f.receipt);
  for (const [key, value] of Object.entries(values)) expect(observed.config[`npm_config_${key}`], key).toBe(value);
  expect(existsSync(path.join(f.root, 'cache', '_cacache'))).toBe(true);
}, 30_000);

it('fails with a real registry 401 when configuration has no credentials', async () => {
  const f = fixture(); writeFileSync(f.userconfig, '');
  const result = await check(f.receipt, { NPM_CONFIG_USERCONFIG: f.userconfig });
  expect(result.ok).toBe(false); expect(result.stderr).toContain('401');
  expect(requests.some(req => req.status === 401 && !req.authenticated)).toBe(true);
  expect(existsSync(f.receipt)).toBe(false);
}, 30_000);

it('still removes saved provider material renamed to an approved npm configuration key', async () => {
  fixture(); vi.stubEnv('O8_MASTER_KEY', randomBytes(32).toString('base64url'));
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const saved = randomBytes(24).toString('hex'); mutateProviderKey('OPENAI_API_KEY', { key: saved });
  vi.stubEnv('NPM_CONFIG_CACHE', saved);
  try {
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(String("NPM_CONFIG_CACHE" in process.env))'], { encoding: 'utf8' })).toBe('false');
  } finally { mutateProviderKey('OPENAI_API_KEY', { key: null }); }
});
