import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { createLane } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { runHeadlessSprintTick } from '@/lib/orchestrator/headless-loop';
import { readMissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const { prune } = vi.hoisted(() => ({ prune: vi.fn(async () => []) }));
vi.mock('@/lib/lane/worktree-cleanup', () => ({ pruneRepoWorktrees: prune }));

const repoPath = join(getDataDir(), 'maintenance-fixture');
const registryIds: string[] = [];
const laneIds: string[] = [];
let sequence = 0;
let clock = Date.UTC(2026, 0, 1, 12);

function mission(): OrchestratorMissionState & { missionId: string } {
  const id = `idle-maintenance-${++sequence}`;
  const packet: OrchestratorPacket = {
    id: `${id}-packet`, referenceLabel: 'P1', title: 'pending maintenance fixture',
    summary: 'unlaunchable without a pinned runtime', workspaceTargetPath: repoPath,
    branchTarget: `test/${id}`, runtime: 'codex', dispatchRuntimePin: null,
    predictedFiles: [], dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'queued',
    blockedReason: null, lane: null,
  };
  return { ...createEmptyOrchestratorMissionState(), missionId: id, repoPath, packets: [packet] };
}

function register(state: OrchestratorMissionState & { missionId: string }) {
  getSqlite().prepare(`
    INSERT INTO missions (id, repo_path, runtime, created_at, updated_at, mission_state_json)
    VALUES (?, ?, 'codex', ?, ?, ?)
  `).run(state.missionId, repoPath, Date.now(), Date.now(), JSON.stringify(state));
  registryIds.push(state.missionId);
}

function bindRunning(state: OrchestratorMissionState) {
  const packet = state.packets[0];
  const lane = createLane({
    repoPath, branch: packet.branchTarget, runtime: 'codex', packetId: packet.id,
    baseCommit: 'b'.repeat(40), sessionKey: `codex-owned:${packet.id}`,
  });
  laneIds.push(lane.id);
  getSqlite().prepare("UPDATE lanes SET status = 'running' WHERE id = ?").run(lane.id);
}

function holdForStorage(state: OrchestratorMissionState) {
  const packet = state.packets[0];
  packet.storageAdmission = {
    schema: 'o8/packet-storage-admission/v1', state: 'held', reason: 'insufficient-space',
    reservationId: 'maintenance-reservation', mutationId: packet.id, ownerId: packet.id,
    ownerGeneration: 1, estimateBytes: 2_000, estimateSource: 'source-size-fallback',
    historySamples: 0, volumeId: 'device:test', physicalAvailableBytes: 1_000,
    reservedBeforeBytes: 0, requiredReserveBytes: 1_000, dispatchHeadroomBytes: 0,
    recordedAt: Date.now(),
  };
}

beforeEach(() => {
  clock += 20 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(clock));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  prune.mockClear();
});

afterEach(() => {
  for (const id of registryIds.splice(0)) {
    getSqlite().prepare('UPDATE missions SET archived_at = ? WHERE id = ?').run(Date.now(), id);
  }
  for (const id of laneIds.splice(0)) {
    getSqlite().prepare("UPDATE lanes SET status = 'archived' WHERE id = ?").run(id);
  }
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('headless idle worktree maintenance', () => {
  it('keeps unlaunchable current and registry packets without periodic worktree sweeps', async () => {
    const current = mission();
    const saved = mission();
    register(saved);
    writeOrchestratorControlPlaneState(current);

    await runHeadlessSprintTick();
    clock += 20 * 60_000;
    vi.setSystemTime(new Date(clock));
    await runHeadlessSprintTick();

    expect(prune).not.toHaveBeenCalled();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: current.packets[0].id, status: 'queued', dispatchRuntimePin: null,
    });
    expect(readMissionRegistryEntry(saved.missionId)?.mission.packets[0]).toMatchObject({
      id: saved.packets[0].id, status: 'queued', dispatchRuntimePin: null,
    });
  });

  it.each(['current', 'registry'] as const)('retains maintenance for a running %s mission', async (location) => {
    const current = mission();
    const running = location === 'current' ? current : mission();
    bindRunning(running);
    if (location === 'registry') register(running);
    writeOrchestratorControlPlaneState(current);

    await runHeadlessSprintTick();

    expect(prune).toHaveBeenCalledExactlyOnceWith(repoPath);
  });

  it.each(['current', 'registry'] as const)('runs no worktree sweep for a storage-held %s packet whose runtime is not pinned', async (location) => {
    // The recovery guard skips it every tick, so freeing space cannot launch it.
    const current = mission();
    const held = location === 'current' ? current : mission();
    holdForStorage(held);
    if (location === 'registry') register(held);
    writeOrchestratorControlPlaneState(current);

    await runHeadlessSprintTick();
    clock += 20 * 60_000;
    vi.setSystemTime(new Date(clock));
    await runHeadlessSprintTick();

    expect(prune).not.toHaveBeenCalled();
  });

  it.each(['current', 'registry'] as const)('retains cleanup retries for a storage-held %s packet', async (location) => {
    const current = mission();
    const held = location === 'current' ? current : mission();
    holdForStorage(held);
    held.packets[0].dispatchRuntimePin = 'codex';
    if (location === 'registry') register(held);
    writeOrchestratorControlPlaneState(current);

    await runHeadlessSprintTick();

    expect(prune).toHaveBeenCalledExactlyOnceWith(repoPath);
  });

  it('cannot create release evidence from a raw packet ID', async () => {
    const current = mission();
    writeOrchestratorControlPlaneState(current);

    // An old in-process caller can still supply extra JavaScript arguments.
    await Reflect.apply(runHeadlessSprintTick, null, [{ releasePacketIds: [current.packets[0].id] }]);

    expect(prune).not.toHaveBeenCalled();
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseState).toBe('pending');
  });
});
