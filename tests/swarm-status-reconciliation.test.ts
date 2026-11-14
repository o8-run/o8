import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-swarm-status-reconciliation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const stateRoute = await import('@/app/api/orchestrator/state/route');
const { createLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { closeDb } = await import('@/lib/db');

afterAll(async () => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function packetFixture(packetId: string, laneId: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `Packet ${packetId}`,
    summary: 'Exercise terminal status reconciliation.',
    workspaceTargetPath: null,
    branchTarget: `packet/${packetId}`,
    runtime: 'qoder',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lane: {
      tileId: '',
      tabId: '',
      repoPath: dataDir,
      runtime: 'qoder',
      sessionKey: `qoder-owned:${packetId}`,
      laneId,
      lastHeartbeatAt: null,
      lastEventAt: '2026-07-29T10:00:00.000Z',
      lastEventLabel: 'session_launched',
    },
    review: null,
  };
}

function persistStaleMission(packet: OrchestratorPacket): void {
  writeOrchestratorControlPlaneState({
    version: 2,
    missionId: `mission-${packet.id}`,
    prompt: 'Exercise packet status truth.',
    summary: 'Exercise packet status truth.',
    repoPath: dataDir,
    runtime: 'codex',
    constraints: '',
    packets: [packet],
    activeComparisonGroups: [],
    updatedAt: new Date().toISOString(),
  } satisfies OrchestratorMissionState);
}

async function readMissionPacket(packetId: string): Promise<OrchestratorPacket> {
  const response = await stateRoute.GET(new NextRequest(
    'http://localhost:3001/api/orchestrator/state',
    { headers: { host: 'localhost:3001' } },
  ));
  expect(response.status).toBe(200);
  const body = await response.json() as { mission: OrchestratorMissionState };
  const packet = body.mission.packets.find((candidate) => candidate.id === packetId);
  expect(packet).toBeTruthy();
  return packet!;
}

describe('#1635 swarm status reconciliation', () => {
  it('reads a persisted terminal lane as failed despite a stale session_launched event', async () => {
    const packetId = 'pkt-terminal-stale-event';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    updateLane(lane.id, {
      status: 'failed',
      lastEventLabel: 'session_launched',
    });
    persistStaleMission(packetFixture(packetId, lane.id));

    const packet = await readMissionPacket(packetId);

    expect(packet.status).toBe('failed');
  });

  it('maps a newer runtime_process_exit event to Failed on the real state read', async () => {
    const packetId = 'pkt-runtime-process-exit';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    persistStaleMission(packetFixture(packetId, lane.id));
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      runtime: 'qoder',
      exitCode: 23,
      signal: null,
      classification: 'nonzero-exit',
      completedTurn: false,
    });

    const packet = await readMissionPacket(packetId);

    const persistedLane = getLane(lane.id);
    const exitEvidence = getLaneEvents(lane.id)
      .filter((event) => event.verb === 'runtime_process_exit')
      .map((event) => ({ timestamp: event.timestamp, payload: event.payload }));
    expect(packet.status, JSON.stringify({
      laneStatus: persistedLane?.status,
      laneEventAt: persistedLane?.lastEventAt,
      exitEvidence,
    })).toBe('failed');
    expect(packet.blockedReason).toBe('runtime_process_exit');
  });

  it.each([
    { label: 'older', offsetMs: -1, expected: 'running' },
    { label: 'equal', offsetMs: 0, expected: 'failed' },
    { label: 'newer', offsetMs: 1, expected: 'failed' },
  ] as const)('reconciles $label exit timestamps after a prior read and database reopen', async ({
    label, offsetMs, expected,
  }) => {
    const launchAt = Date.parse('2026-10-14T10:00:00.000Z');
    const packetId = `pkt-runtime-exit-${label}`;
    // Control only synchronous writes, leaving route timers and lock deadlines real.
    const atTime = <T,>(timestamp: number, write: () => T): T => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(timestamp);
        return write();
      } finally {
        vi.useRealTimers();
      }
    };
    const lane = atTime(launchAt, () => {
      const created = createLane({
        repoPath: dataDir,
        branch: `packet/${packetId}`,
        runtime: 'qoder',
        packetId,
        sessionKey: `qoder-owned:${packetId}`,
      });
      setLaneStatus(created.id, 'running', 'system', 'session_launched');
      persistStaleMission(packetFixture(packetId, created.id));
      return created;
    });
    expect((await readMissionPacket(packetId)).status).toBe('running');

    // An older exit is intentionally stale; this does not establish the flake's cause.
    const exit = atTime(launchAt + offsetMs, () => recordLaneEvent(
      lane.id, 'runtime_process_exit', 'system', {
        runtime: 'qoder',
        exitCode: 23,
        signal: null,
        classification: 'nonzero-exit',
        completedTurn: false,
      },
    ));
    expect(getLane(lane.id)?.lastEventAt).toBe(new Date(launchAt).toISOString());
    expect(getLaneEvents(lane.id).find((event) => event.id === exit.id)?.timestamp)
      .toBe(new Date(launchAt + offsetMs).toISOString());

    const assertOutcome = async () => {
      const packet = await readMissionPacket(packetId);
      expect(packet.status).toBe(expected);
      expect(packet.blockedReason).toBe(expected === 'failed' ? 'runtime_process_exit' : null);
    };
    await assertOutcome();
    closeDb();
    await assertOutcome();
  });

  it('repairs a stale process-exit failure when the owned runtime completed cleanly', async () => {
    const packetId = 'pkt-runtime-clean-exit';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');
    persistStaleMission({
      ...packetFixture(packetId, lane.id),
      status: 'failed',
      blockedReason: 'runtime_process_exit',
    });
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      runtime: 'qoder',
      exitCode: 0,
      signal: null,
      classification: 'clean-exit',
      completedTurn: true,
    });

    const packet = await readMissionPacket(packetId);

    expect(packet.status).toBe('awaiting_review');
    expect(packet.blockedReason).toBeNull();
  });
});
