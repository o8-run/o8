import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import type { OwnedActiveRun } from '@/lib/runtimes/shared/owned-session-index';

// vi.waitFor advances fake Date even when timers stay real. Observe metadata
// with real timers so byte-preservation checks retain their frozen clock.
async function observe(check: () => void | Promise<void>) {
  const deadline = performance.now() + 5000;
  while (true) {
    try { await check(); return; }
    catch (error) { if (performance.now() >= deadline) throw error; }
    await wait(10);
  }
}

const exitWindow = vi.hoisted(() => ({ surfaceId: '', observeLookup: false, blocked: false,
  released: false, release: null as (() => void) | null, captured: null as OwnedActiveRun | null }));
vi.mock('@/lib/runtimes/shared/owned-session/session-io', async (original) => {
  const actual = await original<typeof import('@/lib/runtimes/shared/owned-session/session-io')>();
  return { ...actual, createOwnedSessionIo: (...args: Parameters<typeof actual.createOwnedSessionIo>) => {
    const io = actual.createOwnedSessionIo(...args);
    return { ...io, saveSession: async (session: Parameters<typeof io.saveSession>[0]) => {
      if (session.surfaceId === exitWindow.surfaceId && !session.activeRun && !exitWindow.released) {
        exitWindow.blocked = true;
        await new Promise<void>(resolve => { exitWindow.release = resolve; });
      }
      return io.saveSession(session);
    } };
  } };
});
vi.mock('@/lib/runtimes/shared/owned-session-index', async (original) => {
  const actual = await original<typeof import('@/lib/runtimes/shared/owned-session-index')>();
  return { ...actual, lookupOwnedActiveRunFresh: async (surfaceId: string) => {
    const run = await actual.lookupOwnedActiveRunFresh(surfaceId);
    if (surfaceId === exitWindow.surfaceId && exitWindow.observeLookup) {
      exitWindow.captured = run;
      await observe(() => expect(exitWindow.blocked).toBe(true));
      expect(run?.id).toBeTruthy();
      exitWindow.observeLookup = false;
      exitWindow.released = true;
      exitWindow.release?.();
      await observe(async () => {
        expect((await actual.readOwnedSessionRecord(surfaceId))?.activeRun).toBeFalsy();
      });
    }
    return run;
  } };
});
const publicationSeam = vi.hoisted(() => ({ beforePublish: null as (() => void) | null }));
vi.mock('@/lib/orchestrator/mission-registry', async (original) => {
  const actual = await original<typeof import('@/lib/orchestrator/mission-registry')>();
  return { ...actual, persistMissionRegistryStateIfVersion: async (...args: Parameters<typeof actual.persistMissionRegistryStateIfVersion>) => {
    const beforePublish = publicationSeam.beforePublish;
    publicationSeam.beforePublish = null;
    beforePublish?.();
    return actual.persistMissionRegistryStateIfVersion(...args);
  } };
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
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-stop-retry-owner-')));
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
  O8_TEST_PROVIDER_FINISH: join(root, 'finish'),
  // Children inherit only allowlisted names (#4585); the fake codex and its managed `o8 run` read these knobs.
  O8_WORKER_ENV_ALLOW: 'O8_TEST_PROVIDER_CAPTURE,O8_TEST_PROVIDER_FINISH,O8_TEST_MANAGED_RUN_CAPTURE,O8_TEST_SOURCE_ROOT,O8_TEST_MANAGED_COMMAND',
})) vi.stubEnv(key, value);
writeFileSync(join(root, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
fs.appendFileSync(process.env.O8_TEST_PROVIDER_CAPTURE, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}) + String.fromCharCode(10));
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-thread-' + process.pid}));
function runManaged() {
 if (!process.env.O8_TEST_MANAGED_RUN_CAPTURE) return;
  const child = require('node:child_process').spawnSync(process.execPath,
    [process.env.O8_TEST_SOURCE_ROOT + '/cli/dist/o8.mjs', 'run', '--', process.execPath, process.env.O8_TEST_MANAGED_COMMAND],
    {cwd: process.cwd(), env: {...process.env, O8_API_TOKEN: '', NODE_OPTIONS: ''}, encoding: 'utf8', timeout: 20000});
  fs.writeFileSync(process.env.O8_TEST_MANAGED_RUN_CAPTURE, JSON.stringify({status: child.status, stdout: child.stdout,
    stderr: child.stderr, packetId: process.env.O8_WORKER_PACKET_ID, hasWorkerToken: Boolean(process.env.O8_WORKER_TOKEN)}));
  fs.writeFileSync(process.env.O8_TEST_MANAGED_RUN_CAPTURE + '.credential', process.env.O8_WORKER_TOKEN || '', {mode: 0o600});
}

let ran = false;
setInterval(() => {
  if (!ran && process.env.O8_TEST_MANAGED_RUN_CAPTURE && fs.existsSync(process.env.O8_TEST_MANAGED_RUN_CAPTURE + '.go')) { ran = true; runManaged(); }
  if (fs.existsSync(process.env.O8_TEST_PROVIDER_FINISH + '/' + process.pid)) {
    console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}));
    process.exit(0);
  }
}, 20);
`); chmodSync(join(root, 'codex'), 0o755);
const token = 'prepared-dispatch-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const setupStatusRoute = await import('@/app/api/setup/status/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const lanesRoute = await import('@/app/api/lanes/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const mcpRoute = await import('@/app/api/mcp/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');
const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
const { readOwnedSessionRecord } = await import('@/lib/runtimes/shared/owned-session-index');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { readOrchestratorControlPlaneState, withLockedState } = await import('@/lib/orchestrator/control-plane');
let port = 0;

const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/orchestrator/dispatch' ? await dispatchRoute.POST(request)
      : req.url === '/api/orchestrator/reset-packet' ? await resetRoute.POST(request)
      : request.nextUrl.pathname === '/api/lanes' ? req.method === 'POST' ? await lanesRoute.POST(request) : await lanesRoute.GET(request)
      : request.nextUrl.pathname === '/api/panel/managed-runs' ? req.method === 'GET' ? await runsRoute.GET(request) : await runsRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : request.nextUrl.pathname === '/api/setup/status' ? setupStatusRoute.GET()
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    const responseBody = await response.text();
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
const rawCurrent = () => readFileSync(join(dataDir, 'orchestrator-state.json'), 'utf8');
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
  publicationSeam.beforePublish = null;
  client.kill('SIGTERM');
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  exitWindow.surfaceId = '';
  exitWindow.observeLookup = false;
  exitWindow.released = true;
  exitWindow.release?.();
  publicationSeam.beforePublish = null;
  vi.useRealTimers();
  const { getOwnedCodexFleetAdditions, interruptOwnedCodexSession } = await import('@/lib/codex/owned');
  for (const agent of (await getOwnedCodexFleetAdditions({ fresh: true })).agents) await interruptOwnedCodexSession(agent.sessionKey);
  const { listLanes, archiveLane } = await import('@/lib/lane/registry');
  for (const lane of listLanes()) archiveLane(lane.id, 'system');
}, 30000);

async function dispatched(name: string, managed = false, committed = false) {
  const capturePath = join(root, `managed-${name}.json`);
  vi.stubEnv('O8_TEST_MANAGED_RUN_CAPTURE', managed ? capturePath : '');
  vi.stubEnv('O8_TEST_SOURCE_ROOT', process.cwd());
  const command = join(root, `check-${name}.cjs`);
  writeFileSync(command, 'require("node:fs").writeFileSync("worker-result.txt", "preserve my work\\n");'
    + (committed ? 'const git = (...args) => require("node:child_process").execFileSync("git", args); git("add", "worker-result.txt"); git("-c", "user.name=o8 test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture work");' : '')
    + 'console.log("managed-test-ran");');
  vi.stubEnv('O8_TEST_MANAGED_COMMAND', command);
  const created = payload(await create({ issues_inline: [{ title: name, body: 'Stop and preserve work.' }] }));
  const packet = readMissionRegistryEntry(created.missionId)!.mission.packets[0];
  const launched = await cli(['mission', 'dispatch', '--mission', created.missionId, '--wait']);
  expect(launched.exitCode, launched.stdout + launched.stderr).toBe(0);
  const current = readOrchestratorControlPlaneState().packets.find(row => row.id === packet.id)!;
  expect(current.lane, launched.stdout + launched.stderr).toBeTruthy();
  const laneId = current.lane!.laneId!;
  const owned = JSON.parse(readFileSync(join(dataDir, 'owned-codex', current.lane!.sessionKey!.slice('codex-owned:'.length), 'session.json'), 'utf8'));
  if (managed) {
    writeFileSync(capturePath + '.go', 'dispatch returned');
    await vi.waitFor(() => expect(existsSync(capturePath)).toBe(true), { timeout: 25000 });
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    expect(capture, JSON.stringify(capture)).toMatchObject({ status: 0, packetId: packet.id, hasWorkerToken: true });
    expect(capture.stdout).toContain('managed-test-ran');
  }
  return { created, packet, laneId, owned, capturePath, sessionKey: current.lane!.sessionKey! };
}

async function observeInterruptedExit(f: Awaited<ReturnType<typeof dispatched>>) {
  await observe(async () => {
    const session = await readOwnedSessionRecord(f.sessionKey);
    expect(session?.activeRun).toBeFalsy();
    expect(session?.recentRuns).toContainEqual(expect.objectContaining({
      id: f.owned.activeRun.id, outcome: 'interrupted', finishedAt: expect.any(String),
      childExit: expect.objectContaining({ classification: expect.any(String) }),
    }));
  });
}

it.each([false, true])('preserves dispatched managed work through Stop and Retry (committed=%s)', async committed => {
  const startsBefore = starts();
  const f = await dispatched(`managed-stop-retry-${committed}`, true, committed);
  const savedWork = readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8');
  const stopped = await cli(['packet', 'stop', f.packet.id]);
  expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout).result.ok).toBe(true);
  const retry = await post('/api/orchestrator/reset-packet', { packetId: f.packet.id, clearWorktree: false,
    idempotencyKey: `stop-preserve-work-retry-${committed}` });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect(retry.body.result).toMatchObject({ reset: !committed, salvaged: committed, worktreePruned: false, branchDeleted: false });
  expect(readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8')).toBe(savedWork);
  const current = readOrchestratorControlPlaneState().packets.find(row => row.id === f.packet.id)!;
  const registry = readMissionRegistryEntry(f.created.missionId, { includeArchived: true })!.mission.packets.find(row => row.id === f.packet.id)!;
  if (committed) {
    expect(current.lane!.worktreePath).toBe(f.owned.cwd);
    expect(registry.lane).toMatchObject({ laneId: current.lane!.laneId, worktreePath: f.owned.cwd });
    expect(current.status).toBe('awaiting_review');
  } else {
    expect(current.lane).toBeNull();
    expect(registry.lane).toBeNull();
    expect(current).toMatchObject({ status: 'blocked', queueState: 'held', holdIntent: 'explicit-dispatch' });
    expect(JSON.parse(rawCurrent()).mission.packets[0]).toMatchObject({ status: 'blocked', queueState: 'held', holdIntent: 'explicit-dispatch' });
  }
  expect(starts()).toBe(startsBefore + 1);
  expect(current.id).toBe(f.packet.id);
  const oldCredential = readFileSync(f.capturePath + '.credential', 'utf8');
  const late = await fetch(`http://127.0.0.1:${port}/api/panel/managed-runs`, { method: 'POST',
    headers: { Authorization: `Bearer ${oldCredential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'staleowner0001', session: 'cortex-run-staleowner0001', command: 'late fixture',
      cwd: f.owned.cwd, packetId: f.packet.id, laneId: f.laneId, mode: 'detach' }) });
  expect([401, 403, 409]).toContain(late.status);
  expect((await listManagedRuns()).some(run => run.id === 'staleowner0001')).toBe(false);
}, 90000);

it('reports failed registry publication, retains a local hold, and permits an explicit same-owner stop retry', async () => {
  const f = await dispatched('interrupted-stop-publication');
  const before = rawRegistry(f.created.missionId);
  getSqlite().exec(`CREATE TRIGGER reject_stop_publication BEFORE UPDATE ON missions
    WHEN OLD.id = '${f.created.missionId}' BEGIN SELECT RAISE(ABORT, 'fixture publication unavailable'); END`);
  try {
    const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
    expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(false);
    expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
    expect(rawRegistry(f.created.missionId)).toEqual(before);
    expect(await (await import('@/lib/codex/owned')).ownedCodexSessionState(f.sessionKey)).toBe('active');
  } finally { getSqlite().exec('DROP TRIGGER IF EXISTS reject_stop_publication'); }
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(true);
  expect(readMissionRegistryEntry(f.created.missionId)!.mission.packets[0]).toMatchObject({ operatorStopped: true,
    queueState: 'held', blockedReason: 'operator_stopped' });
}, 60000);

it.each(['generation', 'lane', 'lifecycle', 'archived', 'released', 'unreadable'] as const)(
  'preserves a foreign or terminal registry %s instead of acknowledging a stale stop', async reason => {
    const f = await dispatched(`foreign-${reason}`);
    await withMissionRegistryState(f.created.missionId, state => {
      const packet = state.packets[0];
      if (reason === 'generation') packet.storageAdmissionEpoch = (packet.storageAdmissionEpoch ?? 0) + 1;
      if (reason === 'lane') packet.lane!.laneId = 'different-owner';
      if (reason === 'lifecycle') state.lifecycleHold = { source: 'foreign-owner', reason: 'operator_stop',
        startedAt: new Date().toISOString(), ownerPid: process.pid, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
      if (reason === 'archived') { packet.archivedAt = new Date().toISOString(); packet.status = 'archived'; }
      if (reason === 'released') { packet.releaseState = 'released'; packet.releaseStatePayload = { source: 'release-fixture',
        releasedAt: new Date().toISOString(), headSha: git('rev-parse', 'HEAD').toString().trim() }; }
      return { state, result: undefined };
    });
    if (reason === 'unreadable') getSqlite().prepare('UPDATE missions SET mission_state_json = ?, updated_at = updated_at + 1 WHERE id = ?')
      .run('{invalid', f.created.missionId);
    const registryBefore = rawRegistry(f.created.missionId);
    const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
    expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(false);
    expect(rawRegistry(f.created.missionId)).toEqual(registryBefore);
    expect(await (await import('@/lib/codex/owned')).ownedCodexSessionState(f.sessionKey)).toBe('active');
  }, 60000,
);


it('refuses a stale lane after both stores have advanced to a newer owner', async () => {
  const f = await dispatched('advanced-current-owner');
  const advance = (packet: OrchestratorMissionState['packets'][number]) => {
    packet.storageAdmissionEpoch = (packet.storageAdmissionEpoch ?? 0) + 1;
    packet.lane!.laneId = 'newer-lane-owner';
    packet.lane!.sessionKey = 'codex-owned:newer-owner';
  };
  await withLockedState(state => { advance(state.packets[0]); });
  await withMissionRegistryState(f.created.missionId, state => { advance(state.packets[0]); return { state, result: undefined }; });
  const currentBefore = rawCurrent();
  const registryBefore = rawRegistry(f.created.missionId);
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(false);
  expect(rawCurrent()).toBe(currentBefore);
  expect(rawRegistry(f.created.missionId)).toEqual(registryBefore);
}, 60000);

it('keeps a concurrent registry write and requires a fresh explicit Stop after a lost CAS', async () => {
  const f = await dispatched('concurrent-registry-owner');
  const advanced = structuredClone(readMissionRegistryEntry(f.created.missionId)!.mission);
  advanced.updatedAt = new Date(Date.now() + 1).toISOString();
  let concurrentRow: ReturnType<typeof rawRegistry> | undefined;
  publicationSeam.beforePublish = () => {
    expect(advanceRegistryFromChild(f.created.missionId, advanced)).toEqual({ written: true });
    concurrentRow = rawRegistry(f.created.missionId);
  };
  const refused = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(refused.body.ok, JSON.stringify(refused.body)).toBe(false);
  expect(refused.body.note).toContain('ownership advanced');
  expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
  expect(rawRegistry(f.created.missionId)).toEqual(concurrentRow);
  expect(await (await import('@/lib/codex/owned')).ownedCodexSessionState(f.sessionKey)).toBe('active');
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(true);
  const registered = readMissionRegistryEntry(f.created.missionId)!.mission;
  expect(registered.updatedAt).toBe(advanced.updatedAt);
  expect(registered.packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held', blockedReason: 'operator_stopped' });
}, 60000);

it('stops and salvages the exact registered owner after another mission becomes current', async () => {
  const f = await dispatched('registry-only-stop-retry', true, true);
  const savedWork = readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8');
  // Freeze only Date: normalized routing timestamps stay stable while HTTP, timers and processes remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  const replacement = payload(await create({ issues_inline: [{ title: 'Unrelated current mission', body: 'Preserve this state.' }] }));
  const currentBefore = rawCurrent();
  expect(JSON.parse(currentBefore).mission.missionId).toBe(replacement.missionId);
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(true);
  expect(rawCurrent()).toBe(currentBefore);
  expect(readMissionRegistryEntry(f.created.missionId)!.mission.packets[0].operatorStopped).toBe(true);
  await observeInterruptedExit(f);
  const retry = await post('/api/orchestrator/reset-packet', { packetId: f.packet.id, clearWorktree: false,
    idempotencyKey: 'registered-stop-preserve-work-retry' });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect(retry.body.result).toMatchObject({ reset: false, salvaged: true, packetId: f.packet.id, worktreePruned: false });
  expect(readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8')).toBe(savedWork);
  expect(rawCurrent()).toBe(currentBefore);
  expect(readMissionRegistryEntry(f.created.missionId)!.mission.packets[0].lane!.worktreePath).toBe(f.owned.cwd);
}, 90000);

it('preserves registered work when Retry races exit finalization, then salvages on a fresh explicit retry', async () => {
  const startsBefore = starts();
  const f = await dispatched('registered-exit-finalization-retry', true, true);
  const savedWork = readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8');
  vi.useFakeTimers({ toFake: ['Date'] });
  payload(await create({ issues_inline: [{ title: 'Unrelated current mission', body: 'Preserve this state.' }] }));
  const currentBefore = rawCurrent();
  const laneBefore = readMissionRegistryEntry(f.created.missionId)!.mission.packets[0].lane;
  Object.assign(exitWindow, { surfaceId: f.sessionKey, observeLookup: false, blocked: false,
    released: false, release: null, captured: null });
  const stopped = await post('/api/lanes', { verb: 'stop', laneId: f.laneId });
  expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(true);
  exitWindow.observeLookup = true;
  const request = { packetId: f.packet.id, clearWorktree: false, idempotencyKey: 'registered-exit-pending-retry' };
  const early = await post('/api/orchestrator/reset-packet', request);
  expect(early.status, JSON.stringify(early.body)).toBe(409);
  expect(early.body.error.code).toBe('kill_unconfirmed');
  expect(exitWindow.captured?.id).toBe(f.owned.activeRun.id);
  expect(exitWindow.blocked).toBe(true);
  expect(exitWindow.released).toBe(true);
  expect(rawCurrent()).toBe(currentBefore);
  expect(readMissionRegistryEntry(f.created.missionId)!.mission.packets[0]).toMatchObject({
    operatorStopped: true, queueState: 'held', blockedReason: 'kill_unconfirmed', lane: laneBefore,
  });
  expect(readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8')).toBe(savedWork);
  expect(starts()).toBe(startsBefore + 1);
  const held = rawRegistry(f.created.missionId);
  const replay = await post('/api/orchestrator/reset-packet', request);
  expect(replay.status).toBe(409);
  expect(replay.body.error.code).toBe('kill_unconfirmed');
  expect(rawRegistry(f.created.missionId)).toEqual(held);
  await observeInterruptedExit(f);
  const retry = await post('/api/orchestrator/reset-packet', { ...request, idempotencyKey: 'registered-exit-complete-retry' });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect(retry.body.result).toMatchObject({ reset: false, salvaged: true, packetId: f.packet.id,
    worktreePruned: false, branchDeleted: false });
  expect(readFileSync(join(f.owned.cwd, 'worker-result.txt'), 'utf8')).toBe(savedWork);
  expect(rawCurrent()).toBe(currentBefore);
  expect(readMissionRegistryEntry(f.created.missionId)!.mission.packets[0].lane!.worktreePath).toBe(f.owned.cwd);
  expect(starts()).toBe(startsBefore + 1);
}, 90000);
