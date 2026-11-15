import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-staging-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const launches = vi.hoisted(() => ({ calls: [] as Array<{ packetId?: string; repoPath: string }> }));
const dispatchFailure = vi.hoisted(() => ({ once: false }));
const tempDirs: string[] = [];

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000, error: null,
  })),
}));

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launches.calls.push({ packetId: input.packetId, repoPath: input.repoPath });
    return { ok: true, surfaceId: `codex-owned:${input.packetId}`, note: 'fixture launch', worktree: { path: input.repoPath } };
  }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => undefined) }));

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-staging-repo-'));
  tempDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission staging fixture\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

type McpResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> };

function textContent(result: McpResult) {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

function parseResult<T>(result: McpResult) {
  return JSON.parse(textContent(result)) as T;
}

function stubMissionApiFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText.includes('/supervisor/watch') || urlText.includes('/internal/realtime')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (urlText.includes('/dispatch') && dispatchFailure.once) {
      dispatchFailure.once = false;
      return new Response(JSON.stringify({ ok: false, error: { message: 'interrupted fixture dispatch' } }), { status: 500 });
    }
    try {
      if (urlText.includes('/create-mission')) {
        const [{ NextRequest }, { POST }] = await Promise.all([
          import('next/server'),
          import('@/app/api/orchestrator/create-mission/route'),
        ]);
        return POST(new NextRequest(urlText, {
          method: 'POST',
          headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      }
      const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
      return new Response(JSON.stringify({ ok: true, result: await dispatchMission(body) }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: { message: String(error) } }), { status: 500 });
    }
  }));
}

beforeAll(async () => {
  // Load the real route during fixture setup, outside the interaction deadline.
  await import('@/app/api/orchestrator/create-mission/route');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  launches.calls = [];
  dispatchFailure.once = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('staged mission creation', () => {
  it('keeps comparison candidates staged until explicit dispatch and preserves MCP immediate dispatch', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
    const staged = parseResult<{ missionId: string; packets: Array<{ id: string }> }>(await handleCreateMission({
      issues_inline: [{ title: 'staged comparison mission', body: 'Wait for explicit dispatch.' }],
      repoPath, runtime: 'codex', comparisonModels: ['gpt-5.6-sol', 'gpt-5.6-sol'], dispatch: false,
    }));

    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    expect(launches.calls).toEqual([]);
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(currentMissionState().packets).toEqual(expect.arrayContaining([
      expect.objectContaining({ queueState: 'held', lane: null, review: null }),
    ]));

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect(await dispatchMission({ missionId: staged.missionId })).toMatchObject({ dispatched: 2 });
    expect(launches.calls).toHaveLength(2);

    // The MCP response is intentionally fire-and-forget. If that first call is
    // interrupted, the create-time admission intent leaves this packet queued
    // for the real scheduler instead of stranding it in the held staging state.
    dispatchFailure.once = true;
    const immediate = parseResult<{ missionId: string; packets: Array<{ id: string }> }>(await handleCreateMission({
      issues_inline: [{ title: 'immediate MCP mission' }], repoPath, runtime: 'codex',
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launches.calls).toHaveLength(2);
    expect(currentMissionState().packets.find((packet) => packet.id === immediate.packets[0]?.id)).toMatchObject({
      queueState: 'queued', status: 'queued', runtime: 'codex',
    });
    await runHeadlessSprintTick();
    await vi.waitFor(() => expect(currentMissionState().packets.find((packet) => packet.id === immediate.packets[0]?.id)?.lane?.laneId).toMatch(/^lane-/));
    expect(launches.calls).toHaveLength(3);
    await runHeadlessSprintTick();
    expect(launches.calls).toHaveLength(3);
  }, 20_000);

  it('launches only the selected comparison candidate after an operator holds its sibling', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
    const staged = parseResult<{ missionId: string }>(await handleCreateMission({
      issues_inline: [{ title: 'one worker comparison', body: 'Launch only the selected candidate.' }],
      repoPath, runtime: 'codex', comparisonModels: ['gpt-5.6-sol', 'gpt-5.6-sol'], dispatch: false,
    }));
    const { fanOutComparisonPackets } = await import('@/lib/orchestrator/comparison-fanout');
    const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    const { state: cached } = await withMissionRegistryState(staged.missionId, (state) => ({
      state: fanOutComparisonPackets(state), result: undefined,
    }));
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    writeOrchestratorControlPlaneState(cached);
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(cached.packets).toHaveLength(2);
    const firstId = cached.packets[0]!.id;
    const heldId = cached.packets[1]!.id;
    expect(readMissionRegistryEntry(staged.missionId)?.mission.packets.map((packet) => packet.id))
      .toEqual([firstId, heldId]);
    const { NextRequest } = await import('next/server');
    const stateRoute = await import('@/app/api/orchestrator/state/route');
    const packetRequest = (packetId: string, queueState: 'held' | 'queued') => new NextRequest('http://localhost/api/orchestrator/state', {
      method: 'PATCH',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ packetId, updates: { queueState, blockedReason: queueState === 'held' ? 'Held by operator' : null } }),
    });
    expect((await stateRoute.PATCH(packetRequest(firstId, 'held'))).status).toBe(200);
    expect((await stateRoute.PATCH(packetRequest(heldId, 'held'))).status).toBe(200);
    const status = await stateRoute.GET(new NextRequest('http://localhost/api/orchestrator/state', {
      headers: { host: 'localhost' },
    }));
    const statusBody = await status.json() as { mission: { packets: Array<{ id: string; queueState: string; holdIntent?: string; blockedReason: string | null; lane: unknown }> } };
    expect(status.status).toBe(200);
    expect(statusBody.mission.packets).toHaveLength(2);
    for (const packet of statusBody.mission.packets) {
      expect(packet).toMatchObject({ queueState: 'held', holdIntent: 'operator', blockedReason: 'Held by operator', lane: null });
    }
    expect((await stateRoute.PATCH(packetRequest(firstId, 'queued'))).status).toBe(200);

    // A cached whole-mission write and a fresh dispatch must both respect the hold.
    const stale = await stateRoute.POST(new NextRequest('http://localhost/api/orchestrator/state', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ mission: cached }),
    }));
    expect(stale.status).toBe(200);
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect(await dispatchMission({ missionId: staged.missionId })).toMatchObject({ dispatched: 1 });
    expect(launches.calls.map((entry) => entry.packetId)).toEqual([firstId]);
    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    expect(launches.calls).toHaveLength(1);
    expect(currentMissionState().packets.find((packet) => packet.id === heldId)).toMatchObject({
      queueState: 'held', holdIntent: 'operator', blockedReason: 'Held by operator', lane: null,
    });
  }, 20_000);

  it('treats a fanned-out comparison seed as consumed by its candidates, never as a missing owner', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
    const staged = parseResult<{ missionId: string }>(await handleCreateMission({
      issues_inline: [{ title: 'seed consumption', body: 'Fan out before dispatch.' }],
      repoPath, runtime: 'codex', comparisonModels: ['gpt-5.6-sol', 'gpt-5.6-sol'], dispatch: false,
    }));
    const { fanOutComparisonPackets } = await import('@/lib/orchestrator/comparison-fanout');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { captureCurrentDispatchRegistry } = await import('@/lib/orchestrator/operator-mission-service/dispatch-registry-publication');
    const { withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    const fanned = fanOutComparisonPackets(readOrchestratorControlPlaneState());
    expect(fanned.packets).toHaveLength(2);
    expect(() => captureCurrentDispatchRegistry(fanned)).not.toThrow();
    // Without its candidates the seed really is missing.
    expect(() => captureCurrentDispatchRegistry({ ...fanned, packets: [] })).toThrow(/packet_owner_missing/);
    // Candidates keep every durable authority of the seed, or the dispatch is refused.
    const refusedAfter = async (change: (seed: (typeof fanned.packets)[number]) => void, reason: RegExp) => {
      const { result: before } = await withMissionRegistryState(staged.missionId, (state) => {
        const previous = structuredClone(state.packets[0]!);
        change(state.packets[0]!);
        return { state, result: previous };
      });
      expect(() => captureCurrentDispatchRegistry(fanned)).toThrow(reason);
      await withMissionRegistryState(staged.missionId, (state) => {
        state.packets[0] = before;
        return { state, result: undefined };
      });
      expect(() => captureCurrentDispatchRegistry(fanned)).not.toThrow();
    };
    await refusedAfter((seed) => { seed.operatorStopped = true; }, /operator_stop_changed/);
    // A reset of the durable seed raised its generation past the cached candidates.
    await refusedAfter((seed) => { seed.attemptCount = (seed.attemptCount ?? 0) + 1; }, /newer_generation/);
    // A released or archived seed is terminal and never consumed by launchable candidates.
    await refusedAfter((seed) => { seed.status = 'archived'; seed.archivedAt = new Date().toISOString(); }, /terminal_owner_changed/);
    await refusedAfter((seed) => { seed.branchTarget = 'inline/elsewhere'; }, /workspace_owner_changed/);
  });

  it('does not launch a stale dispatch snapshot after an operator Hold wins during preflight', async () => {
    const repoPath = createTempRepo();
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    const packetId = 'held-during-dispatch-preflight';
    const queued = {
      id: packetId, referenceLabel: 'PKT-HOLD-RACE', title: 'Hold race', summary: 'Do not launch',
      workspaceTargetPath: repoPath, branchTarget: 'main', runtime: 'codex' as const,
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const,
      releaseState: 'pending' as const, status: 'queued' as const,
      blockedReason: null, lane: null, review: null,
    };
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath, packets: [queued] });
    const staleTick = readOrchestratorControlPlaneState();
    const { NextRequest } = await import('next/server');
    const { PATCH } = await import('@/app/api/orchestrator/state/route');
    const hold = await PATCH(new NextRequest('http://localhost/api/orchestrator/state', {
      method: 'PATCH', headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ packetId, updates: { queueState: 'held', blockedReason: 'Held by operator' } }),
    }));
    expect(hold.status).toBe(200);
    await runDispatchTick(staleTick);
    expect(launches.calls).toEqual([]);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      queueState: 'held', holdIntent: 'operator', lane: null,
    });
  }, 20_000);

  it('blocks a scheduled tick while a manual lane claim is live, including a stale tick snapshot', async () => {
    const repoPath = createTempRepo();
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { getDispatchBlocker, runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    const packetId = 'manual-claim-scheduler';
    const packet = {
      id: packetId, referenceLabel: packetId, title: packetId, summary: 'Manual lane owns launch',
      workspaceTargetPath: repoPath, branchTarget: 'main', runtime: 'codex' as const,
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const,
      releaseState: 'pending' as const, status: 'queued' as const,
      blockedReason: null, lane: null, review: null,
    };
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath, packets: [packet] });
    const staleTick = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({
      ...staleTick,
      packets: [{ ...staleTick.packets[0]!, manualLaunchClaim: {
        token: 'live-claim', ownerPid: process.pid, startedAt: new Date().toISOString(),
      } }],
    });
    const claimed = readOrchestratorControlPlaneState();
    expect(getDispatchBlocker(claimed.packets[0]!, claimed.packets)).toBe('Manual lane opening');
    await runDispatchTick(claimed);
    expect(launches.calls).toEqual([]);
    const staleOutcome = await runDispatchTick(staleTick);
    expect(launches.calls).toEqual([]);
    expect(staleOutcome.packets[0]?.blockedReason).toContain('manual lane');
  }, 20_000);

  it('refuses the manual open-lane route for an operator-held packet', async () => {
    const repoPath = createTempRepo();
    const operatorToken = 'manual-held-operator-0123456789abcdef';
    writeFileSync(join(process.env.O8_DATA_DIR!, 'ws-token'), operatorToken);
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packetId = 'manual-open-held';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), repoPath,
      packets: [{
        id: packetId, referenceLabel: 'PKT-MANUAL-HOLD', title: 'Manual hold', summary: 'Do not open',
        workspaceTargetPath: repoPath, branchTarget: 'main', runtime: 'codex',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', holdIntent: 'operator',
        releaseState: 'pending', status: 'draft', blockedReason: 'Held by operator', lane: null, review: null,
      }],
    });
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/lanes/route');
    const response = await POST(new NextRequest('http://localhost/api/lanes', {
      method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'open_lane', packetId, repoPath, branch: 'main', runtime: 'codex', label: 'Manual hold', actor: 'user' }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'packet_held' });
    expect(launches.calls).toEqual([]);
  });
});

it.each([['operator', false], ['operator', true], ['worker', false]] as const)('real dispatch route forwards %s force=%s through the MCP client on a busy machine', async (role, force) => {
  const repoPath = createTempRepo();
  const lanes = await import('@/lib/lane/registry');
  for (const lane of lanes.listActiveLanes()) lanes.archiveLane(lane.id);
  stubMissionApiFetch();
  const { handleCreateMission, handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
  const staged = parseResult<{ missionId: string }>(await handleCreateMission({ repoPath, issues_inline: [{ title: 'forced route fixture' }], dispatch: false, runtime: 'codex' }));
  const machine = await import('./machine-load');
  const original = machine.machineLoadBlocker;
  vi.spyOn(machine, 'machineLoadBlocker').mockImplementation(options => original({ ...options, runningWorkers: 1, readLoad: () => [99999, 99999, 99999] }));
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
  const token = role === 'worker' ? getOrCreateLocalWorkerToken() : getOrCreateWsToken();
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/orchestrator/dispatch/route');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('/api/orchestrator/dispatch')) return new Response('{}');
    return POST(new NextRequest(String(url), { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${token}` }, body: String(init?.body) }));
  }));
  const result = parseResult<{ dispatched: number; status: string }>(await handleDispatchMission({ missionId: staged.missionId, force }));
  expect(result.dispatched).toBe(force ? 1 : 0);
  expect(result.status).toBe(force ? 'dispatched' : 'queued');
  expect(launches.calls).toHaveLength(force ? 1 : 0);
}, 20_000);

it('real dispatch route refuses worker force with a reason before dispatch', async () => {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/orchestrator/dispatch/route');
  const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${getOrCreateLocalWorkerToken()}` }, body: JSON.stringify({ force: true }) }));
  expect(response.status).toBe(403);
  expect((await response.json()).error.message).toMatch(/operator.only/i);
  expect(launches.calls).toHaveLength(0);
});
