import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-external-pr-')));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'state.db'));
const input = vi.hoisted(() => ({ head: 'a'.repeat(40), base: 'b'.repeat(40), state: 'open', merged: false, draft: false, hostFailure: false, primaryQuota: false, beforeVerdict: null as null | (() => Promise<void>), hostHook: null as null | (() => Promise<void>) }));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base']);
input.base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'head']);
input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
const { addRepo } = await import('@/lib/repos/registry');
beforeAll(async () => { await addRepo(repo); const {updateOperatorDefaults}=await import('@/lib/operator/defaults');updateOperatorDefaults({reviewerBackend:'codex',subscriptionProfile:'both'}); });
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: async (_remote: string, path: string) => {
 const snapshot = { number: Number(path.split('/').at(-1)), state: input.state, merged: input.merged, draft: input.draft,
  head: {sha:input.head}, base:{sha:input.base,ref:'main',repo:{id:123,full_name:'example/repo'}} };
 if (input.hostFailure) throw new Error('Private upstream details');
 if (input.hostHook) await input.hostHook();
 return {response:Response.json(snapshot)};
} }));
vi.mock('@/lib/lane/orchestrator-backends/registry', async importOriginal => {
 const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
 const backend = { id: 'codex', label: 'Fixture reviewer', peekSession: () => ({ sessionName: 'review', status: 'ready' }), ensureSession: () => ({ sessionName: 'review', status: 'ready' }),
 async sendTurn(_repo: string, _prompt: string, emit: (v: {type: string; text: string}) => void, options?: {permissionMode?:string}) { expect(options?.permissionMode).toBe('plan'); if(this.id==='codex' && input.primaryQuota){emit({type:'error',text:'',error:'You have hit your usage limit. Try again when it resets.'} as {type:string;text:string});return;} if (input.beforeVerdict) await input.beforeVerdict(); emit({type:'text', text:`CODEX_AUTO_REVIEW: ${JSON.stringify({approved:false,findings:[{file:'answer.txt',severity:'note',description:'Preserve the request.',status:'deferred'}],runEvidence:{status:'run',headSha:input.head,reviewerRuntime:this.id,recordedAt:new Date().toISOString(),observations:[{kind:'command',command:'fixture assertion',result:'passed',exitCode:0,excerpt:'controlled reviewer receipt'}]}})}`}); } };
 return {...actual, getActiveReviewerBackend: () => backend, getOrchestratorBackend: (id:string) => id==='claude'?{...backend,id:'claude'}:backend};
});
vi.mock('@/lib/lane/packet-explainer-queue', () => ({ drainPacketExplainerQueue: async () => {}, enqueuePacketExplainer: async () => {}, notifyCorrectnessReviewQueued: () => {}, startPacketExplainerQueueDrain: () => () => {} }));
vi.mock('@/lib/lane/review-drain-bootstrap', () => ({ensureReviewQueueDrainStarted: vi.fn()}));
const { POST } = await import('@/app/api/tasks/adopt-pr/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const { readExternalReview, listExternalReviews } = await import('@/lib/tasks/external-review-store');
const {handleSubmitReview}=await import('@/lib/mcp/operator-handlers/mission');
const {handleApprove}=await import('@/lib/mcp/operator-handlers/approve');
const {POST:reviewPost}=await import('@/app/api/orchestrator/review/route');
const {POST:approvalPost}=await import('@/lib/approvals/route');
function request(token = getOrCreateWsToken()) { return new NextRequest('http://localhost/api/tasks/adopt-pr', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ repoPath: repo, pullRequest: 7 }) }); }
it('adopts once, appends immutable revisions and survives reopening the database', async () => {
  const first = await POST(request()); expect(first.status).toBe(200); const a = await first.json();
  const second = await POST(request()); const b = await second.json(); expect(b.taskId).toBe(a.taskId); expect(b.revision.id).toBe(a.revision.id);
  execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'corrected']);
  input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const changed = await (await POST(request())).json(); expect(changed.taskId).toBe(a.taskId); expect(changed.revision.sequence).toBe(2);
  expect(changed.state).toBe('waiting'); expect(listExternalReviews()).toHaveLength(1);
  closeDb();
  const cold = execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', join(process.cwd(),'tests/fixtures/external-review-restart-child.ts'), a.taskId], {encoding:'utf8',timeout:30000});
  const recovered = JSON.parse(cold.split('RESTART_RESULT:')[1].split('\n')[0].trim());
  expect(recovered.task.project).not.toBeNull();
  const {getTaskPool} = await import('@/lib/tasks/pool');
  expect((await getTaskPool({projectId:recovered.task.project.id})).tasks.filter(t => t.externalReview)).toHaveLength(1);
  expect(recovered.task.id).toBe(a.taskId); expect(recovered.task.externalReview.revision.headSha).toBe(input.head);
  expect(readExternalReview(a.taskId)?.revision.headSha).toBe(input.head);
});
it('starts the existing review path and preserves canonical findings, refusing author handoff', async () => {
 execFileSync('git', ['-C', repo, 'config', `url.${repo}/.insteadOf`, 'https://github.com/example/repo.git']);
 execFileSync('git', ['-C', repo, 'update-ref', 'refs/pull/7/head', input.head]);
 const task = listExternalReviews()[0];
 const { POST: start } = await import('@/lib/tasks/http/dispatch');
 const originalFetch = globalThis.fetch;
 vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => start(new NextRequest(url,{method:init?.method,headers:init?.headers,body:init?.body}),{params:Promise.resolve({taskId:task.taskId})}));
 try {
  const {handleTaskDispatch} = await import('@/lib/mcp/operator-handlers/task-dispatch');
  const started = await handleTaskDispatch({taskId:task.taskId}); expect(started.isError,JSON.stringify(started)).not.toBe(true);
 } finally { vi.stubGlobal('fetch',originalFetch); }
 const { drainReviewQueue } = await import('@/lib/lane/auto-review'); await drainReviewQueue();
 const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
 const {findLaneByPacket} = await import('@/lib/lane/registry'); expect(findLaneByPacket(task.revision.packetId)?.prNumber).toBe(7);
 const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === task.revision.packetId)!;
 expect(packet.review).toMatchObject({reviewMode:'run',runEvidence:{status:'run',headSha:input.head,principal:{role:'assigned_reviewer',source:'server_review_turn',packetId:packet.id}}});
 expect(packet.review?.findings[0].resolution).toBe('deferred'); expect(packet.review?.reviewedHeadSha).toBe(input.head);
 const { correctAuthorFromReview } = await import('@/lib/orchestrator/review-author-correction');
 await expect(correctAuthorFromReview({repoPath:repo,threadId:'external',review:{packetId:packet.id,approvalId:packet.review!.auditApprovalId!, reviewedHeadSha:input.head,surfaceId:'codex-owned:reviewer',runId:'reviewer'}})).rejects.toThrow();
 const { getTaskPool } = await import('@/lib/tasks/pool');
 const pool = await getTaskPool({repoPath:repo,includeDone:true}); expect(pool.tasks.filter(t => t.externalReview)).toHaveLength(1);
 execFileSync('git',['-C',repo,'config','--unset-all',`url.${repo}/.insteadOf`]); await addRepo(repo);
}, 60000);
it('keeps the old verdict on its revision when another head is adopted', async () => {
 const old = listExternalReviews()[0]; expect(old.state).toBe('sent_back');
 execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'successor']);
 input.head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
 const next = await (await POST(request())).json(); expect(next.taskId).toBe(old.taskId); expect(next.state).toBe('waiting'); expect(next.revision.packetId).not.toBe(old.revision.packetId);
});
it('refuses worker and read-only credentials', async () => {
 const {getOrCreateLocalWorkerToken} = await import('@/lib/auth/worker-token');
 const {mintReadOnlyWorkerToken} = await import('@/lib/auth/read-only-worker-token');
 for (const token of [getOrCreateLocalWorkerToken(),mintReadOnlyWorkerToken('fixture')]) expect((await POST(request(token))).status).toBe(403);
});
it('routes CLI and MCP adoption to the same operator route', async () => {
 const original = globalThis.fetch;
 vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => POST(new NextRequest(String(url), {method:init?.method,headers:init?.headers,body:init?.body})));
 try {
  vi.stubEnv('O8_API_TOKEN',getOrCreateWsToken());
  const {handleAdoptPr} = await import('@/lib/mcp/operator-handlers/adopt-pr');
  const mcp = await handleAdoptPr({repoPath:repo,pullRequest:'https://github.com/example/repo/pull/7',intendedOutcome:'Preserve behavior.'});
  expect(mcp.isError).not.toBe(true);
  const {runTaskAdoptPr} = await import('../cli/src/commands/task');
  const output = vi.spyOn(process.stdout,'write').mockImplementation(() => true);
  try { expect(await runTaskAdoptPr({human:false,verbose:false},['7','--repo',repo,'--intended-outcome','Preserve behavior.'])).toBe(0);
   const cli = JSON.parse(String(output.mock.calls[0][0])); const content = mcp.content[0]; if (content.type !== 'text') throw new Error('Expected a JSON tool result.'); const tool = JSON.parse(content.text); expect(cli.taskId).toBe(tool.taskId); expect(cli.revision.id).toBe(tool.revision.id); }
  finally { output.mockRestore(); }
  expect(listExternalReviews()).toHaveLength(1);
 } finally { vi.stubGlobal('fetch', original); }
});
it('requires an affirmative operator token even on loopback', async () => { expect((await POST(request('invalid'))).status).toBe(403); });
async function adopt(body: Record<string, unknown> = {}) {
 return POST(new NextRequest('http://localhost/api/tasks/adopt-pr', {method:'POST',headers:{authorization:`Bearer ${getOrCreateWsToken()}`},body:JSON.stringify({repoPath:repo,pullRequest:7,...body})}));
}
async function prepareReview() {
 execFileSync('git', ['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','review candidate']);
 input.head = execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 execFileSync('git',['-C',repo,'config',`url.${repo}/.insteadOf`,'https://github.com/example/repo.git']);
 execFileSync('git',['-C',repo,'update-ref','refs/pull/7/head',input.head]);
 const response = await adopt(); expect(response.status).toBe(200); const task = await response.json();
 const {POST:start} = await import('@/lib/tasks/http/dispatch');
 const started = await start(new NextRequest(`http://localhost/api/tasks/${task.taskId}/dispatch`,{method:'POST',headers:{authorization:`Bearer ${getOrCreateWsToken()}`},body:'{}'}),{params:Promise.resolve({taskId:task.taskId})});
 expect(started.status,await started.clone().text()).toBe(200);
 execFileSync('git',['-C',repo,'config','--unset-all',`url.${repo}/.insteadOf`]);
 await addRepo(repo);
 return task;
}
async function detail(taskId: string) {
 const {GET} = await import('@/lib/tasks/detail-route');
 const response = await GET(new NextRequest(`http://localhost/api/tasks/${taskId}`,{headers:{authorization:`Bearer ${getOrCreateWsToken()}`}}),{params:Promise.resolve({taskId})});
 expect(response.status).toBe(200); return (await response.json()).task;
}
it('accepts a registered repository through a symlink', async () => {
 const alias = join(root,'repo-alias'); symlinkSync(repo,alias,'dir');
 expect((await adopt({repoPath:alias})).status).toBe(200);
});
it('keeps an omitted outcome at the same head and records draft state', async () => {
 input.draft=true;
 try {
  const first = await (await adopt({intendedOutcome:'Keep this outcome.'})).json();
  const second = await (await adopt()).json();
  expect(second.revision.id).toBe(first.revision.id);
  expect(second.revision.intendedOutcome).toBe('Keep this outcome.');
  expect(second.revision.draft).toBe(true);
  expect(second.revision.packetId).toMatch(/^pkt-pr-review-/);
 } finally {input.draft=false;}
});
it('returns safe input, upstream and state errors', async () => {
 for (const pullRequest of ['0x10','1e3',' 7 ','0','-1','1.5','https://github.com/another/repo/pull/7']) {
  const response=await adopt({pullRequest}); expect(response.status).toBe(400);
 }
 const malformed=await POST(new NextRequest('http://localhost/api/tasks/adopt-pr',{method:'POST',headers:{authorization:`Bearer ${getOrCreateWsToken()}`},body:'{'})); expect(malformed.status).toBe(400);
 input.hostFailure=true;
 try {const response=await adopt(); expect(response.status).toBe(502); expect(await response.text()).not.toContain('Private');} finally {input.hostFailure=false;}
 for (const merged of [false,true]) {
  input.state='closed'; input.merged=merged;
  try {const response=await adopt(); expect(response.status).toBe(409); expect((await response.json()).error).toMatch(merged?/merged/i:/closed/i);} finally {input.state='open';input.merged=false;}
 }
});
it('refuses a stale concurrent adoption instead of moving the pointer backwards', async () => {
 let release!:()=>void; let arrived!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}); const waiting=new Promise<void>(resolve=>{arrived=resolve;});
 input.hostHook=async()=>{input.hostHook=null;arrived();await blocked;};
 const stale=adopt(); await waiting;
 execFileSync('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','concurrent successor']);
 input.head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 try {
  const fresh=await (await adopt()).json(); release();
  const refused=await stale; expect(refused.status).toBe(409); expect((await refused.json()).error).toMatch(/re-adopt/i);
  expect(readExternalReview(fresh.taskId)?.revision.id).toBe(fresh.revision.id);
 } finally {release();input.hostHook=null;await stale;}
});
it('records the external reviewer fallback final-line verdict at the saved head',async()=>{
 const task=await prepareReview();const {findLaneByPacket}=await import('@/lib/lane/registry');const lane=findLaneByPacket(task.revision.packetId)!;
 const {getSqlite}=await import('@/lib/db');getSqlite().prepare("UPDATE review_queue SET status='completed' WHERE lane_id != ? AND status='pending'").run(lane.id);
 const {updateOperatorDefaults}=await import('@/lib/operator/defaults');updateOperatorDefaults({subscriptionProfile:'both'});input.primaryQuota=true;
 try{const {drainReviewQueue}=await import('@/lib/lane/auto-review');await drainReviewQueue();}finally{input.primaryQuota=false;}
 const {readOrchestratorControlPlaneState}=await import('@/lib/orchestrator/control-plane');expect(readOrchestratorControlPlaneState().packets.find(p=>p.id===task.revision.packetId)?.review).toMatchObject({approved:false,reviewedHeadSha:task.revision.headSha});
 const {getLaneEvents}=await import('@/lib/lane/registry');expect(getLaneEvents(lane.id,100).some(event=>event.verb==='review_fallback')).toBe(true);
 expect(readExternalReview(task.taskId)?.state).toBe('sent_back');
},60000);
it.each(['submit_review','o8_approve'] as const)('keeps external verdicts on their queued path through %s',async surface=>{
 const task=await prepareReview(); const {getApproval,createApproval,listApprovalsForContext}=await import('@/lib/approvals/store');
 const approval=surface==='o8_approve'?createApproval({source:'runtime',runtime:'codex',agent:'Fixture reviewer',sessionKey:'fixture-review',title:'Queued review',description:'Review decision',summary:'Pending review',toolName:'orchestrator_review',risk:'low',args:{packetId:task.revision.packetId,approved:true,reviewedHeadSha:task.revision.headSha}}):null;
 const original=globalThis.fetch;
 vi.stubGlobal('fetch',async(url:string|URL|Request,init?:RequestInit)=>{
  const req=new NextRequest(String(url),{method:init?.method,headers:init?.headers,body:init?.body});
  return surface==='submit_review'?reviewPost(req):approvalPost(req);
 });
 try{
  const result=surface==='submit_review'?await handleSubmitReview({packetId:task.revision.packetId,approved:true,findings:[],reviewedHeadSha:task.revision.headSha})
   :await handleApprove({id:approval!.id});
  expect(result.isError,JSON.stringify(result)).toBe(true);
 }finally{vi.stubGlobal('fetch',original);}
 const {readOrchestratorControlPlaneState}=await import('@/lib/orchestrator/control-plane');
 expect(readOrchestratorControlPlaneState().packets.find(p=>p.id===task.revision.packetId)?.review).toBeFalsy();
 if(approval)expect(getApproval(approval.id)?.status).toBe('pending');
 expect(listApprovalsForContext({packetId:task.revision.packetId}).filter(row=>row.status==='approved')).toHaveLength(0);
});
it('requires the revision head when the worktree and completed turn agree on another head',async()=>{
 const task=await prepareReview();const {findLaneByPacket}=await import('@/lib/lane/registry');const lane=findLaneByPacket(task.revision.packetId)!;
 const {getSqlite}=await import('@/lib/db');const db=getSqlite();
 // Select this queued attempt with the production claimer, independently of earlier fixture attempts.
 db.prepare("UPDATE review_queue SET status='completed' WHERE lane_id != ? AND status='pending'").run(lane.id);
 const {claimNextReview}=await import('@/lib/lane/review-drain-recovery');const claim=claimNextReview()!;expect(claim.lane_id).toBe(lane.id);
 const cwd=lane.worktreePath || lane.repoPath;
 execFileSync('git',['-C',cwd,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','another reviewed commit']);
 const head=execFileSync('git',['-C',cwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim();expect(head).not.toBe(task.revision.headSha);
 const {startReviewTurn,finishReviewTurn}=await import('@/lib/lane/review-turn-state');
 const turn=startReviewTurn({laneId:lane.id,threadId:`auto-review-${lane.id}-${claim.id}`,sessionThreadId:'thoughts-auto-review-head-fixture',backend:'codex',surface:'auto-review',expectedHeadSha:head});
 finishReviewTurn({laneId:lane.id,reviewTurnId:turn,outcome:'completed'});
 let refusal:unknown;
 try{const {submitPacketReview}=await import('@/lib/orchestrator/operator-mission-service/review');await submitPacketReview({packetId:task.revision.packetId,approved:false,findings:[{file:'answer.txt',severity:'note',description:'Retain the request.',resolution:'deferred'}],reviewedHeadSha:head},{externalReview:true,completedCorrectionTurnId:turn,claimOwner:claim.claim_owner!});}catch(error){refusal=error;}
 finally{db.prepare("UPDATE review_queue SET status='completed' WHERE id=?").run(claim.id);}
 expect(refusal).toBeInstanceOf(Error);expect((refusal as Error).message).toBe('The external review turn was interrupted or superseded.');
 const {readOrchestratorControlPlaneState}=await import('@/lib/orchestrator/control-plane');expect(readOrchestratorControlPlaneState().packets.find(p=>p.id===task.revision.packetId)?.review).toBeFalsy();
 const {listApprovalsForContext}=await import('@/lib/approvals/store');expect(listApprovalsForContext({packetId:task.revision.packetId}).filter(row=>row.toolName==='orchestrator_review')).toHaveLength(0);
},60000);
it('refuses a completed reviewer turn started for another head', async () => {
 const task=await prepareReview();
 const {getSqlite}=await import('@/lib/db'); const {findLaneByPacket}=await import('@/lib/lane/registry');
 const lane=findLaneByPacket(task.revision.packetId)!;
 input.beforeVerdict=async()=>{
  const db=getSqlite(); const row=db.prepare("SELECT rowid,payload_json FROM lane_events WHERE lane_id=? AND verb='review_turn_started' ORDER BY rowid DESC LIMIT 1").get(lane.id) as {rowid:number;payload_json:string};
  const payload=JSON.parse(row.payload_json);payload.expectedHeadSha=input.base;
  db.prepare('UPDATE lane_events SET payload_json=? WHERE rowid=?').run(JSON.stringify(payload),row.rowid);
 };
 try {const {drainReviewQueue}=await import('@/lib/lane/auto-review');await drainReviewQueue();} finally {input.beforeVerdict=null;}
 const {readOrchestratorControlPlaneState}=await import('@/lib/orchestrator/control-plane');
 expect(readOrchestratorControlPlaneState().packets.find(p=>p.id===task.revision.packetId)?.review).toBeFalsy();
 const projected=await detail(task.taskId);expect(['approved','sent_back']).not.toContain(projected.externalReview.state);
 const {listApprovalsForContext}=await import('@/lib/approvals/store');
 expect(listApprovalsForContext({packetId:task.revision.packetId}).filter(row=>row.toolName==='orchestrator_review')).toHaveLength(0);
},60000);
it.each([true,false])('does not project a packet verdict for another reviewed head (approved=%s)',async approved=>{
 const task=await prepareReview();
 const {withLockedState,readOrchestratorControlPlaneState}=await import('@/lib/orchestrator/control-plane');
 await withLockedState(state=>{
  const packet=state.packets.find(p=>p.id===task.revision.packetId)!;
  packet.review={approved,summary:'Stale persisted verdict',findings:[],reviewedHeadSha:input.base,recordedAt:new Date().toISOString()};
 });
 try {
  const projected=await detail(task.taskId);expect(['approved','sent_back']).not.toContain(projected.externalReview.state);
  expect(readOrchestratorControlPlaneState().packets.find(p=>p.id===task.revision.packetId)?.review?.auditApprovalId).toBeFalsy();
  const {listApprovalsForContext}=await import('@/lib/approvals/store');
  expect(listApprovalsForContext({packetId:task.revision.packetId}).filter(row=>row.toolName==='orchestrator_review')).toHaveLength(0);
 } finally {
  await withLockedState(state=>{state.packets.find(p=>p.id===task.revision.packetId)!.review=null;});
 }
});
it('retains an older live revision when the external overview contains 100 newer tasks',async()=>{
 const old=await prepareReview();
 for(let i=2000;i<2100;i++){const response=await adopt({pullRequest:i});expect(response.status,await response.clone().text()).toBe(200);}
 expect(listExternalReviews()).toHaveLength(100);expect(listExternalReviews().some(t=>t.taskId===old.taskId)).toBe(false);
 const {getTaskPool}=await import('@/lib/tasks/pool');const pool=await getTaskPool({includeDone:true});
 expect(pool.tasks.some(t=>t.packetId===old.revision.packetId)).toBe(true);
 expect((await detail(old.taskId)).externalReview.revision.id).toBe(old.revision.id);
});
it('bounds listings, reads old tasks directly, and tolerates a missing revision',async()=>{
 const first=await (await adopt({pullRequest:1000})).json();
 for(let i=1001;i<1105;i++)expect((await adopt({pullRequest:i})).status).toBe(200);
 const control=await import('@/lib/orchestrator/control-plane');const registry=await import('@/lib/orchestrator/mission-registry');
 const controlRead=vi.spyOn(control,'readOrchestratorControlPlaneState');const registryRead=vi.spyOn(registry,'listMissionRegistryEntries');
 try {expect(listExternalReviews().length).toBeLessThanOrEqual(100);expect(controlRead.mock.calls.length).toBeLessThanOrEqual(1);expect(registryRead.mock.calls.length).toBeLessThanOrEqual(1);}finally{controlRead.mockRestore();registryRead.mockRestore();}
 expect((await detail(first.taskId)).id).toBe(first.taskId);
 const {getSqlite}=await import('@/lib/db');const db=getSqlite();
 const {getTaskPool}=await import('@/lib/tasks/pool');
 const stateRead=vi.spyOn(control,'readOrchestratorControlPlaneState');const historyRead=vi.spyOn(registry,'listMissionRegistryEntries');const queries=vi.spyOn(db,'prepare');
 try {await getTaskPool({includeDone:true});expect(stateRead.mock.calls.length).toBeLessThanOrEqual(1);expect(historyRead.mock.calls.length).toBeLessThanOrEqual(1);expect(queries.mock.calls.filter(([sql])=>/external_pr_review_revisions WHERE task_id = \?/.test(sql))).toHaveLength(0);}finally{stateRead.mockRestore();historyRead.mockRestore();queries.mockRestore();}
 const newest=listExternalReviews()[0];
 db.pragma('foreign_keys=OFF');db.prepare('UPDATE external_pr_review_tasks SET current_revision_id=? WHERE id=?').run('missing',newest.taskId);
 try {const {getTaskPool}=await import('@/lib/tasks/pool');await expect(getTaskPool({includeDone:true})).resolves.toBeDefined();}
 finally {db.prepare('UPDATE external_pr_review_tasks SET current_revision_id=? WHERE id=?').run(newest.revision.id,newest.taskId);db.pragma('foreign_keys=ON');}
});
it('adds draft metadata to the original v81 shape safely twice without rewriting rows',async()=>{
 const Database=(await import('better-sqlite3')).default;const db=new Database(':memory:');
 try {
  db.exec(`CREATE TABLE external_pr_review_tasks (id TEXT PRIMARY KEY,repo_id TEXT,repo_path TEXT,repository_id TEXT,pr_number INTEGER,pr_url TEXT,current_revision_id TEXT);
   CREATE TABLE external_pr_review_revisions (id TEXT PRIMARY KEY,task_id TEXT,sequence INTEGER,predecessor_id TEXT,head_sha TEXT,base_sha TEXT,base_ref TEXT,intended_outcome TEXT,packet_id TEXT,adopted_at TEXT,run_evidence_id TEXT);
   INSERT INTO external_pr_review_revisions VALUES ('old','task',1,NULL,'head','base','main','Keep me','packet','then',NULL);`);
  const {ensureV81ExternalPrReviewSchema}=await import('@/lib/db/v81-external-pr-review-migration');
  ensureV81ExternalPrReviewSchema(db);ensureV81ExternalPrReviewSchema(db);
  expect(db.prepare('SELECT intended_outcome,draft FROM external_pr_review_revisions').get()).toEqual({intended_outcome:'Keep me',draft:null});
 }finally{db.close();}
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
