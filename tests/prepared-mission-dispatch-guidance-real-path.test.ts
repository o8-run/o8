import { codexModelListFixtureScript } from './helpers/codex-model-list-fixture';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

const launchSeam = vi.hoisted(() => ({ afterLaunch: null as (() => Promise<void>) | null }));
vi.mock('@/lib/runtime/actions', async (original) => {
  const actual = await original<typeof import('@/lib/runtime/actions')>();
  return { ...actual, launchRuntimeSurface: vi.fn(async (...args: Parameters<typeof actual.launchRuntimeSurface>) => {
    const result = await actual.launchRuntimeSurface(...args);
    await launchSeam.afterLaunch?.();
    return result;
  }) };
});

vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(), requestRealtimeRefresh: vi.fn() }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-prepared-dispatch-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
mkdirSync(dataDir); mkdirSync(repoPath);
const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', '--bare', origin]);
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
writeFileSync(join(repoPath, '.gitignore'), '.o8/\n');
git('add', 'README.md', '.gitignore');
git('-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), O8_OPERATOR_MCP_PROFILE: 'full',
  O8_WORKTREE_ROOT: join(dataDir, '.cortex-worktrees'),
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0', O8_WORKER_SANDBOX: '0',
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_CODEX_BIN: join(root, 'codex'),
  CORTEX_IDE_OWNED_CODEX_ROOT: join(dataDir, 'owned-codex'), O8_TEST_PROVIDER_CAPTURE: join(root, 'starts.jsonl'),
  O8_WORKER_ENV_ALLOW: 'O8_TEST_PROVIDER_CAPTURE,O8_TEST_PROVIDER_FINISH,O8_TEST_MANAGED_RUN_CAPTURE,O8_TEST_SOURCE_ROOT,O8_TEST_MANAGED_COMMAND',
  O8_TEST_PROVIDER_FINISH: join(root, 'finish') })) vi.stubEnv(key, value);
writeFileSync(join(root, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const args = process.argv.slice(2);
${codexModelListFixtureScript()}
fs.appendFileSync(process.env.O8_TEST_PROVIDER_CAPTURE, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}) + String.fromCharCode(10));
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-thread-' + process.pid}));
if (process.env.O8_TEST_MANAGED_RUN_CAPTURE) {
  const child = require('node:child_process').spawnSync(process.execPath,
    [process.env.O8_TEST_SOURCE_ROOT + '/cli/dist/o8.mjs', 'run', '--', process.execPath, process.env.O8_TEST_MANAGED_COMMAND],
    {cwd: process.cwd(), env: {...process.env, O8_API_TOKEN: '', NODE_OPTIONS: ''}, encoding: 'utf8', timeout: 20000});
  fs.writeFileSync(process.env.O8_TEST_MANAGED_RUN_CAPTURE, JSON.stringify({status: child.status, stdout: child.stdout,
    stderr: child.stderr, packetId: process.env.O8_WORKER_PACKET_ID, hasWorkerToken: Boolean(process.env.O8_WORKER_TOKEN)}));
  fs.writeFileSync(process.env.O8_TEST_MANAGED_RUN_CAPTURE + '.credential', process.env.O8_WORKER_TOKEN || '', {mode: 0o600});
}

setInterval(() => {
  if (fs.existsSync(process.env.O8_TEST_PROVIDER_FINISH + '/' + process.pid)) {
    console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}));
    process.exit(0);
  }
}, 20);
}
`); chmodSync(join(root, 'codex'), 0o755);
const token = 'prepared-dispatch-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const setupStatusRoute = await import('@/app/api/setup/status/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const lanesRoute = await import('@/app/api/lanes/route');
const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const preservationRoute = await import('@/app/api/orchestrator/workspace/preservation/route');
const retentionRoute = await import('@/app/api/orchestrator/workspace/retention/route');
const mcpRoute = await import('@/app/api/mcp/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');
const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry, withMissionRegistryState, persistMissionRegistryStateIfVersion } = await import('@/lib/orchestrator/mission-registry');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
let port = 0;
let dropDispatchResponse = false;
const dispatchBodies: string[] = [];
const closeReceipts: Array<{ result?: { replayed?: boolean } }> = [];

const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    if (req.url === '/api/orchestrator/dispatch') dispatchBodies.push(body);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/orchestrator/dispatch' ? await dispatchRoute.POST(request)
      : request.nextUrl.pathname === '/api/lanes' ? req.method === 'POST' ? await lanesRoute.POST(request) : await lanesRoute.GET(request)
      : req.url === '/api/orchestrator/discard-packet' ? await closeRoute.POST(request)
      : req.url === '/api/orchestrator/workspace/retention' ? await retentionRoute.POST(request)
      : req.url?.startsWith('/api/orchestrator/workspace/preservation?') ? await preservationRoute.GET(request)
      : request.nextUrl.pathname === '/api/panel/managed-runs' ? req.method === 'GET' ? await runsRoute.GET(request) : await runsRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : request.nextUrl.pathname === '/api/setup/status' ? setupStatusRoute.GET()
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    if (req.url === '/api/orchestrator/dispatch' && dropDispatchResponse) {
      dropDispatchResponse = false; res.destroy(); return;
    }
    const responseBody = await response.text();
    if (request.nextUrl.pathname === '/api/orchestrator/discard-packet') closeReceipts.push(JSON.parse(responseBody));
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(responseBody);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
const contract = {
  version: 1 as const,
  requirements: [{ id: 'R1', source: 'Explicit task.', expectedBehavior: 'One packet receives the sealed contract.', productionPath: 'create_mission -> createMission -> worker', verification: 'Registered HTTP fixture.' }],
  smallestRoute: [{ path: 'src/task.ts', requirements: ['R1'], reason: 'Smallest complete implementation.' }],
  processConstraints: [{ id: 'P1', source: 'Stay within the task.', expectedBehavior: 'No unrelated changes.', verification: 'Review the diff.' }],
  exclusions: ['No candidate comparison.'],
};
async function rpc(method: string, params?: Record<string, unknown>, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}
type Reply = { result: McpToolResult & { tools?: Array<{ name: string; description: string }> }; error?: unknown };
let client: ChildProcess;
let sequence = 0;
const pending = new Map<number, (reply: Reply) => void>();
function clientRpc(method: string, params?: Record<string, unknown>): Promise<Reply> {
  const id = ++sequence;
  return new Promise(resolve => {
    pending.set(id, resolve);
    client.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name: string, args: Record<string, unknown>) {
  const reply = await clientRpc('tools/call', { name, arguments: args });
  expect(reply.error).toBeUndefined();
  return reply.result;
}
const starts = () => { try { return readFileSync(join(root, 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', model: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Implement one sealed task', body: 'Owned fixture.' }], sealedTaskContract: contract, ...extra,
});
const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
function rawRegistry(missionId: string) {
  // Reopen persisted storage independently without invalidating the running API's statement handles.
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    try { console.log(JSON.stringify(db.prepare('SELECT mission_state_json, updated_at, archived_at FROM missions WHERE id = ?').get(process.argv[2]))); }
    finally { db.close(); }
  `, join(dataDir, 'cortex-ide.db'), missionId], { encoding: 'utf8' })) as { mission_state_json: string; updated_at: number; archived_at: number | null };
}
async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function cli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: token,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '' };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [join(process.cwd(), 'cli/dist/o8.mjs'), ...args],
      { cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}
function advanceRegistryFromChild(missionId: string, state: OrchestratorMissionState) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { timeout: 0 });
    try {
      db.prepare('UPDATE missions SET mission_state_json = ?, updated_at = updated_at + 1 WHERE id = ?')
        .run(process.argv[3], process.argv[2]);
      console.log(JSON.stringify({ written: true }));
    } catch (error) { console.log(JSON.stringify({ written: false, code: error.code })); }
    finally { db.close(); }
  `, join(dataDir, 'cortex-ide.db'), missionId, JSON.stringify(state)], { encoding: 'utf8' }));
}
beforeAll(async () => {
  execFileSync(process.execPath, [join(process.cwd(), 'cli/esbuild.config.mjs')], { stdio: 'pipe' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'api-port'), String(port));
  vi.stubEnv('O8_API_PORT', String(port));
  const { buildToolRegistry, resetToolSpinePortIdentityForTests } = await import('@/lib/mcp/tool-spine/build');
  resetToolSpinePortIdentityForTests();
  const registry = buildToolRegistry(repoPath, { profile: 'full' });
  const operator = registry.entries.find(entry => entry.id === 'builtin:operator')!.config;
  if (operator.type !== 'stdio') throw new Error('Expected installed operator stdio seam.');
  client = spawn(operator.command, operator.args ?? [], { cwd: repoPath,
    env: { ...process.env, ...operator.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  client.stdout!.on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); } catch { /* Startup output. */ }
    }
  });
  payload(await call('o8_setup', { action: 'open', path: repoPath }));
}, 30_000);
afterAll(async () => {
  const { getOwnedCodexFleetAdditions, interruptOwnedCodexSession } = await import('@/lib/codex/owned');
  for (const agent of (await getOwnedCodexFleetAdditions({ fresh: true })).agents) await interruptOwnedCodexSession(agent.sessionKey);
  launchSeam.afterLaunch = null;
  client.kill('SIGTERM');
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

async function cortexCatalog() {
  const { buildToolRegistry } = await import('@/lib/mcp/tool-spine/build');
  const config = buildToolRegistry(repoPath, { profile: 'full' }).entries.find(entry => entry.id === 'builtin:cortex')!.config;
  if (config.type !== 'stdio') throw new Error('Expected Cortex stdio seam.');
  const child = spawn(config.command, config.args ?? [], { cwd: repoPath,
    env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let reply: Reply | undefined; let buffer = '';
    child.stdout!.on('data', chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.id === 1) reply = value; } catch { /* Startup output. */ }
      }
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await vi.waitFor(() => expect(reply).toBeDefined(), { timeout: 15_000 });
    return reply!.result.tools!;
  } finally { child.kill('SIGTERM'); }
}

it('advertises the prepared-mission action in the actual full catalog and Codex fleet prompt', async () => {
  const tools = (await clientRpc('tools/list')).result.tools!;
  expect(tools.find(tool => tool.name === 'dispatch_mission')?.description).toContain('dispatch:false');
  expect(tools.find(tool => tool.name === 'dispatch_mission')?.description).not.toContain('USE THIS RARELY');
  const generic = (await cortexCatalog()).find(tool => tool.name === 'cortex_launch_agent');
  expect(generic?.description).toContain('new task');
  expect(generic?.description).toContain('dispatch_mission');
  const { buildCodexOrchestratorPrompt } = await import('@/lib/lane/codex-orchestrator-session');
  const prompt = buildCodexOrchestratorPrompt(repoPath, 'Complete the task.', { toolProfile: 'full', orchestrationMode: 'fleet' });
  expect(prompt).toContain('dispatch_mission({missionId:');
  expect(prompt).toContain('Do not launch a new worker to dispatch an existing mission');
  for (const profile of ['propose', 'solo', 'fable-solo'] as const) {
    const scoped = buildCodexOrchestratorPrompt(repoPath, 'Complete the task.', { toolProfile: profile });
    expect(scoped).not.toContain('dispatch_mission({missionId:');
  }
});

it('dispatches the advertised prepared mission unchanged through the authenticated registered client exactly once', async () => {
  const created = payload(await create());
  expect(created.packets).toHaveLength(1); expect(starts()).toBe(0);
  const prepared = readMissionRegistryEntry(created.missionId)!.mission.packets[0];
  expect(prepared).toMatchObject({ queueState: 'held', taskContract: contract });
  expect(prepared.lane).toBeFalsy();
  expect(JSON.parse(rawRegistry(created.missionId).mission_state_json).packets[0].lane).toBeFalsy();
  const routing = Object.fromEntries(Object.entries(prepared.workerRouting!).filter(([key]) => key !== 'decidedAt'));
  dropDispatchResponse = true;
  const dispatched = payload(await call('dispatch_mission', { missionId: created.missionId }));
  expect(dispatched.dispatched).toBe(1);
  expect(dispatched.replayed).toBe(true);
  expect(dispatchBodies.length).toBeGreaterThan(1);
  expect(new Set(dispatchBodies).size).toBe(1);
  await vi.waitFor(() => expect(starts()).toBe(1), { timeout: 15_000 });
  const saved = JSON.parse(rawRegistry(created.missionId).mission_state_json) as OrchestratorMissionState;
  expect(saved.packets).toHaveLength(1);
  expect(saved.packets[0]).toMatchObject({ id: prepared.id, taskContract: contract, workerRouting: routing });
  const { listLanes } = await import('@/lib/lane/registry');
  const lane = listLanes().find(entry => entry.packetId === prepared.id)!;
  expect(lane.sessionKey).toMatch(/^codex-owned:/);
  expect(saved.packets[0].lane).toMatchObject({ laneId: lane.id, sessionKey: lane.sessionKey });
  expect(dispatched.registryPublication.status).toBe('published');
  expect(count()).toBe(1);
  expect((getSqlite().prepare('SELECT COUNT(*) AS count FROM lanes').get() as { count: number }).count).toBe(1);
  const owned = JSON.parse(readFileSync(join(dataDir, 'owned-codex', lane.sessionKey!.slice('codex-owned:'.length), 'session.json'), 'utf8'));
  expect(owned.model).toBe(MODEL_IDS.raw.openAiGpt61Sol); expect(owned.effort).toBe('medium');
  const capture = JSON.parse(readFileSync(join(root, 'starts.jsonl'), 'utf8').trim());
  expect(capture.argv.join(' ')).toContain(JSON.stringify(contract));
  const changed = await fetch(`http://127.0.0.1:${port}/api/orchestrator/dispatch`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...JSON.parse(dispatchBodies[0]), runtime: 'claude-code' }),
  });
  expect(changed.status).toBe(409);
  payload(await call('dispatch_mission', { missionId: created.missionId }));
  expect(starts()).toBe(1); expect(count()).toBe(1);

  const note = 'Preserve actual dispatched workspace evidence before Close.\n';
  mkdirSync(join(owned.cwd, '.o8'), { recursive: true });
  writeFileSync(join(owned.cwd, '.o8', 'publication.md'), note);
  mkdirSync(join(root, 'finish'), { recursive: true });
  writeFileSync(join(root, 'finish', String(capture.pid)), 'finish controlled fixture\n');
  await vi.waitFor(() => {
    const completed = JSON.parse(readFileSync(join(owned.sessionDir, 'session.json'), 'utf8'));
    expect(completed.activeRun).toBeFalsy();
    expect(completed.recentRuns).toContainEqual(expect.objectContaining({ outcome: 'finished',
      childExit: expect.objectContaining({ classification: 'clean-exit', code: 0 }) }));
  }, { timeout: 15_000 });
  const held = await cli(['packet', 'retain', prepared.id, '--reason', 'Preserve dispatched fixture until explicit Close.',
    '--idempotency-key', 'prepared-dispatch-retention']);
  expect(held.exitCode, held.stdout + held.stderr).toBe(0);
  const stopped = await cli(['packet', 'stop', prepared.id]);
  expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout).result.ok).toBe(true);
  expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, lane: { laneId: lane.id } });
  expect(JSON.parse(rawRegistry(created.missionId).mission_state_json).packets[0].lane?.laneId).toBe(lane.id);
  expect(existsSync(owned.cwd)).toBe(true);
  const released = await cli(['packet', 'release-retention', prepared.id, '--hold-id', 'prepared-dispatch-retention',
    '--idempotency-key', 'prepared-dispatch-retention-release']);
  expect(released.exitCode, released.stdout + released.stderr).toBe(0);
  const closeArgs = ['packet', 'close', prepared.id, '--reason', 'wontfix', '--note', 'Completed bounded fixture.',
    '--idempotency-key', 'prepared-dispatch-close'];
  const closed = await cli(closeArgs);
  expect(closed.exitCode, closed.stdout + closed.stderr).toBe(0);
  expect(existsSync(owned.cwd)).toBe(false);
  for (const packet of [readOrchestratorControlPlaneState().packets[0],
    JSON.parse(rawRegistry(created.missionId).mission_state_json).packets[0]]) {
    expect(packet).toMatchObject({ releaseState: 'pending', status: 'archived', lane: null });
    expect(packet.archivedAt).toBeTruthy();
  }
  const bankResponse = await fetch(`http://127.0.0.1:${port}/api/orchestrator/workspace/preservation?packetId=${prepared.id}`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(bankResponse.status).toBe(200);
  const bank = await bankResponse.json();
  expect(bank.result.artifacts).toContainEqual(expect.objectContaining({ path: '.o8/publication.md',
    bytes: Buffer.byteLength(note), sha256: createHash('sha256').update(note).digest('hex') }));
  const replay = await cli(closeArgs);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  expect(closeReceipts.at(-1)?.result?.replayed).toBe(true);
  const dispatchReplay = await post('/api/orchestrator/dispatch', JSON.parse(dispatchBodies[0]));
  expect(dispatchReplay.status).toBe(200); expect(dispatchReplay.body.result.replayed).toBe(true);
  expect(starts()).toBe(1);
}, 60_000);

it('refuses unavailable profiles, foreign or malformed targets, and anonymous calls without effects', async () => {
  const before = starts();
  for (const profile of ['dogfood', 'propose', 'worker']) {
    vi.stubEnv('O8_OPERATOR_MCP_PROFILE', profile);
    expect((await clientRpc('tools/list')).result.tools!.some(tool => tool.name === 'dispatch_mission')).toBe(false);
    expect((await call('dispatch_mission', {})).isError).toBe(true);
  }
  vi.stubEnv('O8_OPERATOR_MCP_PROFILE', 'full');
  expect((await call('dispatch_mission', { missionId: 'mission-foreign-fixture' })).isError).toBe(true);
  expect((await call('dispatch_mission', { runtime: 'invalid-runtime' })).isError).toBe(true);
  expect((await rpc('tools/call', { name: 'dispatch_mission', arguments: {} }, false)).status).toBe(401);
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const packetId = readOrchestratorControlPlaneState().packets[0].id;
  const denied = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${mintPacketWorkerToken(packetId)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dispatch_mission', arguments: {} } }),
  });
  expect(denied.status).toBe(403);
  expect(starts()).toBe(before); expect(count()).toBe(1);
});

it.each(['newer_generation', 'terminal', 'release_owner', 'lane_owner', 'lifecycle_owner', 'sibling_owner', 'unreadable_owner'] as const)(
  'refuses a pre-existing registry %s through authenticated dispatch before launch', async reason => {
    const before = starts();
    const created = payload(await create({ issues_inline: [{ title: `Guard ${reason}`, body: 'Bounded guard fixture.' }] }));
    await withMissionRegistryState(created.missionId, state => {
      const packet = state.packets[0];
      if (reason === 'newer_generation') packet.storageAdmissionEpoch = (packet.storageAdmissionEpoch ?? 0) + 1;
      if (reason === 'terminal') { packet.archivedAt = new Date().toISOString(); packet.status = 'archived'; }
      if (reason === 'release_owner') { packet.releaseState = 'released'; packet.releaseStatePayload = {
        source: 'fixture_release', releasedAt: new Date().toISOString(), headSha: git('rev-parse', 'HEAD').toString().trim() }; }
      if (reason === 'lane_owner') packet.lane = { laneId: 'different-owner', sessionKey: 'different-session',
        tileId: 'different-tile', tabId: 'different-tab', repoPath, runtime: 'codex' };
      if (reason === 'lifecycle_owner') state.lifecycleHold = { source: 'different-owner', reason: 'operator_stop',
        startedAt: new Date().toISOString(), ownerPid: process.pid, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
      if (reason === 'sibling_owner') state.packets.push({ ...structuredClone(packet), id: packet.id + '-sibling' });
      return { state, result: undefined };
    });
    if (reason === 'unreadable_owner') getSqlite().prepare('UPDATE missions SET mission_state_json = ?, updated_at = updated_at + 1 WHERE id = ?')
      .run('{invalid', created.missionId);
    const durableBefore = rawRegistry(created.missionId);
    const currentBefore = readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8');
    for (const wait of [true, false]) {
      const body = { missionId: created.missionId, wait, idempotencyKey: `refuse-${reason}-${wait}` };
      const refused = await post('/api/orchestrator/dispatch', body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe('dispatch_registry_conflict');
      if (!wait) {
        const replay = await post('/api/orchestrator/dispatch', body);
        expect(replay.status, JSON.stringify(replay.body)).toBe(409);
        expect(replay.body.error.code).toBe('dispatch_registry_conflict');
      }
    }
    expect(rawRegistry(created.missionId)).toEqual(durableBefore);
    expect(readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8')).toBe(currentBefore);
    expect(starts()).toBe(before);
    expect(readOrchestratorControlPlaneState().packets[0].lane).toBeFalsy();
  }, 30_000,
);

it('retains a concurrently advanced registry and reports publication conflict without relaunch on replay', async () => {
  const before = starts();
  const created = payload(await create({ issues_inline: [{ title: 'Concurrent registry publication', body: 'Bounded race fixture.' }] }));
  const baseline = readMissionRegistryEntry(created.missionId)!;
  const concurrent = structuredClone(baseline.mission);
  concurrent.packets.push({ ...structuredClone(concurrent.packets[0]), id: concurrent.packets[0].id + '-concurrent' });
  launchSeam.afterLaunch = async () => { expect(advanceRegistryFromChild(created.missionId, concurrent)).toEqual({ written: true }); };
  const body = { missionId: created.missionId, wait: true, idempotencyKey: 'concurrent-publication-dispatch' };
  try {
    const dispatched = await post('/api/orchestrator/dispatch', body);
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body.result, JSON.stringify(dispatched.body)).toMatchObject({ dispatched: 1,
      registryPublication: { status: 'conflict', expectedVersion: baseline.updatedAt, reason: 'registry_advanced' } });
  } finally { launchSeam.afterLaunch = null; }
  await vi.waitFor(() => expect(starts()).toBe(before + 1), { timeout: 15_000 });
  const durable = readMissionRegistryEntry(created.missionId)!.mission;
  const authoritative = JSON.parse(rawRegistry(created.missionId).mission_state_json);
  expect(authoritative.packets).toEqual(concurrent.packets);
  expect(durable.packets[0].lane).toBeFalsy();
  const current = readOrchestratorControlPlaneState().packets[0];
  expect(current.lane?.laneId).toBeTruthy(); expect(existsSync(current.lane!.worktreePath!)).toBe(true);
  const replay = await post('/api/orchestrator/dispatch', body);
  expect(replay.status).toBe(200); expect(replay.body.result.replayed).toBe(true);
  expect(replay.body.result.registryPublication.status).toBe('conflict');
  expect(starts()).toBe(before + 1);
  expect(JSON.parse(rawRegistry(created.missionId).mission_state_json).packets).toEqual(authoritative.packets);
  // Publication lost ownership: Stop must not overwrite the newer registry or
  // interrupt this lane until both stores agree. afterAll owns fixture teardown.
  const currentBeforeStop = readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8');
  const registryBeforeStop = rawRegistry(created.missionId);
  const worker = JSON.parse(readFileSync(join(root, 'starts.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { pid: number };
  expect(() => process.kill(worker.pid, 0)).not.toThrow();
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: current.lane!.laneId });
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(422);
  expect(stopped.body).toMatchObject({ ok: false, laneId: current.lane!.laneId,
    note: 'Stop refused because the packet hold could not be persisted.',
    lane: { sessionKey: current.lane!.sessionKey, status: 'running' } });
  expect(rawRegistry(created.missionId)).toEqual(registryBeforeStop);
  expect(readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8')).toBe(currentBeforeStop);
  expect(() => process.kill(worker.pid, 0)).not.toThrow();
  expect(starts()).toBe(before + 1);
}, 40_000);

it('holds a SQLite immediate lock across captured-version comparison and publication against another process', async () => {
  const created = payload(await create({ issues_inline: [{ title: 'Atomic registry publication', body: 'Bounded transaction fixture.' }] }));
  const baseline = readMissionRegistryEntry(created.missionId)!;
  const database = getSqlite();
  const originalPrepare = database.prepare.bind(database);
  let childResult: { written: boolean; code?: string } | undefined;
  const spy = vi.spyOn(database, 'prepare').mockImplementation(((sql: string) => {
    const statement = originalPrepare(sql);
    if (sql.includes('SELECT id, mission_state_json, created_at') && !childResult) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: unknown[]) => {
        const row = get(...args);
        childResult = advanceRegistryFromChild(created.missionId, baseline.mission);
        return row;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof database.prepare);
  try { expect(await persistMissionRegistryStateIfVersion(baseline.mission, baseline.updatedAt)).toBe(true); }
  finally { spy.mockRestore(); }
  expect(childResult).toEqual({ written: false, code: 'SQLITE_BUSY' });
  expect(rawRegistry(created.missionId).updated_at).toBeGreaterThan(baseline.updatedAt);
});


it('admits a managed test from the worker after explicit CLI dispatch of a prepared packet', async () => {
  const capturePath = join(root, 'managed-test.json');
  // Keep dispatch inside its launch boundary until the worker attempts its first run.
  launchSeam.afterLaunch = async () => {
    await vi.waitFor(() => expect(existsSync(capturePath)).toBe(true), { timeout: 25_000 });
  };
  vi.stubEnv('O8_TEST_MANAGED_RUN_CAPTURE', capturePath);
  vi.stubEnv('O8_TEST_SOURCE_ROOT', process.cwd());
  const commandPath = join(root, 'managed-check.cjs');
  writeFileSync(commandPath, 'console.log("managed-test-ran")');
  vi.stubEnv('O8_TEST_MANAGED_COMMAND', commandPath);
  const created = payload(await create({ issues_inline: [{ title: 'Explicit dispatch managed test', body: 'Bounded worker test.' }] }));
  const packet = readMissionRegistryEntry(created.missionId)!.mission.packets[0];
  expect(packet).toMatchObject({ queueState: 'held' });
  const held = await post('/api/panel/managed-runs', { id: 'preheld0001', session: 'cortex-run-preheld0001',
    command: 'fixture test', cwd: repoPath, packetId: packet.id, mode: 'detach' });
  expect(held.status).toBe(409);
  const dispatched = await cli(['mission', 'dispatch', '--mission', created.missionId, '--wait']);
  expect(dispatched.exitCode, dispatched.stdout + dispatched.stderr).toBe(0);
  expect(JSON.parse(dispatched.stdout).dispatch.dispatched, dispatched.stdout).toBe(1);
  await vi.waitFor(() => expect(existsSync(capturePath)).toBe(true), { timeout: 25_000 });
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  expect(capture, JSON.stringify(capture)).toMatchObject({ status: 0, packetId: packet.id, hasWorkerToken: true });
  expect(capture.stdout).toContain('managed-test-ran');
  const current = readOrchestratorControlPlaneState().packets.find(row => row.id === packet.id)!;
  const durable = readMissionRegistryEntry(created.missionId)!.mission.packets.find(row => row.id === packet.id)!;
  expect(current).toMatchObject({ queueState: 'queued', status: 'running', blockedReason: null });
  expect(durable).toMatchObject({ queueState: 'queued', blockedReason: null });
  expect(['launching', 'running']).toContain(durable.status);
  expect(durable.lane?.laneId).toBe(current.lane?.laneId);
  expect((await listManagedRuns()).find(run => run.packetId === packet.id)).toMatchObject({ status: 'finished', exitCode: 0 });
  const formerCredential = readFileSync(capturePath + '.credential', 'utf8');
  expect((await post('/api/lanes', { verb: 'stop', laneId: current.lane!.laneId })).status).toBe(200);
  vi.stubEnv('O8_TEST_MANAGED_RUN_CAPTURE', '');
  const late = () => fetch(`http://127.0.0.1:${port}/api/panel/managed-runs`, { method: 'POST',
    headers: { Authorization: `Bearer ${formerCredential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'stalegen0001', session: 'cortex-run-stalegen0001', command: 'fixture test',
      cwd: current.lane!.worktreePath, packetId: packet.id, laneId: current.lane!.laneId, mode: 'detach' }) });
  expect([401, 403, 409]).toContain((await late()).status);
  expect((await listManagedRuns()).some(run => run.id === 'stalegen0001')).toBe(false);
}, 75_000);
