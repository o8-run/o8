import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import type { OwnedRunRecord, OwnedSessionRecord, OwnedRuntimeAdapter } from '@/lib/runtimes/shared/owned-session/types';

const hooks = vi.hoisted(() => ({ bridge: vi.fn(), alive: vi.fn(), signal: vi.fn(),
  spawned: (_child: ChildProcess) => {}, captured: async (_run: OwnedRunRecord) => {} }));
vi.mock('@/lib/runtime/pty-bridge', async original => ({ ...(await original<typeof import('@/lib/runtime/pty-bridge')>()), spawnBridgeTerminalSession: hooks.bridge, isBridgeSessionAlive: hooks.alive, signalBridgeTerminalSession: hooks.signal }));
vi.mock('@/lib/app-update/work-launch-admission', async original => {
  const actual = await original<typeof import('@/lib/app-update/work-launch-admission')>();
  return { ...actual, spawnWithWorkAdmission: (...args: Parameters<typeof actual.spawnWithWorkAdmission>) => {
    const child = actual.spawnWithWorkAdmission(...args); hooks.spawned(child); return child;
  } };
});
vi.mock('@/lib/runtimes/shared/owned-session/process-identity', async original => {
  const actual = await original<typeof import('@/lib/runtimes/shared/owned-session/process-identity')>();
  return { ...actual, captureOwnedRunIdentity: async (...args: Parameters<typeof actual.captureOwnedRunIdentity>) => {
    await actual.captureOwnedRunIdentity(...args); await hooks.captured(args[2]);
  } };
});
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
// Only the external bridge transport and worker are fixtures; store, Stop route,
// durable lane/packet/session state, process identity and termination are real.
vi.mock('@/lib/runtimes/shared/owned-session/worker-mcp-config', () => ({ prepareOwnedWorkerMcpConfig: async () => ({ servers: [], sandboxReadPaths: [] }) }));
const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'standing-stop-matrix-'));
const originalEnv = { ...process.env };
const repo = join(root, 'repo');
const sessions = join(root, 'sessions');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'state.db'),
  CORTEX_IDE_OWNED_CODEX_ROOT: sessions, O8_TEST_STANDING_BRIDGE_ROOT: sessions, O8_TEST_STANDING_BRIDGE_BIN: process.execPath,
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_PROCESS_SUPERVISOR: '0', O8_WORKER_SANDBOX: '0', O8_PACKAGED_APP: '0' });
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});
const paths = ['legacy bridge', 'direct spawn', 'resume bridge', 'resume direct'] as const;
const timings = ['before launch', 'during launch', 'after spawn before response', 'after response'] as const;
// 4 launch paths x 4 Stop timings, plus lost responses for both bridge modes.
const matrix = paths.flatMap(path => timings.flatMap(timing =>
  (path.includes('bridge') ? ['success', 'lost'] as const : ['success'] as const)
    .map(response => ({ path, timing, response }))));
it.skipIf(process.platform === 'win32').each(matrix)('$path / $timing / $response response', async ({ path, timing, response }) => {
  const { createLane, updateLane } = await import('@/lib/lane/registry');
  const { saveStandingLane, readStandingLane } = await import('@/lib/lane/standing-store');
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
  const { POST } = await import('@/app/api/orchestrator/standing-lanes/route');
  const token = (await import('@/lib/ws-auth')).getOrCreateWsToken();
  const packetId = `pkt-matrix-${matrix.findIndex(row => row.path === path && row.timing === timing && row.response === response)}`;
  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'main', runtime: 'codex', packetId });
  const resumed = path.startsWith('resume');
  const bridged = path.includes('bridge');
  saveStandingLane(lane.id, { model: 'fixture', effort: 'high', stopped: false, removed: false, blockedReason: null,
    tasks: [{ id: packetId, prompt: 'matrix fixture', branch: 'main', phase: 'dispatching', startedAt: new Date().toISOString() }] });
  await withLockedState(state => { state.packets.push({ id: packetId, title: 'matrix fixture', summary: '', referenceLabel: packetId,
    runtime: 'codex', standingLaneId: lane.id, workspaceTargetPath: repo, branchTarget: 'main',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', status: 'running', releaseState: 'pending', review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, sessionKey: null, runtime: 'codex', repoPath: repo, worktreePath: repo } }); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let child: ChildProcess | undefined;
  const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
  let bridgeName: string | undefined;
  const signals = join(root, `${packetId}.signals`);
  const ready = join(root, `${packetId}.ready`);
  const code = `const fs=require('node:fs'); for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{fs.appendFileSync(${JSON.stringify(signals)},s+'\\n');process.exit(0)}); fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const track = (value: ChildProcess) => { child = value; children.push({ child: value, exited: once(value, 'exit') }); };
  hooks.spawned = track;
  hooks.captured = async () => { if (!bridged && timing === 'after spawn before response') { entered = true; await gate; } };
  hooks.bridge.mockReset(); hooks.signal.mockReset();
  hooks.bridge.mockImplementation(async (options: { sessionName: string; env: NodeJS.ProcessEnv }) => {
    bridgeName = options.sessionName;
    if (timing === 'during launch') { entered = true; await gate; }
    track(spawn(process.execPath, ['-e', code], { cwd: repo, env: options.env, detached: true, stdio: 'ignore' }));
    await vi.waitFor(() => expect(readFileSync(ready, 'utf8')).toBe('ready'));
    if (timing === 'after spawn before response') { entered = true; await gate; }
    if (response === 'lost') throw new Error('Fixture bridge response lost after child creation');
    return { ok: true, sessionName: bridgeName, pid: child!.pid };
  });
  hooks.alive.mockImplementation(async (name: string) => name === bridgeName && Boolean(child && child.exitCode === null && child.signalCode === null));
  hooks.signal.mockImplementation(async (name: string, sig: NodeJS.Signals) => { if (name === bridgeName && child?.pid) process.kill(-child.pid, sig); });
  const adapter: OwnedRuntimeAdapter = { runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'O8_TEST_STANDING_BRIDGE_ROOT',
    rootDefault: sessions, binaryName: 'node', binaryEnvOverride: 'O8_TEST_STANDING_BRIDGE_BIN', humanLabel: 'Fixture', squadShortName: 'Fixture',
    launchArgs: () => ['-e', code], resumeArgs: () => ['-e', code],
    extraSpawnEnv: async () => {
      if (!bridged && timing === 'during launch') { entered = true; await gate; }
      return {};
    }, parseRunLog: () => ({ entries: [], completedTurn: false, outcome: 'running' }) };
  // Direct spawn is selected by the production crash-survival transport switch.
  process.env.O8_CRASH_SURVIVABLE_WORKERS = bridged ? '0' : '1';
  const store = createOwnedSessionStore(adapter, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
  let surfaceId: string | undefined;
  if (resumed) {
    const id = `codex-owned-${packetId}`;
    surfaceId = `codex-owned:${id}`;
    const sessionDir = join(sessions, id);
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId, sessionDir, laneId: lane.id, packetId,
      cwd: repo, repoPath: repo, branch: 'main', model: 'fixture', effort: 'high', threadId: 'retained-thread',
      createdAt: now, updatedAt: now, initialPrompt: 'previous turn', latestPrompt: 'previous turn', latestSummary: '',
      title: 'Fixture', autoRetry: false, recentRuns: [], runIdentityLedger: { version: 1, totalRuns: 0, complete: true } }));
    updateLane(lane.id, { sessionKey: surfaceId });
    await withLockedState(state => { state.packets.find(p => p.id === packetId)!.lane!.sessionKey = surfaceId!; });
  }
  const stop = () => POST(new NextRequest('http://fixture.test/api/orchestrator/standing-lanes', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', laneId: lane.id, idempotencyKey: packetId }) }));
  let stopResponse: Response | undefined;
  let returned = false;
  let earlyReturn = false;
  let outcome: Promise<{ value?: unknown; error?: Error }> | undefined;
  try {
    if (timing === 'before launch') stopResponse = await stop();
    outcome = (resumed ? store.resume(surfaceId!, 'matrix fixture')
      : store.launch({ cwd: repo, prompt: 'matrix fixture', laneId: lane.id, packetId, model: 'fixture', effort: 'high' }))
      .then(value => ({ value }), error => ({ error }));
    if (timing === 'during launch' || timing === 'after spawn before response') {
      await vi.waitFor(() => expect(entered).toBe(true));
      const stopping = stop().then(value => { returned = true; return value; });
      await vi.waitFor(() => expect(readStandingLane(lane.id)?.stopped).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 100));
      earlyReturn = returned;
      release();
      stopResponse = await stopping;
    } else {
      await outcome;
      if (timing === 'after response') {
        const record = readdirSync(sessions).map(dir => JSON.parse(readFileSync(join(sessions, dir, 'session.json'), 'utf8')) as OwnedSessionRecord).find(row => row.laneId === lane.id)!;
        updateLane(lane.id, { sessionKey: record.surfaceId });
        await withLockedState(state => { state.packets.find(p => p.id === packetId)!.lane!.sessionKey = record.surfaceId; });
        stopResponse = await stop();
      }
    }
    const result = await outcome;
    expect.soft(earlyReturn, 'Stop must wait for an in-flight launch, including a lost response').toBe(false);
    expect.soft(stopResponse!.status, await stopResponse!.clone().text()).toBe(200);
    expect.soft(children.some(({ child: value }) => value.exitCode === null && value.signalCode === null), 'No child may remain alive when Stop returns').toBe(false);
    expect.soft(children.length, 'A lost response must never start a replacement child').toBeLessThanOrEqual(1);
    const record = readdirSync(sessions).map(dir => JSON.parse(readFileSync(join(sessions, dir, 'session.json'), 'utf8')) as OwnedSessionRecord).find(row => row.laneId === lane.id);
    if (child) {
      expect.soft(record?.recentRuns[0]).toMatchObject({ outcome: 'interrupted', interruptRequestedAt: expect.any(String) });
      expect.soft(record?.activeRun).toBeFalsy();
      if (bridged) expect.soft(hooks.signal).toHaveBeenCalled();
      else expect.soft(readFileSync(signals, 'utf8')).toMatch(/SIGINT|SIGTERM/);
    }
    if (timing !== 'after response') expect.soft(result.error?.message ?? JSON.stringify(result.value)).toMatch(/stopped|admission|lost/i);
    if (bridged) expect.soft(hooks.bridge.mock.calls.length).toBe(timing === 'before launch' ? 0 : 1);
  } finally {
    release(); await outcome;
    for (const owned of children) {
      if (owned.child.pid && owned.child.exitCode === null && owned.child.signalCode === null) process.kill(-owned.child.pid, 'SIGKILL');
      await owned.exited;
    }
    hooks.spawned = () => {}; hooks.captured = async () => {};
  }
}, 30000);

it.skipIf(process.platform === 'win32').each(['before admission', 'during registration', 'surviving descendant'] as const)('handles a lost real HTTP response %s across Stop', async mode => {
  const { createServer } = await import('node:http');
  const { withOwnedBridgeLaunchAdmission } = await import('@/lib/runtime/owned-bridge-launch');
  const actual = await vi.importActual<typeof import('@/lib/runtime/pty-bridge')>('@/lib/runtime/pty-bridge');
  const { createLane } = await import('@/lib/lane/registry');
  const { saveStandingLane } = await import('@/lib/lane/standing-store');
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
  const { POST } = await import('@/app/api/orchestrator/standing-lanes/route');
  const packetId = `pkt-http-${mode.replaceAll(' ', '-')}`;
  const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'main', runtime: 'codex', packetId: packetId });
  saveStandingLane(lane.id, { model: 'fixture', effort: 'high', stopped: false, removed: false, blockedReason: null,
    tasks: [{ id: packetId, prompt: 'HTTP fixture', branch: 'main', phase: 'dispatching', startedAt: new Date().toISOString() }] });
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  await withLockedState(state => { state.packets.push({ id: packetId, title: 'HTTP fixture', summary: '', referenceLabel: 'http',
    runtime: 'codex', standingLaneId: lane.id, workspaceTargetPath: repo, branchTarget: 'main',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', status: 'running', releaseState: 'pending', review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, sessionKey: null, runtime: 'codex', repoPath: repo, worktreePath: repo } }); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished!: () => void;
  const handled = new Promise<void>(resolve => { finished = resolve; });
  let received = false;
  let refusal: unknown;
  let registered = false;
  let submittedEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  const spawnChild = vi.fn((): ChildProcess => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: submittedEnv }));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    submittedEnv = payload.env;
    try {
      if (mode === 'before admission') {
        received = true; response.destroy(); await gate;
        await withOwnedBridgeLaunchAdmission(payload, spawnChild);
      } else {
        await withOwnedBridgeLaunchAdmission(payload, async () => {
          const child = spawnChild();
          received = true; response.destroy();
          if (mode === 'during registration') { await gate; registered = true; }
          return child;
        });
      }
    } catch (error) { refusal = error; }
    finished();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previousPort = process.env.O8_WS_PORT;
  process.env.O8_WS_PORT = String((server.address() as { port: number }).port);
  process.env.O8_CRASH_SURVIVABLE_WORKERS = '0';
  hooks.bridge.mockImplementation(actual.spawnBridgeTerminalSession);
  hooks.alive.mockImplementation(async () => registered && spawnChild.mock.results.some(call => call.type === 'return' && call.value.exitCode === null && call.value.signalCode === null));
  hooks.signal.mockImplementation(async (_name: string, sig: NodeJS.Signals) => {
    if (!registered) throw new Error('Fixture PTY leader is absent');
    for (const call of spawnChild.mock.results) if (call.type === 'return' && call.value.pid) process.kill(-call.value.pid, sig);
  });
  const adapter: OwnedRuntimeAdapter = { runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'O8_TEST_STANDING_BRIDGE_ROOT',
    rootDefault: sessions, binaryName: 'node', binaryEnvOverride: 'O8_TEST_STANDING_BRIDGE_BIN', humanLabel: 'Fixture', squadShortName: 'Fixture',
    launchArgs: () => ['-e', 'setInterval(()=>{},1000)'], resumeArgs: () => [], parseRunLog: () => ({ entries: [], completedTurn: false, outcome: 'running' }) };
  try {
    const store = createOwnedSessionStore(adapter, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    const launched = store.launch({ cwd: repo, prompt: 'HTTP fixture', laneId: lane.id, packetId: packetId, model: 'fixture', effort: 'high' }).catch(error => error);
    await vi.waitFor(() => expect(received).toBe(true), { timeout: 10000 });
    if (mode !== 'during registration') await launched;
    const token = (await import('@/lib/ws-auth')).getOrCreateWsToken();
    const stopping = POST(new NextRequest('http://fixture.test/api/orchestrator/standing-lanes', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', laneId: lane.id, idempotencyKey: packetId }) }));
    let returned = false;
    void stopping.then(() => { returned = true; });
    const { readStandingLane } = await import('@/lib/lane/standing-store');
    await vi.waitFor(() => expect(readStandingLane(lane.id)?.stopped).toBe(true), { timeout: 10000 });
    if (mode === 'during registration') {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(returned, 'Stop cannot pass a bridge registration still holding its run lease').toBe(false);
    }
    release(); await launched;
    const stopped = await stopping; await handled;
    expect(stopped.status, await stopped.clone().text()).toBe(mode === 'surviving descendant' ? 409 : 200);
    if (mode === 'before admission') {
      expect(spawnChild).not.toHaveBeenCalled();
      expect(String(refusal)).toMatch(/cancelled|stopped/i);
    } else {
      expect(spawnChild).toHaveBeenCalledOnce();
      const child = spawnChild.mock.results[0].value!;
      expect(child.exitCode === null && child.signalCode === null).toBe(mode === 'surviving descendant');
      const record = readdirSync(sessions).map(dir => JSON.parse(readFileSync(join(sessions, dir, 'session.json'), 'utf8')) as OwnedSessionRecord).find(row => row.laneId === lane.id)!;
      if (mode === 'surviving descendant') expect(record.activeRun?.interruptRequestedAt).toEqual(expect.any(String));
      else expect(record.activeRun).toBeFalsy();
    }
  } finally {
    release();
    for (const call of spawnChild.mock.results) if (call.type === 'return') {
      const child = call.value;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); process.kill(-child.pid!, 'SIGKILL'); await exited;
      }
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousPort === undefined) delete process.env.O8_WS_PORT; else process.env.O8_WS_PORT = previousPort;
  }
}, 120000);
