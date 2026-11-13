import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
const paths = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({...await original<typeof import('node:os')>(),homedir:()=>paths.home}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter',()=>({prewarmHaiku:async()=>{}}));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter',()=>({prewarmSonnetCli:async()=>{}}));
const root=mkdtempSync(join(tmpdir(),'o8-review-profile-'));paths.home=join(root,'user');
const repo=join(root,'repo');mkdirSync(repo);mkdirSync(join(paths.home,'.codex'),{recursive:true});
writeFileSync(join(paths.home,'.codex/config.toml'),'[mcp_servers.operator]\ncommand="fixture-operator"\n');
vi.stubEnv('O8_DATA_DIR',join(root,'data'));vi.stubEnv('CORTEX_IDE_DATA_DIR',join(root,'data'));vi.stubEnv('CORTEX_IDE_DB_PATH',join(root,'state.db'));
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR','0');
const cli=join(root,'provider.cjs');const capture=join(root,'sessions.jsonl');const initialFile=join(root,'initial');
writeFileSync(cli,`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
if(process.argv.includes('--version')){console.log('codex-cli 0.150.0');process.exit(0);}
const claude=process.argv.includes('--input-format');const backend=claude?'claude':'codex';
const cfg=claude?fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8'):fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({backend,cfg,args:process.argv.slice(2)})+'\\n');
const initial=fs.readFileSync(${JSON.stringify(initialFile)},'utf8');const emit=v=>console.log(JSON.stringify(v));
const answer='CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}';
if(claude){require('node:readline').createInterface({input:process.stdin}).on('line',()=>{
 const text=initial===backend?'You have hit your usage limit. Try again when it resets.':answer;
 emit({type:'assistant',message:{content:[{type:'text',text}]}});emit({type:'result',subtype:'success',result:text,is_error:false,usage:{input_tokens:1,output_tokens:1}});
});}else{emit({type:'thread.started',thread_id:'fixture-profile'});
 if(initial===backend)emit({type:'turn.failed',error:{code:'usage_limit_reached',message:'You have hit your usage limit. Try again when it resets.'}});
 else{emit({type:'item.completed',item:{type:'agent_message',text:answer}});emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});}}
`,{mode:0o700});
vi.stubEnv('O8_CODEX_BIN',cli);vi.stubEnv('O8_CLAUDE_CODE_BIN',cli);
execFileSync('git',['init','-q',repo]);
const {getSqlite,closeDb}=await import('@/lib/db');const {createLane}=await import('@/lib/lane/registry');
const {codexBackend}=await import('@/lib/lane/orchestrator-backends/codex');const {claudeBackend}=await import('@/lib/lane/orchestrator-backends/claude');
const {requestOrchestratorSessionReset}=await import('@/lib/lane/orchestrator-session');
const {codexAppThreadConfig}=await import('@/lib/lane/codex-orchestrator-config');
const {runReviewerTurnWithQuotaFallback}=await import('@/lib/lane/review-quota-fallback');
const {updateOperatorDefaults}=await import('@/lib/operator/defaults');
const sessions:string[]=[];
it.each(['codex','claude'] as const)('builds restricted real reviewer sessions for %s and its fallback',async initial=>{
 updateOperatorDefaults({subscriptionProfile:'both'});writeFileSync(initialFile,initial);writeFileSync(capture,'');
 const packetId=`pkt-pr-review-${(initial==='codex'?'a':'b').repeat(16)}`;const taskId=`task-${initial}`;const revisionId=`revision-${initial}`;
 const db=getSqlite();db.prepare('INSERT INTO external_pr_review_tasks (id,repo_id,repo_path,repository_id,pr_number,pr_url) VALUES (?,?,?,?,?,?)').run(taskId,'repo',repo,'123',initial==='codex'?1:2,'https://github.com/example/repo/pull/1');
 db.prepare('INSERT INTO external_pr_review_revisions (id,task_id,sequence,head_sha,base_sha,base_ref,packet_id,adopted_at) VALUES (?,?,?,?,?,?,?,?)').run(revisionId,taskId,1,'a'.repeat(40),'b'.repeat(40),'main',packetId,new Date().toISOString());
 const lane=createLane({repoPath:repo,branch:taskId,baseBranch:'main',runtime:'codex',packetId});const thread=`thoughts-profile-${initial}`;sessions.push(thread);
 const result=await runReviewerTurnWithQuotaFallback({laneId:lane.id,repoPath:repo,threadId:thread,sessionThreadId:thread,surface:'auto-review',prompt:'Review the saved input.',expectedHeadSha:'a'.repeat(40),initialBackend:initial==='codex'?codexBackend:claudeBackend,backendResolver:id=>id==='codex'?codexBackend:claudeBackend});
 expect(result.ok,JSON.stringify(result)).toBe(true);expect(result.text).toContain('CODEX_AUTO_REVIEW:');
 const rows=readFileSync(capture,'utf8').trim().split('\n').map(l=>JSON.parse(l) as {backend:string;cfg:string;args:string[]});
 expect(rows.map(r=>r.backend)).toEqual([initial,initial==='codex'?'claude':'codex']);
 for(const row of rows){
  const servers=row.backend==='codex'?(parse(row.cfg).mcp_servers as Record<string,unknown>):JSON.parse(row.cfg).mcpServers;
  expect(servers).not.toHaveProperty('operator');expect(servers.cortex.env.CORTEX_READONLY).toBe('1');
  expect(servers.visualizations.env.O8_OPERATOR_MCP_PROFILE).toBe('visualizations');
  if(row.backend==='claude')expect(row.args).toEqual(expect.arrayContaining(['--permission-mode','plan']));
 }
 const app=codexAppThreadConfig(repo,'propose',thread);const appServers=app.mcp_servers as Record<string,{enabled?:boolean}>;
 expect(appServers.operator?.enabled).toBe(false);
 requestOrchestratorSessionReset(repo,thread);
},60000);
afterAll(()=>{for(const thread of sessions)requestOrchestratorSessionReset(repo,thread);closeDb();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
