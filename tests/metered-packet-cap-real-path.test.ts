import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { retainTestRunAfterTimeout } from './test-fixture-lifecycle';

// Unrelated capacity discovery must not launch a real provider CLI.
vi.mock('@/lib/codex/live-capacity', () => ({ readLiveCodexRuntimeCapacity: vi.fn(async () => ({ runtime: 'codex', identityId: null, status: 'unavailable',
  reason: 'fixture', observedAt: null, source: null, confidence: null, buckets: [] })) }));
vi.mock('@/lib/claude-code/live-capacity', () => ({ readClaudeAccountCapacity: vi.fn(async () => ({ runtime: 'claude-code', identityId: null, status: 'unavailable',
  reason: 'fixture', observedAt: null, source: null, confidence: null, buckets: [] })) }));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'test', waitedMs: 0, attempts: 1 })),
  };
});

vi.mock('@/lib/worktree/safety-hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => undefined),
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-metered-cap-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(dataDir, 'repo');
const ownedRoot = path.join(dataDir, 'owned');
const priorEgressEnv = Object.fromEntries(['O8_EGRESS_REPORT_PATH', 'O8_EGRESS_BLOCK_UNEXPECTED', 'NODE_OPTIONS'].map(key => [key, process.env[key]]));
const egressReport = path.join(root, 'egress.jsonl');
const egressPreload = fileURLToPath(new URL('./fixtures/egress-assert-preload.mjs', import.meta.url));
process.env.O8_EGRESS_REPORT_PATH = egressReport;
process.env.O8_EGRESS_BLOCK_UNEXPECTED = '1';
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${egressPreload}`.trim();
await import(egressPreload);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
process.env.OPENROUTER_API_KEY = 'test-metered-key';
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';

mkdirSync(dataDir, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(path.join(repoPath, 'README.md'), 'metered test\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);

const fakeWorker = path.join(root, 'fake-worker.mjs');
const fakeWorkerPidFile = path.join(root, 'fake-worker-pids.json');
const fakeWorkerChild = `
// Owned fixture identity: ${root}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '6f879c95-211d-4610-9d15-9c4d16ec3c78' }) + '\\n');
await new Promise((resolve) => setTimeout(resolve, 500));
await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
  body: JSON.stringify({ model: 'metered/test', messages: [{ role: 'user', content: 'test' }] }),
});
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: '6f879c95-211d-4610-9d15-9c4d16ec3c78', total_cost_usd: 6.5, usage: { input_tokens: 653000, output_tokens: 10 } }) + '\\n');
if (process.env.O8_TEST_FINISH_METERED_WORKER === '1') process.exit(0);
setInterval(() => {}, 1000);
`;
writeFileSync(fakeWorker, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('claude 1.0.0'); process.exit(0); }
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  appendFileSync(${JSON.stringify(path.join(root, 'probes.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log(JSON.stringify({ loggedIn: false })); process.exit(0);
}
appendFileSync(${JSON.stringify(path.join(root, 'starts.jsonl'))}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');

process.stdin.resume();
process.stdin.on('end', () => {
  const worker = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(fakeWorkerChild)}], {
    // The captured leader identity authorizes its process group. An escaped
    // child's unverifiable identity correctly keeps the real kill ladder held.
    detached: false,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  writeFileSync(process.env.O8_TEST_FAKE_WORKER_PID_FILE, JSON.stringify({
    interpreterPid: process.pid,
    workerPid: worker.pid,
  }));
  worker.unref();
  if (process.env.O8_TEST_FINISH_METERED_WORKER === '1') worker.once('exit', () => process.exit(0));
  setInterval(() => {}, 1000);
});
`);
chmodSync(fakeWorker, 0o755);
process.env.O8_CLAUDE_CODE_BIN = fakeWorker;
process.env.O8_TEST_FAKE_WORKER_PID_FILE = fakeWorkerPidFile;

let upstreamCalls = 0;
let responseGate: Promise<void> | null = null;
let releaseResponseGate: (() => void) | undefined;
const upstream = createServer(async (request, response) => {
  if (request.url !== '/api/v1/messages') {
    response.writeHead(404).end();
    return;
  }
  upstreamCalls += 1;
  if (responseGate) await responseGate;
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: 'gen-metered-1',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 653_000, output_tokens: 10, cost: 0.09 },
  }));
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address();
if (!address || typeof address === 'string') throw new Error('Fake gateway did not bind.');
process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL = `http://127.0.0.1:${address.port}/api`;

const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
saveRuntimeBillingMode('claude-code', 'api');
const { prepareMeteredGatewaySession } = await import('@/lib/claude-code/metered-gateway');
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { GET: getOperatorStatus } = await import('@/app/api/operator/status/route');
const { addRepo } = await import('@/lib/repos/registry');
const { NextRequest } = await import('next/server');

const fixturePids = new Set<number>();
let retainFixture = false;
const supervisor = await import('@/lib/supervisor/agent-supervisor');
const { POST: runtimeAction } = await import('@/app/api/runtime/action/route');
const { relaunchSupervisedAgent } = await import('@/lib/supervisor/relaunch-agent');
const { createOwnedSessionIo } = await import('@/lib/runtimes/shared/owned-session/session-io');
const { closeDb } = await import('@/lib/db');
const claudeOwned = await import('@/lib/claude-code/owned');
const ownedIo = createOwnedSessionIo({ root: ownedRoot, surfacePrefix: 'claude-code-owned:', invalidateFleetCache: () => {} });
const starts = () => {
  try { return readFileSync(path.join(root, 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; }
  catch { return 0; }
};

async function automaticAction(surfaceId: string, runId: string) {
  const response = await runtimeAction(new NextRequest('http://localhost/api/runtime/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'steer', surfaceId, message: 'Synthetic automatic recovery.',
      automaticRecoveryRunId: runId, clientMutationId: crypto.randomUUID() }),
  }));
  return response.json();
}

function fixtureOwnsPid(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes(root);
  } catch { return false; }
}


function readFixturePids(): number[] {
  try {
    const parsed = JSON.parse(readFileSync(fakeWorkerPidFile, 'utf8')) as Record<string, unknown>;
    return Object.values(parsed)
      .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function fakeWorkerPids(): number[] {
  try {
    return execFileSync('pgrep', ['-f', fakeWorker], { encoding: 'utf8' })
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function collectFixtureTree(): number[] {
  const queue = [...fixturePids, ...readFixturePids(), ...fakeWorkerPids()];
  const collected = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (collected.has(pid)) continue;
    collected.add(pid);
    queue.push(...childPids(pid));
  }
  return [...collected];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForFixturePids(): Promise<{ interpreterPid: number; workerPid: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(fakeWorkerPidFile, 'utf8')) as {
        interpreterPid?: number;
        workerPid?: number;
      };
      if (parsed.interpreterPid && parsed.workerPid) {
        fixturePids.add(parsed.interpreterPid);
        fixturePids.add(parsed.workerPid);
        return { interpreterPid: parsed.interpreterPid, workerPid: parsed.workerPid };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for fake worker pid evidence.');
}

async function waitUntilGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async (context) => {
  delete process.env.O8_TEST_FINISH_METERED_WORKER;
  releaseResponseGate?.();
  responseGate = null;
  retainFixture ||= context.task.result?.state === 'fail' || context.signal.aborted;
  supervisor.stopSupervisorLoop();
  for (const watched of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(watched.surfaceId);
  const pids = collectFixtureTree();
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids) {
      if (fixtureOwnsPid(pid)) { try { process.kill(pid, signal); } catch {} }
    }
    await waitUntilGone(pids);
    if (!pids.some(isAlive)) break;
  }
  const survivors = pids.filter(isAlive);
  fixturePids.clear();
  rmSync(fakeWorkerPidFile, { force: true });
  let unexpectedEgress: unknown[] = [];
  try { unexpectedEgress = readFileSync(egressReport, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { retainFixture = true; unexpectedEgress = ['unreadable egress evidence']; } }
  retainFixture ||= survivors.length > 0 || unexpectedEgress.length > 0;
  if (retainFixture && process.env.O8_TEST_RUN_DATA_ROOT) retainTestRunAfterTimeout(process.env.O8_TEST_RUN_DATA_ROOT);
  expect(unexpectedEgress).toEqual([]);
  expect(survivors).toEqual([]);
});

afterAll(() => {
  upstream.close();
  closeDb();
  for (const [key, value] of Object.entries(priorEgressEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (!retainFixture) rmSync(root, { recursive: true, force: true });
  else console.error(`Retained metered fixture evidence: ${root}`);
});

async function waitForEvent(laneId: string, verb: 'spend_cap_hit' | 'kill_escalated') {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = getLaneEvents(laneId, 200).find((candidate) => candidate.verb === verb);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${verb}.`);
}

async function waitForConfirmedKillEvent(laneId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = getLaneEvents(laneId, 200).find((candidate) =>
      candidate.verb === 'kill_escalated' && candidate.payload?.confirmed === true);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for a confirmed kill_escalated event.');
}

describe('metered packet cap real path', () => {
  it('keeps known cap refusal latched when publishing telemetry fails after upstream inference', async () => {
    const sessionDir = mkdtempSync(path.join(root, 'cap-persistence-failure-'));
    mkdirSync(path.join(sessionDir, 'gateway-spend.json'));
    const gateway = await prepareMeteredGatewaySession({ sessionDir } as OwnedSessionRecord,
      process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL!, { carrier: 'openrouter', costUsd: 0.05, inputTokens: 700_000 });
    const before = upstreamCalls;
    const call = () => fetch(`${gateway}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'metered/test', messages: [{ role: 'user', content: 'test' }] }) });
    expect((await call()).status).toBe(502);
    expect((await call()).status).toBe(429);
    expect(upstreamCalls - before).toBe(1);
  });

  it.each(['sequential', 'concurrent'] as const)('blocks %s post-cap requests before another upstream inference', async (mode) => {
    const sessionDir = mkdtempSync(path.join(root, 'cap-refusal-'));
    const gateway = await prepareMeteredGatewaySession({ sessionDir } as OwnedSessionRecord,
      process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL!, { carrier: 'openrouter', costUsd: 0.05, inputTokens: 700_000 });
    const before = upstreamCalls;
    const call = () => fetch(`${gateway}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'metered/test', messages: [{ role: 'user', content: 'test' }] }) });
    const responses = mode === 'concurrent' ? await Promise.all([call(), call(), call()])
      : [await call(), await call(), await call()];
    expect(responses.map((response) => response.status)).toEqual([429, 429, 429]);
    expect(upstreamCalls - before).toBe(1);
    expect(JSON.parse(readFileSync(path.join(sessionDir, 'gateway-spend.json'), 'utf8'))).toMatchObject({
      costUsd: 0.09, inputTokens: 653_000, capHit: true,
    });
  });

  it.each(['cap-hit', 'input-cap', 'operator-stop', 'registry-stop'] as const)('refuses cold recovery of an unarchived %s packet before its interrupt marker is saved', async (reason) => {
    process.env.O8_TEST_FINISH_METERED_WORKER = '1';
    await writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'metered/test', codexModel: null });
    await addRepo(repoPath);
    const packetId = `packet-cold-${reason}`;
    const lane = createLane({ repoPath, branch: `issue/cold-${reason}`, runtime: 'claude-code', packetId });
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: `mission-cold-${reason}`, repoPath,
      runtime: 'claude-code', packets: [{ id: packetId, referenceLabel: 'P1', title: 'Cold cap', summary: 'Synthetic cap recovery.',
        workspaceTargetPath: repoPath, branchTarget: `issue/cold-${reason}`, runtime: 'claude-code', claudeCodeCarrier: 'openrouter',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'launching', lane: null }] });
    const launch = await dispatch({ verb: 'launch_session', laneId: lane.id, prompt: 'Synthetic under-budget turn.',
      claudeCodeCarrier: 'openrouter', spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 7_000_000 }, actor: 'orchestrator' });
    expect(launch, launch.note).toMatchObject({ ok: true });
    const surfaceId = getLane(lane.id)!.sessionKey!;
    await waitForFixturePids();
    await vi.waitFor(async () => {
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      expect((await ownedIo.findSession(surfaceId))?.activeRun).toBeUndefined();
      expect((await ownedIo.findSession(surfaceId))?.recentRuns[0].outcome).toBe('finished');
    }, { timeout: 15_000, interval: 50 });
    const saved = (await ownedIo.findSession(surfaceId))!;
    const runId = saved.recentRuns[0].id;
    // Simulate a server exit after the gateway persisted its cap/stop decision,
    // before interruption or archival could mark the owned generation.
    const stopped = readOrchestratorControlPlaneState();
    const budget = reason === 'cap-hit' || reason === 'input-cap';
    Object.assign(stopped.packets[0], { operatorStopped: reason !== 'input-cap', status: 'blocked', queueState: 'held', blockedReason: budget ? 'spend_cap_hit' : 'operator_stopped',
      spendCap: { carrier: 'openrouter', costUsd: budget ? 0.05 : 1, inputTokens: budget ? 600_000 : 7_000_000 },
      spendTelemetry: { costUsd: reason === 'input-cap' ? null : 0.09, inputTokens: 653_000, outputTokens: 10, costSource: 'gateway', capHit: reason === 'cap-hit', updatedAt: new Date().toISOString() } });
    writeOrchestratorControlPlaneState(stopped);
    const persistedStop = readOrchestratorControlPlaneState();
    if (reason === 'registry-stop') {
      const { recordMission } = await import('@/lib/db/missions-store');
      recordMission({ id: stopped.missionId!, repoPath, runtime: 'claude-code', prompt: 'Synthetic mission.', summary: '',
        constraints: '', packetMeta: [], totalWaves: 1, missionState: persistedStop });
      writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    }
    supervisor.registerWatchedAgent(surfaceId, repoPath, 'cold cap', 'Synthetic cold recovery.');
    const cold = execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
      '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      const imported = await import('./src/lib/supervisor/agent-supervisor.ts'); const supervisor = imported.default ?? imported;
      let mutations = 0;
      supervisor.startSupervisorLoop({ fetchFleetStatus: async () => [{sessionKey: ${JSON.stringify(surfaceId)}, status: 'waiting'}],
        fetchTranscript: async () => [], steerAgent: async () => { mutations++; }, interruptAgent: async () => { mutations++; },
        relaunchAgent: async () => { mutations++; return {status: 'held', reason: 'fixture'}; },
        broadcastAgentUpdate: () => {}, queueOrchestratorEscalation: () => {} });
      supervisor.stopSupervisorLoop();
      const watched = supervisor.getWatchedAgents().find(w => w.surfaceId === ${JSON.stringify(surfaceId)});
      if (!watched) throw new Error('Persisted cap watcher missing');
      watched.registeredAt = watched.lastActivityAt = Date.now() - 30 * 60_000; watched.nextPollAt = 0;
      await supervisor.runSupervisorTickForTesting();
      console.log('COLD_RESULT=' + JSON.stringify({mutations, status: watched.lastStatus})); process.exit(0);
    `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(cold.split('COLD_RESULT=')[1].split('\n')[0])).toEqual({ mutations: 0, status: 'held' });
    const beforeRequests = upstreamCalls; const beforeStarts = starts();
    expect(await automaticAction(surfaceId, runId))
      .toMatchObject({ ok: false, note: expect.stringMatching(/packet.*(budget|stopped)/i) });
    const explicit = await runtimeAction(new NextRequest('http://localhost/api/runtime/action', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'steer', surfaceId,
        message: 'A prompt alone grants no new budget.', clientMutationId: crypto.randomUUID() }),
    }));
    expect(await explicit.json()).toMatchObject({ ok: false, note: expect.stringMatching(/packet.*(budget|stopped)/i) });
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    expect(await launchRuntimeSurface({ runtime: 'claude-code', prompt: 'Synthetic fresh retry.', repoPath, cwd: repoPath,
      automaticRecoverySurfaceId: surfaceId, automaticRecoveryRunId: runId }))
      .toMatchObject({ ok: false, note: expect.stringMatching(/packet.*(budget|stopped)/i) });
    await vi.waitFor(async () => {
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      expect((await ownedIo.findSession(surfaceId))?.activeRun).toBeUndefined();
    }, { timeout: 15_000, interval: 50 });
    expect(starts()).toBe(beforeStarts); expect(upstreamCalls).toBe(beforeRequests);
    expect((await ownedIo.findSession(surfaceId))?.recentRuns[0].id).toBe(runId);
    const packet = reason === 'registry-stop'
      ? (await import('@/lib/orchestrator/mission-registry')).readMissionRegistryEntry(stopped.missionId!, { includeArchived: true })!.mission.packets[0]
      : readOrchestratorControlPlaneState().packets[0];
    expect(packet).toMatchObject({ operatorStopped: persistedStop.packets[0].operatorStopped,
      queueState: persistedStop.packets[0].queueState, blockedReason: persistedStop.packets[0].blockedReason,
      spendCap: persistedStop.packets[0].spendCap, spendTelemetry: persistedStop.packets[0].spendTelemetry });
    // An explicit budget/stop change admits an ordinary automatic turn again.
    const authorized = structuredClone(persistedStop);
    Object.assign(authorized.packets[0], { operatorStopped: false, status: 'running', queueState: 'running', blockedReason: undefined,
      spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 7_000_000 }, spendTelemetry: { ...authorized.packets[0].spendTelemetry, capHit: false } });
    writeOrchestratorControlPlaneState(authorized);
    const current = (await ownedIo.findSession(surfaceId))!.recentRuns[0].id;
    expect(await automaticAction(surfaceId, current)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(upstreamCalls).toBe(beforeRequests + 1), { timeout: 15_000, interval: 50 });
    await vi.waitFor(async () => {
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      expect((await ownedIo.findSession(surfaceId))?.activeRun).toBeUndefined();
    }, { timeout: 15_000, interval: 50 });
    if (reason === 'cap-hit') {
      // A stop arriving during async provider readiness must win at spawn, too.
      const { ensureDispatchBackendReady } = await import('@/lib/runtimes/shared/dispatch-readiness');
      vi.mocked(ensureDispatchBackendReady).mockImplementationOnce(async () => {
        writeOrchestratorControlPlaneState(persistedStop);
        return { ready: true, reason: 'fixture', waitedMs: 0, attempts: 1,
          lastCheck: { ready: true, reason: 'fixture', apiBase: 'http://127.0.0.1', portSource: 'file', apiPortFilePresent: true } };
      });
      const nextRun = (await ownedIo.findSession(surfaceId))!.recentRuns[0].id;
      expect(await automaticAction(surfaceId, nextRun)).toMatchObject({ ok: false, note: expect.stringMatching(/packet.*budget/i) });
      expect(upstreamCalls).toBe(beforeRequests + 1); expect(starts()).toBe(beforeStarts + 1);
    }
  }, 60_000);

  it('holds a metered cap stop through supervisor recovery and SQLite reopen without another request', async () => {
    await writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'metered/test', codexModel: null });
    await addRepo(repoPath);
    const beforeSiblingRequests = upstreamCalls;
    const sibling = await claudeOwned.launchOwnedClaudeCodeSession({ cwd: repoPath,
      prompt: 'Synthetic unaffected sibling.', claudeCodeCarrier: 'openrouter', claudeCodeModel: 'metered/test',
      spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 7_000_000 } });
    expect(sibling.ok, sibling.note).toBe(true);
    const siblingPids = await waitForFixturePids();
    await vi.waitFor(async () => {
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      expect(upstreamCalls).toBe(beforeSiblingRequests + 1);
      expect((await ownedIo.findSession(sibling.surfaceId))?.threadId).toBe('6f879c95-211d-4610-9d15-9c4d16ec3c78');
    }, { timeout: 15_000, interval: 50 });
    const siblingBefore = await ownedIo.findSession(sibling.surfaceId);
    rmSync(fakeWorkerPidFile, { force: true });
    const packetId = 'packet-metered-real-path';
    const lane = createLane({
      repoPath,
      branch: 'issue/metered-real-path',
      runtime: 'claude-code',
      packetId,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-metered-real-path',
      repoPath,
      runtime: 'claude-code',
      packets: [{
        id: packetId,
        referenceLabel: 'P1',
        title: 'Metered real path',
        summary: 'Verify authoritative spend and interruption.',
        workspaceTargetPath: repoPath,
        branchTarget: 'issue/metered-real-path',
        runtime: 'claude-code',
        claudeCodeCarrier: 'openrouter',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'launching',
        lane: null,
      }],
    });

    const beforeCapRequests = upstreamCalls;
    const beforeCapStarts = starts();
    let releaseResponse!: () => void;
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve; releaseResponseGate = resolve; });
    const launch = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'Exercise the metered gateway.',
      claudeCodeCarrier: 'openrouter',
      spendCap: { carrier: 'openrouter', costUsd: 0.05, inputTokens: 700_000 },
      actor: 'orchestrator',
    });
    expect(launch.ok, launch.note).toBe(true);
    const surfaceId = getLane(lane.id)?.sessionKey;
    expect(surfaceId).toBeTruthy();
    const callbacks = {
      // Stale fleet data must not override durable stopped owned-session evidence.
      fetchFleetStatus: async () => [{ sessionKey: surfaceId!, status: 'waiting' }],
      fetchTranscript: async () => [],
      steerAgent: vi.fn(async (id: string, _message: string, runId?: string) => {
        const result = await automaticAction(id, runId!);
        if (!result.ok) throw new Error(result.note);
      }),
      interruptAgent: vi.fn(async () => {}),
      relaunchAgent: vi.fn(relaunchSupervisedAgent),
      broadcastAgentUpdate: vi.fn(), queueOrchestratorEscalation: vi.fn(),
    };
    supervisor.startSupervisorLoop(callbacks);
    supervisor.stopSupervisorLoop();
    supervisor.registerWatchedAgent(surfaceId!, repoPath, 'metered fixture', 'synthetic recovery');
    releaseResponse();
    responseGate = null;
    const event = await waitForEvent(lane.id, 'spend_cap_hit');
    expect(event.payload).toMatchObject({ costUsd: 0.09, costSource: 'gateway', costCapUsd: 0.05 });
    const { readOwnedRecoveryState } = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
    let stoppingRunId: string | undefined;
    await vi.waitFor(async () => {
      const recovery = await readOwnedRecoveryState(surfaceId!, { includeArchived: true });
      expect(recovery).toMatchObject({ owned: true, interrupted: true });
      stoppingRunId = recovery.owned ? recovery.runId : undefined;
      expect(stoppingRunId).toBeTruthy();
    }, { timeout: 5_000, interval: 10 });
    if (!supervisor.getWatchedAgents().some(agent => agent.surfaceId === surfaceId)) {
      supervisor.registerWatchedAgent(surfaceId!, repoPath, 'settled cap fixture', 'Synthetic stale recovery.');
    }
    const watchedDuringStop = supervisor.getWatchedAgents().find(agent => agent.surfaceId === surfaceId)!;
    watchedDuringStop.registeredAt = watchedDuringStop.lastActivityAt = Date.now() - 30 * 60_000;
    watchedDuringStop.nextPollAt = 0;
    await supervisor.runSupervisorTickForTesting();
    const stoppingRefusal = await automaticAction(surfaceId!, stoppingRunId!);
    expect(stoppingRefusal).toMatchObject({ ok: false, note: expect.stringContaining('interrupted') });
    expect(stoppingRefusal.outcomeUnknown).not.toBe(true);
    expect(['interrupted', 'unavailable']).toContain(watchedDuringStop.lastStatus);
    expect(callbacks.steerAgent).not.toHaveBeenCalled();
    const workerPids = await waitForFixturePids();
    const kill = await waitForConfirmedKillEvent(lane.id);
    expect(kill.payload).toMatchObject({ confirmed: true });
    for (const pid of [workerPids.interpreterPid, workerPids.workerPid]) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }

    const mission = await getMissionStatus({ includeCost: true });
    if (!('cost' in mission) || !mission.cost) throw new Error('Expected mission cost telemetry.');
    expect(mission.cost.packetCosts[0]).toMatchObject({ totalCostUsd: 0.09, costSource: 'gateway' });
    expect(mission.packets[0]).toMatchObject({
      spendTelemetry: { costUsd: 0.09, costSource: 'gateway', capHit: true },
    });

    const request = new NextRequest('http://localhost/api/operator/status');
    const status = await getOperatorStatus(request);
    const body = await status.json() as { spendCapHits: Array<Record<string, unknown>> };
    expect(body.spendCapHits).toEqual(expect.arrayContaining([
      expect.objectContaining({ packetId, costUsd: 0.09, costSource: 'gateway' }),
    ]));

    // Exercise the production recovery entry points after the real stop settles.
    await vi.waitFor(async () => {
      expect(await ownedIo.findArchivedSession(surfaceId!)).toBeTruthy();
      expect(getLane(lane.id)?.status).toBe('archived');
    }, { timeout: 30_000, interval: 50 });
    const stopped = await ownedIo.findArchivedSession(surfaceId!);
    const stoppedRun = stopped!.recentRuns[0];
    expect(stoppedRun.outcome).toBe('interrupted');
    expect(upstreamCalls).toBe(beforeCapRequests + 1);
    expect(starts()).toBe(beforeCapStarts + 1);
    const beforeRequests = upstreamCalls;
    const beforeStarts = starts();
    const packetBefore = readOrchestratorControlPlaneState().packets[0];
    expect(packetBefore).toMatchObject({ operatorStopped: true, queueState: 'held',
      spendTelemetry: { capHit: true, costUsd: 0.09 } });
    expect(packetBefore.blockedReason).not.toBe('kill_unconfirmed');

    supervisor.registerWatchedAgent(surfaceId!, repoPath, 'archived fixture', 'synthetic stale recovery');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      closeDb();
      const watched = supervisor.getWatchedAgents().find(agent => agent.surfaceId === surfaceId)!;
      watched.registeredAt = watched.lastActivityAt = Date.now() - 30 * 60_000;
      watched.nextPollAt = 0;
      await supervisor.runSupervisorTickForTesting();
      expect(watched.lastStatus).toBe('unavailable');
      expect((await automaticAction(surfaceId!, stoppedRun.id)).ok).toBe(false);
      expect(await relaunchSupervisedAgent('Synthetic recovery', repoPath, 'fixture', surfaceId!))
        .toMatchObject({ status: 'held' });
    }
    expect(callbacks.steerAgent).not.toHaveBeenCalled();
    expect(callbacks.relaunchAgent).not.toHaveBeenCalled();
    expect(starts()).toBe(beforeStarts);
    expect(upstreamCalls).toBe(beforeRequests);
    expect((await ownedIo.findArchivedSession(surfaceId!))?.recentRuns[0])
      .toMatchObject({ id: stoppedRun.id, outcome: 'interrupted' });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      operatorStopped: packetBefore.operatorStopped, queueState: packetBefore.queueState,
      status: packetBefore.status, blockedReason: packetBefore.blockedReason,
      spendCap: packetBefore.spendCap, spendTelemetry: packetBefore.spendTelemetry,
    });
    expect((await ownedIo.findSession(sibling.surfaceId))?.recentRuns[0].id).toBe(siblingBefore!.recentRuns[0].id);
    for (const pid of Object.values(siblingPids)) expect(isAlive(pid)).toBe(true);
    closeDb();
    const coldOutput = execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
      '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      const imported = await import('./src/lib/supervisor/agent-supervisor.ts');
      const supervisor = imported.default ?? imported;
      const persisted = await import('./src/lib/orchestrator/control-plane.ts');
      const control = persisted.default ?? persisted;
      const database = await import('./src/lib/db/index.ts');
      const db = database.default ?? database;
      const rowCount = () => db.getSqlite().prepare('SELECT count(*) AS count FROM watched_agents WHERE surface_id = ?').get(${JSON.stringify(surfaceId)}).count;
      const beforeWatch = rowCount();
      let mutations = 0;
      supervisor.startSupervisorLoop({ fetchFleetStatus: async () => [{sessionKey: ${JSON.stringify(surfaceId)}, status: 'waiting'}],
        fetchTranscript: async () => [], steerAgent: async () => { mutations++; }, interruptAgent: async () => { mutations++; },
        relaunchAgent: async () => { mutations++; return {status: 'held', reason: 'fixture'}; },
        broadcastAgentUpdate: () => {}, queueOrchestratorEscalation: () => {} });
      supervisor.stopSupervisorLoop();
      await supervisor.runSupervisorTickForTesting();
      const packet = control.readOrchestratorControlPlaneState().packets.find(p => p.id === ${JSON.stringify(packetId)});
      console.log('COLD_RESULT=' + JSON.stringify({mutations, beforeWatch, afterWatch: rowCount(), watches: supervisor.getWatchedAgents().length,
        held: packet.queueState, stopped: packet.operatorStopped, capHit: packet.spendTelemetry.capHit}));
      process.exit(0);
    `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(coldOutput.split('COLD_RESULT=')[1].split('\n')[0])).toEqual({
      mutations: 0, beforeWatch: 1, afterWatch: 0, watches: 0, held: 'held', stopped: true, capHit: true,
    });
    expect(upstreamCalls).toBe(beforeRequests);
    expect(starts()).toBe(beforeStarts);
    // Explicit steering alone must not revive this archived capped packet.
    const explicit = await runtimeAction(new NextRequest('http://localhost/api/runtime/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'steer', surfaceId, message: 'No new budget decision.', clientMutationId: crypto.randomUUID() }),
    }));
    expect((await explicit.json()).ok).toBe(false);
    expect(starts()).toBe(beforeStarts);
    expect(upstreamCalls).toBe(beforeRequests);
    // Positive control: an explicit turn for an under-budget sibling still works.
    // This control does not authorize or resume the capped packet.
    const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
    expect((await escalateInterruptOwnedSurface(sibling.surfaceId))?.confirmedDead).toBe(true);
    rmSync(fakeWorkerPidFile, { force: true });
    const resumed = await runtimeAction(new NextRequest('http://localhost/api/runtime/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'steer', surfaceId: sibling.surfaceId, message: 'Explicit synthetic sibling turn.', clientMutationId: crypto.randomUUID() }),
    }));
    const resumeResult = await resumed.json();
    expect(resumeResult, JSON.stringify(resumeResult)).toMatchObject({ ok: true });
    await waitForFixturePids();
    await vi.waitFor(() => expect(upstreamCalls).toBe(beforeRequests + 1), { timeout: 10_000, interval: 50 });
    expect(starts()).toBe(beforeStarts + 1);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true,
      queueState: 'held', spendTelemetry: { capHit: true, costUsd: 0.09 } });
    expect(getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'spend_cap_hit', payload: expect.objectContaining({ reason: expect.stringContaining('spend cap reached') }) }),
      expect.objectContaining({ verb: 'kill_escalated', payload: expect.objectContaining({ confirmed: true }) }),
    ]));
  }, 90_000);
});
