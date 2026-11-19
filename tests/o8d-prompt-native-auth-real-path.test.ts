import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { seedSessionFixture } from '../scripts/o8d/parity';
const route='/api/prompt-library',single='/api/prompt-library/[id]';
const binary=process.env.O8D_TEST_BINARY??join(process.cwd(),'crates/o8d/target/session-reads/debug/o8d');
const clientBinary=process.env.O8_PROMPT_CLIENT_TEST_BINARY;
beforeAll(async()=>{
  if(!process.env.O8D_TEST_BINARY)await promisify(execFile)('cargo',['build','--locked','--manifest-path','crates/o8d/Cargo.toml','--features','experimental-session-reads','--jobs','1','--target-dir','crates/o8d/target/session-reads']);
},1_800_000);
async function raw(response:Response){return{status:response.status,type:response.headers.get('content-type'),cache:response.headers.get('cache-control'),body:await response.text()};}
function classic(origin:string,path:string,token:string){return new Promise<{status:number;body:string;type:string|null;cache:string|null}>((resolve,reject)=>{const req=httpRequest(origin+path,{headers:{authorization:'Bearer '+token,'transfer-encoding':'chunked'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode!,body,type:res.headers['content-type']??null,cache:res.headers['cache-control']??null}));});req.on('error',reject);req.end();});}
it.skipIf(process.platform!=='linux')('keeps saved-prompt operator reads alive on the product front door after Node stops',async()=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'o8d-prompt-native-')));let server:Awaited<ReturnType<typeof startParityReference>>|undefined;let daemon:ReturnType<typeof spawn>|undefined;let stderr='';
 try{
  await seedSessionFixture(directory);
  server=await startParityReference({directory,nativeHttp:true,productFrontDoor:true,o8d:true,nativeSessionReads:'default',binary});await server.stopNext();
  let origin=server.url.replace('ws:','http:').replace('/ws','');const token=server.token;
  const posted=await fetch(origin+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({title:'fixture saved prompt',body:'fixture prompt body',tags:['fixture'],scope:'global'})});expect(posted.status).toBe(201);const payload=await posted.json();const id=payload.prompt.id;
  const paths=[route,single.replace('[id]',id),single.replace('[id]','missing')];
  const references=new Map<string,Awaited<ReturnType<typeof raw>>>();
  for(const path of paths){const expected=await classic(origin,path,token);const response=await fetch(origin+path,{headers:{authorization:'Bearer '+token}});expect(response.headers.get('x-o8d-native'),'Native route was not reached: '+path).toBe('1');const actual=await raw(response);expect({...actual,body:JSON.parse(actual.body)}).toEqual({...expected,body:JSON.parse(expected.body)});references.set(path,expected);}
  await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','tests/fixtures/o8d-prompt-auth-seed.ts'],{env:{...process.env,O8_DATA_DIR:undefined,CORTEX_IDE_DATA_DIR:directory,CORTEX_IDE_DB_PATH:join(directory,'cortex-ide.db')}});
  const credentials=JSON.parse(readFileSync(join(directory,'prompt-credentials.json'),'utf8'));
  for(const bearer of ['', 'wrong',...Object.values(credentials) as string[]])for(const path of paths.slice(0,2)){const expected=await classic(origin,path,bearer);const response=await fetch(origin+path,{headers:{authorization:'Bearer '+bearer}});expect(response.headers.get('x-o8d-native')).toBeNull();expect(expected.status).toBe(bearer === '' || bearer === 'wrong' ? 401 : 403);const actual=await raw(response);expect(actual).toEqual(expected);}
  // Spectator recognition precedes operator equality even on a colliding value.
  const spectatorFile=join(directory,'broadcast-spectator-tokens'),spectatorBefore=readFileSync(spectatorFile);
  writeFileSync(spectatorFile,spectatorBefore.toString()+createHash('sha256').update(token).digest('hex')+'\n');
  const collisionOracle=await classic(origin,route,token);
  const collision=await fetch(origin+route,{headers:{authorization:'Bearer '+token}});
  expect(collisionOracle.status).toBe(403);expect(collision.headers.get('x-o8d-native')).toBeNull();expect(await raw(collision)).toEqual(collisionOracle);
  writeFileSync(spectatorFile,spectatorBefore);
  const publicPort=new URL(origin).port;
  await server.stop();server=undefined;writeFileSync(join(directory,'node-stopped'),'stopped');
  // Separate fixture-owned daemon, same product transport, a stopped Node upstream.
  daemon=spawn(binary,['--experimental-ws','--listen','127.0.0.1:0','--app-upstream','127.0.0.1:'+publicPort],{env:{...process.env,O8_API_FRONT_DOOR:'1',O8D_NATIVE_OWNED:'1',O8D_NATIVE_SESSION_READS:undefined,O8D_BRIDGE_KEY:'fixture-prompt-bridge',O8D_EPOCH:'fixture-prompt',O8D_SESSION_DATA_DIR:directory,O8D_SESSION_DB_PATH:join(directory,'cortex-ide.db'),O8D_REQUEST_COUNTS_PATH:join(directory,'o8d-request-counts.jsonl')},stdio:['pipe','pipe','pipe']});
  daemon.stderr!.on('data',x=>stderr+=x.toString());
  origin=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('daemon startup timeout')),10000);daemon!.stdout!.on('data',x=>{output+=x;for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.listening){clearTimeout(timer);resolve('http://'+value.listening);}}catch{}});daemon!.once('error',reject);});
  for (const bearer of ['', 'wrong', ...Object.values(credentials) as string[]]) {
    await expect(fetch(origin + route, { headers: { authorization: 'Bearer ' + bearer } })).rejects.toThrow();
  }
  await expect(fetch(origin + route, { headers: { authorization: 'Bearer ' + token, 'x-o8-relay-forward': '1' } })).rejects.toThrow();
  if(clientBinary){
  const probe = await promisify(execFile)(clientBinary!,['client::transport::tests::saved_prompts_product_transport_without_node','--ignored','--exact'],{env:{...process.env,O8_PROMPT_CLIENT_ORIGIN:origin,O8_PROMPT_CLIENT_DATA:directory,O8_NEXT_TUNNEL_HOST:undefined,O8_NEXT_WS_PORT:undefined},maxBuffer:1024*1024});
  expect(probe.stdout).toContain('client::transport::tests::saved_prompts_product_transport_without_node ... ok');
  expect(probe.stdout).toContain('1 passed');
  console.info('[native-client-proof] Supplied window Client: 1 passed with Node stopped.');
  }else console.info('[native-client-proof] Client leg not run: O8_PROMPT_CLIENT_TEST_BINARY is unset; integration never builds the GUI crate. Socket auth and Node-stopped reads remain required.');
  for(const path of paths){const response=await fetch(origin+path,{headers:{authorization:'Bearer '+token}});expect(response.headers.get('x-o8d-native')).toBe('1');const actual=await raw(response),expected=references.get(path)!;expect({...actual,body:JSON.parse(actual.body)}).toEqual({...expected,body:JSON.parse(expected.body)});}
  const tokenPath=join(directory,'ws-token'),date=new Date('2026-01-01T00:00:00.000Z');
  const rotated=token.slice(0,-1)+'X';utimesSync(tokenPath,date,date);
  expect((await fetch(origin+route,{headers:{authorization:'Bearer '+token}})).status).toBe(200);
  writeFileSync(tokenPath,rotated);utimesSync(tokenPath,date,date);
  await expect(fetch(origin+route,{headers:{authorization:'Bearer '+token}})).rejects.toThrow();
  expect((await fetch(origin+route,{headers:{authorization:'Bearer '+rotated}})).headers.get('x-o8d-native')).toBe('1');
  rmSync(tokenPath);await expect(fetch(origin+route,{headers:{authorization:'Bearer '+rotated}})).rejects.toThrow();
  writeFileSync(tokenPath,token);
  expect((stderr+readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8')).includes(token)).toBe(false);
 }finally{if(daemon&&daemon.exitCode===null){daemon.kill('SIGTERM');await new Promise<void>(resolve=>daemon!.once('exit',()=>resolve()));}await server?.stop();rmSync(directory,{recursive:true,force:true});}
},300_000);
