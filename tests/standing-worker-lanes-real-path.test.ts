import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
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
 if (task !== 'steer') { fs.writeFileSync(task + '.txt',task); if(task !== 'dirty') { git('add',task + '.txt'); git('-c','user.name=o8-test','-c','user.email=o8@example.test','commit','-qm','fix: lane task ' + task); } }
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
};
if(task === 'blocking') { fs.writeFileSync('in-progress.txt','working'); setTimeout(() => {fs.unlinkSync('in-progress.txt');finish();},30000); } else finish();
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
      throw new Error(status.blockedReason + '\n' + detail);
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
  expect(dispatchToOutputMs).toBeLessThan(2000);
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
