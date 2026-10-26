import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: async () => {},
}));
const root = mkdtempSync(join(tmpdir(), 'o8-mcp-owned-payer-'));
const data = join(root, 'data'), repo = join(root, 'repo');
const keys = { anthropic: 'fixture-owned-anthropic-material', openai: 'fixture-owned-openai-material' };
const binary = join(root, 'worker.cjs'), peerDir = join(root, 'peer');
const gate = join(root, 'launch-gate');
mkdirSync(data); mkdirSync(peerDir);
vi.stubEnv('HOME', root);
vi.stubEnv('O8_DATA_DIR', data); vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
vi.stubEnv('CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', join(data, 'owned-claude'));
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(data, 'owned-codex'));
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 102).toString('base64url'));
vi.stubEnv('O8_CLAUDE_CODE_BIN', binary); vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1'); vi.stubEnv('O8_WORKER_SANDBOX', 'off');
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1'); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-owned-oauth');
vi.stubEnv('CODEX_HOME', join(root, 'profile')); mkdirSync(join(root, 'profile'));
const servers = await import('@/lib/mcp/external-servers');
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');
const { createLane } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { managedPacketWorktreeId } = await import('@/lib/worktree/root-layout');
const { closeMcpLaunchBrokers } = await import('@/lib/mcp/launch-broker');
const { closeDb } = await import('@/lib/db');
let sequence = 0;
beforeAll(() => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=o8', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: initialize MCP payer fixture'], { cwd: repo });
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
if(process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
const args=process.argv.slice(2), known=${JSON.stringify(Object.values(keys))};
let entries={}, config='';
if(args.includes('--mcp-config')) { config=fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'); entries=JSON.parse(config).mcpServers; }
else { const parse=require(${JSON.stringify(join(process.cwd(), 'node_modules/smol-toml'))}).parse; for(let i=0;i<args.length;i++) if(args[i]==='-c'&&args[i+1].startsWith('mcp_servers.')) { const table=parse(args[++i]).mcp_servers; for(const [name,server] of Object.entries(table)) entries[name]={...entries[name],...server}; } }
if(!Object.keys(entries).length) process.exit(0);
const selected=Object.values(entries)[0];
const report={descriptor:selected?.args?.[0]==='-e'?selected.args[2]:undefined,argvSecret:known.some(key=>args.join('').includes(key)),configSecret:known.some(key=>config.includes(key)),parentKey:!!process.env.ANTHROPIC_API_KEY};
fs.writeFileSync('worker-ready.json',JSON.stringify(report));
const launch=()=>{ const server=Object.values(entries)[0]; if(!server) throw new Error('Missing configured MCP');
 const child=cp.spawnSync(server.command,server.args,{env:{...process.env,...server.env},input:'{}\\n',encoding:'utf8',timeout:10000});
 fs.writeFileSync('worker-result.json',JSON.stringify({...report,childOk:child.status===0,outputSecret:known.some(key=>(String(child.stdout)+String(child.stderr)).includes(key))}));
 if(args.includes('--input-format')) console.log(JSON.stringify({type:'result',session_id:'payer-worker',is_error:false}));
 else { console.log(JSON.stringify({type:'thread.started',thread_id:'payer-worker'})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})); }
};
if(fs.existsSync(${JSON.stringify(gate)})) { const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);launch();}},10); } else launch();
`, { mode: 0o755 });
  for (const name of ['claude', 'codex']) writeFileSync(join(peerDir, name), `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync('mcp-receipt.json',JSON.stringify({anthropic:!!process.env.ANTHROPIC_API_KEY,openai:!!process.env.OPENAI_API_KEY,alias:!!process.env.NPM_TOKEN,service:process.env.SERVICE_AUTH,argvSecret:${JSON.stringify(Object.values(keys))}.some(key=>process.argv.join('').includes(key))}));
console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools:[]}}));
`, { mode: 0o755 });
});
beforeEach(() => {
  for(const server of servers.listExternalMcpServers()) servers.removeExternalMcpServer(server.id);
  mutateProviderKey('ANTHROPIC_API_KEY', { key: keys.anthropic }); mutateProviderKey('OPENAI_API_KEY', { key: keys.openai });
  saveRuntimeBillingMode('claude-code', 'subscription'); rmSync(gate, { force: true });
});
afterAll(() => { closeMcpLaunchBrokers(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive:true, force:true }); });
async function launch(runtime: 'claude-code' | 'codex', command: string, env: Record<string,string>, args: string[] = []) {
  const id=`pkt-payer-${++sequence}`, branch=`test/payer-${sequence}`;
  const state=readOrchestratorControlPlaneState();
  const packet: OrchestratorPacket={id,referenceLabel:id,title:'MCP payer fixture',summary:'MCP payer fixture',workspaceTargetPath:repo,branchTarget:branch,runtime,dependencyLabels:[],dependencyPacketIds:[],queueState:'queued',releaseState:'pending',status:'queued',lane:null};
  writeOrchestratorControlPlaneState({...state,packets:[...state.packets,packet]});
  const worktreeId=managedPacketWorktreeId(id)!;
  const parent=join(repo,'.cortex-worktrees'),cwd=join(parent,worktreeId); mkdirSync(parent,{recursive:true});
  execFileSync('git',['worktree','add','-q',cwd,'-b',branch],{cwd:repo});
  const materializationIdentity=await captureWorktreeMaterializationIdentity(cwd),materializationParentIdentity=await captureWorktreeMaterializationIdentity(parent);
  await withWorktreeMetaTransaction(repo,tx=>tx.save(worktreeId,{id:worktreeId,agentType:runtime,baseBranch:'main',createdAt:Date.now(),claudeManaged:false,taskName:id,branchName:branch,status:'ready',isolationKind:'git-worktree',materializationIdentity,materializationParentIdentity}));
  const lane=createLane({repoPath:repo,worktreePath:cwd,branch,runtime,label:id,packetId:id});
  servers.insertExternalMcpServer({name:'payer',transport:'stdio',command,args,env,enabled:true,workerInjection:true});
  const result=await dispatchLaneCommand({verb:'launch_session',laneId:lane.id,prompt:'Exercise MCP payer',actor:'orchestrator'});
  expect(result.ok,result.note).toBe(true);
  return {cwd,lane};
}
async function receipt(cwd:string) {
  await vi.waitFor(()=>expect(existsSync(join(cwd,'worker-result.json'))).toBe(true),{timeout:15000,interval:20});
  return JSON.parse(readFileSync(join(cwd,'worker-result.json'),'utf8'));
}
it('keeps saved credentials out of a subscription worker config and MCP child',async()=>{
  const {cwd}=await launch('claude-code',join(peerDir,'claude'),{ANTHROPIC_API_KEY:keys.anthropic,NPM_TOKEN:keys.anthropic,SERVICE_AUTH:'fixture-service'});
  const report=await receipt(cwd);
  expect(report).toMatchObject({argvSecret:false,configSecret:false,outputSecret:false,childOk:true});
  expect(JSON.parse(readFileSync(join(cwd,'mcp-receipt.json'),'utf8'))).toMatchObject({anthropic:false,openai:false,alias:false,service:'fixture-service',argvSecret:false});
});
it('keeps registered MCP keys out of subscription worker argv and the subscription MCP child',async()=>{
  const {cwd}=await launch('codex',join(peerDir,'codex'),{OPENAI_API_KEY:keys.openai,NPM_TOKEN:keys.openai});
  expect(await receipt(cwd)).toMatchObject({argvSecret:false,configSecret:false,outputSecret:false,childOk:true});
  expect(JSON.parse(readFileSync(join(cwd,'mcp-receipt.json'),'utf8'))).toMatchObject({openai:false,alias:false,argvSecret:false});
});
it('delivers API credentials only at the MCP child boundary, with no config or argv copy',async()=>{
  saveRuntimeBillingMode('claude-code','api');
  const {cwd}=await launch('codex',join(peerDir,'claude'),{ANTHROPIC_API_KEY:keys.anthropic});
  expect(await receipt(cwd)).toMatchObject({argvSecret:false,configSecret:false,childOk:true,outputSecret:false});
  expect(JSON.parse(readFileSync(join(cwd,'mcp-receipt.json'),'utf8')).anthropic).toBe(true);
});
it('rereads payer settings after worker launch and before the delayed MCP launch',async()=>{
  saveRuntimeBillingMode('claude-code','api'); writeFileSync(gate,'wait');
  const {cwd}=await launch('claude-code',join(peerDir,'claude'),{ANTHROPIC_API_KEY:keys.anthropic,NPM_TOKEN:keys.anthropic});
  await vi.waitFor(()=>expect(existsSync(join(cwd,'worker-ready.json'))).toBe(true));
  saveRuntimeBillingMode('claude-code','subscription'); rmSync(gate);
  expect(await receipt(cwd)).toMatchObject({argvSecret:false,configSecret:false,childOk:true});
  expect(JSON.parse(readFileSync(join(cwd,'mcp-receipt.json'),'utf8'))).toMatchObject({anthropic:false,alias:false});
});


it.each(['raw', 'unicode', 'percent', 'split', 'raw-api'])('refuses deferred %s credential args without putting them in worker argv',async kind=>{
  saveRuntimeBillingMode('claude-code',kind==='raw-api'?'api':'subscription');
  const value=kind==='unicode'?'"'+[...keys.anthropic].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"':JSON.stringify([keys.anthropic.slice(0,12),keys.anthropic.slice(12)]);
  const args=kind.startsWith('raw')?['--token',keys.anthropic]:kind==='percent'
    ? ['https://example.invalid/'+[...keys.anthropic].map(c=>'%'+c.charCodeAt(0).toString(16)).join('')]
    : ['-c',`mcp_servers.fixture.args=${value}`];
  const {cwd}=await launch('codex',join(peerDir,'claude'),{},args);
  expect(await receipt(cwd)).toMatchObject({argvSecret:false,configSecret:false,childOk:false,outputSecret:false});
  expect(existsSync(join(cwd,'mcp-receipt.json'))).toBe(false);
});
it('refuses an attachment revoked after the worker was prepared',async()=>{
  writeFileSync(gate,'wait');
  const {cwd}=await launch('codex',join(peerDir,'claude'),{});
  await vi.waitFor(()=>expect(existsSync(join(cwd,'worker-ready.json'))).toBe(true));
  const server=servers.listExternalMcpServers()[0]; servers.updateExternalMcpServer(server.id,{workerInjection:false});
  rmSync(gate); expect(await receipt(cwd)).toMatchObject({childOk:false,outputSecret:false});
  expect(existsSync(join(cwd,'mcp-receipt.json'))).toBe(false);
});
it('releases refused authentication sockets before a legitimate deferred launch',async()=>{
  writeFileSync(gate,'wait');
  const {cwd}=await launch('codex',join(peerDir,'claude'),{});
  await vi.waitFor(()=>expect(existsSync(join(cwd,'worker-ready.json'))).toBe(true));
  const ready=JSON.parse(readFileSync(join(cwd,'worker-ready.json'),'utf8'));
  await vi.waitFor(()=>expect(existsSync(ready.descriptor)).toBe(true));
  const descriptor=JSON.parse(readFileSync(ready.descriptor,'utf8'));
  const sockets: ReturnType<typeof connect>[]=[];
  try {
    for(let i=0;i<20;i++) await new Promise<void>((resolve,reject)=>{
      const socket=connect({host:'127.0.0.1',port:descriptor.port,allowHalfOpen:true}); sockets.push(socket);
      socket.setTimeout(1000,()=>reject(new Error('Authentication refusal stalled')));
      socket.on('error',reject); socket.on('connect',()=>socket.write(JSON.stringify({token:'0'.repeat(64)})+'\n'));
      socket.on('data',()=>{socket.setTimeout(0);resolve();});
    });
    rmSync(gate); expect(await receipt(cwd)).toMatchObject({childOk:true});
  } finally { for(const socket of sockets) socket.destroy(); }
});


it('reports a missing delayed executable as a failed MCP launch',async()=>{
  writeFileSync(gate,'wait');
  const {cwd}=await launch('codex',join(peerDir,'claude'),{});
  await vi.waitFor(()=>expect(existsSync(join(cwd,'worker-ready.json'))).toBe(true));
  rmSync(join(peerDir,'claude')); rmSync(gate);
  expect(await receipt(cwd)).toMatchObject({childOk:false,outputSecret:false});
  expect(existsSync(join(cwd,'mcp-receipt.json'))).toBe(false);
});
