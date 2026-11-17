import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import * as registry from '@/lib/lane/registry';
import {
  buildDomainLaneSummaries,
  readOrchestratorControlPlaneState,
  reconcileOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import {
  createEmptyOrchestratorMissionState,
  reconcileOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { LaneStatus } from '@/lib/lane/types';

const { inventory } = vi.hoisted(() => ({
  inventory: vi.fn(async () => ({ agents: [] })),
}));

vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: inventory }));

const repoPath = join(getDataDir(), 'scope-fixture-repo');
let sequence = 0;

function fixture(status: LaneStatus = 'running', packetId?: string) {
  const id = packetId ?? `scope-packet-${++sequence}`;
  const lane = registry.createLane({
    repoPath, runtime: 'codex', packetId: id, branch: `test/${id}`,
    baseCommit: 'a'.repeat(40), sessionKey: `codex-owned:${id}-${sequence}`,
  });
  getSqlite().prepare('UPDATE lanes SET status = ? WHERE id = ?').run(status, lane.id);
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: 'scoped reconciliation fixture',
    workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'queued', blockedReason: null, lane: null,
  };
  return { packet, lane };
}

function persist(packets: OrchestratorPacket[]) {
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), packets,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  inventory.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mission-scoped persisted lane reconciliation', () => {
  it('reads only this mission history while preserving the full-fleet result', () => {
    const first = fixture();
    const second = fixture();
    for (let index = 0; index < 20; index += 1) fixture('reviewing');
    registry.appendEvent(first.lane.id, 'runtime_process_exit', 'system', {
      surfaceId: first.lane.sessionKey, runtimeOutcome: 'failed', exitCode: 0,
      classification: 'clean-exit', completedTurn: false,
    });
    const current = persist([first.packet, second.packet]);
    const all = buildDomainLaneSummaries();
    const expected = reconcileOrchestratorMissionState(current, {
      laneSnapshots: [], runtimeTruth: [], domainLanes: all,
    });
    const events = vi.spyOn(registry, 'getRecentLaneEvents');
    const lanes = vi.spyOn(registry, 'listLanes');

    // Read the mission back through the same default entry point used by
    // headless reconciliation, not a helper supplied with a prefiltered list.
    const actual = reconcileOrchestratorControlPlaneState();

    expect(actual).toEqual(expected);
    expect(lanes).toHaveBeenCalledExactlyOnceWith(new Set([first.packet.id, second.packet.id]));
    expect(events).toHaveBeenCalledExactlyOnceWith([first.lane.id, second.lane.id], 100);
    expect(buildDomainLaneSummaries(new Set([first.packet.id]))[0]?.status).toBe('failed');
  });

  it('persists the scoped result without discovering unrelated review workers', async () => {
    const current = fixture();
    fixture('reviewing');
    persist([current.packet]);
    const events = vi.spyOn(registry, 'getRecentLaneEvents');

    const result = await syncOrchestratorControlPlaneState();

    expect(events).toHaveBeenCalledExactlyOnceWith([current.lane.id], 100);
    expect(inventory).not.toHaveBeenCalled();
    expect(readOrchestratorControlPlaneState()).toEqual(result);
  });

  it('still refreshes runtime truth for a reviewing worker in this mission', async () => {
    const current = fixture('reviewing');
    persist([current.packet]);

    await syncOrchestratorControlPlaneState();

    expect(inventory).toHaveBeenCalledExactlyOnceWith({ fresh: true });
  });

  it('scopes a locked mutation to the post-callback packets', async () => {
    const before = fixture('reviewing');
    const after = fixture();
    persist([before.packet]);
    const events = vi.spyOn(registry, 'getRecentLaneEvents');

    const result = await withLockedState((current) => {
      current.packets = [after.packet];
    });

    expect(events).toHaveBeenCalledExactlyOnceWith([after.lane.id], 100);
    expect(inventory).not.toHaveBeenCalled();
    expect(result.state.packets.map((packet) => packet.id)).toEqual([after.packet.id]);
    expect(readOrchestratorControlPlaneState()).toEqual(result.state);
  });

  it('does no lane scan for an empty persisted mission', async () => {
    fixture('reviewing');
    persist([]);
    const lanes = vi.spyOn(registry, 'listLanes');
    const events = vi.spyOn(registry, 'getRecentLaneEvents');

    expect(reconcileOrchestratorControlPlaneState().packets).toEqual([]);
    await syncOrchestratorControlPlaneState();
    await withLockedState(() => undefined);

    expect(lanes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  });

  it('keeps all matching lane attempts in their existing order', () => {
    const first = fixture();
    const second = fixture('reviewing', first.packet.id);
    const all = buildDomainLaneSummaries();

    expect(buildDomainLaneSummaries(new Set([first.packet.id])))
      .toEqual(all.filter((entry) => entry.packetId === first.packet.id));
    expect(all.some((entry) => entry.laneId === first.lane.id)).toBe(true);
    expect(all.some((entry) => entry.laneId === second.lane.id)).toBe(true);
  });

  it('honors an explicitly supplied lane snapshot without another database read', () => {
    const current = fixture();
    const state = persist([current.packet]);
    const summary = buildDomainLaneSummaries(new Set([current.packet.id]));
    const events = vi.spyOn(registry, 'getRecentLaneEvents');

    const actual = reconcileOrchestratorControlPlaneState(state, [], summary);
    const expected = reconcileOrchestratorMissionState(state, {
      laneSnapshots: [], runtimeTruth: [], domainLanes: summary,
    });

    expect(actual).toEqual(expected);
    expect(events).not.toHaveBeenCalled();
  });
});
