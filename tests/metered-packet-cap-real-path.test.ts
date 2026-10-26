import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  // Fixture receipts must survive the worker's ambient-environment allowlist.
  writeFileSync(${JSON.stringify(fakeWorkerPidFile)}, JSON.stringify({
    interpreterPid: process.pid,
    workerPid: worker.pid,
  }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { try { worker.kill(signal); } catch {} });
  }
  worker.once('exit', () => process.exit(0));
  worker.unref();
  setInterval(() => {}, 1000);
});
`);
chmodSync(fakeWorker, 0o755);
process.env.O8_CLAUDE_CODE_BIN = fakeWorker;

let upstreamCalls = 0;
let responseGate: Promise<void> | null = null;
let releaseResponseGate: (() => void) | undefined;
const upstream = createServer(async (request, response) => {
  if (request.url === '/api/setup/status' || request.url === '/supervisor/watch') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
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
process.env.O8_API_PORT = String(address.port);
process.env.O8_WS_PORT = String(address.port);
process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL = `http://127.0.0.1:${address.port}/api`;

const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
saveRuntimeBillingMode('claude-code', 'api');
const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
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
// Cold recovery has one live owner. Refresh explicitly so the fixture parent
// cannot rewrite the child server's run while that server verifies Stop.
const refreshTimer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[
  Symbol.for('o8.ownedSession.refreshTimer.claude-code')
];
if (refreshTimer) clearInterval(refreshTimer);
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
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
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
  it('keeps a live outer admission after its inner guard completes', async () => {
    const { AsyncResource } = await import('node:async_hooks');
    const { withOwnedActionGuard, assertOwnedActionAdmission } = await import('@/lib/runtimes/shared/owned-session/action-admission');
    let held = false;
    let inherited!: () => void;
    await withOwnedActionGuard(() => { if (held) throw new Error('Outer admission held.'); }, async () => {
      await withOwnedActionGuard(() => {}, async () => {
        inherited = AsyncResource.bind(() => assertOwnedActionAdmission(null));
      });
      held = true;
      expect(inherited).toThrow('Outer admission held.');
    });
    expect(inherited).not.toThrow();
  });

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

  it.each(['capped', 'held', 'operator stopped'] as const)(
    'cold recovery respects a %s packet before interruption journaling', async (stop) => {
      await writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'metered/test', codexModel: null });
      await addRepo(repoPath);
      const packetId = `cold-${stop.replaceAll(' ', '-')}`;
      const lane = createLane({ repoPath, branch: `issue/${packetId}`, runtime: 'claude-code', packetId });
      const beforeRequests = upstreamCalls;
      const beforeStarts = starts();
      writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath,
        packets: [{ id: packetId, referenceLabel: 'P1', title: 'Cold recovery', summary: 'Recovery window.',
          runtime: 'claude-code', workspaceTargetPath: repoPath, branchTarget: `issue/${packetId}`,
          dependencyLabels: [], dependencyPacketIds: [], status: 'launching', releaseState: 'pending', queueState: 'queued', lane: null }] });
      const launched = await dispatch({ verb: 'launch_session', laneId: lane.id, prompt: 'Synthetic recovery window.',
        claudeCodeCarrier: 'openrouter', spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 7_000_000 }, actor: 'orchestrator' });
      expect(launched.ok, launched.note).toBe(true);
      const launch = { surfaceId: getLane(lane.id)!.sessionKey! };
      const pids = await waitForFixturePids();
      await vi.waitFor(() => expect(upstreamCalls - beforeRequests).toBe(1), { timeout: 15_000 });
      await vi.waitFor(async () => {
        await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
        expect((await ownedIo.findSession(launch.surfaceId))?.threadId).toBeTruthy();
      });
      // The process has exited, but no interruption receipt has been journaled.
      try { process.kill(pids.workerPid, 'SIGKILL'); } catch {}
      await waitUntilGone([pids.workerPid]);
      try { process.kill(pids.interpreterPid, 'SIGKILL'); } catch {}
      await waitUntilGone([pids.interpreterPid]);
      await vi.waitFor(async () => {
        expect((await ownedIo.findSession(launch.surfaceId))?.recentRuns[0].childExit).toBeTruthy();
      }, { timeout: 5_000 });
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      const saved = (await ownedIo.findSession(launch.surfaceId))!;
      const run = (saved.activeRun ?? saved.recentRuns[0])!;
      run.outcome = 'finished';
      run.finishedAt = new Date().toISOString();
      delete run.interruptRequestedAt;
      saved.recentRuns = [run, ...saved.recentRuns.filter(candidate => candidate.id !== run.id)];
      delete saved.activeRun;
      await ownedIo.saveSession(saved);
      const reason = stop === 'capped' ? 'Packet spend cap reached.' : stop;
      const state = readOrchestratorControlPlaneState();
      Object.assign(state.packets[0], { status: 'running', queueState: stop === 'held' ? 'held' : 'queued',
        operatorStopped: stop === 'operator stopped', blockedReason: reason,
        ...(stop === 'capped' ? { spendCap: { carrier: 'openrouter', costUsd: 0.05, inputTokens: 700_000 },
          spendTelemetry: { capHit: true, costUsd: 0.09, inputTokens: 653_000, outputTokens: 10,
            costSource: 'gateway', updatedAt: new Date().toISOString() } } : {}),
      });
      writeOrchestratorControlPlaneState(state);
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
        '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
        const load = async p => { const m = await import(p); return m.default ?? m; };
        const supervisor = await load('./src/lib/supervisor/agent-supervisor.ts');
        const { POST } = await load('./src/app/api/runtime/action/route.ts');
        const { NextRequest } = await import('next/server');
        let actions = 0;
        supervisor.startSupervisorLoop({ fetchFleetStatus: async () => [{sessionKey: ${JSON.stringify(launch.surfaceId)}, status: 'waiting'}],
          fetchTranscript: async () => [], steerAgent: async (surfaceId, message, automaticRecoveryRunId) => {
            actions++;
            await POST(new NextRequest('http://localhost/api/runtime/action', {method: 'POST',
              headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'steer', surfaceId,
                message, automaticRecoveryRunId, clientMutationId: crypto.randomUUID()})}));
          }, interruptAgent: async () => {}, relaunchAgent: async () => ({status: 'held', reason: 'fixture'}),
          broadcastAgentUpdate: () => {}, queueOrchestratorEscalation: () => {} });
        supervisor.stopSupervisorLoop();
        supervisor.registerWatchedAgent(${JSON.stringify(launch.surfaceId)}, ${JSON.stringify(repoPath)}, 'fixture', 'recovery');
        const watched = supervisor.getWatchedAgents().find(agent => agent.surfaceId === ${JSON.stringify(launch.surfaceId)});
        watched.registeredAt = watched.lastActivityAt = Date.now() - 30 * 60_000;
        watched.nextPollAt = 0;
        await supervisor.ingestAgentCompletionSignal(${JSON.stringify(launch.surfaceId)}, ${JSON.stringify(run.id)});
        await supervisor.runSupervisorTickForTesting();
        const direct = await POST(new NextRequest('http://localhost/api/runtime/action', {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'steer',
            surfaceId: ${JSON.stringify(launch.surfaceId)}, message: 'Synthetic direct recovery.',
            automaticRecoveryRunId: ${JSON.stringify(run.id)}, clientMutationId: crypto.randomUUID()})}));
        console.log('COLD_DIRECT_OK=' + (await direct.json()).ok);
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log('COLD_ACTIONS=' + actions);
        supervisor.unregisterWatchedAgent(${JSON.stringify(launch.surfaceId)});
        process.exit(0);
      `], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
      expect.soft(upstreamCalls - beforeRequests, 'provider requests after cold recovery').toBe(1);
      expect.soft(starts() - beforeStarts, 'worker launches after cold recovery').toBe(1);
      expect(stdout).toContain('COLD_ACTIONS=0');
      expect(stdout).toContain('COLD_DIRECT_OK=false');
      expect(readOrchestratorControlPlaneState().packets[0].blockedReason).toBe(reason);
      expect((await ownedIo.findSession(launch.surfaceId))?.recentRuns[0]).toMatchObject({ id: run.id, outcome: 'finished' });
    }, 60_000);

  it.each(['store', 'route'] as const)('kills a cold-resumed worker when its next request breaches the cap via %s', async (entry) => {
    await writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'metered/test', codexModel: null });
    await addRepo(repoPath);
    const packetId = `cold-resume-then-cap-${entry}`;
    const lane = createLane({ repoPath, branch: `issue/${packetId}`, runtime: 'claude-code', packetId });
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath,
      packets: [{ id: packetId, referenceLabel: 'P1', title: 'Resume then cap', summary: 'Stop a recovered worker.',
        runtime: 'claude-code', workspaceTargetPath: repoPath, branchTarget: `issue/${packetId}`,
        dependencyLabels: [], dependencyPacketIds: [], status: 'launching', releaseState: 'pending', queueState: 'queued', lane: null }] });
    const beforeRequests = upstreamCalls;
    const launched = await dispatch({ verb: 'launch_session', laneId: lane.id, prompt: 'Synthetic first turn.',
      claudeCodeCarrier: 'openrouter', spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 7_000_000 }, actor: 'orchestrator' });
    expect(launched.ok, launched.note).toBe(true);
    const surfaceId = getLane(lane.id)!.sessionKey!;
    const firstPids = await waitForFixturePids();
    await vi.waitFor(async () => {
      await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
      expect(upstreamCalls - beforeRequests).toBe(1);
      expect((await ownedIo.findSession(surfaceId))?.threadId).toBeTruthy();
    }, { timeout: 15_000 });
    process.kill(firstPids.workerPid, 'SIGKILL');
    await waitUntilGone(Object.values(firstPids));
    await vi.waitFor(async () => {
      expect((await ownedIo.findSession(surfaceId))?.recentRuns[0].childExit).toBeTruthy();
    }, { timeout: 5_000 });
    await claudeOwned.getOwnedClaudeCodeFleetAdditions({ fresh: true });
    const saved = (await ownedIo.findSession(surfaceId))!;
    const run = (saved.activeRun ?? saved.recentRuns[0])!;
    run.outcome = 'finished'; run.finishedAt = new Date().toISOString(); delete run.interruptRequestedAt;
    saved.recentRuns = [run, ...saved.recentRuns.filter(candidate => candidate.id !== run.id)];
    delete saved.activeRun;
    // The next admitted turn has a bounded cap; its first response breaches it.
    saved.runtimeConfig = { ...saved.runtimeConfig, spendCapCostUsd: '0.05', spendCapInputTokens: '700000' };
    await ownedIo.saveSession(saved);
    rmSync(fakeWorkerPidFile, { force: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
      '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      const load = async p => { const m = await import(p); return m.default ?? m; };
      const { POST } = await load('./src/app/api/runtime/action/route.ts');
      const { getLaneEvents } = await load('./src/lib/lane/registry.ts');
      const { NextRequest } = await import('next/server');
      const resumed = ${JSON.stringify(entry)} === 'store'
        ? await (async () => {
          const owned = await load('./src/lib/claude-code/owned.ts');
          const { withAutomaticRecoveryRequest } = await load('./src/lib/runtimes/shared/owned-session/automatic-recovery.ts');
          return withAutomaticRecoveryRequest(${JSON.stringify(surfaceId)}, ${JSON.stringify(run.id)}, async () => {
            const result = await owned.continueOwnedClaudeCodeSession(${JSON.stringify(surfaceId)}, 'Synthetic automatic cold resume.');
            // Keep the admission attempt alive while its gateway enforces Stop.
            await new Promise(resolve => setTimeout(resolve, 2000));
            return result;
          });
        })()
        : await (await POST(new NextRequest('http://localhost/api/runtime/action', {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({ action: 'steer',
            surfaceId: ${JSON.stringify(surfaceId)}, message: 'Synthetic automatic cold resume.',
            automaticRecoveryRunId: ${JSON.stringify(run.id)}, clientMutationId: crypto.randomUUID() })}))).json();
      const { readOwnedRecoveryState } = await load('./src/lib/runtimes/shared/owned-session/automatic-recovery.ts');
      const deadline = Date.now() + 12000;
      let kill; let interrupted = false;
      while (Date.now() < deadline) {
        kill = getLaneEvents(${JSON.stringify(lane.id)}, 200).find(event => event.verb === 'kill_escalated' && event.payload?.confirmed === true);
        interrupted = (await readOwnedRecoveryState(${JSON.stringify(surfaceId)}, { includeArchived: true })).interrupted;
        if (kill && interrupted) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      console.log('RESUME_CAP=' + JSON.stringify({resumed: resumed.ok, kill: !!kill, interrupted}));
      process.exit(0);
    `], { cwd: process.cwd(), env: process.env, timeout: 25_000 });
    const result = JSON.parse(stdout.split('RESUME_CAP=')[1].split('\n')[0]);
    expect(result.resumed).toBe(true);
    expect.soft(result.kill, 'cap enforcement must confirm a kill after automatic cold resume').toBe(true);
    expect.soft(result.interrupted, 'the stopped run must retain its interruption receipt').toBe(true);
    const resumedPids = await waitForFixturePids();
    await waitUntilGone(Object.values(resumedPids));
    expect.soft(Object.values(resumedPids).map(isAlive), 'both resumed workers must be dead').toEqual([false, false]);
    expect(upstreamCalls - beforeRequests).toBe(2);
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
    const watchedDuringStop = supervisor.getWatchedAgents().find(agent => agent.surfaceId === surfaceId)!;
    watchedDuringStop.registeredAt = watchedDuringStop.lastActivityAt = Date.now() - 30 * 60_000;
    watchedDuringStop.nextPollAt = 0;
    await supervisor.runSupervisorTickForTesting();
    const stoppingRefusal = await automaticAction(surfaceId!, stoppingRunId!);
    expect(stoppingRefusal).toMatchObject({ ok: false, note: expect.stringMatching(/spend_cap_hit|interrupted/) });
    expect(stoppingRefusal.outcomeUnknown).not.toBe(true);
    expect(['interrupted', 'unavailable']).toContain(watchedDuringStop.lastStatus);
    expect(callbacks.steerAgent).not.toHaveBeenCalled();
    const workerPids = await waitForFixturePids();
    const kill = await waitForConfirmedKillEvent(lane.id);
    expect(kill.payload).toMatchObject({ confirmed: true });
    for (const pid of [workerPids.interpreterPid, workerPids.workerPid]) {
      expect(isAlive(pid)).toBe(false);
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
