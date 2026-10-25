import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import type { AcpClient } from '@/lib/acp/client';

const corpus = createRequire(import.meta.url)('./acp-redaction-matrix.cjs') as {
 canaries: string[]; separators: string[]; benign: string[];
 forms: Record<string, (value: string) => string>;
 rows(separator: string, family: string): Array<{id: string; secret: string; value: string; expected: string}>;
};
interface Harness {
 dir: string;
 configure(args: string[], values: string[]): Promise<void>;
 token(): string;
 client(options: {onStderr(chunk: string): void; onExit(): void}): AcpClient;
 turn(id: string): Promise<{events: Array<{type: string; text?: string; error?: string}>; lifecycle: unknown}>;
}
export function defineAcpRedactionMatrix(h: Harness): void {
 const peer=join(h.dir,'matrix-peer.cjs');
 writeFileSync(peer,String.raw`
 const {readFileSync}=require('node:fs'); const data=JSON.parse(readFileSync(process.argv[3],'utf8'));
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
 const split=text=>Array.from({length:data.parts},(_,i)=>text.slice(Math.floor(i*text.length/data.parts),Math.floor((i+1)*text.length/data.parts)));
 require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const r=JSON.parse(line);let result={};
 if(r.method==='initialize'){if(process.argv[2]==='check')return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:data.text}});result={protocolVersion:1};}
 if(r.method==='session/new')result={sessionId:'matrix',configOptions:[]};
 if(r.method==='session/prompt'){
  const update=text=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'matrix',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  update('Working on it\n');
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'matrix',update:{sessionUpdate:'tool_call',toolCallId:'matrix-tool',title:'Fixture tool',rawInput:{}}}});
  for(const row of data.rows)for(const [index,text] of split(row).entries()){
   update(text);
   if(index===0&&data.parts>1)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'matrix',update:{sessionUpdate:'tool_call',toolCallId:'matrix-middle',title:'Between chunks',rawInput:{}}}});
  }
  const bytes=Buffer.from(data.text);
  for(let index=0;index<data.parts;index++){process.stderr.write(bytes.subarray(Math.floor(index*bytes.length/data.parts),Math.floor((index+1)*bytes.length/data.parts)));await new Promise(resolve=>setTimeout(resolve,3));}
  if(data.success)return send({jsonrpc:'2.0',id:r.id,result:{stopReason:'end_turn'}});
  return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:data.text}});
 }
 if(r.id!=null)send({jsonrpc:'2.0',id:r.id,result});});
 setTimeout(()=>process.exit(0),5000).unref();`);
 const cases=corpus.separators.flatMap((separator,index)=>[1,2,3].flatMap(parts=>(index<corpus.separators.length-3?['base64','escapes']:['base64']).map(family=>({separator,index,parts,family}))));
 async function exercise(rows: string[], expected: string, parts: number, label: string, values=corpus.canaries) {
  const payload=join(h.dir,'matrix-payload.json');writeFileSync(payload,JSON.stringify({rows,text:rows.join(''),parts}));
  await h.configure([peer,'check',payload],values);
  const {GET}=await import('@/app/api/orchestrator/backend-models/route');
  const response=await GET(new NextRequest(`http://fixture.invalid/api/orchestrator/backend-models?backend=acp&refresh=1&repoPath=${encodeURIComponent(h.dir)}`,{headers:{authorization:`Bearer ${h.token()}`}}));
  const checked=await response.json();
  const strings=(value: unknown): string[] => typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
  expect.soft(strings(checked),label+' Check connection').toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  await h.configure([peer,'turn',payload],values);
  const {events,lifecycle}=await h.turn(label);
  const firstTool=events.findIndex(event=>event.type==='tool_use');
  expect.soft(firstTool,label+' tool notification present').toBeGreaterThan(0);
  expect.soft(events.slice(0,firstTool).filter(e=>e.type==='text').map(e=>e.text).join(''),label+' progress before tool').toBe('Working on it\n');
  expect.soft(events.filter(e=>e.type==='text').map(e=>e.text).join(''),label+' turn output').toBe('Working on it\n'+expected);
  expect.soft(events.filter(e=>e.type==='error').map(e=>e.error),label+' turn error').toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  expect.soft(strings(lifecycle),label+' lifecycle error').toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  const stderr: string[]=[];let exited!:()=>void;const closed=new Promise<void>(resolve=>{exited=resolve;});
  const resident=h.client({onStderr:chunk=>stderr.push(chunk),onExit:exited});
  try{await resident.initialize();await resident.newSession(h.dir,[]);await resident.prompt('matrix','Fixture matrix.');}catch{}finally{resident.kill();await closed;}
  expect.soft(stderr.join(''),label+' stderr').toBe(expected);
 }
 it.each(cases)('generated five-path matrix: separator $index / $family / $parts chunks',async({separator,index,parts,family})=>{
  const rows=corpus.rows(separator,family);
  await exercise(rows.map(row=>row.value),rows.map(row=>row.expected).join(''),parts,`${index}-${family}-${parts}`);
 },30_000);
 it.each([1,2,3])('maps astral Unicode spans on all five output paths: %i chunks',async parts=>{
  const secret='secret123';
  const hidden='sec\u200bret123';
  const astral='\u{E0001}'.repeat(100);
  const encoders={raw:(value:string)=>value,base64:corpus.forms.base64,base64url:corpus.forms.base64url,
   percent:corpus.forms.percent,nested:(value:string)=>corpus.forms.percent(corpus.forms.base64(corpus.forms.json(value)))};
  const rows:string[]=[];const expected:string[]=[];
  for(const [name,encode] of Object.entries(encoders))for(const [prefix,suffix] of [
   [astral,''], ['\u{1F600}'.repeat(20)+astral,''], ['kept prefix with long UTF-16 offsets ',astral+'\u{1F600}'],
  ]){
   rows.push(`${name}: ${prefix}${encode(hidden)}${suffix}!\n`);
   expected.push(`${name}: ${prefix}[redacted]${suffix}!\n`);
  }
  // 99 format characters occupy complete Base64 byte groups, so preserved
  // surrounding encodings have independent, exact expected spans.
  const inside='\u{E0001}'.repeat(99);
  for(const [name,encode] of Object.entries(encoders)){
   rows.push(`${name} decoded: ${encode(inside+hidden+inside)}!\n`);
   expected.push(`${name} decoded: ${encode(inside)}[redacted]${encode(inside)}!\n`);
  }
  await exercise(rows,expected.join(''),parts,`astral-${parts}`,[secret]);
 },30_000);
 it.each([1,2,3])('folds combining marks and canonical secret spellings on all five paths: %i chunks',async parts=>{
  const variants=[
   {secret:'secret123',emitted:'sec\u0301ret123'},
   {secret:'synthetic-caf\u00e9-first',emitted:'synthetic-cafe\u0301-first'},
   {secret:'synthetic-pine\u0301-second',emitted:'synthetic-pin\u00e9-second'},
   {secret:'synthetic-\ufb01-third',emitted:'synthetic-fi-third'},
   {secret:'synthetic-caf\u00e9',emitted:'synthetic-cafe\u0301'},
  ];
  const encoders={...corpus.forms,form:(value:string)=>new URLSearchParams({v:value}).toString().slice(2),
   nested:(value:string)=>corpus.forms.percent(corpus.forms.base64(corpus.forms.json(value)))};
  const rows:string[]=[],expected:string[]=[];
  for(const [name,encode]of Object.entries(encoders))for(const [index,{emitted}]of variants.entries()){
   rows.push(`Fold ${name}-${index}: ${encode(emitted)}!\n`);
   expected.push(`Fold ${name}-${index}: [redacted]!\n`);
  }
  await exercise(rows,expected.join(''),parts,`folded-${parts}`,variants.map(row=>row.secret));
  for (const [secret,emitted] of [['office','o\ufb03ce'],['式会社','\u337f']]) for (const encode of [corpus.forms.raw,corpus.forms.base64]) await exercise([encode(emitted)],'[redacted]',parts,`short-fold-${parts}`,[secret]);
 },60_000);
 it.each([1,2,3])('generated benign corpus survives all five paths and tool boundaries: %i chunks',async parts=>{
  const rows=corpus.benign.map(value=>value+'\n');await exercise(rows,rows.join(''),parts,`benign-${parts}`);
 },30_000);
 it('completes successfully when a redacted value ends after a tool notification',async()=>{
  const secret=corpus.canaries[0];
  const payload=join(h.dir,'matrix-success.json');
  writeFileSync(payload,JSON.stringify({rows:[secret],text:'Synthetic success.',parts:3,success:true}));
  await h.configure([peer,'turn',payload],[secret]);
  const {events}=await h.turn('matrix-success');
  expect(events.filter(event=>event.type==='error')).toEqual([]);
  expect(events.some(event=>event.type==='done')).toBe(true);
  expect(events.filter(event=>event.type==='text').map(event=>event.text).join('')).toBe('Working on it\n[redacted]');
 },15_000);
 it('preserves 1 MiB real turn output within the 8 second shared-host budget',async()=>{
  // Keep the subprocess/chunking guarantee affordable; matcher-only guards still cover 4 MiB.
  const size=1024*1024;
  const rows=['Working on it\n'.repeat(Math.ceil(size/14)).slice(0,size)];
  expect(Buffer.byteLength(rows[0])).toBe(size);
  const payload=join(h.dir,'matrix-large.json');writeFileSync(payload,JSON.stringify({rows,text:'Large fixture completed.',parts:3}));
  await h.configure([peer,'turn',payload],corpus.canaries);
  const start=process.cpuUsage();const wall=performance.now();const {events}=await h.turn('matrix-large');const used=process.cpuUsage(start);const elapsed=(used.user+used.system)/1000;
  expect(events.filter(e=>e.type==='text').map(e=>e.text).join('')==='Working on it\n'+rows[0]).toBe(true);
  process.stdout.write(`[acp-redaction] ACP_1MIB_CPU_MS=${elapsed.toFixed(2)} ACP_1MIB_WALL_MS=${(performance.now()-wall).toFixed(2)}\n`);expect(performance.now()-wall).toBeLessThan(8000);
 },15_000);
 it('preserves 1 MiB escaped real turn output with literal-escape secrets within 8 seconds',async()=>{
  const size=1024*1024;const unit=String.raw`\u0062\n`;
  const rows=[unit.repeat(Math.ceil(size/unit.length)).slice(0,size)];
  const payload=join(h.dir,'matrix-escaped-large.json');
  writeFileSync(payload,JSON.stringify({rows,text:'Escaped fixture completed.',parts:3,success:true}));
  await h.configure([peer,'turn',payload],[String.raw`synthetic-\u0061-credential`,String.raw`synthetic-\n-credential`]);
  const cpu=process.cpuUsage();const wall=performance.now();const {events}=await h.turn('matrix-escaped-large');
  const used=process.cpuUsage(cpu);const wallMs=performance.now()-wall;
  expect(events.filter(event=>event.type==='error')).toEqual([]);
  expect(events.filter(event=>event.type==='text').map(event=>event.text).join('')==='Working on it\n'+rows[0]).toBe(true);
  process.stdout.write(`[acp-redaction] ACP_ESCAPED_1MIB_CPU_MS=${((used.user+used.system)/1000).toFixed(2)} ACP_ESCAPED_1MIB_WALL_MS=${wallMs.toFixed(2)}\n`);
  expect(wallMs).toBeLessThan(8000);
 },15_000);

}
