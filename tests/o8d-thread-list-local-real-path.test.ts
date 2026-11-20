import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { firstDifference, seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';
const route='/api/mobile/orchestrator/threads';
const targetDir=join(process.cwd(),'crates/o8d/target/session-reads');
const binary=process.env.O8D_TEST_BINARY ?? join(targetDir,'debug/o8d');
beforeAll(async()=>{if(!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo',['test','--locked','--manifest-path','crates/o8d/Cargo.toml','--features','experimental-session-reads','--jobs','1','--target-dir',targetDir,'--test','thread_list_reads']);},900_000);
type Body={ threads?: Array<Record<string,unknown>>; archivedIds?: string[]; updatedAt?: string|null };
async function snapshot(response:Response) {return{status:response.status,type:response.headers.get('content-type'),cache:response.headers.get('cache-control'),body:await response.json() as Body};}
type Count={nonce:number;phase:string;name:string;ids?:string[]};
const localNames=['listMobileOrchestratorThreads','listThoughtHistoryFileStats','threadGitContext','inboxProjection','lookupLinkedWork','createParkedWorkspaceContext'];
async function seed(directory:string) {
  await seedSessionFixture(directory); writeFileSync(join(directory,'computer-name'),'Fixture computer\n');
  const history=join(directory,'chat-history'); for(const name of readdirSync(history)) if(name.startsWith('thoughts-')&&name.endsWith('.json')) rmSync(join(history,name));
  const repo=join(directory,'fixture-repo');
  const git=async(...args:string[])=>promisify(execFile)('git',['-C',repo,...args]);
  await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Thread list fixture');
  await git('remote','remove','origin').catch(()=>{}); await git('remote','add','origin','https://github.com/fixture/thread-list.git');
  const worktree=join(directory,'linked-worktree'); await git('worktree','add','--quiet','-b','thread-list-worktree',worktree,'HEAD');
  const plain=join(directory,'no-remote'); mkdirSync(plain); writeFileSync(join(plain,'.git'),'not a git repository\n');
  const at=Date.parse('2026-10-01T00:00:00.000Z');
  const put=(id:string,extra:Record<string,unknown>={})=>writeFileSync(join(history,id+'.json'),JSON.stringify({title:id,messages:[],backend:'claude',repoPath:repo,repoBranch:'saved-branch',savedAt:new Date(at+100_000).toISOString(),...extra}));
  for(let i=0;i<510;i++) put('thoughts-page-'+String(i).padStart(3,'0'),{savedAt:new Date(at-i*1000).toISOString(),backend:i%2?'claude':'pi'});
  for(const id of ['thoughts-linked','thoughts-parked','thoughts-pinned']) put(id);
  const token=readFileSync(join(directory,'ws-token'),'utf8').trim(); put('thoughts-pinned',{pinned:true,title:'Fixture '+token});
  put('thoughts-busy',{messages:[{role:'user',content:'Running fixture',timestamp:at+200_000}]});
  put('thoughts-worktree',{repoPath:worktree}); put('thoughts-no-remote',{repoPath:plain});
  put('thoughts-source-network',{source:'bot-network',network:{question:{id:'fixture-question',status:'pending'}},messages:[{role:'user',content:'Network fixture',timestamp:at+150_000}]});
  put('thoughts-bus-network',{source:'bot-network'});
  put('thoughts-openclaw',{backend:'openclaw'}); put('thoughts-archived',{archivedAt:'2026-10-02'});
  const db=new Database(join(directory,'cortex-ide.db'));
  try {
    db.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,100) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('inbox:subject:'+JSON.stringify(['conversation',repo,'thoughts-busy']),JSON.stringify({runStatus:'running',runStartedAt:'2026-10-01T00:03:00.000Z',inboxRevision:1}));
    db.prepare("INSERT INTO bot_network_threads(thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES ('thoughts-bus-network',?,NULL,'[]','Bus fixture','2026-10-01T00:00:00.000Z')").run(repo);
    const columns=db.prepare('PRAGMA table_info(github_pull_requests)').all() as Array<{name:string;type:string;notnull:number;dflt_value:unknown}>;
    const mirrored:Record<string,unknown>={repository_id:1,pull_request_id:10,number:7,title:'Mirrored fixture',state:'open',merged_at:null,head_ref_name:'saved-branch',url:'https://github.com/fixture/thread-list/pull/7'};
    for(const col of columns) if(col.notnull && col.dflt_value===null && !(col.name in mirrored)) mirrored[col.name]=col.type.includes('INT')?1:'';
    db.prepare(`INSERT INTO github_pull_requests (${Object.keys(mirrored).join(',')}) VALUES (${Object.keys(mirrored).map(()=>'?').join(',')})`).run(...Object.values(mirrored));
    for(const id of ['thoughts-linked','thoughts-pinned']) db.prepare("INSERT INTO conversation_pr_context(thread_id,host,repository_id,pull_request_id,number,repository_name,kind,source,created_at) VALUES (?,'github.com',1,10,7,'fixture/thread-list','context','operator','2026-10-01')").run(id);
  } finally {db.close();}
  await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','tests/fixtures/o8d-thread-list-parked.ts'],{env:{...process.env,O8_DATA_DIR:undefined,CORTEX_IDE_DATA_DIR:directory,CORTEX_IDE_DB_PATH:join(directory,'cortex-ide.db')}});
  return{repo,token,worktree};
}
it.skipIf(process.platform!=='linux')('moves local thread listing and projections through the front door, retaining one live Node enrichment and composition',async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'o8d-thread-list-')));
  let server:Awaited<ReturnType<typeof startParityReference>>|undefined; let origin=''; let nonce=0;
  const control=(flags:Record<string,unknown>={})=>{writeFileSync(join(directory,'thread-list-control.json'),JSON.stringify({nonce:++nonce,...flags}));return nonce;};
  const counts=(id:number):Count[]=>{try{return readFileSync(join(directory,'thread-list-counters.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.nonce===id);}catch{return[];}};
  try {
    const {repo,token}=await seed(directory);
    const start=async(native:boolean)=>{
      server=await startParityReference({directory,nativeHttp:true,o8d:native,nativeSessionReads:false,binary:native?join(directory,'capture-o8d'):undefined,preload:resolve('tests/fixtures/o8d-thread-list-preload.cjs')});
      await server.stopNext(); origin=server.url.replace('ws:','http:').replace('/ws','');
    };
    const call=(path=route,bearer=token)=>fetch(origin+path,{headers:{authorization:'Bearer '+bearer}});
    const paths=[route,route+'?backend=claude',route+'?backend=pi',route+'?backend=openclaw',route+'?limit=500',route+'?limit=500&offset=500',route+'?limit=5tail&offset=500tail',route+'?limit=-3&offset=-9',route+'?limit=9999&offset=99999',route+'?limit='+ '9'.repeat(400),route+'?backend=invalid',route+'?archived=1'];
    await start(false); const expected=[]; for(const [index,path] of paths.entries()){const id=control();expected.push(await snapshot(await call(path)));if(index===0){for(const name of localNames)expect(counts(id).filter(row=>row.name===name).length,'TS counter '+name).toBeGreaterThan(0);}}
    const rejected=await snapshot(await call(route,'')); expect(rejected.status).toBe(401);
    control({networkHealthError:true}); const networkFailed=await snapshot(await call());expect(networkFailed.body.threads!.find(row=>row.id==='thoughts-source-network')).toMatchObject({status:'failed',networkProjectionError:'Fixture projection failure',outcome:'asked'});
    control({prThrows:true}); const withoutPr=await snapshot(await call()); expect(withoutPr.status).toBe(200); expect(withoutPr.body.threads!.some(row=>'pullRequestNumber'in row)).toBe(false);
    await server!.stop();server=undefined;
    const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
    const stderr=join(directory,'daemon-stderr');writeFileSync(join(directory,'capture-o8d'),'#!/bin/sh\nexec '+quote(binary)+' "$@" 2>'+quote(stderr)+'\n',{mode:0o700});
    await start(true);
    for(const [index,path] of paths.entries()) {
      const id=control();const response=await call(path);const simple=path.includes('archived=1')||path.includes('backend=invalid');
      expect(response.headers.get(simple?'x-o8d-native':'x-o8d-local-stage'),'Native route was not reached: '+path).toBe(simple?'1':'threads/1');
      if(!simple) expect(response.headers.get('x-o8d-native')).toBeNull();
      const actual=await snapshot(response);expect(firstDifference(expected[index],actual),path).toBeNull();
      const events=counts(id);for(const name of localNames)expect(events.filter(row=>row.name===name),name).toHaveLength(0);
      expect(events.filter(row=>row.name==='projectAllNetworkThreads')).toHaveLength(simple?0:1);
      const pulls=events.filter(row=>row.name==='mobileThreadPullRequests');expect(pulls).toHaveLength(simple?0:1);
      if(!simple)expect(pulls[0].ids).toEqual(actual.body.threads!.map(row=>row.id));
      if(index===0){
        expect(events.filter(row=>row.name==='fetchGitHubPullRequestDetail')).toHaveLength(1);
        const receipt={local:Object.fromEntries(localNames.map(name=>[name,events.filter(row=>row.name===name).length])),projectAllNetworkThreads:events.filter(row=>row.name==='projectAllNetworkThreads').length,mobileThreadPullRequests:pulls.length,brokerDetail:events.filter(row=>row.name==='fetchGitHubPullRequestDetail').length,selectedIdsMatch:true,selectedCount:actual.body.threads!.length};
        if(process.env.O8D_THREAD_LIST_COUNTER_RECEIPT)writeFileSync(process.env.O8D_THREAD_LIST_COUNTER_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
        const rows=actual.body.threads!;
        expect(rows.find(row=>row.id==='thoughts-busy')).toMatchObject({status:'busy',runStartedAt:'2026-10-01T00:03:00.000Z'});
        expect(rows.find(row=>row.id==='thoughts-pinned')).toMatchObject({pinned:true,pullRequestNumber:7,pullRequestState:'open',changeCount:7});
        expect(rows.find(row=>row.id==='thoughts-linked')).toMatchObject({linkedWork:{pullRequests:{total:1,open:1,closed:0,merged:0},branches:1}});
        expect(rows.find(row=>row.id==='thoughts-parked')).toMatchObject({parkedWorkspaces:[{packetId:'parked-packet',repositoryUuid:'fixture-repository',reclaimedAvailableBytes:4096}]});
        expect(rows.find(row=>row.id==='thoughts-worktree')).toMatchObject({isWorktree:true,branch:'thread-list-worktree'});
        expect(rows.find(row=>row.id==='thoughts-no-remote')).toMatchObject({githubOwner:null,githubRepo:null,repoSlug:'no-remote'});
      }
    }
    let id=control({networkHealthError:true});let response=await call();expect(response.headers.get('x-o8d-local-stage')).toBe('threads/1');expect(await snapshot(response)).toEqual(networkFailed);
    id=control({prThrows:true});response=await call();expect(response.headers.get('x-o8d-local-stage')).toBe('threads/1');expect(await snapshot(response)).toEqual(withoutPr);expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toHaveLength(1);
    const db=new Database(join(directory,'cortex-ide.db'));
    try {
      const key='inbox:subject:'+JSON.stringify(['conversation',repo,'thoughts-busy']);db.prepare("UPDATE app_state SET value=json_set(value,'$.inboxRevision','unsupported') WHERE key=?").run(key);
      id=control();response=await call();expect(response.headers.get('x-o8d-local-stage')).toBeNull();expect(response.headers.get('x-o8d-native')).toBeNull();const fallback=await snapshot(response);expect(fallback.status).toBe(200);expect(fallback.body.threads!.find(row=>row.id==='thoughts-busy')!.inboxRevision).toBe('unsupported');
      expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toMatchObject([{phase:'typescript'}]);
      db.prepare("UPDATE app_state SET value=json_set(value,'$.inboxRevision',1) WHERE key=?").run(key);
      db.prepare("UPDATE workspace_snapshots SET record_version=record_version+1 WHERE packet_id='parked-packet'").run();
      id=control();response=await call();expect(response.headers.get('x-o8d-local-stage')).toBeNull();const corrupt=await snapshot(response);expect(corrupt.status).toBe(200);expect(corrupt.body.threads!.find(row=>row.id==='thoughts-parked')).not.toHaveProperty('parkedWorkspaces');expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toMatchObject([{phase:'typescript'}]);
      db.prepare("UPDATE workspace_snapshots SET record_version=record_version-1 WHERE packet_id='parked-packet'").run();
    } finally {db.close();}
    id=control({composeTransportFailure:true});response=await call();expect(response.headers.get('x-o8d-local-stage')).toBeNull();expect(await snapshot(response)).toEqual(expected[0]);expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toHaveLength(2);
    id=control({oversizedGrant:true});response=await call();expect(response.headers.get('x-o8d-local-stage')).toBeNull();expect(await snapshot(response)).toEqual(expected[0]);expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toMatchObject([{phase:'typescript'}]);
    for(const flag of ['missingGrant','malformedGrant','oversizedBodyGrant','wrongVersionGrant']){id=control({[flag]:true});response=await call();expect(response.headers.get('x-o8d-local-stage'),flag).toBeNull();expect(response.headers.get('x-o8d-native'),flag).toBeNull();expect(await snapshot(response),flag).toEqual(expected[0]);expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests'),flag).toMatchObject([{phase:'typescript'}]);}
    control();response=await call(route,'');expect(response.headers.get('x-o8d-local-stage')).toBeNull();expect(await snapshot(response)).toEqual(rejected);
    const privatePort=readFileSync(join(directory,'thread-list-private-port'),'utf8');id=control();
    const spoofed=await new Promise<number>((done,fail)=>{const req=httpRequest('http://127.0.0.1:'+privatePort+route,{method:'POST',headers:{host:new URL(origin).host,authorization:'Bearer '+token,'x-o8d-session-read':'compose-threads/1','content-type':'application/json'}},res=>{res.resume();res.once('end',()=>done(res.statusCode!));});req.once('error',fail);req.end(JSON.stringify({version:1,pieces:[],machineDisplayName:'spoofed'}));});
    expect(spoofed).toBe(409);expect(counts(id).filter(row=>row.name==='mobileThreadPullRequests')).toHaveLength(0);
    control();const post=await fetch(origin+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({repoPath:repo,title:'Created by Node',backend:'claude'})});expect(post.headers.get('x-o8d-local-stage')).toBeNull();expect(post.headers.get('x-o8d-native')).toBeNull();expect(post.status).toBe(200);const created=await post.json();expect(created).toHaveProperty('thread.id');
    control();const fresh=await call(route+'?limit=500');expect(fresh.headers.get('x-o8d-local-stage')).toBe('threads/1');expect((await fresh.json()).threads.some((row:{id:string})=>row.id===created.thread.id)).toBe(true);
    await server!.stop();server=undefined;
    expect(readFileSync(stderr,'utf8')+readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8')).not.toContain(token);
  } finally {await server?.stop();rmSync(directory,{recursive:true,force:true});}
},240_000);


it('rejects malformed or oversized compose payloads before any enrichment',async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'o8d-thread-compose-')));
  try {
    const script=`const {Readable}=require('node:stream');const {composeNativeThreadList}=require('./src/lib/ws-server/native-thread-list-compose.ts');
      (async()=>{const result=[];for(const [body,authenticated,header] of [[{version:2,pieces:[],machineDisplayName:'fixture'},true,'compose-threads/1'],[{version:1,pieces:[{}],machineDisplayName:'fixture'},true,'compose-threads/1'],[{version:1,pieces:[],machineDisplayName:'fixture'},false,'compose-threads/1'],[{version:1,pieces:[],machineDisplayName:'fixture'},true,'compose-threads/2'],[' '.repeat(8*1024*1024+1),true,'compose-threads/1']]){const request=Readable.from([typeof body==='string'?body:JSON.stringify(body)]);request.method='POST';request.headers={'x-o8d-session-read':header};result.push((await composeNativeThreadList(request,authenticated)).status);}console.log(JSON.stringify(result));})().catch(()=>process.exitCode=1);`;
    const {stdout}=await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','-e',script],{env:{...process.env,O8_DATA_DIR:undefined,CORTEX_IDE_DATA_DIR:directory}});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual([409,409,409,409,409]);
  } finally {rmSync(directory,{recursive:true,force:true});}
},60_000);
