import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  killGate: null as Promise<void> | null,
  killsStarted: 0,
  killWaiters: [] as Array<{ count: number; resolve: () => void }>,
  resetPacket: vi.fn(async () => ({ reset: true, worktreePruned: false })),
}));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [], runtimes: [] })),
}));
vi.mock('@/lib/lane/reap-sessions', () => ({
  archiveLaneSessions: vi.fn(),
  killLaneSessionsConfirmed: vi.fn(async (lanes: Array<{ id: string; sessionKey: string; runtime: string }>) => {
    h.killsStarted += 1;
    h.killWaiters = h.killWaiters.filter((waiter) => {
      if (waiter.count > h.killsStarted) return true;
      waiter.resolve();
      return false;
    });
    if (h.killGate) await h.killGate;
    return lanes.map((lane) => ({
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      runtime: lane.runtime,
      confirmed: true,
      alreadyDead: false,
      stages: [],
    }));
  }),
}));
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: vi.fn(async () => ({ targeted: 0, confirmed: 0, failures: [] })),
}));
// The race ends at confirmed stop, before asynchronous archive/prune. Actual
// cleanup and newer-lane preservation are covered by the generation fixtures.
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ resetPacket: h.resetPacket }));
vi.mock('@/lib/orchestrator/operator-mission-service/reset', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service/reset')>(),
  resetPacket: h.resetPacket,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-stop-client-race-'));
const token = 'stop-client-race-operator-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const stateRoute = await import('@/app/api/orchestrator/state/route');
const stopRoute = await import('@/app/api/orchestrator/stop-packet/route');
// Resolve the mocked lazy service before simultaneous stop imports compete to
// initialize its re-export graph in the test runner.
await import('@/lib/orchestrator/operator-mission-service');
const { closeDb } = await import('@/lib/db');
const { getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, listLanes, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { holdPacketLifecycleMutation } = await import('@/lib/orchestrator/packet-lifecycle-guard');
const { readOrchestratorControlPlaneState, withLockedState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');

/** Resolves when the kill ladder has been entered `count` times. */
function killsStarted(count: number): Promise<void> {
  if (h.killsStarted >= count) return Promise.resolve();
  return new Promise((resolve) => { h.killWaiters.push({ count, resolve }); });
}

function request(body: unknown, method = 'POST', pathname = '/api/orchestrator/state') {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function packet(id: string): OrchestratorPacket {
  return {
    id, referenceLabel: id, title: id, summary: 'fixture',
    workspaceTargetPath: null, branchTarget: `packet/${id}`, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'draft',
    releaseState: 'pending', status: 'draft', blockedReason: null, lane: null, review: null,
  };
}

function seedMission(withTwoLanes = false) {
  const lane = createLane({
    repoPath: dataDir, branch: 'packet/b',
    runtime: 'codex', packetId: 'b', sessionKey: 'codex-owned:stop-client-race',
  });
  setLaneStatus(lane.id, 'running', 'system', 'fixture_running');
  const worker: OrchestratorPacket = {
    ...packet('b'), queueState: 'queued', status: 'running',
    lane: {
      tileId: 'tile-b', tabId: 'tab-b', laneId: lane.id, sessionKey: lane.sessionKey,
      runtime: 'codex', repoPath: dataDir, worktreePath: null,
      lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null,
    },
  };
  let first = packet('a');
  if (withTwoLanes) {
    const firstLane = createLane({ repoPath: dataDir, branch: 'packet/a', runtime: 'codex',
      packetId: 'a', sessionKey: 'codex-owned:stop-client-race-a' });
    setLaneStatus(firstLane.id, 'running', 'system', 'fixture_running');
    first = { ...worker, ...first, queueState: 'queued', status: 'running',
      lane: { ...worker.lane!, laneId: firstLane.id, sessionKey: firstLane.sessionKey } };
  }
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: 'stop-client-race',
    repoPath: dataDir, packets: [first, worker],
  });
}

beforeEach(() => {
  h.killsStarted = 0;
  h.killWaiters = [];
  h.killGate = null;
  h.resetPacket.mockClear();
  vi.unstubAllGlobals();
  for (const lane of listLanes()) deleteLane(lane.id);
});
afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cached client mission writes during stop', () => {
  it('refuses Hold after a manual lane is opened but before its session launches', async () => {
    const packetId = 'manual-lane-hold-race';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'manual-lane-race',
      repoPath: dataDir, packets: [{ ...packet(packetId), queueState: 'queued', status: 'queued' }],
    });
    createLane({ repoPath: dataDir, branch: 'packet/manual-lane', runtime: 'codex', packetId });
    const response = await stateRoute.PATCH(request({
      packetId, updates: { queueState: 'held', blockedReason: 'Held by operator' },
    }, 'PATCH'));
    expect(response.status).toBe(409);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ queueState: 'queued' });
  });

  it('refuses Hold once the packet has an active launch reservation', async () => {
    const packetId = 'reserved-launch-hold-race';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'reserved-launch-race',
      repoPath: dataDir, packets: [{ ...packet(packetId), queueState: 'queued', status: 'queued' }],
    });
    const now = Date.now();
    getSqlite().prepare(`
      INSERT INTO storage_admission_reservations (
        reservation_id, volume_id, target_path, exact_bytes, owner_id,
        owner_generation, generation, state, lease_expires_at,
        pre_measurement_json, last_mutation_id, last_reason, created_at, updated_at
      ) VALUES (?, 'fixture-volume', ?, 1, ?, 1, 1, 'reserved', ?, '{}', ?, 'admitted', ?, ?)
    `).run(`reservation:${packetId}`, dataDir, packetId, now + 60_000, `reserve:${packetId}`, now, now);
    const response = await stateRoute.PATCH(request({
      packetId, updates: { queueState: 'held', blockedReason: 'Held by operator' },
    }, 'PATCH'));
    expect(response.status).toBe(409);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ queueState: 'queued', status: 'queued' });
  });

  it('rejects a late hold after a worker has launched', async () => {
    seedMission();
    const response = await stateRoute.PATCH(request({
      packetId: 'b', updates: { queueState: 'held', blockedReason: 'Held by operator' },
    }, 'PATCH'));
    expect(response.status).toBe(409);
    expect(readOrchestratorControlPlaneState().packets[1]).toMatchObject({
      queueState: 'queued', status: 'running', lane: expect.objectContaining({ laneId: expect.any(String) }),
    });
  });

  it('preserves the stop guard when a stale sidebar archives a sibling during kill confirmation', async () => {
    const cached = seedMission();
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const stopping = stopRoute.POST(request({ packetId: 'b' }, 'POST', '/api/orchestrator/stop-packet'));
    let guardSource: unknown;
    try {
      await killsStarted(1);
      guardSource = readOrchestratorControlPlaneState().packets[1]?.releaseStatePayload?.source;
      const response = await stateRoute.POST(request({
        mission: {
          ...cached,
          packets: cached.packets.map((entry) => entry.id === 'a'
            ? { ...entry, archivedAt: '2026-09-07T00:00:00.000Z' } : entry),
        },
      }));
      expect(response.status).toBe(200);
    } finally {
      releaseKill();
      await stopping;
    }
    const stopped = await stopping;
    const body = await stopped.json();
    expect(stopped.status, JSON.stringify(body)).toBe(200);
    expect(body.result).toMatchObject({ ok: true, killConfirmed: true });
    expect(readOrchestratorControlPlaneState().packets[1]).toMatchObject({
      queueState: 'held', operatorStopped: true, blockedReason: 'operator_stopped',
      releaseStatePayload: { source: guardSource },
    });
    expect(h.resetPacket).toHaveBeenCalledWith(expect.objectContaining({
      packetId: 'b', scope: expect.objectContaining({ expectedReleaseSource: guardSource }),
    }));
  });

  it('lets both concurrent stops finalize despite a cached reconciliation', async () => {
    const cached = seedMission(true);
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const stop = (packetId: string) => stopRoute.POST(request({ packetId }, 'POST', '/api/orchestrator/stop-packet'));
    // Start the second stop once the first is inside kill confirmation. Two
    // same-tick dynamic imports of a vi.mock'd module share the runner's
    // importer callstack, so the second import skips the mock factory and
    // evaluates the real mission-service graph, which takes seconds under load.
    // Both stops still overlap for the cached reconciliation below.
    const stopping = [stop('a')];
    try {
      await killsStarted(1);
      stopping.push(stop('b'));
      await killsStarted(2);
      expect((await stateRoute.POST(request({ mission: cached }))).status).toBe(200);
    } finally {
      releaseKill();
      await Promise.all(stopping);
    }
    for (const response of await Promise.all(stopping)) expect(response.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets.every((entry) => entry.operatorStopped && entry.queueState === 'held')).toBe(true);
    expect(h.resetPacket).toHaveBeenCalledTimes(2);
  });

  it('cannot drop a stopped packet omitted by a stale client', async () => {
    const cached = seedMission();
    const guard = await holdPacketLifecycleMutation({ packetId: 'b', kind: 'stop' });
    const response = await stateRoute.POST(request({ mission: { ...cached, packets: [cached.packets[0]] } }));
    expect(response.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets.find((entry) => entry.id === 'b')).toMatchObject({
      operatorStopped: true, queueState: 'held', releaseStatePayload: { source: guard?.source },
    });
  });

  it('does not resurrect an older stop after an explicit server-side reset', async () => {
    seedMission();
    await holdPacketLifecycleMutation({ packetId: 'b', kind: 'stop' });
    const stoppedCache = readOrchestratorControlPlaneState();
    await withLockedState((state) => {
      state.packets[1] = { ...packet('b'), queueState: 'held', operatorStopped: false, storageAdmissionEpoch: 2 };
    });
    const response = await stateRoute.POST(request({ mission: stoppedCache }));
    expect(response.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[1]).toMatchObject({
      operatorStopped: undefined, queueState: 'held', storageAdmissionEpoch: 2, lane: null,
    });
  });

  it('does not requeue a reset packet from a pre-stop cache with no stop flag', async () => {
    const cached = seedMission();
    await withLockedState((state) => {
      state.packets[1] = { ...packet('b'), queueState: 'held', operatorStopped: false, storageAdmissionEpoch: 2 };
    });
    await stateRoute.POST(request({ mission: cached }));
    expect(readOrchestratorControlPlaneState().packets[1]).toMatchObject({
      operatorStopped: undefined, queueState: 'held', storageAdmissionEpoch: 2, lane: null,
    });
  });

  it('preserves a mission-wide stop hold while still accepting ordinary draft edits', async () => {
    const cached = seedMission();
    const lifecycleHold = {
      source: 'mission-stop-fixture', reason: 'operator_stop' as const,
      startedAt: new Date().toISOString(), ownerPid: process.pid,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await withLockedState((state) => { state.lifecycleHold = lifecycleHold; });
    await stateRoute.POST(request({
      mission: { ...cached, packets: cached.packets.map((entry) => entry.id === 'a'
        ? { ...entry, title: 'Edited draft', queueState: 'held' } : entry) },
    }));
    expect(readOrchestratorControlPlaneState()).toMatchObject({
      lifecycleHold, packets: [expect.objectContaining({ title: 'Edited draft', queueState: 'held' }), expect.anything()],
    });
  });

  it('accepts held-packet metadata only as a targeted patch and does not undo it on the next snapshot', async () => {
    seedMission();
    await holdPacketLifecycleMutation({ packetId: 'b', kind: 'stop' });
    const cached = readOrchestratorControlPlaneState();
    const archivedAt = '2026-09-07T00:00:00.000Z';
    const response = await stateRoute.PATCH(request({ packetId: 'b', updates: { archivedAt } }, 'PATCH'));
    expect(response.status).toBe(200);
    await stateRoute.POST(request({ mission: cached }));
    expect(readOrchestratorControlPlaneState().packets[1]).toMatchObject({ operatorStopped: true, archivedAt });
  });
});
