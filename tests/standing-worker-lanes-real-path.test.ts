import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import type { StandingTask } from '@/lib/lane/standing-store';
import type { PacketReceipt } from '@/lib/receipts/types';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import type { AgentSummary } from '@/lib/fleet/types';
type StandingStatus = ReturnType<typeof import('@/lib/lane/standing').standingLaneStatus>;
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The external worker and GitHub CLI are finite fixtures. MCP, CLI, lane commands,
// runtime session persistence, worktrees, packet state and signed receipts are real.
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-sol': [] } }) }));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'standing-'));
const repo = join(root, 'repo');
const bin = join(root, 'bin');
const captures = join(root, 'turns');
const ownedRoot = join(root, 'owned-codex');
const originalEnv = { ...process.env };
mkdirSync(repo); mkdirSync(bin); mkdirSync(captures);
Object.assign(process.env, {
  CORTEX_IDE_DATA_DIR: root, O8_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'state.db'),
  CORTEX_IDE_OWNED_CODEX_ROOT: ownedRoot, O8_CODEX_BIN: join(bin, 'codex'),
  O8_WORKTREE_ROOT: join(root, 'worktrees'), O8_CRASH_SURVIVABLE_WORKERS: '0',
  O8_PACKAGED_APP: '0', O8_SKIP_PRELAUNCH_TYPECHECK: '1',
  PATH: `${bin}:${process.env.PATH}`,
});
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-qb', 'main');
git('config', 'user.name', 'o8-test'); git('config', 'user.email', 'o8@example.test');
writeFileSync(join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
writeFileSync(join(repo, '.gitignore'), '.env.local\n.codex/\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore local task settings');
git('remote', 'add', 'origin', repo);
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const args = process.argv.slice(2); if (!args.some(arg => arg.includes('LANE_TASK='))) process.exit(0); const resumed = args.includes('resume');
const thread = resumed ? args[args.indexOf('resume') + 1] : 'standing-thread-' + process.pid;
const prompt = args.join(' '); const task = /LANE_TASK=(\\w+)/.exec(prompt)?.[1] || 'steer';
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
const row = { task, thread, resumed, packetId:process.env.O8_WORKER_PACKET_ID, branch:git('branch','--show-current'), base:git('rev-parse','HEAD'), clean:git('status','--porcelain') === '', outputAt:Date.now(), args };
fs.writeFileSync(path.join(${JSON.stringify(captures)}, task + '.json'), JSON.stringify(row));
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
console.log(JSON.stringify({type:'item.completed',item:{id:task,type:'agent_message',text:'FIRST_OUTPUT ' + task}}));
const finish = () => {
 if (task === 'ignored') { fs.mkdirSync('.codex', {recursive:true}); fs.writeFileSync('.env.local','FIXTURE_MODE=previous-task'); fs.writeFileSync('.codex/config.toml','fixture_mode = true'); }
 if (task !== 'steer') { fs.writeFileSync(task + '.txt',task); if(task !== 'dirty') { git('add',task + '.txt'); git('-c','user.name=o8-test','-c','user.email=o8@example.test','commit','-qm','fix: lane task ' + task); } }
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
};
if (task === 'immediate') {
 const port = fs.readFileSync(${JSON.stringify(join(root, 'api-port'))}, 'utf8');
 fetch('http://127.0.0.1:' + port + '/api/panel/managed-runs', {method:'POST', headers:{'Content-Type':'application/json',authorization:'Bearer ' + process.env.O8_WORKER_TOKEN}, body:JSON.stringify({action:'register',id:'immediate' + process.pid,session:'cortex-run-immediate' + process.pid,command:'fixture command',cwd:process.cwd(),packetId:process.env.O8_WORKER_PACKET_ID,mode:'detach'})})
 .then(async response => { fs.writeFileSync(${JSON.stringify(join(captures, 'immediate-registration.json'))}, JSON.stringify({status:response.status})); finish(); });
} else if(task === 'blocking') { fs.writeFileSync('in-progress.txt','working'); setTimeout(() => {fs.unlinkSync('in-progress.txt');finish();},30000); } else finish();
`);
writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const file = ${JSON.stringify(join(root, 'prs.json'))}; const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
const args = process.argv.slice(2);
if(args[0] === 'pr' && args[1] === 'create') { const branch = args[args.indexOf('--head')+1]; if(rows.some(r=>r.branch === branch)) process.exit(9); rows.push({branch,number:rows.length+1,args}); fs.writeFileSync(file,JSON.stringify(rows)); console.log('https://github.com/fixture/repo/pull/' + rows.length); }
else if(args[0] === 'pr' && args[1] === 'list') { const gate = ${JSON.stringify(join(root, 'publication-gate'))}; if(fs.existsSync(gate)){fs.writeFileSync(${JSON.stringify(join(root, 'publication-entered'))},'entered'); while(fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); } const branch=args[args.indexOf('--head')+1]; console.log(JSON.stringify(rows.filter(r=>r.branch===branch).map(r=>({number:r.number,url:'https://github.com/fixture/repo/pull/'+r.number,state:'OPEN',headRefName:r.branch})))); }
else if(args[0] === 'pr' && args[1] === 'view') { const branch = cp.execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const row=rows.find(r=>r.branch===branch); if(!row) process.exit(1); console.log(JSON.stringify({number:row.number,url:'https://github.com/fixture/repo/pull/'+row.number,state:'OPEN',headRefName:branch})); }
else process.exit(8);
`);
chmodSync(join(bin, 'codex'), 0o755); chmodSync(join(bin, 'gh'), 0o755);
// These fixtures have no tmux transport; real marker/process probes own their trees.
writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'tmux'), 0o755);
let server: Server;
let base = '';
let port = 0;
let token = '';
let host: typeof import('@/lib/mcp/operator-mcp-host');
function stopServerTimers() {
  const globals = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>;
  for (const key of Object.getOwnPropertySymbols(globals)) {
    if (Symbol.keyFor(key)?.startsWith('o8.ownedSession.refreshTimer.')) { clearInterval(globals[key]); delete globals[key]; }
  }
}
async function start() {
  host = await import('@/lib/mcp/operator-mcp-host');
  token = (await import('@/lib/ws-auth')).getOrCreateWsToken();
  const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const request = new NextRequest(`${base}${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(bytes.length ? { body: bytes } : {}) });
      let response: Response;
      if (incoming.url?.startsWith('/api/orchestrator/standing-lanes')) {
        const route = await import('@/app/api/orchestrator/standing-lanes/route');
        response = await route.POST(request);
      } else if (incoming.url?.startsWith('/api/panel/managed-runs')) {
        response = await (await import('@/app/api/panel/managed-runs/route')).POST(request);
      } else response = new Response('{}');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  port = (server.address() as { port: number }).port; base = `http://127.0.0.1:${port}`;
  process.env.O8_API_PORT = String(port); setApiBase(base);
  writeFileSync(join(root, 'api-port'), String(port));
}
async function tool(action: string, args: Record<string, unknown> = {}, fail = false) {
  const response = await host.handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `o8_lane_${action}`, arguments: args } });
  const result = response!.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError === true, result.content[0]?.text).toBe(fail);
  return fail ? result.content[0].text : JSON.parse(result.content[0].text);
}
async function cli(...args: string[]) {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve('cli/dist/o8.mjs'), 'lane', ...args], {
    env: { ...process.env, O8_API_TOKEN: token, O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '' }, cwd: repo,
  });
  return JSON.parse(stdout);
}
async function idle(laneId: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await tool('status', { laneId }) as StandingStatus;
    if (status.blockedReason) {
      const record = status.lane.sessionKey ? await (await import('@/lib/runtimes/shared/owned-session-index')).readOwnedSessionRecord(status.lane.sessionKey) : null;
      const run = record?.recentRuns[0];
      const detail = run && existsSync(run.stderrPath) ? readFileSync(run.stderrPath, 'utf8').replaceAll(root, '<fixture>') : '';
      const task = status.currentTask;
      const exact = record?.recentRuns.find(run => run.id === task?.runId);
      const proof = { tasks: status.tasks.length, packetMatches: record?.packetId === task?.id,
        lanePacketMatches: status.lane.packetId === task?.id, branchMatches: status.lane.branch === task?.branch,
        runFound: Boolean(exact), promptMatches: exact?.prompt.includes(`Standing worker task ${task?.id}.`),
        outcome: exact?.outcome, spawnState: exact?.spawnState, childExit: exact?.childExit?.classification,
        timeOrdered: Boolean(exact && task?.startedAt && exact.startedAt >= task.startedAt) };
      throw new Error(status.blockedReason + '\n' + JSON.stringify(proof) + '\n' + detail);
    }
    if (!status.currentTask) return status;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Standing task did not settle.');
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['cli/esbuild.config.mjs']);
  await start();
}, 120000);
afterAll(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv); rmSync(root, { recursive: true, force: true });
});

it('runs two MCP/CLI tasks on one pinned session and clean current-base branches with separate signed PR receipts, then resumes after server restart', async () => {
  const denied = await fetch(`${base}/api/orchestrator/standing-lanes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high', actor: 'user' }) });
  expect(denied.status).toBe(403);
  const created = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high', label: 'Standing fixture' });
  const laneId = created.lane.id;
  expect((await tool('list')).lanes.map((row: StandingStatus) => row.lane.id)).toContain(laneId);
  await tool('send', { laneId, task: 'LANE_TASK=first', idempotencyKey: 'standing-first-task' });
  await tool('send', { laneId, task: 'LANE_TASK=first', idempotencyKey: 'standing-first-task' });
  const first = await idle(laneId);
  const firstTurn = JSON.parse(readFileSync(join(captures, 'first.json'), 'utf8'));
  writeFileSync(join(repo, 'base.txt'), 'advanced base\n'); git('add', '.'); git('commit', '-qm', 'advance base');
  const currentBase = git('rev-parse', 'main');
  const started = Date.now();
  await cli('send', laneId, '--task', 'LANE_TASK=second');
  const second = await idle(laneId);
  const secondTurn = JSON.parse(readFileSync(join(captures, 'second.json'), 'utf8'));
  const dispatchToOutputMs = secondTurn.outputAt - started;
  expect(second.lane.sessionKey).toBe(first.lane.sessionKey);
  expect(secondTurn.thread).toBe(firstTurn.thread); expect(secondTurn.resumed).toBe(true);
  expect(secondTurn.clean).toBe(true); expect(secondTurn.base).toBe(currentBase);
  expect(secondTurn.branch).not.toBe(firstTurn.branch);
  expect(secondTurn.packetId).toBe(second.tasks[1].id);
  expect(secondTurn.packetId).not.toBe(firstTurn.packetId);
  expect(secondTurn.args).toContain('gpt-5.6-sol');
  expect(secondTurn.args).toContain('model_reasoning_effort=high');
  const { listStoredPacketReceipts } = await import('@/lib/receipts/packet-receipt');
  const receipts = second.tasks.map((task: StandingTask) => listStoredPacketReceipts(task.id)[0]?.receipt);
  expect(receipts).toHaveLength(2); expect(receipts.every(Boolean)).toBe(true);
  expect(receipts.map((receipt: PacketReceipt) => receipt.task!.branch)).toEqual([firstTurn.branch, secondTurn.branch]);
  expect(receipts.map((receipt: PacketReceipt) => receipt.task!.prNumber)).toEqual([1, 2]);
  expect(receipts.every((receipt: PacketReceipt) => receipt.task!.commit && receipt.task!.verification.length > 0)).toBe(true);
  const { verifyPacketReceipt } = await import('@/lib/receipts/verify-receipt');
  const { getReceiptIdentityPublicKey } = await import('@/lib/receipts/receipt-identity');
  for (const receipt of receipts) expect((await verifyPacketReceipt({ receipt, publicKeyB64: getReceiptIdentityPublicKey() })).ok).toBe(true);
  expect(JSON.parse(readFileSync(join(root, 'prs.json'), 'utf8'))).toHaveLength(2);
  expect(git('rev-parse', 'main')).toBe(currentBase);
  expect((await cli('transcript', laneId)).transcript.map((row: RuntimeTranscriptEntry) => row.text).join('\n')).toContain('FIRST_OUTPUT second');
  expect((await tool('transcript', { laneId })).transcript.map((row: RuntimeTranscriptEntry) => row.text).join('\n')).toContain('FIRST_OUTPUT first');
  await cli('steer', laneId, '--message', 'LANE_TASK=steer');
  await vi.waitFor(() => expect(existsSync(join(captures, 'steer.json'))).toBe(true), { timeout: 30000 });
  const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
  await vi.waitFor(async () => expect((await readOwnedSessionRecord(first.lane.sessionKey!))?.activeRun).toBeFalsy(), { timeout: 30000 });
  await new Promise<void>(done => server.close(() => done())); stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.resetModules(); await start();
  expect((await cli('status', laneId)).lane.sessionKey).toBe(first.lane.sessionKey);
  await tool('send', { laneId, task: 'LANE_TASK=third' }); await idle(laneId);
  expect(JSON.parse(readFileSync(join(captures, 'third.json'), 'utf8')).thread).toBe(firstTurn.thread);
  // The dedicated speed command enforces the two-second target on all three samples.
  // Functional lifecycle checks also run on shared runners with variable scheduling.
  const measurement = { dispatchToOutputMs, runtimeSessionReused: true, tasks: 2, pullRequests: 2 };
  process.stdout.write('[standing-lane-speed] ' + JSON.stringify(measurement) + '\n');
  if (process.env.O8_SPEED_RECEIPT) writeFileSync(process.env.O8_SPEED_RECEIPT, JSON.stringify(measurement));
}, 120000);

it('exposes create/list/steer/stop/remove through the CLI and never starts queued work after stop', async () => {
  const created = await cli('create', '--repo', repo, '--runtime', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'high');
  const laneId = created.lane.id;
  expect((await cli('list')).lanes.some((row: StandingStatus) => row.lane.id === laneId)).toBe(true);
  await cli('send', laneId, '--task', 'LANE_TASK=blocking');
  await vi.waitFor(() => expect(existsSync(join(captures, 'blocking.json'))).toBe(true), { timeout: 30000 });
  await tool('send', { laneId, task: 'LANE_TASK=queued' });
  expect((await tool('status', { laneId })).queueDepth).toBe(1);
  const inventory = await import('@/app/api/runtime/inventory/route');
  const snapshot = await (await inventory.GET(new NextRequest(`${base}/api/runtime/inventory?fresh=1`))).json();
  expect(snapshot.agents.find((agent: AgentSummary) => agent.standingLane?.laneId === laneId)?.standingLane).toMatchObject({ currentTask: 'LANE_TASK=blocking', queueDepth: 1 });
  expect((await cli('steer', laneId, '--message', 'Keep this task bounded.')).steer.deliveryState).toBe('queued');
  await cli('stop', laneId);
  expect((await tool('status', { laneId })).stopped).toBe(true);
  await new Promise<void>(done => server.close(() => done())); stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.resetModules(); await start();
  expect((await tool('status', { laneId })).stopped).toBe(true);
  expect(existsSync(join(captures, 'queued.json'))).toBe(false);
  await tool('send', { laneId, task: 'LANE_TASK=refused' }, true);
  await cli('remove', laneId);
  expect((await tool('list')).lanes.some((row: StandingStatus) => row.lane.id === laneId)).toBe(false);
}, 120000);

it('refuses task N+1 when the previous task leaves uncommitted files', async () => {
  const created = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const laneId = created.lane.id;
  await tool('send', { laneId, task: 'LANE_TASK=dirty' });
  await vi.waitFor(() => expect(existsSync(join(captures, 'dirty.json'))).toBe(true), { timeout: 30000 });
  await vi.waitFor(async () => expect((await tool('status', { laneId })).blockedReason).toMatch(/uncommitted/i), { timeout: 30000 });
  await tool('send', { laneId, task: 'LANE_TASK=must_not_start' }, true);
  expect(existsSync(join(captures, 'must_not_start.json'))).toBe(false);
}, 60000);


it('fences pull request publication when stop wins during the GitHub lookup', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const gate = join(root, 'publication-gate');
  const count = () => existsSync(join(root, 'prs.json')) ? JSON.parse(readFileSync(join(root, 'prs.json'), 'utf8')).length : 0;
  const before = count();
  writeFileSync(gate, 'wait');
  try {
    await tool('send', { laneId: lane.id, task: 'LANE_TASK=publication' });
    await vi.waitFor(() => expect(existsSync(join(captures, 'publication.json'))).toBe(true), { timeout: 30000 });
    const status = tool('status', { laneId: lane.id });
    await vi.waitFor(() => expect(existsSync(join(root, 'publication-entered'))).toBe(true), { timeout: 30000 });
    await tool('stop', { laneId: lane.id });
    rmSync(gate);
    await status;
    expect(count()).toBe(before);
    expect((await tool('status', { laneId: lane.id })).stopped).toBe(true);
  } finally { rmSync(gate, { force: true }); }
}, 60000);


it('does not attribute the previous finished run to a dispatch interrupted before checkout across restart', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=checkpoint' });
  const completed = await idle(lane.id);
  const { saveStandingLane } = await import('@/lib/lane/standing-store');
  // Persist the exact crash boundary: admitted N+1, but no branch change or runtime turn yet.
  const id = 'pkt-11111111-1111-4111-8111-111111111111';
  saveStandingLane(lane.id, { ...completed, tasks: [...completed.tasks, { id,
    prompt: 'LANE_TASK=undispatched', branch: `lane/${lane.id}/${id}`, baseCommit: git('rev-parse','main'),
    startedAt: new Date().toISOString(), phase: 'dispatching' }] });
  await new Promise<void>(done => server.close(() => done())); stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.resetModules(); await start();
  const status = await tool('status', { laneId: lane.id });
  expect(status.tasks.at(-1).phase).not.toBe('done');
  expect(status.blockedReason).toMatch(/dispatch|task|run/i);
  expect((await import('@/lib/receipts/packet-receipt')).listStoredPacketReceipts(id)).toHaveLength(0);
  expect(existsSync(join(captures, 'undispatched.json'))).toBe(false);
}, 90000);


it('keeps the task run receipt when steering a settled run before completion reconciliation', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const sent = await tool('send', { laneId: lane.id, task: 'LANE_TASK=settled' });
  const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
  await vi.waitFor(async () => {
    const record = await readOwnedSessionRecord(sent.lane.sessionKey);
    expect(record).not.toBeNull(); expect(record?.activeRun).toBeFalsy();
  }, { timeout: 30000 });
  await tool('steer', { laneId: lane.id, message: 'LANE_TASK=steer' });
  const completed = await idle(lane.id);
  expect(completed.tasks[0].phase).toBe('done');
  expect(completed.tasks[0].receiptId).toBeTruthy();
  await tool('remove', { laneId: lane.id });
  expect((await tool('list')).lanes.some((row: StandingStatus) => row.lane.id === lane.id)).toBe(false);
}, 90000);

it('keeps an idle standing worker in the real grid inventory after the ordinary session age window', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=aged' });
  const settled = await idle(lane.id);
  expect(settled.lane.sessionKey).toBeTruthy();
  const { GET } = await import('@/app/api/runtime/inventory/route');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90 * 24 * 60 * 60 * 1000);
  try {
    const snapshot = await (await GET(new NextRequest(`${base}/api/runtime/inventory?fresh=1`))).json();
    expect(snapshot.agents.some((agent: AgentSummary) => agent.standingLane?.laneId === lane.id)).toBe(true);
  } finally { clock.mockRestore(); }

}, 90000);

it('settles detached packet-managed work before a CLI handoff reuses the checkout', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=managed_parent' });
  const first = await idle(lane.id);
  const marker = `standing-managed-${lane.id}`;
  const release = join(root, 'managed-release');
  const ready = join(root, 'managed-ready');
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) {
      fs.writeFileSync('previous-task-wrote.txt', 'cross-task write'); clearInterval(timer);
    } }, 20);
  `], { cwd: first.lane.worktreePath!, detached: true, stdio: 'ignore', env: { ...process.env, O8_MANAGED_RUN_MARKER: marker } });
  const exited = once(writer, 'exit');
  const { registerManagedRun, findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    registerManagedRun({ id: marker, session: `cortex-run-${marker}`, command: 'fixture detached writer',
      cwd: first.lane.worktreePath!, packetId: first.tasks[0].id, laneId: lane.id,
      processMarker: marker, mode: 'detach', startedAt: new Date().toISOString(), status: 'running' });
    await cli('send', lane.id, '--task', 'LANE_TASK=managed_successor');
    await idle(lane.id);
    expect(findManagedRun(marker)?.termination?.confirmedDead).toBe(true);
    await exited;
    writeFileSync(release, 'release');
    expect(existsSync(join(first.lane.worktreePath!, 'previous-task-wrote.txt'))).toBe(false);
  } finally {
    writer.kill('SIGKILL'); await exited;
  }
}, 90000);

it('admits a fixture worker managed command immediately after OS spawn', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=immediate' });
  await vi.waitFor(() => expect(existsSync(join(captures, 'immediate-registration.json'))).toBe(true), { timeout: 30000 });
  expect(JSON.parse(readFileSync(join(captures, 'immediate-registration.json'), 'utf8')).status).toBe(200);
  await idle(lane.id);
}, 90000);

it('refuses handoff while a completed worker still has a detached process in its checkout', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=process_parent' });
  const first = await idle(lane.id);
  const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
  const record = await readOwnedSessionRecord(first.lane.sessionKey!);
  const writer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: first.lane.worktreePath!, detached: true, stdio: 'ignore',
    env: { ...process.env, O8_OWNED_RUN_MARKER: record!.recentRuns[0].processMarker! },
  });
  const exited = once(writer, 'exit');
  try {
    await once(writer, 'spawn');
    const result = await tool('send', { laneId: lane.id, task: 'LANE_TASK=process_successor' });
    expect(result.blockedReason).toMatch(/process|quiescen|live/i);
    expect(result.lane.branch).toBe(first.lane.branch);
    expect(existsSync(join(captures, 'process_successor.json'))).toBe(false);
  } finally { writer.kill('SIGKILL'); await exited; }
}, 90000);

it('refuses ignored task configuration before admitting the next task through the MCP entry point', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=ignored' });
  const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
  await vi.waitFor(async () => {
    expect(existsSync(join(captures, 'ignored.json'))).toBe(true);
    expect((await readOwnedSessionRecord((await tool('list')).lanes.find((row: StandingStatus) => row.lane.id === lane.id).lane.sessionKey))?.activeRun).toBeFalsy();
  }, { timeout: 30000 });
  const before = await tool('status', { laneId: lane.id });
  const refused = await tool('send', { laneId: lane.id, task: 'LANE_TASK=ignored_successor' }, true);
  expect(refused).toContain('409');
  expect((await tool('status', { laneId: lane.id })).lane.branch).toBe(before.lane.branch);
  expect(existsSync(join(captures, 'ignored_successor.json'))).toBe(false);
}, 90000);

it.each(['skip-worktree', 'assume-unchanged'])('refuses tracked edits hidden by %s before the next MCP task', async flag => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const key = flag.replaceAll('-', '_');
  await tool('send', { laneId: lane.id, task: `LANE_TASK=flag_parent_${key}` });
  const first = await idle(lane.id);
  const worktree = first.lane.worktreePath!;
  const gitAt = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
  gitAt('update-index', `--${flag}`, '--', 'base.txt');
  writeFileSync(join(worktree, 'base.txt'), 'previous-task private fixture data\n');
  expect(gitAt('status', '--porcelain')).toBe('');
  expect(gitAt('ls-files', '-v', '--', 'base.txt')[0]).toBe(flag === 'skip-worktree' ? 'S' : 'h');
  await tool('send', { laneId: lane.id, task: `LANE_TASK=flag_successor_${key}` }, true);
  const after = await tool('status', { laneId: lane.id });
  expect(after.lane.branch).toBe(first.lane.branch);
  expect(after.tasks).toHaveLength(first.tasks.length);
  expect(readFileSync(join(worktree, 'base.txt'), 'utf8')).toBe('previous-task private fixture data\n');
  expect(existsSync(join(captures, `flag_successor_${key}.json`))).toBe(false);
}, 90000);

it('rechecks a stale owned header before permanently refusing the exact current task', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=header_parent' });
  const first = await idle(lane.id);
  const sent = await tool('send', { laneId: lane.id, task: 'LANE_TASK=header_current' });
  const index = await import('@/lib/runtimes/shared/owned-session-index');
  const read = index.readOwnedSessionRecord;
  await vi.waitFor(async () => expect((await read(sent.lane.sessionKey))?.activeRun).toBeFalsy(), { timeout: 30000 });
  const spy = vi.spyOn(index, 'readOwnedSessionRecord').mockImplementationOnce(async key => {
    const current = await read(key);
    return current ? { ...current, packetId: first.tasks[0].id } : null;
  });
  try {
    const completed = await idle(lane.id);
    expect(completed.tasks[1].phase).toBe('done');
    expect(completed.tasks[1].receiptId).toBeTruthy();
  } finally { spy.mockRestore(); }
}, 90000);

it('waits for terminal run truth when activeRun clears before its outcome is refreshed', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const sent = await tool('send', { laneId: lane.id, task: 'LANE_TASK=terminal_gap' });
  const index = await import('@/lib/runtimes/shared/owned-session-index');
  const read = index.readOwnedSessionRecord;
  await vi.waitFor(async () => expect((await read(sent.lane.sessionKey))?.activeRun).toBeFalsy(), { timeout: 30000 });
  const spy = vi.spyOn(index, 'readOwnedSessionRecord').mockImplementationOnce(async key => {
    const current = await read(key);
    return current ? { ...current, activeRun: undefined,
      recentRuns: [{ ...current.recentRuns[0], outcome: 'running', finishedAt: undefined }, ...current.recentRuns.slice(1)] } : null;
  });
  try {
    const completed = await idle(lane.id);
    expect(completed.tasks[0].phase).toBe('done');
    expect(completed.tasks[0].receiptId).toBeTruthy();
  } finally { spy.mockRestore(); }
}, 90000);

it('resumes a standing task when the durable lane and runtime binding use canonical path aliases', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=alias_parent' });
  const first = await idle(lane.id);
  const alias = join(root, 'worktree-alias');
  symlinkSync(join(root, 'worktrees'), alias, 'dir');
  const { updateLane } = await import('@/lib/lane/registry');
  updateLane(lane.id, { worktreePath: join(alias, relative(join(root, 'worktrees'), first.lane.worktreePath!)) });
  await cli('send', lane.id, '--task', 'LANE_TASK=alias_successor');
  const second = await idle(lane.id);
  expect(second.lane.sessionKey).toBe(first.lane.sessionKey);
  expect(second.tasks[1].phase).toBe('done');
  expect(JSON.parse(readFileSync(join(captures, 'alias_successor.json'), 'utf8')).resumed).toBe(true);
}, 90000);

it('keeps one surface lock identity when an aliased owned root is created during launch', async () => {
  const { withOwnedSurfaceLock } = await import('@/lib/runtimes/shared/owned-session/surface-lock');
  const parent = join(root, 'new-owned-parent');
  const alias = join(root, 'new-owned-alias');
  mkdirSync(parent); symlinkSync(parent, alias, 'dir');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const launch = withOwnedSurfaceLock(join(alias, 'sessions'), 'fixture-owned:new', async () => {
    mkdirSync(join(parent, 'sessions')); entered(); await gate;
  });
  await holding;
  let overlapped = false;
  const callback = withOwnedSurfaceLock(join(parent, 'sessions'), 'fixture-owned:new', async () => { overlapped = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(overlapped).toBe(false);
  } finally { release(); await launch; await callback; }
  expect(overlapped).toBe(true);
});

it('serializes a surviving inventory refresh with the next MCP task after a server reload', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  await tool('send', { laneId: lane.id, task: 'LANE_TASK=old_inventory' });
  const first = await idle(lane.id);
  const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
  const record = (await readOwnedSessionRecord(first.lane.sessionKey!))!;
  // Real terminal-publication gap: inventory must refresh this run before saving.
  record.recentRuns[0].outcome = 'running';
  writeFileSync(join(record.sessionDir, 'session.json'), JSON.stringify(record));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const controllerModule = await import('@/lib/runtimes/shared/owned-session/run-controller');
  const createController = controllerModule.createOwnedRunController;
  const controllerSpy = vi.spyOn(controllerModule, 'createOwnedRunController').mockImplementation(options => {
    const controller = createController(options);
    const refresh = controller.refreshSession;
    let held = false;
    controller.refreshSession = async (session, ...args) => {
      if (!held && session.surfaceId === record.surfaceId) {
        held = true; entered(); await gate;
      }
      return refresh(session, ...args);
    };
    return controller;
  });
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
  const { codexOwnedAdapter } = await import('@/lib/codex/owned');
  const ownedAlias = join(root, 'owned-alias');
  symlinkSync(ownedRoot, ownedAlias, 'dir');
  const survivingStore = createOwnedSessionStore({ ...codexOwnedAdapter,
    rootEnvVar: 'O8_TEST_STANDING_ALIAS_ROOT', rootDefault: ownedAlias });
  controllerSpy.mockRestore();
  const inventory = survivingStore.getFleetAdditions({ fresh: true });
  await holding;
  let sending: ReturnType<typeof tool> | undefined;
  let admittedWhileHeld = false;
  try {
    await new Promise<void>(done => server.close(() => done()));
    stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.resetModules(); await start();
    sending = tool('send', { laneId: lane.id, task: 'LANE_TASK=new_inventory' });
    admittedWhileHeld = await Promise.race([
      sending.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
    ]);
  } finally {
    release(); await inventory; await sending;
  }
  expect(admittedWhileHeld, 'reload admitted a task while the old store held its session snapshot').toBe(false);
  const second = await idle(lane.id);
  const current = (await (await import('@/lib/runtimes/shared/owned-session-index')).readOwnedSessionRecord(record.surfaceId))!;
  expect(second.lane.sessionKey).toBe(first.lane.sessionKey);
  expect(current.recentRuns.slice(0, 2).map(run => run.id)).toEqual([second.tasks[1].runId, first.tasks[0].runId]);
  expect(current.packetId).toBe(second.tasks[1].id);
  expect(second.processSettlement?.totalRuns).toBe(2);
  expect(second.tasks[1].receiptId).toBeTruthy();
  expect(second.tasks[1].receiptId).not.toBe(first.tasks[0].receiptId);
  expect(second.tasks[1].prNumber).toBeTruthy();
  expect(second.tasks[1].prNumber).not.toBe(first.tasks[0].prNumber);
}, 90000);

it('preserves process settlement across restart and more than sixteen sequential tasks', async () => {
  const { lane } = await tool('create', { repoPath: repo, runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  let sessionKey: string | null = null;
  for (let index = 0; index < 18; index++) {
    await tool('send', { laneId: lane.id, task: `LANE_TASK=retained_${index}` });
    const completed = await idle(lane.id);
    sessionKey ??= completed.lane.sessionKey;
    expect(completed.lane.sessionKey).toBe(sessionKey);
    expect(completed.processSettlement?.totalRuns).toBe(index + 1);
    expect(completed.processSettlement?.runId).toBeTruthy();
    if (index === 16) {
      await new Promise<void>(done => server.close(() => done())); stopServerTimers(); (await import('@/lib/db')).closeDb(); vi.resetModules(); await start();
    }
  }
  const { readStandingLane, saveStandingLane } = await import('@/lib/lane/standing-store');
  const state = readStandingLane(lane.id)!;
  // A corrupt or evicted proof boundary must never grant reuse.
  saveStandingLane(lane.id, { ...state, processSettlement: { runId: 'missing-run-proof', totalRuns: 18 } });
  const refused = await tool('send', { laneId: lane.id, task: 'LANE_TASK=unproven_successor' });
  expect(refused.blockedReason).toMatch(/process|settlement|ledger/i);
  expect(existsSync(join(captures, 'unproven_successor.json'))).toBe(false);
}, 180000);
