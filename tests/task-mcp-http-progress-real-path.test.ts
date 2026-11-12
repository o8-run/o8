import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({ port: 0, launch: vi.fn(), cloudSource: vi.fn(), cleanup: vi.fn(async (request: { surfaceId: string }) => ({ ok: true, action: 'stop', surfaceId: request.surfaceId, status: 'completed' as 'completed' | 'queued' | 'unavailable' })), failPersist: false, failAccepted: false, spawns: 0 }));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/lane/registry', async (original) => {
  const actual = await original<typeof import('@/lib/lane/registry')>();
  return { ...actual, appendEvent: (...args: Parameters<typeof actual.appendEvent>) => {
    if (args[1] === 'task_dispatch_accepted' && h.failAccepted) {
      h.failAccepted = false;
      throw new Error('Fixture admission receipt write failed');
    }
    return actual.appendEvent(...args);
  } };
});
vi.mock('@/lib/orchestrator/control-plane', async (original) => {
  const actual = await original<typeof import('@/lib/orchestrator/control-plane')>();
  return { ...actual, withLockedState: (...args: Parameters<typeof actual.withLockedState>) => {
    if (h.failPersist) { h.failPersist = false; throw new actual.ControlPlaneLockTimeoutError(10); }
    return actual.withLockedState(...args);
  } };
});
vi.mock('@/lib/cloud/worker-readiness', async (original) => ({
  ...await original<typeof import('@/lib/cloud/worker-readiness')>(), remoteWorkerPreflightError: () => null,
}));
vi.mock('@/lib/cloud/remote-source', () => ({ resolveCloudRemoteSource: h.cloudSource }));
vi.mock('@/lib/cloud/remote-manifest', () => ({ resolveRemoteWorkspaceManifest: vi.fn(async () => ({ remoteManifestHash: null, remotePreview: null })) }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: vi.fn(async () => {}),
}));
// Hold the external runtime/provisioning boundary. HTTP, MCP, task admission,
// lane commands, Stop and persisted packet/event state remain real.
vi.mock('@/lib/runtime/actions', async (original) => ({
  ...await original<typeof import('@/lib/runtime/actions')>(), launchRuntimeSurface: h.launch, performRuntimeAction: h.cleanup,
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/panel/api-port', async (original) => {
  const actual = await original<typeof import('@/lib/panel/api-port')>();
  return { ...actual, resolvePortInfo: () => ({ ...actual.resolvePortInfo(), wsPort: h.port }) };
});
vi.mock('@/lib/cortex/spec-ingest', () => ({ ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })), purgeOrphanedSpecDirectives: vi.fn(() => ({ purged: 0, slugs: [] })) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-task-http-progress-')));
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_DATA_DIR = root;
const repo = join(root, 'repo');
const { closeDb, getSqlite } = await import('@/lib/db');
const lanes = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { assertOwnedActionAdmission } = await import('@/lib/runtimes/shared/owned-session/action-admission');
const { persistLanePacketHold } = await import('@/lib/lane/packet-stop-hold');
const { panelGateMiddleware } = await import('@/middleware');
const mcp = await import('@/app/api/mcp/route');
const events = await import('@/app/api/lanes/[id]/events/route');
const { addRepo } = await import('@/lib/repos/registry');
const token = getOrCreateWsToken();
let server: Server;
let sequence = 0;
const pending = new Set<Promise<void>>();

beforeAll(async () => {
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'HTTP fixture\n');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', repo);
  await addRepo(repo);
  server = createServer((incoming, outgoing) => {
    const operation = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const url = `http://127.0.0.1:${h.port}${incoming.url}`;
      const request = new NextRequest(url, { method: incoming.method, headers: incoming.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const gate = panelGateMiddleware(request);
      const response = gate.status !== 200 ? gate
        : request.nextUrl.pathname === '/api/mcp' ? await mcp.POST(request)
        : request.nextUrl.pathname.startsWith('/api/lanes/') ? await events.GET(request, {
          params: Promise.resolve({ id: decodeURIComponent(request.nextUrl.pathname.split('/')[3]) }),
        }) : Response.json({ ok: true });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error) => { outgoing.writeHead(500); outgoing.end(String(error)); });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.port = (server.address() as { port: number }).port;
  writeFileSync(join(root, 'api-port'), String(h.port));
});
afterAll(async () => {
  await Promise.allSettled([...pending]);
  await vi.waitFor(() => expect(getSqlite().prepare('SELECT COUNT(*) FROM workspace_lifecycle_leases').pluck().get()).toBe(0), { timeout: 10000 });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 60000);

function fixture() {
  const id = `pkt-http-${++sequence}`;
  const packet = { id, referenceLabel: `P${sequence}`, title: 'HTTP task', summary: 'Hold provisioning',
    runtime: 'codex', workspaceTargetPath: repo, branchTarget: `task/${id}`, dependencyLabels: [], dependencyPacketIds: [],
    status: 'queued', queueState: 'held', holdIntent: 'explicit-dispatch', releaseState: 'pending', lane: null,
  } as OrchestratorPacket;
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [packet] });
  return id;
}
async function call(name: string, args: Record<string, unknown>, timeoutMs = 5000, modern = false) {
  const response = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(modern ? { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
      ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  if (modern) expect(body.result.resultType).toBe('complete');
  return { ...JSON.parse(body.result.content[0].text), isError: body.result.isError };
}
function heldLaunch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.launch.mockImplementationOnce(async () => {
    await gate;
    assertOwnedActionAdmission(null);
    h.spawns++;
    return { ok: true, surfaceId: `fixture:${sequence}`, note: 'Fixture started' };
  });
  return release;
}

it('returns and replays an HTTP dispatch receipt while provisioning remains pending', async () => {
  const id = fixture();
  const release = heldLaunch();
  const started = performance.now();
  try {
    const receipt = await call('o8_task_dispatch', { taskId: id });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(receipt).toMatchObject({ ok: true, packetId: id, status: 'launching', laneId: expect.any(String) });
    closeDb();
    expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ status: 'launching', lane: { laneId: receipt.laneId } });
    const replay = await call('o8_task_dispatch', { taskId: id });
    expect(replay).toMatchObject({ ok: true, laneId: receipt.laneId, dispatchId: receipt.dispatchId, replayed: true });
    const conflict = await call('o8_task_dispatch', { taskId: id, message: 'different launch' });
    expect(conflict).toMatchObject({ isError: true, code: 'task_dispatch_conflict' });
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));
    expect(h.spawns).toBe(0);
  } finally { release(); }
  await vi.waitFor(() => expect(lanes.findLaneByPacket(id)?.status).toBe('running'), { timeout: 10000 });
  expect(h.spawns).toBe(1);
}, 20000);

it('preserves Stop while a previously accepted HTTP dispatch finishes provisioning', async () => {
  const id = fixture();
  const release = heldLaunch();
  const spawnsBefore = h.spawns;
  try {
    const receipt = await call('o8_task_dispatch', { taskId: id });
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(2));
    await persistLanePacketHold(id, lanes.getLane(receipt.laneId)!);
    lanes.setLaneStatus(receipt.laneId, 'awaiting_orchestrator', 'user', 'operator_stopped');
  } finally { release(); }
  await new Promise((resolve) => setTimeout(resolve, 100));
  closeDb();
  expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held' });
  expect(lanes.findLaneByPacket(id)).toMatchObject({ status: 'awaiting_orchestrator', sessionKey: null });
  expect(h.spawns).toBe(spawnsBefore);
}, 20000);

it('refuses an already stopped task without publishing a successful launch admission', async () => {
  const id = fixture();
  await control.withLockedState((state) => {
    state.packets[0].operatorStopped = true;
    state.packets[0].queueState = 'held';
    state.packets[0].status = 'blocked';
  });
  const before = h.launch.mock.calls.length;
  const result = await call('o8_task_dispatch', { taskId: id });
  expect(result).toMatchObject({ isError: true, code: 'task_dispatch_conflict' });
  expect(h.launch).toHaveBeenCalledTimes(before);
  expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, status: 'blocked' });
});

it('records an unexpected settlement failure instead of leaving an accepted receipt launching forever', async () => {
  const id = fixture();
  h.launch.mockImplementationOnce(async () => {
    h.failPersist = true;
    return { ok: true, surfaceId: 'fixture:settlement', note: 'Started' };
  });
  const receipt = await call('o8_task_dispatch', { taskId: id });
  expect(receipt.ok).toBe(true);
  await vi.waitFor(() => expect(control.readOrchestratorControlPlaneState().packets[0].status).toBe('blocked'));
  closeDb();
  expect(lanes.getLaneEvents(receipt.laneId, 100)).toContainEqual(expect.objectContaining({
    verb: 'task_dispatch_failed', payload: expect.objectContaining({ dispatchId: receipt.dispatchId }),
  }));
});

it('prevents a cloud job from being enqueued after Stop during remote source resolution', async () => {
  const id = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.cloudSource.mockImplementationOnce(async () => {
    await gate;
    return { repoUrl: 'https://example.invalid/fixture.git', baseSha: 'a'.repeat(40), branch: `task/${id}` };
  });
  const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');
  const { getLatestPacketJob } = await import('@/lib/cloud/job-queue');
  const { DEFAULT_CLOUD_TEAM_ID } = await import('@/lib/cloud/team');
  h.launch.mockImplementationOnce(async (payload: { packetId: string; branchName: string }) => {
    const result = await cloudRuntime.launch!({ cwd: repo, prompt: 'fixture', packetId: payload.packetId,
      sourceRepoPath: repo, branchName: payload.branchName, baseBranch: 'main' });
    return { ok: result.ok, surfaceId: result.sessionKey, note: result.note };
  });
  try {
    const receipt = await call('o8_task_dispatch', { taskId: id, requestedRuntime: 'cloud' });
    expect(receipt.ok).toBe(true);
    await vi.waitFor(() => expect(h.cloudSource).toHaveBeenCalledOnce());
    await persistLanePacketHold(id, lanes.getLane(receipt.laneId)!);
    lanes.setLaneStatus(receipt.laneId, 'awaiting_orchestrator', 'user', 'operator_stopped');
  } finally { release(); }
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(getLatestPacketJob(DEFAULT_CLOUD_TEAM_ID, id)).toBeUndefined();
});

it('leaves no launching state when the admission receipt cannot be persisted', async () => {
  const id = fixture();
  const before = h.launch.mock.calls.length;
  h.failAccepted = true;
  const result = await call('o8_task_dispatch', { taskId: id });
  expect(result.isError).toBe(true);
  expect(lanes.findLaneByPacket(id)?.status).toBe('idle');
  expect(control.readOrchestratorControlPlaneState().packets[0].status).toBe('queued');
  expect(h.launch).toHaveBeenCalledTimes(before);
  h.launch.mockResolvedValueOnce({ ok: false, note: 'Fixture refused launch' });
  const retry = await call('o8_task_dispatch', { taskId: id });
  expect(retry).toMatchObject({ ok: true, status: 'launching' });
  await vi.waitFor(() => expect(lanes.findLaneByPacket(id)?.status).toBe('awaiting_orchestrator'));
});

it('preserves a standalone lane Stop during accepted provisioning', async () => {
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [] });
  const lane = lanes.createLane({ repoPath: repo, branch: 'task/standalone', runtime: 'codex' });
  lanes.setLaneStatus(lane.id, 'idle');
  const release = heldLaunch();
  const callsBefore = h.launch.mock.calls.length;
  const spawnsBefore = h.spawns;
  try {
    const receipt = await call('o8_task_dispatch', { taskId: lane.id });
    expect(receipt).toMatchObject({ ok: true, packetId: null, laneId: lane.id });
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(callsBefore + 1));
    const { dispatch } = await import('@/lib/lane/commands');
    expect((await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' })).ok).toBe(true);
  } finally { release(); }
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lanes.getLane(lane.id)).toMatchObject({ status: 'paused', sessionKey: null });
  expect(h.spawns).toBe(spawnsBefore);
});

it.each(['completed', 'queued', 'unavailable'].flatMap((status) => ['success', 'returned-failure', 'post-effect-error'].map((mode) => [status, mode] as const)))('records %s cleanup for %s when Stop wins before attachment', async (status, mode) => {
  const id = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const surfaceId = `fixture:spawned-before-stop-${status}-${mode}`;
  const callsBefore = h.launch.mock.calls.length;
  h.cleanup.mockResolvedValueOnce({ ok: status !== 'unavailable', action: 'stop', surfaceId, status: status as 'completed' | 'queued' | 'unavailable' });
  h.launch.mockImplementationOnce(async () => {
    await gate;
    // The child already crossed its guarded spawn boundary. Deliver the result
    // after Stop, exercising the separate attachment fence and exact cleanup.
    const result = { ok: mode === 'success', runtime: 'codex', surfaceId, note: 'Spawned before Stop', cwd: repo, repoPath: repo, worktree: null, laneId: null };
    if (mode === 'post-effect-error') {
      const { RuntimeLaunchPostEffectError } = await import('@/lib/runtime/launch-governance');
      throw new RuntimeLaunchPostEffectError(result);
    }
    return result;
  });
  try {
    const receipt = await call('o8_task_dispatch', { taskId: id });
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(callsBefore + 1));
    const { dispatch } = await import('@/lib/lane/commands');
    expect((await dispatch({ verb: 'stop', laneId: receipt.laneId, actor: 'user' })).ok).toBe(true);
  } finally { release(); }
  await vi.waitFor(() => expect(h.cleanup).toHaveBeenCalledWith({ action: 'stop', surfaceId }));
  expect(lanes.findLaneByPacket(id)).toMatchObject({ status: 'paused', sessionKey: null });
  expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held' });
  await vi.waitFor(() => expect(lanes.getLaneEvents(lanes.findLaneByPacket(id)!.id, 100)).toContainEqual(expect.objectContaining({
    verb: 'task_dispatch_cleanup', payload: { surfaceId, cleanup: status === 'completed' ? 'confirmed' : status === 'queued' ? 'queued' : 'unconfirmed' },
  })));
});

it('leaves explicit cloud lane attachment to the guarded caller after Stop', async () => {
  const id = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const before = h.launch.mock.calls.length;
  h.launch.mockImplementationOnce(async (payload: { existingLaneId: string; packetId: string }) => {
    await gate;
    const { settleRuntimeLaunchGovernance } = await import('@/lib/runtime/launch-governance');
    const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');
    return settleRuntimeLaunchGovernance({
      payload: { runtime: 'cloud', prompt: 'Fixture cloud launch', repoPath: repo, existingLaneId: payload.existingLaneId, packetId: payload.packetId },
      runtime: cloudRuntime, runtimeId: 'cloud', prompt: 'fixture',
      result: { ok: true, sessionKey: 'cloud:fixture-governance', note: 'Fixture queued' },
      launchWorktree: null, projectId: null, cwd: repo, repoPath: repo,
    });
  });
  h.cleanup.mockResolvedValueOnce({ ok: true, action: 'stop', surfaceId: 'cloud:fixture-governance', status: 'queued' });
  try {
    const receipt = await call('o8_task_dispatch', { taskId: id, requestedRuntime: 'cloud' });
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(before + 1));
    const { dispatch } = await import('@/lib/lane/commands');
    expect((await dispatch({ verb: 'stop', laneId: receipt.laneId, actor: 'user' })).ok).toBe(true);
  } finally { release(); }
  await vi.waitFor(() => expect(h.cleanup).toHaveBeenCalledWith({ action: 'stop', surfaceId: 'cloud:fixture-governance' }));
  expect(lanes.findLaneByPacket(id)).toMatchObject({ status: 'paused', sessionKey: null });
});

it('returns a modern receipt and cursor poll without holding a socket during provisioning', async () => {
  const id = fixture();
  const release = heldLaunch();
  try {
    const started = performance.now();
    const receipt = await call('o8_task_dispatch', { taskId: id }, 5000, true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(receipt).toMatchObject({ ok: true, status: 'launching', laneId: expect.any(String) });
    const since = Date.now() + 1000;
    const pollStart = performance.now();
    const tail = await call('mission_tail', { packetId: id, since, timeoutMs: 25000 }, 3000, true);
    expect(performance.now() - pollStart).toBeLessThan(1000);
    expect(tail.data).toMatchObject({ packetId: id, events: [], nextSince: since });
    closeDb();
    expect((await call('mission_tail', { packetId: id, since }, 3000, true)).data).toEqual(tail.data);
  } finally { release(); }
  await vi.waitFor(() => expect(lanes.findLaneByPacket(id)?.status).toBe('running'), { timeout: 10000 });
}, 20000);

it('holds a real HTTP mission_tail for its documented maximum and returns normally', async () => {
  const id = fixture();
  const since = Date.now() + 1000;
  const started = performance.now();
  const result = await call('mission_tail', { packetId: id, since, timeoutMs: 25000 }, 32000);
  expect(result.isError).not.toBe(true);
  expect(result.data).toMatchObject({ packetId: id, events: [], nextSince: since });
  expect(performance.now() - started).toBeGreaterThanOrEqual(24500);
  expect(performance.now() - started).toBeLessThan(31000);
}, 40000);

it('resumes a modern persisted event cursor after restarting the standalone MCP process', async () => {
  const id = fixture();
  const lane = lanes.createLane({ repoPath: repo, runtime: 'codex', branch: `fixture/${id}`, label: 'Restart fixture', packetId: id });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  async function start() {
    child = spawn(process.execPath, ['--import=tsx', 'src/lib/mcp/operator-mcp-server.ts', '--transport', 'http', '--port', String(port)], {
      env: { ...process.env, O8_API_BASE: `http://127.0.0.1:${h.port}`, O8_MCP_TOOL_LOADING: 'full' }, stdio: 'ignore',
    });
    await vi.waitFor(async () => {
      expect(child!.exitCode).toBeNull();
      expect((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).status).toBe(200);
    }, { timeout: 20000, interval: 100 });
  }
  async function poll(since: number) {
    const response = await fetch(`${url}/mcp`, { method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'mission_tail' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'restart', method: 'tools/call', params: {
        name: 'mission_tail', arguments: { packetId: id, since, timeoutMs: 25000 }, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
        },
      } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.has('mcp-session-id')).toBe(false);
    const body = await response.json();
    expect(body.result.resultType).toBe('complete');
    expect(body.result.isError).not.toBe(true);
    return JSON.parse(body.result.content[0].text).data;
  }
  try {
    await start();
    const firstPid = child!.pid;
    const first = await poll(0);
    await stop();
    closeDb();
    lanes.appendEvent(lane.id, 'update', 'system', { afterRestart: true });
    await start();
    expect(child!.pid).not.toBe(firstPid);
    const next = await poll(first.nextSince);
    expect(next.events).toContainEqual(expect.objectContaining({ verb: 'update', payload: { afterRestart: true } }));
    expect(next.nextSince).toBeGreaterThanOrEqual(first.nextSince);
  } finally { await stop(); }
}, 60000);

it.each(['claude', 'codex', 'claude-code', 'gemini', 'opencode'])('preserves named runtime %s from task creation to started child', async (requestedRuntime) => {
  const tasks = await import('@/app/api/tasks/route');
  const dispatch = await import('@/lib/tasks/http/dispatch');
  const expected = requestedRuntime === 'claude' ? 'claude-code' : requestedRuntime;
  h.launch.mockImplementationOnce(async (input) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', input.runtime]);
    let observed = '';
    child.stdout!.on('data', chunk => { observed += String(chunk); });
    await once(child, 'close');
    expect(observed).toBe(expected);
    return { ok: true, surfaceId: `${observed}:fixture`, note: 'Stub worker started' };
  });
  const response = await tasks.POST(new NextRequest('http://localhost/api/tasks', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Runtime fixture ${++sequence}`, repoPath: repo, requestedRuntime, workerIntent: 'reviewer' }),
  }));
  expect(response.status).toBe(201);
  const created = await response.json();
  const result = await dispatch.POST(new NextRequest('http://localhost/dispatch', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  }), { params: Promise.resolve({ taskId: created.taskId }) });
  expect(result.status).toBe(200);
  await vi.waitFor(() => expect(lanes.findLaneByPacket(created.packetId)).toMatchObject({ runtime: expected, status: 'running' }), { timeout: 5000 });
});

it('refuses an unknown explicit runtime before creating a task', async () => {
  const tasks = await import('@/app/api/tasks/route');
  const response = await tasks.POST(new NextRequest('http://localhost/api/tasks', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Unknown runtime fixture', repoPath: repo, requestedRuntime: 'uninstalled-typo' }),
  }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('uninstalled-typo');
});
it.each([42, {}, false])('refuses non-string requestedRuntime %j through HTTP', async requestedRuntime => {
  const tasks = await import('@/app/api/tasks/route');
  const response = await tasks.POST(new NextRequest('http://localhost/api/tasks', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Invalid runtime fixture', repoPath: repo, requestedRuntime }),
  }));
  expect(response.status).toBe(400);
});
it('creates a task on the saved operator runtime when runtime is omitted', async () => {
  const defaults = await import('@/lib/operator/defaults');
  const prior = await defaults.getOperatorDefaults();
  await defaults.updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code' });
  try {
    const tasks = await import('@/app/api/tasks/route');
    const response = await tasks.POST(new NextRequest('http://localhost/api/tasks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Operator default fixture', repoPath: repo }),
    }));
    expect(response.status).toBe(201);
    expect((await response.json()).workerRouting.selectedRuntime).toBe('claude-code');
  } finally { await defaults.updateOperatorDefaults({ defaultDispatchRuntime: prior.values.defaultDispatchRuntime }); }
});
it.each(['assistant', 'open_lane'])('validates runtime and applies the saved default through %s', async entry => {
  const defaults = await import('@/lib/operator/defaults');
  const prior = await defaults.getOperatorDefaults();
  await defaults.updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code' });
  try {
    const invoke = async (runtime?: string) => {
      if (entry === 'assistant') return (await import('@/lib/llm/tools')).executeTool('dispatch_codex_task', { repoPath: repo, task: 'Inspect fixture', branch: `entry-${++sequence}`, runtime });
      return (await import('@/lib/lane/commands')).dispatch({ verb: 'open_lane', repoPath: repo, branch: `entry-${++sequence}`, runtime: runtime as never, actor: 'user' });
    };
    const refused = entry === 'open_lane'
      ? await invoke('typo-runtime')
      : await invoke('typo-runtime').catch(error => ({ error: error.message }));
    if (entry === 'open_lane') expect(refused).toMatchObject({ ok: false, note: expect.stringContaining('typo-runtime') });
    expect(JSON.stringify(refused)).toContain('typo-runtime');
    expect(JSON.stringify(refused)).not.toContain('"ok":true');
    if (entry === 'assistant') h.launch.mockResolvedValueOnce({ ok: true, surfaceId: 'claude-code-owned:assistant-fixture', note: 'Started fixture' });
    const result = await invoke();
    expect(JSON.stringify(result)).toContain('claude-code');
  } finally { await defaults.updateOperatorDefaults({ defaultDispatchRuntime: prior.values.defaultDispatchRuntime }); }
});

async function runtimeToolCall(name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  const text = envelope.result?.content?.map((part: { text?: string }) => part.text ?? '').join('\n') ?? JSON.stringify(envelope.error);
  let data: Partial<import('@/lib/tasks/actions').TaskMutationResult> = {};
  try { data = JSON.parse(text); } catch { /* Refusals can be plain MCP text. */ }
  return { refused: Boolean(envelope.error || envelope.result?.isError), text, data };
}
it.each(['claude', undefined])('routes MCP task_create with requestedRuntime=%s through persisted state', async requestedRuntime => {
  fixture();
  const defaults = await import('@/lib/operator/defaults');
  const prior = await defaults.getOperatorDefaults();
  await defaults.updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code' });
  try {
    const count = control.readOrchestratorControlPlaneState().packets.length;
    const refused = await runtimeToolCall('o8_task_create', { title: 'Refuse runtime typo', repoPath: repo, requestedRuntime: 'typo-runtime' });
    expect(refused.refused).toBe(true);
    expect(refused.text).toMatch(/runtime/i);
    expect(control.readOrchestratorControlPlaneState().packets).toHaveLength(count);
    const result = await runtimeToolCall('o8_task_create', { title: 'MCP runtime fixture', repoPath: repo, requestedRuntime });
    expect(result.refused).toBe(false);
    expect(result.data.workerRouting?.selectedRuntime).toBe('claude-code');
    expect(control.readOrchestratorControlPlaneState().packets.find(packet => packet.id === result.data.packetId)?.runtime).toBe('claude-code');
  } finally { await defaults.updateOperatorDefaults({ defaultDispatchRuntime: prior.values.defaultDispatchRuntime }); }
});
it.each(['claude', undefined])('routes MCP task_dispatch with requestedRuntime=%s to the admitted runtime', async requestedRuntime => {
  fixture();
  const defaults = await import('@/lib/operator/defaults');
  const prior = await defaults.getOperatorDefaults();
  await defaults.updateOperatorDefaults({ defaultDispatchRuntime: 'claude-code' });
  try {
    const tasks = await import('@/app/api/tasks/route');
    const response = await tasks.POST(new NextRequest('http://localhost/api/tasks', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'MCP dispatch runtime fixture', repoPath: repo }) }));
    expect(response.status).toBe(201);
    const task = await response.json();
    const before = h.launch.mock.calls.length;
    const refused = await runtimeToolCall('o8_task_dispatch', { taskId: task.taskId, requestedRuntime: 'typo-runtime' });
    expect(refused.refused).toBe(true);
    expect(refused.text).toMatch(/runtime/i);
    expect(h.launch).toHaveBeenCalledTimes(before);
    h.launch.mockImplementationOnce(async input => {
      expect(input.runtime).toBe('claude-code');
      return { ok: true, surfaceId: `claude-code-owned:mcp-${++sequence}`, note: 'Started stub worker' };
    });
    const result = await runtimeToolCall('o8_task_dispatch', { taskId: task.taskId, requestedRuntime });
    expect(result.refused).toBe(false);
    expect(result.data.workerRouting?.selectedRuntime).toBe('claude-code');
    await vi.waitFor(() => expect(lanes.findLatestLaneByPacket(task.packetId)).toMatchObject({ runtime: 'claude-code', status: 'running' }), { timeout: 5000 });
  } finally { await defaults.updateOperatorDefaults({ defaultDispatchRuntime: prior.values.defaultDispatchRuntime }); }
});

it('batches pool fallback receipts and ignores malformed saved event JSON', async () => {
  fixture();
  const { resolveWorkerRouting } = await import('@/lib/agents/routing');
  const { getTaskPool } = await import('@/lib/tasks/pool');
  const state = control.readOrchestratorControlPlaneState();
  const seed = state.packets[0];
  const ids = ['bad', 'good'].map(kind => `${seed.id}-${kind}`);
  state.packets = ids.map(id => ({ ...seed, id, branchTarget: `task/${id}`, workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex' }) }));
  control.writeOrchestratorControlPlaneState(state);
  for (const [index, id] of ids.entries()) {
    const lane = lanes.createLane({ repoPath: repo, branch: `task/${id}`, runtime: 'claude-code', packetId: id });
    const event = lanes.appendEvent(lane.id, 'worker_fallback', 'system', { status: 'redispatched', toRuntime: 'claude-code', fromRuntime: 'codex' });
    if (index === 0) getSqlite().prepare('UPDATE lane_events SET payload_json = ? WHERE id = ?').run('{', event.id);
  }
  const queries = vi.spyOn(getSqlite(), 'prepare');
  try {
    const pool = await getTaskPool({ repoPath: repo });
    expect(pool.tasks.find(task => task.id === ids[0])?.runtimeSubstitution).toBeNull();
    expect(pool.tasks.find(task => task.id === ids[1])?.runtimeSubstitution).toContain('Worker quota fallback from codex to claude-code');
    expect(queries.mock.calls.filter(([sql]) => sql.includes('worker_fallback'))).toHaveLength(1);
  } finally { queries.mockRestore(); }
});
