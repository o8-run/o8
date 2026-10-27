import { codexModelListFixtureScript } from './helpers/codex-model-list-fixture';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { SupervisorCallbacks } from '@/lib/supervisor/agent-supervisor';

// The executable below is the provider boundary. Session locks, process proof,
// signals, persistence, MCP, authenticated action routing and supervision are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-interrupted-recovery-')));
const data = join(root, 'data'); const repo = join(data, 'repo'); const bin = join(root, 'codex');
const providerGate = join(root, 'provider-start-held');
mkdirSync(data); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'),
  O8_CODEX_BIN: bin, O8_CRASH_SURVIVABLE_WORKERS: '0', O8_WORKER_SANDBOX: '0',
  O8_TEST_PROVIDER_CAPTURE: join(root, 'starts.jsonl'), O8_TEST_PROVIDER_MODE: join(root, 'mode'),
  O8_TEST_PROVIDER_GATE: providerGate })) vi.stubEnv(key, value);
writeFileSync(join(root, 'mode'), 'running');
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const args = process.argv.slice(2);
${codexModelListFixtureScript()}
// A queued-lock fixture can hold provider output until both admissions settle.
while (fs.existsSync(${JSON.stringify(providerGate)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
fs.appendFileSync(${JSON.stringify(join(root, 'starts.jsonl'))}, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}) + '\\n');
console.log(JSON.stringify({type: 'thread.started', thread_id: 'synthetic-thread'}));
const mode = fs.readFileSync(${JSON.stringify(join(root, 'mode'))}, 'utf8');
if (mode === 'failed') { console.log(JSON.stringify({type: 'turn.failed', error: {message: 'Synthetic failure'}})); process.exit(1); }
if (mode === 'finished') {
 console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 0, output_tokens: 0}}));
 process.exit(0);
}
setInterval(() => {}, 1000);
}
`); chmodSync(bin, 0o755);
const token = 'interrupted-recovery-operator-fixture'; writeFileSync(join(data, 'ws-token'), token);
const route = await import('@/app/api/runtime/action/route');
const launchRoute = await import('@/app/api/runtime/launch/route');
const { panelGateMiddleware } = await import('@/middleware');
const owned = await import('@/lib/codex/owned');
// This fixture refreshes owned state explicitly. Its background refresh must
// not rewrite run records while another case measures artifact admission.
const refreshTimer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[
  Symbol.for('o8.ownedSession.refreshTimer.codex')
];
if (refreshTimer) clearInterval(refreshTimer);
const supervisor = await import('@/lib/supervisor/agent-supervisor');
const { closeDb } = await import('@/lib/db');
const surfaces: string[] = [];
let port = 0; let mcp: ChildProcess;
const pending = new Map<number, (value: unknown) => void>(); let nextId = 0;
let afterGuardQueued: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    if (req.url === '/supervisor/completed') { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
    const payload = JSON.parse(body);
    if (payload.automaticRecoveryRunId && afterGuardQueued) await afterGuardQueued();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: 'POST', headers: req.headers as Record<string, string>, body,
    });
    const gate = panelGateMiddleware(request); const response = gate.status === 200 ? await (req.url === '/api/runtime/launch' ? launchRoute : route).POST(request) : gate;
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
function rpc(method: string, params?: Record<string, unknown>): Promise<{ result: { isError?: boolean; content: Array<{ text: string }>; tools: Array<{ name: string }> } }> {
  const id = ++nextId;
  return new Promise(resolve => { pending.set(id, value => resolve(value as Awaited<ReturnType<typeof rpc>>)); mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
async function interrupt(surfaceId: string) {
  const result = await rpc('tools/call', { name: 'cortex_interrupt_agent', arguments: { surfaceId } });
  expect(result.result?.isError, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.result.content[0].text).ok).toBe(true);
}
function record(surfaceId: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(data, 'owned-codex', surfaceId.slice('codex-owned:'.length), 'session.json'), 'utf8'));
}
function settled(surfaceId: string): boolean {
  const session = record(surfaceId);
  return !session.activeRun && session.recentRuns.every(run => run.pid <= 0 || Boolean(run.childExit));
}
const starts = () => { try { return readFileSync(join(root, 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
async function waitFor(read: () => boolean | Promise<boolean>) { await vi.waitFor(async () => expect(await read()).toBe(true), { timeout: 15_000, interval: 30 }); }
async function launch(mode: 'running' | 'finished' | 'failed') {
  writeFileSync(join(root, 'mode'), mode);
  const result = await owned.launchOwnedCodexSession({ cwd: repo, prompt: 'Synthetic provider fixture.', model: MODEL_IDS.raw.openAiGpt61Sol, effort: 'medium' });
  expect(result.ok, result.note).toBe(true); surfaces.push(result.surfaceId);
  await waitFor(async () => { await owned.getOwnedCodexFleetAdditions({ fresh: true }); return Boolean(record(result.surfaceId).threadId); });
  if (mode !== 'running') await waitFor(() => {
    const session = record(result.surfaceId);
    return settled(result.surfaceId) && session.recentRuns[0].outcome === (mode === 'failed' ? 'failed' : 'finished');
  });
  return result.surfaceId;
}
async function action(surfaceId: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/action`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'steer', surfaceId, message: 'Explicit next turn.', clientMutationId: crypto.randomUUID(), ...extra }),
  });
  return response.json();
}
async function httpLaunch(extra: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/launch`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtime: 'codex', prompt: 'Synthetic launch fixture.', cwd: repo, repoPath: repo,
      model: MODEL_IDS.raw.openAiGpt61Sol, effort: 'medium', skipSetup: true, isolate: false,
      clientMutationId: crypto.randomUUID(), ...extra }),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(result.ok ? 200 : 400);
  if (result.ok) surfaces.push(result.surfaceId);
  return result;
}
function watch(surfaceId: string, fleetStatus?: string) {
  const callbacks = {
    fetchFleetStatus: async () => fleetStatus ? [{ sessionKey: surfaceId, status: fleetStatus }] :
      (await owned.getOwnedCodexFleetAdditions()).agents.map(agent => ({ sessionKey: agent.sessionKey, status: agent.status })),
    fetchTranscript: async () => [],
    steerAgent: vi.fn(async (id: string, message: string, automaticRecoveryRunId?: string) => {
      const result = await action(id, { message, automaticRecoveryRunId });
      if (!result.ok) throw new Error(result.note);
    }),
    interruptAgent: interrupt,
    relaunchAgent: vi.fn(async () => ({ status: 'held' as const, reason: 'No new provider on retry.' })),
    broadcastAgentUpdate: vi.fn(), queueOrchestratorEscalation: vi.fn(), onAgentCompletion: vi.fn(),
  } satisfies SupervisorCallbacks;
  supervisor.startSupervisorLoop(callbacks); supervisor.stopSupervisorLoop();
  supervisor.registerWatchedAgent(surfaceId, repo, 'fixture', 'synthetic');
  return callbacks;
}
async function tick(surfaceId: string) {
  const watched = supervisor.getWatchedAgents().find(w => w.surfaceId === surfaceId);
  if (!watched) return;
  watched.registeredAt = Date.now() - 30 * 60_000; watched.lastActivityAt = watched.registeredAt; watched.nextPollAt = 0;
  await supervisor.runSupervisorTickForTesting();
}
beforeAll(async () => {
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as { port: number }).port;
  writeFileSync(join(data, 'api-port'), String(port)); vi.stubEnv('O8_WS_PORT', String(port));
  mcp = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, CORTEX_API_BASE: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = ''; mcp.stdout!.on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); } catch { /* Non-protocol startup output. */ }
    }
  });
  const list = await rpc('tools/list'); expect(list.result.tools.some((tool: { name: string }) => tool.name === 'cortex_interrupt_agent')).toBe(true);
}, 20_000);
afterEach(async () => {
  afterGuardQueued = undefined;
  for (const surfaceId of surfaces) {
    if (record(surfaceId).activeRun) await owned.interruptOwnedCodexSession(surfaceId);
  }
  // A prior case must finish writing its owned run before the next case asks
  // artifact admission to measure the shared runtime root.
  await waitFor(() => surfaces.every(settled));
});
afterAll(async () => {
  afterGuardQueued = undefined;
  supervisor.stopSupervisorLoop(); for (const watched of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(watched.surfaceId);
  for (const surfaceId of surfaces) if (record(surfaceId).activeRun) await owned.interruptOwnedCodexSession(surfaceId);
  mcp.kill('SIGTERM'); await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it('honors the persisted interrupt across repeated ticks and a fresh watcher', async () => {
  const surface = await launch('running'); await interrupt(surface);
  await waitFor(() => record(surface).recentRuns[0].outcome === 'interrupted');
  const before = starts(); const stopped = record(surface); const runId = stopped.recentRuns[0].id;
  // Historical failure evidence must not schedule a retry of the stopped generation.
  stopped.autoRetry = true;
  stopped.recentRuns.push({ ...stopped.recentRuns[0], id: 'historical-failure', pid: 0,
    outcome: 'failed', interruptRequestedAt: undefined, childExit: undefined,
    startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString() });
  writeFileSync(join(stopped.sessionDir, 'session.json'), JSON.stringify(stopped));
  const { createLane, updateLane } = await import('@/lib/lane/registry');
  const lane = createLane({ repoPath: repo, runtime: 'codex', branch: 'synthetic', sessionKey: surface });
  updateLane(lane.id, { status: 'running' });
  const callbacks = watch(surface, 'waiting');
  closeDb();
  // A new server process loads both the owned run and watched row from disk.
  const cold = execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
    const module = await import('./src/lib/codex/owned.ts'); const owned = module.default ?? module;
    const source = await import('./src/lib/supervisor/agent-supervisor.ts'); const supervisor = source.default ?? source;
    let mutations = 0;
    const fleet = await owned.getOwnedCodexFleetAdditions({ fresh: true });
    supervisor.startSupervisorLoop({ fetchFleetStatus: async () => [{sessionKey: ${JSON.stringify(surface)}, status: 'waiting'}],
      fetchTranscript: async () => [], steerAgent: async () => { mutations++; }, interruptAgent: async () => { mutations++; },
      relaunchAgent: async () => { mutations++; return {status: 'held', reason: 'fixture'}; },
      broadcastAgentUpdate: () => {}, queueOrchestratorEscalation: () => {} });
    supervisor.stopSupervisorLoop();
    const watched = supervisor.getWatchedAgents().find(w => w.surfaceId === ${JSON.stringify(surface)});
    if (!watched) throw new Error('Persisted watcher missing');
    watched.registeredAt = watched.lastActivityAt = Date.now() - 30 * 60_000; watched.nextPollAt = 0;
    await supervisor.runSupervisorTickForTesting();
    console.log('COLD_RESULT=' + JSON.stringify({mutations, status: fleet.agents.find(a => a.sessionKey === watched.surfaceId)?.status}));
    process.exit(0);
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000 });
  expect(JSON.parse(cold.split('COLD_RESULT=')[1].split('\n')[0])).toEqual({ mutations: 0, status: 'blocked' });
  await tick(surface); await tick(surface);
  expect(await supervisor.ingestAgentCompletionSignal(surface, runId)).toBe(true);
  expect(callbacks.onAgentCompletion).not.toHaveBeenCalled();
  supervisor.unregisterWatchedAgent(surface); closeDb(); owned.invalidateOwnedCodexFleetCache();
  const reloaded = watch(surface); await tick(surface);
  await new Promise(resolve => setTimeout(resolve, 5_200));
  expect(starts()).toBe(before); expect(record(surface).recentRuns[0].id).toBe(runId);
  expect(callbacks.steerAgent).not.toHaveBeenCalled(); expect(reloaded.steerAgent).not.toHaveBeenCalled();
  expect(callbacks.relaunchAgent).not.toHaveBeenCalled(); expect(callbacks.onAgentCompletion).not.toHaveBeenCalled();
  supervisor.unregisterWatchedAgent(surface);
}, 40_000);
it('recovers ordinary waiting and refuses an interrupt arriving after automatic steering was queued', async () => {
  const ordinary = await launch('finished'); writeFileSync(join(root, 'mode'), 'finished');
  const callbacks = watch(ordinary, 'waiting'); const before = starts(); await tick(ordinary);
  await waitFor(() => starts() === before + 1); expect(callbacks.steerAgent).toHaveBeenCalledOnce();
  supervisor.unregisterWatchedAgent(ordinary);
  const interrupted = await launch('running');
  const stale = watch(interrupted, 'waiting'); const racedStarts = starts();
  afterGuardQueued = async () => { afterGuardQueued = undefined; await interrupt(interrupted); };
  await tick(interrupted); await new Promise(resolve => setTimeout(resolve, 100));
  expect(starts()).toBe(racedStarts); expect(record(interrupted).recentRuns[0].outcome).toBe('interrupted');
  expect(stale.steerAgent).toHaveBeenCalledOnce(); supervisor.unregisterWatchedAgent(interrupted);
}, 40_000);
it('allows explicit resume but rejects stale automatic generation even with operator source hints', async () => {
  const surface = await launch('running'); await interrupt(surface); const old = record(surface).recentRuns[0].id;
  writeFileSync(join(root, 'mode'), 'finished'); const before = starts();
  expect((await action(surface)).ok).toBe(true); await waitFor(() => starts() === before + 1);
  const resumedCallbacks = watch(surface, 'running');
  expect(await supervisor.ingestAgentCompletionSignal(surface, old)).toBe(true);
  expect(resumedCallbacks.onAgentCompletion).not.toHaveBeenCalled();
  supervisor.unregisterWatchedAgent(surface);
  await waitFor(() => record(surface).recentRuns[0].outcome === 'finished');
  expect((await action(surface, { automaticRecoveryRunId: old, steerSource: 'operator' })).ok).toBe(false);
  expect(starts()).toBe(before + 1); expect(record(surface).recentRuns.find(run => run.id === old)?.outcome).toBe('interrupted');
}, 40_000);

it('refuses malformed or non-owned automatic action guards without starting a provider', async () => {
  const surface = await launch('finished'); const before = starts();
  for (const guard of ['', 42, {}]) expect(await action(surface, { automaticRecoveryRunId: guard })).toMatchObject({ error: expect.any(String) });
  expect(await action('foreign:synthetic', { automaticRecoveryRunId: 'synthetic' })).toMatchObject({ ok: false, status: 'unavailable' });
  expect(starts()).toBe(before);
}, 25_000);

it('does not revive a newer interrupted run from an already scheduled failure retry', async () => {
  const surface = await launch('failed'); const failed = record(surface);
  failed.autoRetry = true;
  writeFileSync(join(failed.sessionDir, 'session.json'), JSON.stringify(failed));
  await owned.getOwnedCodexFleetAdditions({ fresh: true });
  const before = starts(); writeFileSync(join(root, 'mode'), 'running');
  expect((await action(surface)).ok).toBe(true); await waitFor(() => starts() === before + 1);
  await interrupt(surface); const stopped = record(surface).recentRuns[0].id;
  expect(stopped).not.toBe(failed.recentRuns[0].id);
  await new Promise(resolve => setTimeout(resolve, 5_300));
  await owned.getOwnedCodexFleetAdditions({ fresh: true });
  expect(starts()).toBe(before + 1);
  expect(record(surface).recentRuns[0]).toMatchObject({ id: stopped, outcome: 'interrupted' });
}, 30_000);

it('returns a durable no-effect launch refusal for interrupted retry generations and does not replay it', async () => {
  const surface = await launch('running'); await interrupt(surface); const before = starts();
  const body = { runtime: 'codex', prompt: 'Synthetic retry.', cwd: repo, repoPath: repo,
    automaticRecoverySurfaceId: surface, automaticRecoveryRunId: record(surface).recentRuns[0].id,
    clientMutationId: crypto.randomUUID() };
  const send = (value: typeof body) => fetch(`http://127.0.0.1:${port}/api/runtime/launch`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const refused = await (await send(body)).json();
  expect(refused).toMatchObject({ ok: false, surfaceId: '', note: expect.stringContaining('interrupted') });
  expect(refused.outcomeUnknown).not.toBe(true);
  expect(await (await send(body)).json()).toMatchObject({ ok: false, replayed: true });
  expect((await send({ ...body, automaticRecoveryRunId: 'changed' })).status).toBe(409);
  expect(starts()).toBe(before);
}, 25_000);

it('launches an uninterrupted current-generation retry and an explicit normal launch through the authenticated route', async () => {
  const original = await launch('finished'); const generation = record(original).recentRuns[0].id;
  writeFileSync(join(root, 'mode'), 'running'); const before = starts();
  const retry = await httpLaunch({ automaticRecoverySurfaceId: original, automaticRecoveryRunId: generation });
  expect(retry, retry.note).toMatchObject({ ok: true, runtime: 'codex' });
  expect(retry.surfaceId).not.toBe(original);
  await waitFor(() => starts() === before + 1 && Boolean(record(retry.surfaceId).threadId));
  expect(record(original).recentRuns[0]).toMatchObject({ id: generation, outcome: 'finished' });
  const explicit = await httpLaunch();
  expect(explicit, explicit.note).toMatchObject({ ok: true, runtime: 'codex' });
  await waitFor(() => starts() === before + 2 && Boolean(record(explicit.surfaceId).threadId));
  expect(explicit.surfaceId).not.toBe(retry.surfaceId);
}, 40_000);

it.each(['interrupt', 'resume'] as const)('refuses a queued automatic launch after the original session lock observes %s', async transition => {
  const original = await launch(transition === 'interrupt' ? 'running' : 'finished');
  const generation = (record(original).activeRun ?? record(original).recentRuns[0]).id;
  writeFileSync(join(root, 'mode'), 'running'); const before = starts();
  // The queued actions test session-lock ordering, so hold the new providers'
  // startup output while real artifact admission measures the runtime root.
  writeFileSync(providerGate, 'held');
  const { ensureDispatchBackendReady } = await import('@/lib/runtimes/shared/dispatch-readiness');
  let entered = false; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  // The first real launch holds the ORIGINAL store mutex while its provider
  // readiness boundary waits. Neither the launch wrapper nor lock is replaced.
  vi.mocked(ensureDispatchBackendReady).mockImplementationOnce(async () => {
    entered = true; await blocked;
    return { ready: true, reason: 'Synthetic provider ready.', waitedMs: 0, attempts: 1,
      lastCheck: { ready: true, reason: 'Synthetic provider ready.', apiBase: `http://127.0.0.1:${port}`,
        portSource: 'file', apiPortFilePresent: true } };
  });
  const guard = { automaticRecoverySurfaceId: original, automaticRecoveryRunId: generation };
  const first = httpLaunch(guard);
  try {
    await waitFor(() => entered);
    // These production store operations queue on the same mutex before the
    // second authenticated launch, changing the generation while it waits.
    const changed = transition === 'interrupt'
      ? owned.interruptOwnedCodexSession(original)
      : owned.continueOwnedCodexSession(original, 'Explicit new generation.');
    let settled = false;
    const queued = httpLaunch(guard).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(settled).toBe(false); expect(starts()).toBe(before);
    release();
    expect(await first).toMatchObject({ ok: true });
    const changedResult = await changed;
    expect(changedResult, JSON.stringify(changedResult)).toMatchObject(transition === 'interrupt' ? { interrupted: true } : { ok: true });
    const refused = await queued;
    expect(refused).toMatchObject({ ok: false, surfaceId: '', note: expect.stringContaining(
      transition === 'interrupt' ? 'interrupted' : 'changed') });
    expect(refused.outcomeUnknown).not.toBe(true);
    rmSync(providerGate, { force: true });
    const expectedStarts = before + (transition === 'interrupt' ? 1 : 2);
    await waitFor(() => starts() === expectedStarts);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(starts()).toBe(expectedStarts);
    const current = record(original).activeRun ?? record(original).recentRuns[0];
    if (transition === 'interrupt') expect(current).toMatchObject({ id: generation, outcome: 'interrupted' });
    else expect(current.id).not.toBe(generation);
  } finally {
    rmSync(providerGate, { force: true });
    release(); await first;
  }
}, 40_000);

it('retains unknown action outcomes without retrying the automatic mutation', async () => {
  const surface = await launch('finished'); const before = starts();
  const { ensureDispatchBackendReady } = await import('@/lib/runtimes/shared/dispatch-readiness');
  vi.mocked(ensureDispatchBackendReady).mockRejectedValueOnce(new Error('Synthetic uncertain backend boundary'));
  const extra = { automaticRecoveryRunId: record(surface).recentRuns[0].id, clientMutationId: crypto.randomUUID() };
  const first = await action(surface, extra);
  expect(first).toMatchObject({ ok: false, outcomeUnknown: true });
  expect(await action(surface, extra)).toMatchObject({ ok: false, outcomeUnknown: true, replayed: true });
  expect(starts()).toBe(before);
}, 25_000);
