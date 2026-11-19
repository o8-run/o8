import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
interface WireEvent { channel: string; event: string; data: { mutation: { surfaceId: string; action: string; mutationId: string } }; }
interface WireFrame { channel: string; event: string; data: { delivery: string; epoch: string; events: WireEvent[] }; }
const run = promisify(execFile);
const target = process.env.O8_LAUNCHER_TEST_TARGET ?? '/tmp/o8-launcher-owner-target';
const launcher = process.env.O8_LAUNCHER_TEST_BINARY ?? join(target, 'debug/o8-launcher');
const daemon = process.env.O8D_TEST_BINARY ?? join(target, 'debug/o8d');
const clientBinary = process.env.O8_LAUNCHER_TRANSPORT_TEST_BINARY;
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.O8_LAUNCHER_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--jobs', '1', '--target-dir', target]);
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', target]);
}, 600_000);
function json(path: string) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function alive(pid: number) { try { process.kill(pid, 0); return !readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } }
async function until(check: () => boolean | Promise<boolean>, reason: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw Error('Native global fixture timeout: ' + reason); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process quit', 15_000); }
}
function bootstrap(origin: string, headers: Record<string, string>) {
  return new Promise<{ status: number; marker: string | undefined; type: string | undefined; cache: string | undefined; body: string }>((resolve, reject) => {
    const req = request(origin + '/api/panel/ws-info', { headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, marker: res.headers['x-o8d-native'] as string | undefined, type: res.headers['content-type'], cache: res.headers['cache-control'], body }));
    }); req.on('error', reject); req.end();
  });
}
function connect(origin: string, token: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?token=' + encodeURIComponent(token), { headers });
  const frames: WireFrame[] = []; // Protocol fields are asserted before use.
  let code: number | null = null;
  socket.on('message', raw => frames.push(JSON.parse(String(raw))));
  socket.on('close', value => code = value);
  socket.on('error', () => {});
  return { socket, frames, get code() { return code; } };
}
it.runIf(process.platform === 'linux')('delivers committed prompt and rule writes once, keeps refusals silent and hands back to TS', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-native-global-'))), server = join(root, 'server');
  let owner: ChildProcess | undefined, client: ChildProcess | undefined;
  const sockets: WebSocket[] = []; let clientOutput = '', stderr = '';
  try {
    await seedSessionFixture(root); await run('git', ['init', '--quiet', root]); mkdirSync(server);
    symlinkSync(join(process.cwd(), 'node_modules'), join(server, 'node_modules'), 'dir');
    const repo = process.cwd(), window = join(root, 'window'), probe = join(root, 'probe');
    writeFileSync(join(server, 'server.js'), 'throw Error("Next must remain absent");');
    writeFileSync(join(server, 'ws-server.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'tests/fixtures/launcher-ws-owner-entry.mjs')).href)});`);
    writeFileSync(window, '#!/bin/sh\necho o8-next-ready\ncat >/dev/null\n', { mode: 0o700 });
    writeFileSync(probe, `#!/bin/sh\nprintf '__O8_PATH=%s\\n__O8_NODE=%s\\n' "$PATH" '${process.execPath}'\n`, { mode: 0o700 });
    writeFileSync(join(root, 'launch.json'), JSON.stringify({ data_dir: root, server_dir: server, node: process.execPath, window, probe, api_port: 0, ws_port: 0, version: 'fixture', native_lifecycle: false, api_front_door: true, next_off: true }));
    const nodeOptions = ['--require=' + join(repo, 'scripts/next/brain-runtime.cjs'), '--import=' + pathToFileURL(join(repo, 'scripts/register-server-only-stub.mjs')).href, '--import=' + pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href].join(' ');
    owner = spawn(launcher, ['--config', join(root, 'launch.json')], { env: { PATH: process.env.PATH, HOME: root, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: nodeOptions, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), CORTEX_IDE_REVIEW_REPO_ROOT: root, O8D_BINARY: daemon, O8_TTS_PYTHON: join(root, 'no-python') }, stdio: ['pipe', 'pipe', 'pipe'] });
    owner.stderr!.on('data', chunk => stderr += chunk);
    let port = 0, daemonPid = 0;
    await until(async () => { try { port = Number(readFileSync(join(root, 'api-port'), 'utf8').trim()); const body = await (await fetch('http://127.0.0.1:' + port + '/health')).json(); daemonPid = body.delivery?.pid ?? 0; return daemonPid > 0; } catch { return false; } }, 'producer readiness');
    const origin = 'http://127.0.0.1:' + port, token = readFileSync(join(root, 'ws-token'), 'utf8').trim(), headers = { authorization: 'Bearer ' + token };
    const firstProducer = json(join(root, 'launcher-ws.json')).pid as number;
    writeFileSync(join(root, 'hold-ws-start'), 'hold'); process.kill(firstProducer, 'SIGKILL');
    await until(() => { try { return readFileSync(join(root, 'ws-starts'), 'utf8').trim().split('\n').length >= 2; } catch { return false; } }, 'replacement held');
    expect((await bootstrap(origin, headers)).status).toBe(200);
    const observer = connect(origin, token); sockets.push(observer.socket);
    await until(() => observer.socket.readyState === WebSocket.OPEN, 'native upgrade');
    observer.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    await until(() => observer.frames.some(f => f.channel === 'realtime'), 'checkpoint');
    if (clientBinary) {
      client = spawn(clientBinary, ['launcher_owner_tests::native_commits_and_handback', '--ignored', '--exact'], { env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', O8_LAUNCHER_CLIENT_ORIGIN: origin, O8_LAUNCHER_CLIENT_DATA: root }, stdio: ['pipe','pipe','pipe'] });
      client!.stdout!.on('data', x => clientOutput += x); client!.stderr!.on('data', x => clientOutput += x);
      await until(() => json(join(root, 'commit-client-ready')) !== null || (() => { try { return readFileSync(join(root, 'commit-client-ready'), 'utf8') === 'ready'; } catch { return false; } })(), 'production Client ready');
    }
    if (!clientBinary) console.info('[native-client-proof] Client leg requires O8_LAUNCHER_TRANSPORT_TEST_BINARY; integration runs socket proof without building the GUI.');
    const events = () => observer.frames.flatMap(f => f.data?.events ?? []).filter(e => e.data?.mutation?.action?.match(/^(prompt-library|session-rule)\./));
    const expected: {action:string;surfaceId:string;native:boolean}[] = [];
    const call = (path:string, method:string, payload?:unknown) => fetch(origin + path, {method, headers:{...headers,'content-type':'application/json'}, ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
    const confirm = async (action:string, surfaceId:string) => {
      expected.push({action,surfaceId,native:true});
      await until(() => events().some(e => e.data.mutation.action === action && e.data.mutation.surfaceId === surfaceId), 'Native committed '+action+' event was not reached', 5000);
      expect(events().filter(e => e.data.mutation.action === action && e.data.mutation.surfaceId === surfaceId)).toHaveLength(1);
    };
    const created = await call('/api/prompt-library','POST',{title:'commit fixture',body:'isolated body'});
    expect(created.status).toBe(201); expect(created.headers.get('x-o8d-native')).toBe('1'); const prompt=(await created.json()).prompt;
    await confirm('prompt-library.create',prompt.id);
    expect((await call('/api/prompt-library/'+prompt.id,'PATCH',{title:'edited'})).status).toBe(200); await confirm('prompt-library.edit',prompt.id);
    expect((await call('/api/prompt-library/'+prompt.id+'/use','POST')).status).toBe(200); await confirm('prompt-library.use',prompt.id);
    expect((await call('/api/prompt-library/'+prompt.id,'DELETE')).status).toBe(200); await confirm('prompt-library.delete',prompt.id);
    const thread='thoughts-native-commit';
    const added=await call('/api/orchestrator/session-rules','POST',{threadId:thread,text:'isolated rule'});expect(added.status).toBe(200);expect(added.headers.get('x-o8d-native')).toBe('1');const rule=(await added.json()).result.rule;
    await confirm('session-rule.add',thread);
    expect((await call('/api/orchestrator/session-rules?id='+rule.id,'DELETE')).status).toBe(200);await confirm('session-rule.remove',thread);
    const db=new Database(join(root,'cortex-ide.db'));
    try {
      const hold={id:'commit-hold-fixture',repoPath:root,threadId:'thoughts-hold',payload:{message:'hold fixture',mode:'send',holdMerges:true,targets:[]},fences:[{scope:'parent:'+root+'\nthoughts-hold',version:0}]};
      const held=await call('/api/orchestrator/session-rules?operation=correction-hold','POST',hold);expect(held.status).toBe(200);await confirm('session-rule.add','thoughts-hold');
      expect((await call('/api/orchestrator/session-rules?operation=correction-hold','POST',hold)).status).toBe(200);
      const counts=()=>['session_rules','worker_corrections','worker_correction_deliveries'].map(table=>db.prepare('SELECT count(*) n FROM '+table).get());
      const before=counts();
      db.exec("CREATE TRIGGER fail_hold BEFORE INSERT ON worker_corrections BEGIN SELECT RAISE(ABORT,'isolated rollback'); END");
      expect((await call('/api/orchestrator/session-rules?operation=correction-hold','POST',{...hold,id:'rollback-hold-fixture'})).status).toBe(500);
      expect(counts()).toEqual(before);db.exec('DROP TRIGGER fail_hold');
      expect((await call('/api/prompt-library','POST',{})).status).toBe(400);
      expect((await fetch(origin+'/api/prompt-library',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body:'{}'})).status).toBe(503);
      await new Promise(r=>setTimeout(r,300));expect(events()).toHaveLength(expected.length);
    } finally {db.close();}
    rmSync(join(root,'hold-ws-start'));
    await until(async()=>{try{return (await (await fetch(origin+'/health')).json()).delivery?.pid===daemonPid;}catch{return false;}},'reattach');
    await until(()=>observer.code!==null,'native close');expect(observer.code).toBe(1013);
    if(client) await until(()=>{try{return Number(readFileSync(join(root,'commit-client-handback'),'utf8'))>0;}catch{return false;}},'Client handback');
    const attached=connect(origin,token);sockets.push(attached.socket);
    await until(()=>attached.socket.readyState===WebSocket.OPEN,'producer upgrade');
    attached.socket.send(JSON.stringify({type:'realtime-subscribe',subscriptions:[{stream:'global'}]}));
    await until(()=>attached.frames.some(f=>f.channel==='realtime'),'producer checkpoint');
    const next=await call('/api/prompt-library','POST',{title:'attached commit',body:'isolated attached body'});expect(next.status).toBe(201);const nextId=(await next.json()).prompt.id;
    const attachedEvents=()=>attached.frames.flatMap(f=>f.data?.events??[]).filter(e=>e.data?.mutation?.action==='prompt-library.create'&&e.data.mutation.surfaceId===nextId);
    await until(()=>attachedEvents().length>0,'producer-sequenced native commit');
    await new Promise(r=>setTimeout(r,300));expect(attachedEvents()).toHaveLength(1);
    expect(attached.frames.filter(f=>f.data?.events?.some(e=>e.data?.mutation?.surfaceId===nextId)).every(f=>!f.data.epoch.startsWith('o8d-native:'))).toBe(true);
    expected.push({action:'prompt-library.create',surfaceId:nextId,native:false});
    if(client)await until(()=>{try{return readFileSync(join(root,'commit-client-events.jsonl'),'utf8').includes(nextId);}catch{return false;}},'Client producer notification');
    writeFileSync(join(root,'commit-client-expected.json'),JSON.stringify(expected));
    if(client){writeFileSync(join(root,'transport-stop'),'stop');await until(()=>client!.exitCode!==null,'Client finish');expect(client.exitCode).toBe(0);expect(clientOutput.includes('1 passed')).toBe(true);}
    const secondProducer=json(join(root,'launcher-ws.json')).pid as number;
    await stop(owner);expect(owner.exitCode).toBe(0);expect(alive(daemonPid)).toBe(false);expect(alive(secondProducer)).toBe(false);
    const captured=readFileSync(join(root,'logs/o8d.log'),'utf8')+readFileSync(join(root,'o8d-request-counts.jsonl'),'utf8')+stderr+JSON.stringify(events());
    for(const privateValue of [token,'isolated body','isolated rule','hold fixture'])expect(captured.includes(privateValue)).toBe(false);
  } finally {for(const socket of sockets)socket.terminate();if(client&&client.exitCode===null)client.kill('SIGTERM');await stop(owner);rmSync(root,{recursive:true,force:true});}
},240_000);
