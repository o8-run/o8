import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { firstDifference, seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';
const route='/api/lanes/[id]/diff';
const targetDir=join(process.cwd(),'crates/o8d/target/session-reads');
const binary=process.env.O8D_TEST_BINARY??join(targetDir,'debug/o8d');
beforeAll(async()=>{if(!process.env.O8D_TEST_BINARY)await promisify(execFile)('cargo',['build','--locked','--manifest-path','crates/o8d/Cargo.toml','--features','experimental-session-reads','--jobs','1','--target-dir',targetDir]);},900_000);
async function snapshot(response:Response){return{status:response.status,type:response.headers.get('content-type'),cache:response.headers.get('cache-control'),body:await response.json() as Record<string,unknown>};}
it.skipIf(process.platform!=='linux')('owns materialized lane diffs on the product front door with exact redaction and Node refusal fallbacks',async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'o8d-lane-review-')));let server:Awaited<ReturnType<typeof startParityReference>>|undefined;let origin='',nonce=0;
  const control=(flags={})=>{writeFileSync(join(directory,'lane-diff-control.json'),JSON.stringify({nonce:++nonce,...flags}));return nonce;};
  const counts=(id:number)=>{try{return readFileSync(join(directory,'lane-diff-counters.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.nonce===id);}catch{return[];}};
  try{
    await seedSessionFixture(directory);const token=readFileSync(join(directory,'ws-token'),'utf8').trim(),repo=join(directory,'fixture-repo');
    const git=async(cwd:string,...args:string[])=>promisify(execFile)('git',['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',...args]);
    await git(repo,'symbolic-ref','HEAD','refs/heads/main');writeFileSync(join(repo,'change.txt'),'base line\n');await git(repo,'add','change.txt');await git(repo,'commit','-qm','Fixture base');
    const base=(await git(repo,'rev-parse','HEAD')).stdout.trim();const remote=join(directory,'remote.git');await promisify(execFile)('git',['clone','--bare','--quiet',repo,remote]);await git(repo,'remote','add','origin',remote);
    const worktree=join(directory,'lane-worktree');await git(repo,'worktree','add','--quiet','-b','lane-review',worktree);
    writeFileSync(join(worktree,'change.txt'),'base line\ncommitted change\n');await git(worktree,'commit','-qam','Committed lane change');
    writeFileSync(join(worktree,'change.txt'),'base line\ncommitted change\nuncommitted change\nUnicode 雪 sample\nprivate value '+token+'\n');
    const large=join(directory,'large-worktree');await git(repo,'worktree','add','--quiet','-b','lane-large',large,'lane-review');writeFileSync(join(large,'change.txt'),'base line\nlarge Unicode 雪\n'+'x'.repeat(530_000)+'\n');
    const full=(await git(large,'diff',base)).stdout;const cut=Buffer.byteLength(full.slice(0,full.indexOf('雪')))+1;expect(Buffer.from(full).subarray(0,cut).toString('utf8')).toContain('�');
    const broken=join(directory,'broken-repo');mkdirSync(broken);await git(broken,'init','-q','-b','broken-review');writeFileSync(join(broken,'change.txt'),'broken fixture\n');await git(broken,'add','.');await git(broken,'commit','-qm','Fixture broken head');writeFileSync(join(broken,'.git/refs/heads/broken-review'),'f'.repeat(40)+'\n');
    writeFileSync(join(directory,'repos.json'),JSON.stringify({version:1,repos:[{id:'lane-repository',name:'Fixture lane repo',localPath:repo,isGitRepo:true,remoteUrl:null,defaultBranch:'main',addedAt:'2026-01-01T00:00:00.000Z'}]}));
    writeFileSync(join(directory,'lane-diff-seed.json'),JSON.stringify({base}));
    await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','tests/fixtures/o8d-lane-diff-seed.ts'],{env:{...process.env,O8_DATA_DIR:undefined,CORTEX_IDE_DATA_DIR:directory,CORTEX_IDE_DB_PATH:join(directory,'cortex-ide.db')}});
    const fixture=JSON.parse(readFileSync(join(directory,'lane-diff-fixture.json'),'utf8'));
    const path=(id:string,query='')=>route.replace('[id]',id)+query;
    const cases=[path(fixture.ordinary),path('lane-packet'),path(fixture.ordinary,'?maxBytes=9999'),path(fixture.ordinary,'?maxBytes=invalid'),path(fixture.ordinary,'?maxBytes=0'),path(fixture.ordinary,'?maxBytes=999999999999999999999999999999999999999999'),path(fixture.legacy),path(fixture.large),path(fixture.large,'?maxBytes=524288'),path(fixture.large,'?maxBytes=999999'),path(fixture.large,'?maxBytes='+cut+'suffix'),path(fixture.ordinary,'?maxBytes=1'),path(fixture.ordinary,'?maxBytes='+'9'.repeat(400))];
    const fallback=[{path:path('missing'),token,status:404},{path:path(fixture.ordinary),token:fixture.foreign,status:403},{path:path(fixture.immutable),token,status:200},{path:path(fixture.unresolved),token,status:409},{path:path(fixture.failed),token,status:500},{path:path(fixture.ordinary),token:'',status:401},{path:path(fixture.missingWorktree),token,status:409}];
    const call=(url:string,bearer=token)=>fetch(origin+url,{headers:{authorization:'Bearer '+bearer}});
    const start=async(native:boolean)=>{server=await startParityReference({directory,nativeHttp:true,productFrontDoor:true,o8d:native,nativeSessionReads:'default',binary:native?join(directory,'capture-o8d'):undefined,preload:resolve('tests/fixtures/o8d-lane-diff-preload.cjs')});await server.stopNext();origin=server.url.replace('ws:','http:').replace('/ws','');};
    await start(false);const expected=[];for(const url of cases){const id=control();const response=await call(url);expect(response.headers.get('x-o8d-native')).toBeNull();expected.push(await snapshot(response));expect(counts(id).filter(row=>row.name==='readLaneReviewDiff')).toHaveLength(1);}
    expect(expected[0].body.diff).toContain('committed change');expect(expected[0].body.diff).toContain('uncommitted change');expect(expected[0].body.diff).toContain('[redacted]');expect(expected[0].body.diff).toContain('Unicode 雪 sample');expect(expected[11].body).toMatchObject({diff:'[redacted]',maxBytes:1,truncated:true});expect(expected[12].body.maxBytes).toBe(65536);expect(JSON.stringify(expected[0].body).includes(token)).toBe(false);
    expect(expected[0].body.diffBase).toMatchObject({requestedRef:base,mergeBase:base});expect(expected[6].body.diffBase).toMatchObject({requestedRef:'origin/main',mergeBase:base,fetchedRemoteBase:true});
    expect(expected[10].body).toMatchObject({maxBytes:cut,truncated:true,diff:'[redacted]\n'});
    const fallbackExpected=[];for(const item of fallback){control();const response=await call(item.path,item.token);const actual=await snapshot(response);expect(actual.status).toBe(item.status);fallbackExpected.push(actual);}
    expect(fallbackExpected[2].body).toHaveProperty('diffFingerprint');expect(fallbackExpected[2].body.reviewSource).toBe('immutable_snapshot');expect(fallbackExpected[3].body.error).toMatchObject({code:'branch_unresolved'});expect(fallbackExpected.at(-1)!.body.error).toMatchObject({code:'worktree_missing'});
    control();const writeExpected=await snapshot(await fetch(origin+cases[0],{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'}));
    await server!.stop();server=undefined;
    const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";const stderr=join(directory,'daemon-stderr');writeFileSync(join(directory,'capture-o8d'),'#!/bin/sh\nexec '+quote(binary)+' "$@" 2>'+quote(stderr)+'\n',{mode:0o700});
    await start(true);
    for(const [index,url] of cases.entries()){
      const id=control(),response=await call(url);expect(response.headers.get('x-o8d-native'),'Native route was not reached: case='+index+' '+url+' counts='+JSON.stringify(counts(id))).toBe('1');expect(firstDifference(expected[index],await snapshot(response)),url).toBeNull();
      expect(counts(id).filter(row=>row.name==='readLaneReviewDiff')).toHaveLength(0);expect(counts(id).filter(row=>row.name==='materializedGrant')).toHaveLength(1);
      if(index===0&&process.env.O8D_LANE_DIFF_COUNTER_RECEIPT)writeFileSync(process.env.O8D_LANE_DIFF_COUNTER_RECEIPT,JSON.stringify({readLaneReviewDiff:0,materializedGrant:1,productFrontDoor:true,sessionReads:'unset'})+'\n');
    }
    control();const worker=await call(path(fixture.ordinary),fixture.worker);expect(worker.headers.get('x-o8d-native')).toBe('1');expect(await snapshot(worker)).toEqual(expected[0]);
    for(const [index,item] of fallback.entries()){const id=control(),response=await call(item.path,item.token);expect(response.headers.get('x-o8d-native')).toBeNull();expect(await snapshot(response)).toEqual(fallbackExpected[index]);if(item.status===500)expect(counts(id).filter(row=>row.name==='materializedGrant')).toHaveLength(1);}
    for(const flag of ['missingGrant','malformedGrant','overLimitGrant','wrongTarget','relativeRoot']){const id=control({[flag]:true}),response=await call(cases[0]);expect(response.headers.get('x-o8d-native'),flag).toBeNull();expect(await snapshot(response),flag).toEqual(expected[0]);expect(counts(id).filter(row=>row.name==='readLaneReviewDiff')).toHaveLength(1);}
    const original=readFileSync(join(worktree,'change.txt'),'utf8');writeFileSync(join(worktree,'change.txt'),original+'compatibility Ａ sample\n');
    control({missingGrant:true});const normalizedOracle=await snapshot(await call(cases[0]));control();const unsupported=await call(cases[0]);expect(unsupported.headers.get('x-o8d-native')).toBeNull();expect(await snapshot(unsupported)).toEqual(normalizedOracle);writeFileSync(join(worktree,'change.txt'),original);
    control();const write=await fetch(origin+cases[0],{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});expect(write.headers.get('x-o8d-native')).toBeNull();expect(await snapshot(write)).toEqual(writeExpected);
    await server!.stop();server=undefined;const logs=readFileSync(stderr,'utf8')+readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8');expect(logs.includes(token)).toBe(false);expect(logs.includes(fixture.worker)).toBe(false);expect(logs.includes(fixture.foreign)).toBe(false);
  }finally{await server?.stop();rmSync(directory,{recursive:true,force:true});}
},300_000);
