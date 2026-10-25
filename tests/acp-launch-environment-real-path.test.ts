import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '', failRename: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: string, to: string) => {
    if (fixture.failRename && to.endsWith('local-acp.json')) throw new Error('Fixture connection rename failed');
    return fs.renameSync(from, to);
  } };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.dir }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: vi.fn() }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('No fixture tools'); } }));
vi.mock('@/lib/providers/child-process', async original => ({ ...await original<typeof import('@/lib/providers/child-process')>(),
  execKeychainCommand: () => { throw Object.assign(new Error('Fixture Keychain entry absent'), { status: 44 }); },
}));
fixture.dir = mkdtempSync(join(tmpdir(), 'o8-acp-environment-'));
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
vi.stubEnv('O8_ACP_COMMAND', '');
vi.stubEnv('ACP_REGION', 'ambient');
vi.stubEnv('OPENROUTER_API_KEY', '');
const { GET, POST } = await import('@/app/api/runtime/acp-connection/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { acpBackend, makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');
const { localAcpProcessLaunch } = await import('@/lib/acp/local-connection');
const { AcpClient } = await import('@/lib/acp/client');
const peer = join(fixture.dir, 'peer.cjs');
writeFileSync(peer, `
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); let result={};
 if(r.method==='initialize') result={protocolVersion:1};
 if(r.method==='session/new') result={sessionId:String(process.pid),configOptions:[]};
 if(r.method==='session/prompt') {
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:String(process.pid),update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({region:process.env.ACP_REGION,token:process.env.ACP_TOKEN||null})}}}});
  result={stopReason:'end_turn'};
 }
 if(r.id!=null) send({jsonrpc:'2.0',id:r.id,result});
});
setTimeout(()=>process.exit(0),5000).unref();
`);
const connection = { name: 'Fixture', command: process.execPath, args: [peer], useOpenRouter: false };
const request = (body?: unknown, token = getOrCreateWsToken()) => new NextRequest('http://fixture.invalid/api/runtime/acp-connection?environment=1', {
  method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
});
async function inventory() { const r = await GET(request()); expect(r.status).toBe(200); return r.json(); }
async function save(variables: unknown, binding?: { connectionId: string; revision: number }) {
  const current = binding ?? await inventory();
  return POST(request({ environment: { connectionId: current.connectionId, revision: current.revision, variables } }));
}
async function turn(threadId: string, backend = acpBackend) {
  let text = '';
  const errors: string[] = [];
  await backend.sendTurn(fixture.dir, 'fixture', event => {
    if (event.type === 'text') text += event.text;
    if (event.type === 'error') errors.push(event.error);
  }, { threadId });
  expect(errors).toEqual([]);
  return JSON.parse(text);
}
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(fixture.dir, { recursive: true, force: true }); });

it('saves masked connection secrets and refreshes only new selected ACP processes', async () => {
  expect((await POST(request({ connection }))).status).toBe(200);
  const initial = await inventory();
  const response = await save([{ name: 'ACP_REGION', secret: false, value: 'first' }, { name: 'ACP_TOKEN', secret: true, value: 'synthetic-connection-secret' }]);
  expect(response.status).toBe(200);
  const masked = await response.text();
  expect(masked).not.toContain('synthetic-connection-secret');
  expect(await inventory()).toMatchObject({ variables: [{ name: 'ACP_REGION', secret: false, value: 'first' }, { name: 'ACP_TOKEN', secret: true, configured: true }] });
  const db = new Database(join(fixture.dir, 'acp-environment.sqlite'), { readonly: true });
  try {
    expect(JSON.stringify(db.prepare('SELECT * FROM configuration').all())).not.toContain('synthetic-connection-secret');
    expect(JSON.stringify(db.prepare('SELECT * FROM credentials').all())).not.toContain('synthetic-connection-secret');
  } finally { db.close(); }
  expect(readFileSync(join(fixture.dir, 'local-acp.json'), 'utf8')).not.toContain('synthetic-connection-secret');
  expect(await turn('resident')).toEqual({ region: 'first', token: 'synthetic-connection-secret' });
  const prepared = localAcpProcessLaunch()!;
  expect((await save([{ name: 'ACP_REGION', secret: false, value: 'second' }, { name: 'ACP_TOKEN', secret: true }])).status).toBe(200);
  expect(() => new AcpClient({ runtimeId: 'acp', cwd: fixture.dir, ...prepared })).toThrow(/environment changed/i);
  const databasePath = join(fixture.dir, 'acp-environment.sqlite');
  const { renameSync } = await import('node:fs');
  renameSync(databasePath, `${databasePath}.held`);
  writeFileSync(databasePath, 'unavailable fixture database');
  try {
    expect(await turn('resident')).toEqual({ region: 'first', token: 'synthetic-connection-secret' });
    await expect(turn('unavailable')).rejects.toThrow();
  } finally { rmSync(databasePath); renameSync(`${databasePath}.held`, databasePath); }
  expect(await turn('resident')).toEqual({ region: 'first', token: 'synthetic-connection-secret' });
  expect(await turn('new')).toEqual({ region: 'second', token: 'synthetic-connection-secret' });
  const other = makeAcpBackend({ id: 'opencode', label: 'Other fixture', resolveLaunch: () => connection });
  expect(await turn('other', other)).toEqual({ region: 'ambient', token: null });
  expect((await save([], initial)).status).toBe(409);
  expect((await save([])).status).toBe(200);
  expect((await inventory()).variables).toEqual([]);
  expect(await turn('removed')).toEqual({ region: 'ambient', token: null });
});

it('binds edits to the current connection and preserves secrets on unavailable encryption', async () => {
  const binding = await inventory();
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-retained-secret' }])).status).toBe(200);
  vi.stubEnv('O8_MASTER_KEY', 'invalid');
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-replacement' }])).status).toBe(400);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
  expect(await turn('after-failed-save')).toEqual({ region: 'ambient', token: 'synthetic-retained-secret' });
  expect((await POST(request({ connection: { ...connection, args: [peer, 'another-connection'] } }))).status).toBe(200);
  expect((await save([], binding)).status).toBe(409);
  expect((await inventory()).variables).toEqual([]);
  expect(await turn('different-connection')).toEqual({ region: 'ambient', token: null });
  const savedBinding = await inventory();
  vi.stubEnv('O8_ACP_COMMAND', process.execPath);
  expect((await save([], savedBinding)).status).toBe(409);
  vi.stubEnv('O8_ACP_COMMAND', '');
});

it('refuses unauthorized and reserved environment mutations without changing persisted entries', async () => {
  expect((await GET(request(undefined, 'wrong-token'))).status).toBe(401);
  expect((await POST(request({ environment: {} }, 'worker-token'))).status).toBe(401);
  const before = await inventory();
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'O8_API_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'LD_PRELOAD', 'GIT_CONFIG_COUNT', '__proto__', 'bad-name']) {
    expect((await save([{ name, secret: false, value: 'value' }])).status, name).toBe(400);
  }
  expect((await save([{ name: 'ACP_TOKEN', secret: false, value: 'must-be-secret' }])).status).toBe(400);
  expect(await inventory()).toEqual(before);
  expect((await POST(request({ connection: null }))).status).toBe(200);
  expect((await GET(request())).status).toBe(409);
});

it('preserves the original connection and credentials when disconnect cannot commit its file', async () => {
  expect((await POST(request({ connection }))).status).toBe(200);
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-disconnect-secret' }])).status).toBe(200);
  const original = await inventory();
  fixture.failRename = true;
  try { expect((await POST(request({ connection: null }))).status).toBe(400); }
  finally { fixture.failRename = false; }
  expect(await inventory()).toEqual(original);
  expect(localAcpProcessLaunch()?.env?.ACP_TOKEN).toBe('synthetic-disconnect-secret');
  expect((await POST(request({ connection: null }))).status).toBe(200);
  const db = new Database(join(fixture.dir, 'acp-environment.sqlite'), { readonly: true });
  try { expect(db.prepare('SELECT * FROM credentials WHERE connection_id = ?').all(original.connectionId)).toEqual([]); }
  finally { db.close(); }
});

it('never creates a replacement key for cache-cold ACP credentials with a missing backing key', async () => {
  expect((await POST(request({ connection }))).status).toBe(200);
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-key-recovery' }])).status).toBe(200);
  vi.resetModules();
  vi.stubEnv('O8_MASTER_KEY', '');
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
  const fresh = await import('@/app/api/runtime/acp-connection/route');
  const binding = await (await fresh.GET(request())).json();
  expect(existsSync(join(fixture.dir, 'master-key'))).toBe(false);
  const response = await fresh.POST(request({ environment: { ...binding, variables: [{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-unwanted-replacement' }] } }));
  expect(response.status).toBe(400);
  expect(existsSync(join(fixture.dir, 'master-key'))).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  const provider = await import('@/app/api/v2/keys/route');
  const savedProvider = await provider.POST(new NextRequest('http://localhost/api/v2/keys', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ provider: 'openrouter', key: 'synthetic-provider-key' }),
  }));
  expect(savedProvider.status).toBe(503);
  expect(existsSync(join(fixture.dir, 'master-key'))).toBe(false);
  const launch = await import('@/lib/acp/local-connection');
  expect(() => launch.localAcpProcessLaunch()).toThrow(/credential|key/i);
  expect(existsSync(join(fixture.dir, 'master-key'))).toBe(false);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
  expect(launch.localAcpProcessLaunch()?.env?.ACP_TOKEN).toBe('synthetic-key-recovery');
  } finally { Object.defineProperty(process, 'platform', originalPlatform); }
});
