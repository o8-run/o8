import Database from 'better-sqlite3';
import { ORCHESTRATOR_BACKEND_IDS } from '../src/lib/lane/orchestrator-backends/types';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';
const targetDir = join(process.cwd(),'crates/o8d/target/session-reads'); const binary = process.env.O8D_TEST_BINARY ?? join(targetDir,'debug/o8d');
beforeAll(async () => { if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo',['test','--locked','--manifest-path','crates/o8d/Cargo.toml','--features','experimental-session-reads','--jobs','1','--target-dir',targetDir,'--test','composer_queue_reads']); },900_000);
const route = '/api/orchestrator/composer-queue';
const pathFor = (repoPath: string,threadId: string,extra: Record<string,string> = {}) => route + '?' + new URLSearchParams({ repoPath,threadId,...extra });
const payload = (backend = 'pi',collide = false,mode = 'single') => ({ text: 'queued text',wireMessage: 'wire text',images: [],routing: { backend,model: 'fixture',effort: 'high',permissionMode: 'full',mode,pickedMode: 'solo',collide } });
async function snapshot(response: Response) { return { status: response.status,cache: response.headers.get('cache-control'),type: response.headers.get('content-type'),body: await response.json() as Record<string,unknown> }; }
async function typescript(origin: string,token: string,path: string) {
  return new Promise<Awaited<ReturnType<typeof snapshot>>>((resolve,reject) => { const req = httpRequest(origin + path,{ headers: { authorization: `Bearer ${token}`,'transfer-encoding': 'chunked' } },res => {
    expect(res.headers['x-o8d-native']).toBeUndefined(); const chunks: Buffer[] = []; res.on('data',chunk => chunks.push(Buffer.from(chunk))); res.on('end',() => resolve({ status: res.statusCode!,cache: res.headers['cache-control'] ? String(res.headers['cache-control']) : null,type: res.headers['content-type'] ? String(res.headers['content-type']) : null,body: JSON.parse(Buffer.concat(chunks).toString()) })); res.once('error',reject);
  }); req.once('error',reject); req.end(); });
}
function seedRows(directory: string) {
  const repo = join(directory,'fixture-repo'); const history = join(directory,'chat-history'); mkdirSync(history,{ recursive: true });
  for (const id of ['thoughts-queue','thoughts-empty','thoughts-bad-json','thoughts-bad-receipt','thoughts-grant-limit','thoughts-unknown-state','thoughts-write','thoughts-network']) writeFileSync(join(history,id + '.json'),JSON.stringify({ repoPath: repo,messages: id === 'thoughts-queue' ? [{ id: 'composer-steer-applied-fixture',role: 'user',content: 'canonical delivered text',steerAnchor: { messageId: 'anchor' } }] : [] }));
  const db = new Database(join(directory,'cortex-ide.db'));
  try {
    const add = (id: string,status: string,p: unknown,intent = 'send-next',thread = 'thoughts-queue') => db.prepare('INSERT INTO composer_send_queue (id,repo_path,thread_id,intent,payload_json,status,reason,created_at,updated_at,admitted_at) VALUES (?,?,?,?,?,?,?,100,200,?)').run(id,repo,thread,intent,JSON.stringify(p),status,status === 'held' ? 'Delivery failed' : null,status === 'applied' ? 150 : null);
    // A persisted held fence keeps the real heartbeat from dispatching fixture work.
    add('queue-fence','held',payload('claude'));
    add('write-fence','held',payload('claude'),'send-next','thoughts-write');
    db.prepare("UPDATE composer_send_queue SET updated_at = ? WHERE id IN ('queue-fence','write-fence')").run(Number.MAX_SAFE_INTEGER);
    add('queued-fixture','queued',{ ...payload(),text: readFileSync(join(directory,'ws-token'),'utf8').trim() });
    add('sending-fixture','dispatching',payload('claude'));
    add('failed-fixture','held',payload('pi',true,'fleet'));
    add('single-collide','queued',payload('pi',true,'single'));
    add('applied-fixture','applied',{ ...payload(),text: 'old compact text',wireMessage: '',deliveredMedia: [{ path: '/fixture/media.png' }] },'steer-now');
    add('cancelled-fixture','cancelled',payload()); add('delivered-next','applied',payload(),'send-next');
    add('malformed-payload','applied',payload(),'steer-now','thoughts-bad-json');
    add('malformed-receipt','applied',payload(),'steer-now','thoughts-bad-receipt');
    for (let index = 0; index < 33; index++) add('grant-limit-' + index,'applied',payload('future-' + index),'steer-now','thoughts-grant-limit');
    add('unknown-status','future-state',payload(),'send-next','thoughts-unknown-state');
    db.prepare('INSERT INTO bot_network_threads (thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES (?,?,NULL,?,?,?)').run('thoughts-network',repo,'[]','Network queue','2026-01-01T00:00:00.000Z');
  } finally { db.close(); }
  return repo;
}
it.skipIf(process.platform !== 'linux')('serves ordinary lists through the public socket with live capability grants and canonical Node mutations',async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'o8d-composer-queue-'))); let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory); const token = readFileSync(join(directory,'ws-token'),'utf8').trim(); const repo = seedRows(directory);
    const corruption = (enabled: boolean) => { const db = new Database(join(directory,'cortex-ide.db')); try {
      db.prepare('UPDATE composer_send_queue SET payload_json = ? WHERE id = ?').run(enabled ? '{bad' : JSON.stringify(payload()),'malformed-payload');
      db.prepare('UPDATE composer_send_queue SET payload_json = ? WHERE id = ?').run(JSON.stringify(enabled ? { ...payload(),deliveredMedia: '{bad' } : payload()),'malformed-receipt');
    } finally { db.close(); } };
    const restoreSending = () => { const db = new Database(join(directory,'cortex-ide.db')); try { db.prepare("UPDATE composer_send_queue SET status='dispatching',reason=NULL,updated_at=200 WHERE id='sending-fixture'").run(); } finally { db.close(); } };
    const reference = await startParityReference({ directory,nativeHttp: true,o8d: false }); await reference.stopNext(); server = { ...reference,origin: reference.url.replace('ws:','http:').replace('/ws','') };
    // Transport /health is available before recovery finishes. A stateful GET
    // waits for the real WS bootstrap before installing the active/error seed.
    await typescript(server.origin,token,pathFor(repo,'thoughts-empty'));
    restoreSending(); corruption(true);
    const call = (path: string,bearer = token) => fetch(server!.origin + path,{ headers: { authorization: `Bearer ${bearer}` } });
    const cases = [pathFor(repo,'thoughts-empty'),...['pi','claude','codex','collide','unknown',''].map(backend => pathFor(repo,'thoughts-queue',{ backend })),pathFor(repo + '/.','thoughts-queue'),pathFor(repo,'thoughts-grant-limit',{ backend: 'future-0' })];
    const expected = []; for (const path of cases) expected.push(await snapshot(await call(path)));
    expect(expected[0].body).toEqual({ items: [],canSteer: false,steerableIds: [] }); expect(expected[1].body.canSteer).toBe(true); expect(expected[2].body.canSteer).toBe(false);
    expect(expected[1].body.steerableIds).toEqual(['queued-fixture','single-collide','applied-fixture']);
    const applied = (expected[1].body.items as { id: string; payload: unknown }[]).find(row => row.id === 'applied-fixture'); expect(applied).toMatchObject({ payload: { text: 'canonical delivered text',images: [{ name: 'Image',dataUri: '/fixture/media.png' }] },steerAnchor: { messageId: 'anchor' } });
    const fallbackPaths = [pathFor(repo,'thoughts-network'),pathFor(repo,'thoughts-queue',{ id: 'visual-missing' }),pathFor(repo,'invalid-thread'),pathFor(repo,'thoughts-bad-json'),pathFor(repo,'thoughts-unknown-state'),pathFor(repo,'thoughts-bad-receipt')]; const fallbackExpected = []; for (const path of fallbackPaths) fallbackExpected.push(await snapshot(await call(path)));
    const denied = await snapshot(await call(cases[0],'')); expect(denied.status).toBe(401);
    corruption(false); await server.stop(); server = undefined;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'"; const stderr = join(directory,'daemon-stderr'); const wrapper = join(directory,'capture-o8d'); writeFileSync(wrapper,'#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderr) + '\n',{ mode: 0o700 }); server = await startSessionServer(directory,false,wrapper); await typescript(server.origin,token,pathFor(repo,'thoughts-empty')); restoreSending(); corruption(true);
    for (const [index,path] of cases.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'),'Native route was not reached: ' + path).toBe('1'); expect(firstDifference(expected[index],await snapshot(response)),path).toBeNull(); }
    for (const [index,path] of fallbackPaths.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'),path).toBeNull(); expect(await snapshot(response),path).toEqual(fallbackExpected[index]); }
    const refused = await call(cases[0],''); expect(refused.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(refused)).toEqual(denied);
    const write = (method: string,body: unknown) => fetch(server!.origin + route,{ method,headers: { authorization: `Bearer ${token}`,'content-type': 'application/json' },body: JSON.stringify(body) });
    const target = { repoPath: repo,threadId: 'thoughts-write',id: 'written-node-fixture' }; const post = await write('POST',{ ...target,intent: 'send-next',payload: payload('claude') }); expect(post.headers.get('x-o8d-native')).toBeNull(); expect(post.status).toBe(200); expect(await post.json()).toMatchObject({ item: { ...target,status: 'queued' } });
    const fresh = await call(pathFor(repo,'thoughts-write',{ backend: 'pi' })); expect(fresh.headers.get('x-o8d-native')).toBe('1'); expect((await fresh.json()).items.find((row: { id: string }) => row.id === target.id)).toMatchObject({ ...target,status: 'queued',intent: 'send-next' });
    const patch = await write('PATCH',target); expect(patch.headers.get('x-o8d-native')).toBeNull(); expect(await patch.json()).toMatchObject({ item: { intent: 'steer-now' } });
    const removed = await write('DELETE',target); expect(removed.headers.get('x-o8d-native')).toBeNull(); expect(await removed.json()).toEqual({ ok: true });
    expect((await (await call(pathFor(repo,'thoughts-write'))).json()).items.map((row: { id: string }) => row.id)).toEqual(['write-fence']);
    const connection = new Database(join(directory,'cortex-ide.db')); try {
      connection.exec('ALTER TABLE composer_send_queue RENAME COLUMN payload_json TO unavailable_payload_json'); const oracle = await typescript(server.origin,token,cases[1]); const response = await call(cases[1]); expect(response.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(response)).toEqual(oracle);
    } finally { connection.exec('ALTER TABLE composer_send_queue RENAME COLUMN unavailable_payload_json TO payload_json'); connection.close(); }
    expect(readFileSync(stderr,'utf8') + readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8')).not.toContain(token);
  } finally { await server?.stop(); rmSync(directory,{ recursive: true,force: true }); }
},180_000);

it.skipIf(process.platform !== 'linux')('rejects missing, malformed, oversized and incomplete capability grants through the front door',async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'o8d-queue-grant-'))); let mode = 'valid'; let stderr = ''; let stdout = '';
  await seedSessionFixture(directory); const repo = seedRows(directory); const path = pathFor(repo,'thoughts-queue',{ backend: 'pi' });
  const context = () => ({ target: { repoPath: repo,threadId: 'thoughts-queue' },request: { repoPath: repo,threadId: 'thoughts-queue',backend: 'pi' },capabilities: ORCHESTRATOR_BACKEND_IDS.map(id => ({ id: String(id),liveSteer: mode !== 'rotate' && (id === 'pi' || id === 'muse') })) });
  const upstream = createServer((req,res) => {
    if (req.headers['x-o8d-session-read'] === 'authorize') {
      expect(req.headers['x-o8d-composer-queue']).toBe('capabilities/1'); if (mode === 'missing') { res.writeHead(204).end(); return; }
      const grant = { version: mode === 'version' ? 2 : 1,defaultsContext: { composerQueue: context() } };
      if (mode === 'outside') grant.defaultsContext.composerQueue.capabilities = [{ id: 'pi',liveSteer: true }];
      if (mode === 'count') grant.defaultsContext.composerQueue.capabilities = Array.from({ length: 33 },(_,i) => ({ id: 'backend-' + i,liveSteer: true }));
      if (mode === 'scope') grant.defaultsContext.composerQueue.request.threadId = 'thoughts-other';
      if (mode === 'new-backend' || mode === 'unknown-backend') {
        const db = new Database(join(directory,'cortex-ide.db'));
        try { db.prepare("INSERT INTO composer_send_queue (id,repo_path,thread_id,intent,payload_json,status,created_at,updated_at) VALUES ('after-admission',?,'thoughts-queue','send-next',?,'queued',1,1)").run(repo,JSON.stringify(payload(mode === 'new-backend' ? 'muse' : 'future-backend'))); } finally { db.close(); }
      }
      const body = mode === 'boolean' ? JSON.stringify(grant).replace('"liveSteer":true','"liveSteer":"yes"') : mode === 'json' ? '{' : mode === 'body' ? ' '.repeat(1024*1024+1) : JSON.stringify(grant);
      res.writeHead(200,{ 'content-type': 'application/json',connection: 'close' }).end(body);
    } else res.writeHead(200,{ 'content-type': 'application/json',connection: 'close' }).end('{"fallback":true}');
  });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve)); const address = upstream.address() as { port: number };
  const child = spawn(binary,['--experimental-ws','--listen','127.0.0.1:0','--app-upstream',`127.0.0.1:${address.port}`],{ env: { ...process.env,O8D_BRIDGE_KEY: 'queue-grant-fixture',O8D_EPOCH: 'queue-grant-fixture',O8D_NATIVE_SESSION_READS: '0',O8D_NATIVE_OWNED: '1',O8D_SESSION_DATA_DIR: directory,O8D_REQUEST_COUNTS_PATH: join(directory,'o8d-request-counts.jsonl') },stdio: ['pipe','pipe','pipe'] }); child.stderr.on('data',chunk => { stderr += chunk.toString(); });
  try {
    const origin = await new Promise<string>((resolve,reject) => { const timer = setTimeout(() => reject(new Error('o8d startup timeout')),10_000); child.stdout.on('data',chunk => { stdout += chunk.toString(); for (const line of stdout.split('\n')) try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve('http://' + value.listening); } } catch { /* Partial startup line. */ } }); child.once('error',reject); });
    const valid = await fetch(origin + path); expect(valid.headers.get('x-o8d-native')).toBe('1'); await valid.json();
    for (mode of ['missing','json','version','outside','boolean','count','scope','body']) { const response = await fetch(origin + path); expect(response.headers.get('x-o8d-native'),mode).toBeNull(); expect(await response.json()).toEqual({ fallback: true }); }
    for (mode of ['new-backend','unknown-backend']) {
      const response = await fetch(origin + path); expect(response.headers.get('x-o8d-native'),mode).toBe('1');
      const body = await response.json(); expect(body.canSteer).toBe(true);
      expect(body.items.some((item: { id: string }) => item.id === 'after-admission')).toBe(true);
      expect(body.steerableIds.includes('after-admission')).toBe(mode === 'new-backend');
      const db = new Database(join(directory,'cortex-ide.db')); try { db.prepare("DELETE FROM composer_send_queue WHERE id='after-admission'").run(); } finally { db.close(); }
    }
    mode = 'rotate'; const rotated = await fetch(origin + path); expect(rotated.headers.get('x-o8d-native')).toBe('1'); expect(await rotated.json()).toMatchObject({ canSteer: false,steerableIds: [] });
    mode = 'valid'; const recovered = await fetch(origin + path); expect(recovered.headers.get('x-o8d-native')).toBe('1'); await recovered.json();
    expect(stderr + stdout + readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8')).not.toContain('ws-parity-fixture-credential');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit',() => resolve())); } upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(directory,{ recursive: true,force: true }); }
},60_000);


it('grants every fixed backend without reading the queue, with the existing backend-id guard',async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'o8d-queue-authority-')));
  try {
    await seedSessionFixture(directory); const repo = seedRows(directory);
    const script = `
      const { getSqlite } = require('./src/lib/db/index.ts');
      const { nativeComposerQueueContext } = require('./src/lib/ws-server/native-composer-queue-context.ts');
      const { ORCHESTRATOR_BACKEND_IDS, isOrchestratorBackendId } = require('./src/lib/lane/orchestrator-backends/types.ts');
      getSqlite().exec('ALTER TABLE composer_send_queue RENAME COLUMN payload_json TO inaccessible_payload');
      const context = nativeComposerQueueContext(new URL(process.argv[1]));
      console.log(JSON.stringify({ context, known: ORCHESTRATOR_BACKEND_IDS.every(isOrchestratorBackendId), unknown: [null, 1, 'future-backend', 'PI', ''].some(isOrchestratorBackendId) }));
      getSqlite().close();
    `;
    const { stdout } = await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','-e',script,'http://fixture' + pathFor(repo,'thoughts-queue',{ backend: 'unknown' })],{ env: { ...process.env,O8_DATA_DIR: undefined,CORTEX_IDE_DATA_DIR: directory } });
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.known).toBe(true); expect(result.unknown).toBe(false);
    expect(result.context.target).toEqual({ repoPath: repo,threadId: 'thoughts-queue' });
    expect(result.context.capabilities.map((row: { id: string }) => row.id)).toEqual(ORCHESTRATOR_BACKEND_IDS);
    expect(result.context.capabilities).toContainEqual({ id: 'pi',liveSteer: true });
    expect(result.context.capabilities).toContainEqual({ id: 'claude',liveSteer: false });
  } finally { rmSync(directory,{ recursive: true,force: true }); }
},60_000);
