import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { LaunchOptions, RuntimeId } from '@/lib/runtimes/types';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';

vi.mock('@/lib/codex/service-tier-catalogue', async () => ({ getCodexSpeedCatalogue: async () =>
  (await import('./helpers/codex-model-list-fixture')).codexEffortCatalogFixture }));
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
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
// Capture only the provider start boundary. Real dispatch, provisioning, prompt
// construction and lane persistence still execute; no provider is contacted.
const launches = vi.hoisted(() => vi.fn(async (input: LaunchOptions) => ({
  ok: true, sessionKey: `fixture:${input.packetId}`, note: 'Captured provider start without inference.',
})));
vi.mock('@/lib/runtimes', async (original) => {
  const actual = await original<typeof import('@/lib/runtimes')>();
  return { ...actual, getRuntime: (id: RuntimeId) => {
    const runtime = actual.getRuntime(id);
    return runtime ? { ...runtime, launch: launches } : undefined;
  } };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mission-retry-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
mkdirSync(dataDir); mkdirSync(repoPath);
const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', '--bare', origin]);
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
git('add', 'README.md');
git('-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), O8_OPERATOR_MCP_PROFILE: 'full',
  O8_WORKTREE_ROOT: join(dataDir, 'worktrees'),
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0' })) vi.stubEnv(key, value);
const token = 'mission-retry-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const stopRoute = await import('@/app/api/orchestrator/stop-mission/route');
const mcpRoute = await import('@/app/api/mcp/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { WorktreeManager, WorktreeRebaseConflictError } = await import('@/lib/worktree/manager');
let port = 0;
const dispatches: Promise<unknown>[] = [];
const creationBodies: Record<string, unknown>[] = [];
let dropCreationResponse = false;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    if (req.url === '/api/orchestrator/create-mission') creationBodies.push(JSON.parse(body));
    const dispatch = req.url === '/api/orchestrator/dispatch' && gate.status === 200 ? dispatchRoute.POST(request) : null;
    if (dispatch) dispatches.push(dispatch);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : req.url === '/api/orchestrator/reset-packet' ? await resetRoute.POST(request)
      : req.url === '/api/orchestrator/stop-mission' ? await stopRoute.POST(request)
      : dispatch ? await dispatch
      : new Response('Unknown fixture route', { status: 404 });
    if (req.url === '/api/orchestrator/create-mission' && dropCreationResponse) {
      dropCreationResponse = false; res.destroy(); return;
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}
async function call(name: string, args: Record<string, unknown>) {
  return (await rpc('tools/call', { name, arguments: args })).result as McpToolResult;
}
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', requestedModel: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Implement a retry-safe task', body: 'Owned fixture.' }], ...extra,
});
const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  vi.stubEnv('O8_API_PORT', String(port));
  writeFileSync(join(dataDir, 'api-port'), String(port));
  payload(await call('o8_setup', { action: 'open', path: repoPath }));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await Promise.allSettled(dispatches);
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('advertises an explicit exact-retry key on the registered MCP entry point', async () => {
  const tool = (await rpc('tools/list')).result.tools.find((entry: { name: string }) => entry.name === 'create_mission');
  expect(tool.inputSchema.properties.idempotencyKey).toMatchObject({ type: 'string', minLength: 1 });
});

it('replays one persisted inline mission across concurrent calls and a database reopen', async () => {
  const before = count();
  const args = { idempotencyKey: 'inline-retry' };
  const first = payload(await create(args));
  expect(first.replayed).not.toBe(true);
  const [second, third] = await Promise.all([create(args), create(args)]);
  for (const result of [second, third]) expect(payload(result)).toMatchObject({ missionId: first.missionId, packets: first.packets, replayed: true });
  closeDb();
  expect(payload(await create(args))).toMatchObject({ missionId: first.missionId, replayed: true });
  expect(count()).toBe(before + 1);
  expect(readMissionRegistryEntry(first.missionId)?.mission.packets.map(packet => packet.id)).toEqual(first.packets.map((packet: { id: string }) => packet.id));
  const conflict = await create({ ...args, constraints: 'Different task instructions' });
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain('409');
  expect(count()).toBe(before + 1);
});

it('keeps distinct explicit keys and omitted keys as separate deliberate missions', async () => {
  const before = count();
  const results = [];
  for (const args of [{ idempotencyKey: 'separate-a' }, { idempotencyKey: 'separate-b' }, {}, {}]) results.push(payload(await create(args)));
  expect(new Set(results.map(result => result.missionId)).size).toBe(4);
  expect(count()).toBe(before + 4);
});

// #4069: exercise the CLI/MCP while real dispatch owns the mission-store lock.
it.each(['stop-launching', 'stop-provisioning', 'reset-provisioning', 'retry-provisioning',
  'stop-watchdog', 'reset-watchdog', 'stop-rebase-rejection', 'reset-ready-publication', 'reset-packet-lease',
  'stop-packet-lease', 'reset-ready-replacement'] as const)(
  'cancels %s before releasing a blocked provisioner', async (action) => {
    const { runMission } = await import('../cli/src/commands/mission');
    const lanes = await import('@/lib/lane/registry');
    const control = await import('@/lib/orchestrator/control-plane');
    const runtimeActions = await import('@/lib/runtime/actions');
    const launchSurface = runtimeActions.launchRuntimeSurface;
    let runtimeCompletion: Promise<unknown> | undefined;
    vi.spyOn(runtimeActions, 'launchRuntimeSurface').mockImplementation((...args) => {
      const completion = launchSurface(...args);
      runtimeCompletion = completion;
      return completion;
    });
    const created = payload(await create({ issues_inline: [{ title: `Cancel ${action}`, body: 'Owned fixture.' }] }));
    const packetId = created.packets[0].id;
    const beforeLaunches = launches.mock.calls.length;
    const held = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const prototype = WorktreeManager.prototype as unknown as {
      resetTrackedWorkspaceChanges(path: string): Promise<void>;
      updateMetaStatus(id: string, status: string): Promise<void>;
    };
    const isLaunching = action === 'stop-launching' || action === 'stop-rebase-rejection';
    let started = false;
    let isEntered = false;
    let preparedPath: string | undefined;
    let laneId = '';
    const block = async () => { isEntered = true; await held.promise; };
    if (isLaunching) {
      const original = WorktreeManager.prototype.create;
      vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
        started = true;
        try {
          await block();
          if (action === 'stop-rebase-rejection') throw new WorktreeRebaseConflictError({
            baseBranch: 'main', conflictFiles: ['README.md'], worktreePath: repoPath, branch: 'fixture-conflict',
          });
          return await original.apply(this, args);
        }
        finally { finished.resolve(); }
      });
    } else {
      const original = prototype.resetTrackedWorkspaceChanges;
      vi.spyOn(prototype, 'resetTrackedWorkspaceChanges').mockImplementation(async function (this: typeof prototype, path) {
        preparedPath = path;
        await original.call(this, path);
        if (!action.startsWith('reset-ready')) await block();
      });
      if (action.startsWith('reset-ready')) {
        const update = prototype.updateMetaStatus;
        vi.spyOn(prototype, 'updateMetaStatus').mockImplementation(async function (this: typeof prototype, id, status) {
          await update.call(this, id, status);
          if (status === 'ready') await block();
        });
      }
      if (action === 'reset-ready-replacement') {
        const cleanup = WorktreeManager.prototype.cleanup;
        vi.spyOn(WorktreeManager.prototype, 'cleanup').mockImplementationOnce(async function (this: InstanceType<typeof WorktreeManager>, id, options) {
          const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
          await withWorktreeMetaTransaction(repoPath, async transaction => {
            const entry = (await transaction.readAll())[id];
            await transaction.save(id, { ...entry, createdAt: entry.createdAt + 1, laneId: 'newer-fixture-generation' });
          });
          return cleanup.call(this, id, options);
        });
      }
      const createOriginal = WorktreeManager.prototype.create;
      vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
        started = true;
        try { return await createOriginal.apply(this, args); }
        finally { finished.resolve(); }
      });
    }
    let operation: Promise<unknown> | undefined;
    let dispatched: Promise<McpToolResult> | undefined;
    const output: string[] = [];
    let receipt: unknown;
    let failure: unknown;
    try {
      const dispatch = () => call('dispatch_mission', { missionId: created.missionId });
      const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
      dispatched = action.endsWith('packet-lease') ? withPacketLifecycleMutationLock(packetId, dispatch) : dispatch();
      await vi.waitFor(() => expect(isEntered).toBe(true), { timeout: 10_000 });
      const lane = lanes.findLatestLaneByPacket(packetId)!;
      laneId = lane.id;
      expect(lane).toMatchObject({ status: 'launching', sessionKey: null });
      if (action.endsWith('watchdog')) {
        const { enforceWedgeTimeouts, WEDGE_LAUNCHING_MS } = await import('@/lib/lane/wedge-timeouts');
        enforceWedgeTimeouts(Date.now() + WEDGE_LAUNCHING_MS + 1000);
        expect(lanes.getLane(lane.id)?.status).toBe('awaiting_orchestrator');
      }
      expect(existsSync(join(dataDir, 'orchestrator-state.json.lock'))).toBe(true);
      if (action.startsWith('stop')) {
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
        operation = runMission({ human: false, verbose: false }, 'stop', ['--mission', created.missionId]).then(code => {
          expect(code).toBe(0);
          receipt = JSON.parse(output.find(line => line.includes('o8/cli/mission.stop/v1'))!).mission;
        });
      } else {
        operation = call('reset_packet', { packetId, clearWorktree: action.startsWith('reset') }).then(result => { receipt = payload(result); });
      }
      operation = operation.catch(error => { failure = error; });
      // A cancellation must acknowledge while the provisioner is still blocked.
      await vi.waitFor(() => expect(receipt ?? failure).toBeDefined(), { timeout: 3000 });
      if (failure) throw failure;
      if (action.startsWith('stop')) expect(receipt).toMatchObject({ packets: [{ packetId, status: 'stopped',
        stoppedFrom: isLaunching ? 'launching' : 'provisioning' }] });
      else expect(receipt).toMatchObject({ reset: true, packetId });
      expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({ queueState: 'held' });
      expect(lanes.getLane(lane.id)?.status).toBe(action.startsWith('stop') ? 'paused' : 'archived');
    } finally {
      held.resolve();
      await Promise.allSettled([operation, dispatched, runtimeCompletion, ...(started ? [finished.promise] : [])]);
      expect.soft(launches.mock.calls.length - beforeLaunches).toBe(0);
    }
    expect(launches.mock.calls.length - beforeLaunches).toBe(0);
    expect(control.readOrchestratorControlPlaneState().packets[0].queueState).toBe('held');
    expect(lanes.getLane(laneId)?.status).toBe(action.startsWith('stop') ? 'paused' : 'archived');
    if (preparedPath) expect(existsSync(preparedPath)).toBe(action === 'reset-ready-replacement');
    if (action === 'reset-ready-replacement') expect(readFileSync(join(preparedPath!, 'README.md'), 'utf8')).toBe('fixture\n');
  }, 30_000,
);

it('reports queued as the stopped-from state through mission stop CLI', async () => {
  const created = payload(await create({ issues_inline: [{ title: 'Stop queued packet', body: 'Owned fixture.' }] }));
  const control = await import('@/lib/orchestrator/control-plane');
  const queued = control.readOrchestratorControlPlaneState();
  Object.assign(queued.packets[0], { queueState: 'queued', status: 'queued', blockedReason: null, holdIntent: null });
  control.writeOrchestratorControlPlaneState(queued);
  const { runMission } = await import('../cli/src/commands/mission');
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  expect(await runMission({ human: false, verbose: false }, 'stop', ['--mission', created.missionId])).toBe(0);
  const receipt = JSON.parse(output.find(line => line.includes('o8/cli/mission.stop/v1'))!).mission;
  expect(receipt.packets).toMatchObject([{ packetId: created.packets[0].id, status: 'stopped', stoppedFrom: 'queued' }]);
});

it('stops both packets after a timed-out retry creates a duplicate, including the provisioning queue', async () => {
  const { runMission } = await import('../cli/src/commands/mission');
  const lanes = await import('@/lib/lane/registry');
  // Model a legacy caller that loses the create response and retries with a
  // fresh correlation key. Both persisted packets must remain stoppable.
  const body = { repoPath, runtime: 'codex', issues: [{ number: 90_000_004_069, title: 'Duplicate cancellation fixture', body: 'Owned fixture.', url: '' }] };
  const known = new Set((getSqlite().prepare('SELECT id FROM missions').all() as Array<{ id: string }>).map(row => row.id));
  dropCreationResponse = true;
  await expect(fetch(`http://127.0.0.1:${port}/api/orchestrator/create-mission`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, clientMutationId: 'duplicate-lost-response' }),
  })).rejects.toThrow();
  const originalId = (getSqlite().prepare('SELECT id FROM missions').all() as Array<{ id: string }>).find(row => !known.has(row.id))!.id;
  const originalPacket = readMissionRegistryEntry(originalId)!.mission.packets[0];
  const retryResponse = await fetch(`http://127.0.0.1:${port}/api/orchestrator/create-mission`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // Legacy inline retries allocate another synthetic number for the same task.
    body: JSON.stringify({ ...body, issues: [{ ...body.issues[0], number: body.issues[0].number + 1 }], clientMutationId: 'duplicate-new-retry-key' }),
  });
  expect(retryResponse.status).toBe(201);
  const duplicate = (await retryResponse.json()).result;
  expect(duplicate.missionId).not.toBe(originalId);
  expect(duplicate.packets[0].id).not.toBe(originalPacket.id);
  expect(duplicate.packets[0].title).toBe(originalPacket.title);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const finished: Promise<unknown>[] = [];
  const prototype = WorktreeManager.prototype as unknown as { resetTrackedWorkspaceChanges(path: string): Promise<void> };
  let isEntered = false;
  const reset = prototype.resetTrackedWorkspaceChanges;
  vi.spyOn(prototype, 'resetTrackedWorkspaceChanges').mockImplementation(async function (this: typeof prototype, path) {
    await reset.call(this, path); isEntered = true; entered.resolve(); await held.promise;
  });
  const originalCreate = WorktreeManager.prototype.create;
  vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(function (this: InstanceType<typeof WorktreeManager>, ...args) {
    const completion = originalCreate.apply(this, args);
    finished.push(completion);
    return completion;
  });
  const beforeLaunches = launches.mock.calls.length;
  const pending: Promise<unknown>[] = [];
  const output: string[] = [];
  try {
    pending.push(call('dispatch_mission', { missionId: originalId }));
    await vi.waitFor(() => expect(isEntered).toBe(true), { timeout: 10_000 });
    pending.push(call('dispatch_mission', { missionId: duplicate.missionId }));
    await vi.waitFor(() => expect(lanes.findLatestLaneByPacket(duplicate.packets[0].id)?.lastEventLabel)
      .toMatch(/^worktree_provision_queued:/), { timeout: 10_000 });
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    for (const missionId of [duplicate.missionId, originalId]) {
      let stopped = false;
      let failure: unknown;
      const stop = runMission({ human: false, verbose: false }, 'stop', ['--mission', missionId]).then(() => { stopped = true; }, error => { failure = error; });
      pending.push(stop);
      await vi.waitFor(() => expect(stopped || failure).toBeTruthy(), { timeout: 3000 });
      if (failure) throw failure;
    }
    const receipts = output.filter(line => line.includes('o8/cli/mission.stop/v1')).map(line => JSON.parse(line).mission);
    expect(receipts.map(receipt => receipt.packets[0])).toMatchObject([
      { packetId: duplicate.packets[0].id, status: 'stopped', stoppedFrom: 'queued' },
      { packetId: originalPacket.id, status: 'stopped', stoppedFrom: 'provisioning' },
    ]);
  } finally {
    held.resolve();
    await Promise.allSettled([...pending, ...finished]);
    expect.soft(launches.mock.calls.length - beforeLaunches).toBe(0);
  }
  for (const [missionId, packetId] of [[originalId, originalPacket.id], [duplicate.missionId, duplicate.packets[0].id]]) {
    expect(readMissionRegistryEntry(missionId)!.mission.packets.find(packet => packet.id === packetId)).toMatchObject({ operatorStopped: true, queueState: 'held' });
    expect(lanes.findLatestLaneByPacket(packetId)).toMatchObject({ status: 'paused', sessionKey: null });
  }
}, 30_000);

it('returns ids before slow provisioning finishes and never dispatches an exact replay again', async () => {
  const before = count();
  const beforeDispatches = dispatches.length;
  const beforeLaunches = launches.mock.calls.length;
  let packetId = '';
  let retry: Promise<McpToolResult> | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = WorktreeManager.prototype.create;
  const provision = vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
    await held;
    return original.apply(this, args);
  });
  try {
    const started = performance.now();
    const first = payload(await create({ dispatch: true, idempotencyKey: 'slow-provision' }));
    expect(performance.now() - started).toBeLessThan(3000);
    packetId = first.packets[0].id;
    expect(first.missionId).toEqual(expect.any(String));
    expect(first.packets).toHaveLength(1);
    expect(first.dispatch).toMatchObject({ queued: true });
    await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const saved = readMissionRegistryEntry(first.missionId)!.mission;
    expect(saved.packets[0].id).toBe(first.packets[0].id);
    let replay: McpToolResult | undefined;
    retry = create({ dispatch: true, idempotencyKey: 'slow-provision' });
    void retry.then(result => { replay = result; });
    await vi.waitFor(() => expect(replay).toBeDefined(), { timeout: 2000 });
    const second = payload(replay!);
    expect(second).toMatchObject({ missionId: first.missionId, replayed: true });
    expect(count()).toBe(before + 1);
    // Allow a queued accidental second dispatch request to reach the HTTP server.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dispatches).toHaveLength(beforeDispatches + 1);
    expect(provision).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await retry;
    await Promise.allSettled(dispatches);
  }
  expect(launches.mock.calls.length).toBe(beforeLaunches + 1);
  closeDb();
  const { findLaneByPacket } = await import('@/lib/lane/registry');
  const lane = findLaneByPacket(packetId);
  expect(lane?.worktreePath).toBeTruthy();
  expect(existsSync(lane!.worktreePath!)).toBe(true);
}, 30_000);

it('reuses the exact create body after a lost HTTP response without duplicating the mission', async () => {
  const before = count();
  const bodyStart = creationBodies.length;
  dropCreationResponse = true;
  const created = payload(await create({ idempotencyKey: 'lost-response' }));
  expect(created.missionId).toEqual(expect.any(String));
  expect(creationBodies.slice(bodyStart)).toHaveLength(2);
  expect(creationBodies[bodyStart + 1]).toEqual(creationBodies[bodyStart]);
  closeDb();
  expect(payload(await create({ idempotencyKey: 'lost-response' })).missionId).toBe(created.missionId);
  expect(count()).toBe(before + 1);
});

it('forwards the same key for GitHub issues through the real issue-loader process and HTTP route', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({number: 123, title: "Fixture issue", body: "Owned fixture.", url: "https://example.invalid/issues/123"}));\n');
  chmodSync(gh, 0o755);
  const oldPath = process.env.PATH;
  vi.stubEnv('PATH', `${bin}:${oldPath}`);
  try {
    const before = count();
    const args = { issues_inline: undefined, issues: ['123'], idempotencyKey: 'github-retry' };
    const first = payload(await create(args));
    closeDb();
    expect(payload(await create(args))).toMatchObject({ missionId: first.missionId, packets: first.packets, replayed: true });
    expect(count()).toBe(before + 1);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

it.each(['', '   ', 42])('rejects a malformed key before allocating a mission: %j', async idempotencyKey => {
  const before = count();
  expect((await create({ idempotencyKey })).isError).toBe(true);
  expect(count()).toBe(before);
});


it.each([
  ['retry_packet', 'in-process'], ['reset_packet', 'in-process'],
  ['retry_packet', 'filesystem'], ['reset_packet', 'filesystem'],
])('returns a bounded busy receipt for %s while a real %s lock stays held', async (tool, mode) => {
  const created = payload(await create());
  const packetId = created.packets[0].id;
  const { withLockedState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const expectedState = readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId)!.status;
  const registryBefore = readMissionRegistryEntry(created.missionId)?.mission.packets[0].status;
  const statePath = join(dataDir, 'orchestrator-state.json');
  const lockDir = `${statePath}.lock`;
  let release!: () => void;
  let owner: Promise<unknown> | undefined;
  if (mode === 'in-process') {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    owner = withLockedState(async () => { entered(); await held; });
    await ready;
  } else {
    // Live filesystem ownership without an in-process FIFO slot models the
    // other server process. The actual filesystem lock/acquirer stays real.
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'busy-fixture' }));
    release = () => rmSync(lockDir, { recursive: true, force: true });
  }
  const before = readFileSync(statePath, 'utf8');
  const lockBefore = readFileSync(join(lockDir, 'holder.json'), 'utf8');
  let pending: Promise<McpToolResult> | undefined;
  try {
    let result: McpToolResult | undefined;
    pending = call(tool, { packetId });
    void pending.then(value => { result = value; });
    await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 3000 });
    expect(result!.isError).toBe(true);
    const content = result!.content[0];
    const error = JSON.parse(content.type === 'text' ? content.text : '');
    expect(error).toMatchObject({ code: 'mission_store_busy', state: expectedState, packetId, retryAfterMs: 1000 });
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(readFileSync(join(lockDir, 'holder.json'), 'utf8')).toBe(lockBefore);
    expect(readMissionRegistryEntry(created.missionId)?.mission.packets[0].status).toBe(registryBefore);
  } finally {
    release();
    await owner;
    await pending;
  }
}, 15_000);
