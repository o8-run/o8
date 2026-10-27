import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { format } from 'node:util';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import { defineAcpRedactionMatrix } from './fixtures/acp-redaction-matrix';

const fixture = vi.hoisted(() => ({ dir: '', failRename: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: string, to: string) => {
    if (fixture.failRename && to.endsWith('local-acp.json')) throw new Error('Fixture connection rename failed');
    return fs.renameSync(from, to);
  } };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.dir }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: vi.fn() }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('No fixture tools'); } }));
// Keep application process wrappers real across the cache-cold module reset.
vi.mock('node:child_process', async original => {
  const childProcess = await original<typeof import('node:child_process')>();
  return { ...childProcess, execFileSync: (file: string, ...args: unknown[]) => {
    if (file === '/usr/bin/security') throw Object.assign(new Error('Fixture Keychain entry absent'), { status: 44 });
    return Reflect.apply(childProcess.execFileSync, childProcess, [file, ...args]);
  } };
});
fixture.dir = mkdtempSync(join(tmpdir(), 'o8-acp-environment-'));
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
vi.stubEnv('O8_ACP_COMMAND', '');
vi.stubEnv('O8_WORKER_ENV_INHERIT', '');
vi.stubEnv('O8_WORKER_ENV_ALLOW', '');
// ACP_REGION is outside the ambient allowlist; only saved connection overrides may supply it.
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
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:String(process.pid),update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({region:process.env.ACP_REGION,token:process.env.ACP_TOKEN?require('node:crypto').createHash('sha256').update(process.env.ACP_TOKEN).digest('hex'):null})}}}});
  result={stopReason:'end_turn'};
 }
 if(r.id!=null) send({jsonrpc:'2.0',id:r.id,result});
});
setTimeout(()=>process.exit(0),5000).unref();
`);
const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex');
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

defineAcpRedactionMatrix({ dir: fixture.dir, token: getOrCreateWsToken,
  configure: async (args, values) => {
    expect((await POST(request({ connection: { ...connection, args } }))).status).toBe(200);
    expect((await save(values.map((value, index) => ({ name: `ACP_CANARY_${index}`, secret: true, value })))).status).toBe(200);
  },
  client: options => new AcpClient({runtimeId: 'acp', cwd: fixture.dir, ...localAcpProcessLaunch()!, ...options}),
  turn: async id => {
    const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
    vi.mocked(publishRealtimeMutation).mockClear();
    const events: Array<{type: string; text?: string; error?: string}> = [];
    await acpBackend.sendTurn(fixture.dir, 'Fixture generated matrix.', event => events.push(event), {threadId: `matrix-${id}`});
    return {events, lifecycle: vi.mocked(publishRealtimeMutation).mock.calls};
  },
});

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
  expect(await turn('resident')).toEqual({ region: 'first', token: tokenDigest('synthetic-connection-secret') });
  const prepared = localAcpProcessLaunch()!;
  expect((await save([{ name: 'ACP_REGION', secret: false, value: 'second' }, { name: 'ACP_TOKEN', secret: true }])).status).toBe(200);
  expect(() => new AcpClient({ runtimeId: 'acp', cwd: fixture.dir, ...prepared })).toThrow(/environment changed/i);
  const databasePath = join(fixture.dir, 'acp-environment.sqlite');
  const { renameSync } = await import('node:fs');
  renameSync(databasePath, `${databasePath}.held`);
  writeFileSync(databasePath, 'unavailable fixture database');
  try {
    expect(await turn('resident')).toEqual({ region: 'first', token: tokenDigest('synthetic-connection-secret') });
    await expect(turn('unavailable')).rejects.toThrow();
  } finally { rmSync(databasePath); renameSync(`${databasePath}.held`, databasePath); }
  expect(await turn('resident')).toEqual({ region: 'first', token: tokenDigest('synthetic-connection-secret') });
  expect(await turn('new')).toEqual({ region: 'second', token: tokenDigest('synthetic-connection-secret') });
  const other = makeAcpBackend({ id: 'opencode', label: 'Other fixture', resolveLaunch: () => connection });
  expect(await turn('other', other)).toStrictEqual({ token: null });
  expect((await save([], initial)).status).toBe(409);
  expect((await save([])).status).toBe(200);
  expect((await inventory()).variables).toEqual([]);
  expect(await turn('removed')).toStrictEqual({ token: null });
});

it('binds edits to the current connection and preserves secrets on unavailable encryption', async () => {
  const binding = await inventory();
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-retained-secret' }])).status).toBe(200);
  vi.stubEnv('O8_MASTER_KEY', 'invalid');
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-replacement' }])).status).toBe(400);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
  expect(await turn('after-failed-save')).toStrictEqual({ token: tokenDigest('synthetic-retained-secret') });
  expect((await POST(request({ connection: { ...connection, args: [peer, 'another-connection'] } }))).status).toBe(200);
  expect((await save([], binding)).status).toBe(409);
  expect((await inventory()).variables).toEqual([]);
  expect(await turn('different-connection')).toStrictEqual({ token: null });
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

it.each(['initialize', 'session/prompt'] as const)('redacts saved secret echoes from Check connection, turn and lifecycle outputs at %s', async (failure) => {
  const secrets = ['synthetic-echo-canary', 'synthetic-echo-canary::extended', 'synthetic-quoted-"canary"\nvalue'];
  const failingPeer = join(fixture.dir, `echo-${failure.replace('/', '-')}.cjs`);
  writeFileSync(failingPeer, String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
 const r = JSON.parse(line);
 if (r.method === process.argv[2]) {
   const values = [process.env.ACP_TOKEN, process.env.ACP_EXTRA, process.env.ACP_LABEL];
   const diagnostic = 'Fixture stderr: '+values.join(' / ');
   process.stderr.write(diagnostic.slice(0, 23));
   await new Promise(resolve => setTimeout(resolve, 10));
   process.stderr.write(diagnostic.slice(23));
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'echo-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:values.join(' / ')}}}});
   send({jsonrpc:'2.0', id:r.id, error:{code:-32000, message:'Fixture diagnostic: '+values.join(' / ')+' / '+values[0], data:{[values[0]]:'Rejected input',nested:values}}});
   return;
 }
 let result = r.method === 'initialize' ? {protocolVersion:1} : r.method === 'session/new' ? {sessionId:'echo-session',configOptions:[]} : {};
 if (r.id != null) send({jsonrpc:'2.0', id:r.id, result});
});
setTimeout(() => process.exit(0), 5000).unref();
`);
  expect((await POST(request({ connection: { ...connection, args: [failingPeer, failure] } }))).status).toBe(200);
  expect((await save(secrets.map((value, index) => ({ name: ['ACP_TOKEN', 'ACP_EXTRA', 'ACP_LABEL'][index], secret: true, value })))).status).toBe(200);
  const { GET: checkConnection } = await import('@/app/api/orchestrator/backend-models/route');
  if (failure === 'initialize') {
    const response = await checkConnection(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&refresh=1&repoPath=${encodeURIComponent(fixture.dir)}`, {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    const body = await response.text();
    expect(body).toContain('Fixture diagnostic:');
    for (const secret of secrets) expect.soft(body.includes(secret) || body.includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
  }
  const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
  vi.mocked(publishRealtimeMutation).mockClear();
  const events: unknown[] = [];
  await acpBackend.sendTurn(fixture.dir, 'Synthetic echo failure.', event => events.push(event), { threadId: `echo-${failure}` });
  const output = JSON.stringify(events);
  const lifecycle = JSON.stringify(vi.mocked(publishRealtimeMutation).mock.calls);
  expect(output).toContain('Fixture diagnostic:'); expect(lifecycle).toContain('Fixture diagnostic:');
  for (const secret of secrets) {
    const encoded = JSON.stringify(secret).slice(1, -1);
    expect.soft(output.includes(encoded)).toBe(false);
    expect.soft(lifecycle.includes(encoded)).toBe(false);
  }
  // A resident process retains its original credentials and redaction even if
  // the saved variables are removed before it reports a diagnostic.
  const stderr: string[] = []; const notifications: unknown[] = [];
  let closed!: () => void;
  const exit = new Promise<void>(resolve => { closed = resolve; });
  const resident = new AcpClient({ runtimeId: 'acp', cwd: fixture.dir, ...localAcpProcessLaunch()!,
    onStderr: chunk => stderr.push(chunk), onNotification: notification => notifications.push(notification), onExit: closed });
  expect((await save([])).status).toBe(200);
  let diagnostic: { message?: string; data?: unknown } | undefined;
  try {
    await resident.initialize();
    const session = await resident.newSession(fixture.dir, []);
    await resident.prompt(session.sessionId, 'Synthetic resident failure.');
  } catch (error) { diagnostic = error as typeof diagnostic; }
  finally { resident.kill(); await exit; }
  expect(diagnostic?.message).toContain('Fixture diagnostic:');
  expect(stderr.join('')).toContain('Fixture stderr:');
  expect(notifications.length).toBeGreaterThan(0);
  for (const secret of secrets) {
    expect(diagnostic?.message?.includes(secret)).toBe(false);
    expect(JSON.stringify(diagnostic?.data).includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
    expect(JSON.stringify(notifications).includes(JSON.stringify(secret).slice(1, -1))).toBe(false);
    expect(stderr.join('').includes(secret)).toBe(false);
  }
});

const echoEncodings = ['json', 'json-unicode', 'json-ascii-slash', 'json-html-slash', 'url', 'url-lower', 'form', 'base64', 'base64url'] as const;
const generatorPath = join(process.cwd(), 'tests/fixtures/acp-encoding-cases.cjs');
const generated = createRequire(import.meta.url)(generatorPath) as {
  recipes: Array<{ name: string; steps: string[] }>; encode(value: string, steps: string[]): string;
};
const echoCases = [...echoEncodings.map(encoding => ({ encoding, steps: null as string[] | null })),
  ...generated.recipes.map((recipe, index) => ({ encoding: `generated-${index}`, steps: recipe.steps }))];
it.each(echoCases)('redacts $encoding encoded canaries through Check connection, turn output/errors, lifecycle errors and stderr', async ({ encoding, steps }) => {
  const paths = ['CHECK', 'OUTPUT', 'ERROR', 'LIFECYCLE', 'STDERR'] as const;
  const secrets = Object.fromEntries(paths.map(name => [name, `synthetic-${encoding}-${name}:"\\\n\t\u0001 café/<> &?+=${steps?.includes('replacement-prefix') ? '\uFFFD' : ''}`]));
  const encode = (value: string) => {
    if (steps) return generated.encode(value, steps);
    if (encoding === 'json') return JSON.stringify(value).slice(1, -1);
    if (encoding === 'json-unicode') return [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    if (encoding === 'json-ascii-slash' || encoding === 'json-html-slash') return JSON.stringify(value).slice(1, -1)
      .replace(encoding === 'json-ascii-slash' ? /[\u007f-\uffff]/g : /[<>&\u2028\u2029]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/\//g, '\\/');
    if (encoding === 'url') return encodeURIComponent(value);
    if (encoding === 'url-lower') return encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, match => match.toLowerCase());
    if (encoding === 'form') return new URLSearchParams({ token: value }).toString().slice(6);
    return Buffer.from(value).toString(encoding as 'base64' | 'base64url');
  };
  const encodedPeer = join(fixture.dir, `encoded-${encoding}.cjs`);
  writeFileSync(encodedPeer, String.raw`
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const encoding = process.argv[3];
const steps = JSON.parse(process.argv[4]);
const generated = require(${JSON.stringify(generatorPath)});
const receipt = ${JSON.stringify(join(fixture.dir, 'encoded-seen-'))} + encoding;
const encode = value => {
 if(steps) return generated.encode(value,steps);
 if(encoding==='json') return JSON.stringify({token:value});
 if(encoding==='json-unicode') return [...value].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 if(encoding==='json-ascii-slash'||encoding==='json-html-slash') return JSON.stringify({token:value})
  .replace(encoding==='json-ascii-slash'?/[\u007f-\uffff]/g:/[<>&\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).replace(/\//g,'\\/');
 if(encoding==='url') return encodeURIComponent(value);
 if(encoding==='url-lower') return encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, match=>match.toLowerCase());
 if(encoding==='form') return new URLSearchParams({token:value}).toString().slice(6);
 return Buffer.from(value).toString(encoding);
};
require('node:readline').createInterface({input:process.stdin}).on('line', async line=>{
 const r=JSON.parse(line); let result={};
 require('node:fs').appendFileSync(receipt, r.method+'\n');
 if(r.method==='initialize') {
  if(process.argv[2]==='check') return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Fixture encoded check: '+encode(process.env.ACP_CHECK_TOKEN)}});
  result={protocolVersion:1};
 }
 if(r.method==='session/new') result={sessionId:'encoded-session',configOptions:[]};
 if(r.method==='session/prompt') {
  const output=encode(process.env.ACP_OUTPUT_TOKEN);
  for(const kind of ['agent_message_chunk','agent_thought_chunk']) {
   const boundary = steps?.includes('interrupted') ? 1 : Math.floor(output.length/2);
   for(const text of ['Fixture encoded output: ', output.slice(0,boundary), output.slice(boundary), '!']) {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'encoded-session',update:{sessionUpdate:kind,content:{type:'text',text}}}});
    if(steps?.includes('interrupted') && text===output.slice(0,boundary))
     send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'encoded-session',update:{sessionUpdate:'tool_call',toolCallId:'interrupted',title:'Fixture tool',rawInput:{}}}});
   }
  }
  const diagnostic='Fixture encoded stderr: '+encode(process.env.ACP_STDERR_TOKEN);
  process.stderr.write(diagnostic.slice(0,diagnostic.length-3));
  await new Promise(resolve=>setTimeout(resolve,10)); process.stderr.write(diagnostic.slice(-3));
  return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Fixture encoded turn: '+encode(process.env.ACP_ERROR_TOKEN)+' / '+encode(process.env.ACP_LIFECYCLE_TOKEN),data:{nested:encode(process.env.ACP_ERROR_TOKEN),[encode(process.env.ACP_LIFECYCLE_TOKEN)]:'Fixture encoded data'}}});
 }
 if(r.id!=null) send({jsonrpc:'2.0',id:r.id,result});
});
setTimeout(()=>process.exit(0),5000).unref();
`);
  const configure = async (mode: string) => {
    expect((await POST(request({ connection: { ...connection, args: [encodedPeer, mode, encoding, JSON.stringify(steps)] } }))).status).toBe(200);
    expect((await save(paths.map(name => ({ name: `ACP_${name}_TOKEN`, secret: true, value: secrets[name] })))).status).toBe(200);
  };
  const strings = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object'
    ? Object.entries(value).map(([key, item]) => key + '\n' + strings(item)).join('\n') : '';
  const assertMasked = (value: unknown, names: typeof paths[number][]) => {
    const exposed = strings(value);
    for (const name of names) {
      expect.soft(exposed.includes(encode(secrets[name])), `${encoding} ${name} encoded canary`).toBe(false);
      expect.soft(exposed.includes(secrets[name]), `${encoding} ${name} raw canary`).toBe(false);
    }
    expect.soft(exposed).toContain('[redacted]');
  };
  const assertContext = (value: unknown, prefix: string) => {
    // Ambiguous decoding deliberately replaces the complete value. The peer's
    // independent receipt proves that the real handler reached its echo path.
    expect(strings(value).includes(prefix) || strings(value).includes('[redacted]')).toBe(true);
  };
  await configure('check');
  const { GET: checkConnection } = await import('@/app/api/orchestrator/backend-models/route');
  const checked = await checkConnection(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&refresh=1&repoPath=${encodeURIComponent(fixture.dir)}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  const checkBody = await checked.json(); assertContext(checkBody, 'Fixture encoded check:');
  expect(readFileSync(join(fixture.dir, `encoded-seen-${encoding}`), 'utf8')).toContain('initialize');
  assertMasked(checkBody, ['CHECK']);
  await configure('turn');
  const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
  vi.mocked(publishRealtimeMutation).mockClear();
  const events: Array<{ type: string; text?: string; error?: string }> = [];
  await acpBackend.sendTurn(fixture.dir, 'Synthetic encoded echo.', event => events.push(event), { threadId: `encoded-${encoding}` });
  for (const type of ['text', 'thinking']) {
    const output = events.filter(event => event.type === type).map(event => event.text).join('');
    assertContext(output, 'Fixture encoded output:'); assertMasked(output, ['OUTPUT']);
  }
  expect(readFileSync(join(fixture.dir, `encoded-seen-${encoding}`), 'utf8')).toContain('session/prompt');
  const errors = events.filter(event => event.type === 'error'); assertContext(errors, 'Fixture encoded turn:');
  assertMasked(errors, ['ERROR', 'LIFECYCLE']);
  const lifecycle = vi.mocked(publishRealtimeMutation).mock.calls;
  assertContext(lifecycle, 'Fixture encoded turn:'); assertMasked(lifecycle, ['ERROR', 'LIFECYCLE']);
  const stderr: string[] = []; const notifications: unknown[] = [];
  let closed!: () => void; const exited = new Promise<void>(resolve => { closed = resolve; });
  const resident = new AcpClient({ runtimeId: 'acp', cwd: fixture.dir, ...localAcpProcessLaunch()!,
    onStderr: chunk => stderr.push(chunk), onNotification: notification => notifications.push(notification), onExit: closed });
  expect((await save([])).status).toBe(200);
  let diagnostic: unknown;
  try { await resident.initialize(); const session = await resident.newSession(fixture.dir, []); await resident.prompt(session.sessionId, 'Synthetic encoded resident echo.'); }
  catch (error) { const failure = error as { message: string; data?: unknown }; diagnostic = { message: failure.message, data: failure.data }; }
  finally { resident.kill(); await exited; }
  assertMasked(diagnostic, ['ERROR', 'LIFECYCLE']); assertMasked(notifications, ['OUTPUT']);
  expect(readFileSync(join(fixture.dir, `encoded-seen-${encoding}`), 'utf8').match(/session\/prompt/g)?.length).toBeGreaterThanOrEqual(2);
  assertContext(stderr.join(''), 'Fixture encoded stderr:'); assertMasked(stderr.join(''), ['STDERR']);
}, 120_000);

it.each(['synthetic-stream-canary', 'text', 'model'])('keeps schemas and redacts split ACP text/thinking for saved value %s', async (secret) => {
  const streamPeer = join(fixture.dir, 'stream-peer.cjs');
  writeFileSync(streamPeer, String.raw`
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); let result={};
 if(r.method==='initialize') result={protocolVersion:1};
 if(r.method==='session/new') result={sessionId:'stream-session',configOptions:[{id:'model',type:'select',currentValue:'fixture',options:[{value:'fixture'}]}]};
 if(r.method==='session/prompt') {
   const secret=process.env.ACP_TOKEN;
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'stream-session',update:{sessionUpdate:'tool_call',toolCallId:'fixture-tool',title:'Fixture tool',rawInput:{[secret]:'Rejected input'}}}});
   for(const kind of ['agent_message_chunk','agent_thought_chunk']) {
     for(const piece of ['Visible reply: ',secret.slice(0,Math.ceil(secret.length/2)),secret.slice(Math.ceil(secret.length/2)),'!'])
       send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'stream-session',update:{sessionUpdate:kind,content:{type:'text',text:piece}}}});
   }
   result={stopReason:'end_turn'};
 }
 if(r.id!=null) send({jsonrpc:'2.0',id:r.id,result});
});
setTimeout(()=>process.exit(0),5000).unref();
`);
  expect((await POST(request({ connection: { ...connection, args: [streamPeer] } }))).status).toBe(200);
  expect((await save([{ name: 'ACP_TOKEN', secret: true, value: secret }])).status).toBe(200);
  const { GET: checkConnection } = await import('@/app/api/orchestrator/backend-models/route');
  const response = await checkConnection(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&refresh=1&repoPath=${encodeURIComponent(fixture.dir)}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(await response.json()).toMatchObject({ total: 1, currentModel: 'fixture' });
  const cachePath = join(fixture.dir, 'acp-models', 'acp.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  cache.models[0].name = `Diagnostic ${secret}`;
  writeFileSync(cachePath, JSON.stringify(cache));
  const cached = await checkConnection(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&repoPath=${encodeURIComponent(fixture.dir)}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  const cachedBody = await cached.json();
  expect.soft(cachedBody.groups[0].models[0].label).toBe('Diagnostic [redacted]');
  const events: Array<{ type: string; text?: string }> = [];
  await acpBackend.sendTurn(fixture.dir, 'Synthetic split echo.', event => events.push(event), { threadId: `split-${secret}` });
  for (const type of ['text', 'thinking']) {
    const text = events.filter(event => event.type === type).map(event => event.text).join('');
    expect(text).toBe('Visible reply: [redacted]!');
    expect(text.includes(secret)).toBe(false);
  }
  expect(events.some(event => event.type === 'done')).toBe(true);
  expect((events.find(event => event.type === 'tool_use') as { input?: unknown })?.input).toEqual({ '[redacted]': 'Rejected input' });
  const { acpBackendModels } = await import('@/lib/lane/orchestrator-backends/acp');
  expect(acpBackendModels('acp')).toEqual([{ value: 'fixture', name: undefined }]);
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


it('keeps a secret legacy profile selector out of Check connection responses and server logs', async () => {
  expect((await POST(request({ connection }))).status).toBe(200);
  const profile = join(fixture.dir, 'synthetic-private-legacy-selector');
  mkdirSync(profile, { recursive: true });
  const secret = realpathSync(profile);
  expect((await save([{ name: 'HERMES_HOME', secret: true, value: secret }])).status).toBe(200);
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { encryptValueSync } = await import('@/lib/db/master-key');
  const providerValue = 'synthetic-contaminating-provider-material';
  mutateProviderKey('OPENAI_API_KEY', { key: providerValue });
  const file = join(secret, 'auth.json');
  writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: providerValue }));
  const payload = encryptValueSync(JSON.stringify({ owner: 'o8', runtime: 'hermes', path: file, contents: '{}' }));
  const ledger = join(fixture.dir, 'owned-credential-artifacts.json');
  writeFileSync(ledger, JSON.stringify([{ owner: 'o8', runtime: 'hermes', path: file, replacement: `enc:${payload.iv}:${payload.ciphertext}` }]));
  const logs: string[] = [];
  const spies = (['warn', 'error', 'info', 'log', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(format(...args)); }));
  try {
    const { GET: checkConnection } = await import('@/app/api/orchestrator/backend-models/route');
    const response = await checkConnection(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&refresh=1&repoPath=${encodeURIComponent(fixture.dir)}`, {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Legacy o8 file');
    expect(body).toContain('#4340');
    expect.soft(body).not.toContain(secret);
    expect.soft(body).not.toContain(providerValue);
    expect(logs.some(line => line.includes('Legacy o8 runtime config'))).toBe(true);
    expect.soft(logs.join('\n')).not.toContain(secret);
    expect.soft(logs.join('\n')).not.toContain(providerValue);
    expect(readFileSync(file, 'utf8')).toContain(providerValue);
  } finally {
    spies.forEach(spy => spy.mockRestore());
    rmSync(ledger);
  }
});

it.each(['HERMES_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'])('keeps secret-bearing %s out of a silent ACP child receipt', async name => {
  const silent = join(fixture.dir, 'silent-profile.cjs');
  writeFileSync(silent, 'process.stdin.resume();');
  expect((await POST(request({ connection: { ...connection, args: [silent] } }))).status).toBe(200);
  const value = join(fixture.dir, `synthetic-profile-canary-${name}`);
  expect((await save([{ name, secret: true, value }])).status).toBe(200);
  const client = new AcpClient({runtimeId:'acp',cwd:fixture.dir,...localAcpProcessLaunch()!});
  try {
    const directory = join(fixture.dir, 'runtime-profile-processes');
    const records = readdirSync(directory).map(file => readFileSync(join(directory,file),'utf8'));
    const selected = records.map(raw=>JSON.parse(raw)).find(record=>record.pid===client.pid);
    expect(selected).toBeDefined();
    expect.soft(JSON.stringify(selected).includes(value)).toBe(false);
    expect(selected.redactedEnvironment).toContainEqual({name,value:'[redacted]'});
  } finally { client.kill(); }
});

it('scrubs a legacy secret-bearing profile receipt at real child admission, even for a silent child', async () => {
  expect((await POST(request({connection}))).status).toBe(200);
  const value = join(fixture.dir,'synthetic-legacy-profile-canary');
  expect((await save([{name:'HERMES_HOME',secret:true,value}])).status).toBe(200);
  const directory=join(fixture.dir,'runtime-profile-processes');mkdirSync(directory,{recursive:true});
  const file=join(directory,'legacy-profile-canary.json');
  const {probeMetadataLockProcessIdentitySync}=await import('@/lib/worktree/metadata-lock-process-identity');
  const probe=probeMetadataLockProcessIdentitySync(process.pid);expect(probe.state).toBe('live');
  writeFileSync(file,JSON.stringify({version:1,owner:'o8',runtimeId:'acp',pid:process.pid,processIdentity:probe.state==='live'?probe.identity:null,profiles:[value],apiAllowedAtLaunch:true}));
  let client:InstanceType<typeof AcpClient>|undefined;let failure:unknown;
  try { client=new AcpClient({runtimeId:'acp',cwd:fixture.dir,...localAcpProcessLaunch()!}); } catch(error){failure=error;}
  finally {client?.kill();}
  expect.soft(String(failure)).not.toContain(value);
  expect.soft(readFileSync(file,'utf8')).not.toContain(value);
  expect(failure).toBeInstanceOf(Error);
  vi.resetModules();
  const {assertNoRecordedApiProfileChild:cacheColdAdmission}=await import('@/lib/providers/runtime-profile-processes');
  expect(()=>cacheColdAdmission([fixture.dir])).toThrow(/API.*still running/i);
  expect(readFileSync(file,'utf8')).not.toContain(value);
  rmSync(file);
});
