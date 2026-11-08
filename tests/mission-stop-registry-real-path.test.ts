import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  beforeKill: null as (() => Promise<void>) | null,
  kills: [] as string[],
}));

// Keep route, mission stop, lane command, locks and both stores real. Only the
// external runtime death confirmation is supplied by this bounded fixture.
vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/reap-sessions')>(),
  killLaneSessionsConfirmed: vi.fn(async (lanes: Lane[]) => {
    const beforeKill = h.beforeKill;
    h.beforeKill = null;
    if (beforeKill) await beforeKill();
    return lanes.map((lane) => {
      h.kills.push(lane.packetId!);
      return {
        laneId: lane.id, sessionKey: lane.sessionKey!, runtime: lane.runtime,
        confirmed: true, alreadyDead: false, stages: [], note: 'Fixture worker stopped.',
      };
    });
  }),
  archiveLaneSessions: vi.fn(async () => ({ targeted: 0, archived: 0, outcomes: [], failures: [] })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-stop-registry-'));
const operatorToken = 'operator-stop-registry-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repoPath = join(dataDir, 'repo');
execFileSync('git', ['init', repoPath]);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);

const stopRoute = await import('@/app/api/orchestrator/stop-mission/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, getLane, updateLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { persistMissionRegistryState, readMissionRegistryEntry, withMissionRegistryState, missionHasPendingHeadlessWork } = await import('@/lib/orchestrator/mission-registry');
const { runDispatchTick } = await import('@/lib/orchestrator/dispatch');

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3001/api/orchestrator/${path}`, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createComparison(missionId: string) {
  h.kills = [];
  const packets = [0, 1].map((index) => {
    const packetId = `${missionId}-cmp-${index}`;
    const lane = createLane({ repoPath, branch: `fixture-${packetId}`, runtime: 'codex', packetId });
    const sessionKey = `codex-owned:fixture-${packetId}`;
    updateLane(lane.id, { sessionKey });
    setLaneStatus(lane.id, 'running', 'system', 'fixture_running');
    return {
      id: packetId, referenceLabel: `inline-${index}`, title: 'Comparison worker', summary: 'Stop comparison',
      workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
      status: 'running', comparisonGroupId: 'fixture-comparison', comparisonIndex: index,
      lane: { tileId: lane.id, tabId: lane.id, repoPath, worktreePath: null, runtime: 'codex',
        sessionKey, laneId: lane.id, lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null },
    } as OrchestratorPacket;
  });
  const state = normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), missionId, repoPath, packets });
  recordMission({ id: missionId, repoPath, runtime: 'codex', prompt: '', summary: '', constraints: '',
    packetMeta: packets.map((packet) => ({ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel })),
    missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  return packets;
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission stop registry durability through the public route', () => {
  it('acknowledges both holds durably after an overlapping partial lifecycle mirror', async () => {
    const missionId = 'mission-stop-comparison';
    const packets = createComparison(missionId);
    h.beforeKill = async () => {
      // A lifecycle tick mirrors the first hold while the second worker still
      // runs. It also adds newer registry metadata which finalization must keep.
      await persistMissionRegistryState(readOrchestratorControlPlaneState());
      await withMissionRegistryState(missionId, (state) => ({
        state: { ...state, constraints: 'newer-registry-metadata' }, result: undefined,
      }));
      expect(readMissionRegistryEntry(missionId)!.mission.packets.map((packet) => packet.operatorStopped))
        .toEqual([true, undefined]);
    };
    const response = await stopRoute.POST(request('stop-mission', { missionId, idempotencyKey: 'stop-comparison' }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.packets.map((packet: { status: string }) => packet.status))
      .toEqual(['stopped', 'stopped']);
    expect(h.kills).toEqual(packets.map((packet) => packet.id));
    closeDb();
    const durable = readMissionRegistryEntry(missionId, { includeArchived: true })!.mission;
    expect(durable.constraints).toBe('newer-registry-metadata');
    expect(durable.lifecycleHold).toBeNull();
    for (const packet of durable.packets) {
      expect(packet).toMatchObject({ operatorStopped: true, queueState: 'held', status: 'blocked', blockedReason: 'operator_stopped' });
    }
    expect(missionHasPendingHeadlessWork(durable)).toBe(false);
    const dispatched = await runDispatchTick(durable);
    expect(dispatched.packets.map((packet) => packet.launchAttempts)).toEqual([0, 0]);
    expect(dispatched.packets.every((packet) => packet.operatorStopped)).toBe(true);
  });

  it('stops the live worker of a packet archived mid-turn and leaves it archived', async () => {
    const missionId = 'mission-stop-archived-live';
    const packets = createComparison(missionId);
    // Archiving refuses further runs but does not end the current turn, so the
    // first worker is still running when the operator presses Stop all.
    const archivedAt = new Date().toISOString();
    const state = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({ ...state,
      packets: state.packets.map((packet) => packet.id === packets[0]!.id ? { ...packet, archivedAt } : packet) });
    const response = await stopRoute.POST(request('stop-mission', { missionId, idempotencyKey: 'stop-archived-live' }));
    expect(response.status).toBe(200);
    expect(h.kills).toEqual(packets.map((packet) => packet.id));
    const results = (await response.json()).result.packets as Array<{ packetId: string; status: string }>;
    expect(results.map((result) => result.status)).toEqual(['already-terminal', 'stopped']);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ archivedAt });
    expect(readOrchestratorControlPlaneState().packets[0]?.operatorStopped).not.toBe(true);
    expect(getLane(packets[0]!.lane!.laneId!)).toMatchObject({ status: 'paused' });
  });

  it('resetting one stopped comparison member leaves its sibling held', async () => {
    const missionId = 'mission-stop-reset-one';
    const packets = createComparison(missionId);
    expect((await stopRoute.POST(request('stop-mission', { missionId, idempotencyKey: 'stop-reset-one' }))).status).toBe(200);
    // Move to another current mission so reset exercises the durable owner,
    // rather than inheriting the control-plane file's already-correct hold.
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    const response = await resetRoute.POST(request('reset-packet', {
      packetId: packets[0].id, idempotencyKey: 'reset-one', clearWorktree: false,
    }));
    expect(response.status).toBe(200);
    closeDb();
    const durable = readMissionRegistryEntry(missionId, { includeArchived: true })!.mission;
    expect(durable.packets[0]).toMatchObject({ status: 'draft', queueState: 'held', lane: null });
    expect(durable.packets[0].operatorStopped).not.toBe(true);
    expect(durable.packets[1]).toMatchObject({ operatorStopped: true, status: 'blocked', queueState: 'held' });
    expect(missionHasPendingHeadlessWork(durable)).toBe(false);
  });

  it('does not acknowledge success if the finalized registry write fails', async () => {
    const missionId = 'mission-stop-write-failure';
    createComparison(missionId);
    h.beforeKill = async () => {
      getSqlite().exec(`CREATE TRIGGER reject_stop_registry BEFORE UPDATE ON missions
        WHEN OLD.id = 'mission-stop-write-failure'
        BEGIN SELECT RAISE(ABORT, 'fixture registry unavailable'); END`);
    };
    try {
      const response = await stopRoute.POST(request('stop-mission', { missionId, idempotencyKey: 'stop-write-failure' }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'stop_mission_failed' } });
      expect(readOrchestratorControlPlaneState().packets.every((packet) => packet.operatorStopped)).toBe(true);
    } finally {
      getSqlite().exec('DROP TRIGGER IF EXISTS reject_stop_registry');
    }
  });
});
