import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-cost-real-path-'));
const ownedRoot = join(dataDir, 'owned-opencode');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;

const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { attachSession, createLane, findLaneByPacket, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { persistSessionCost } = await import('@/lib/orchestrator/cost-persistence');
const { aggregateMissionCost } = await import('@/lib/orchestrator/cost-aggregator');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission cost persisted-state path', () => {
  it('does not charge cumulative telemetry to either mission when a session crosses missions', async () => {
    const sessionKey = 'opencode-owned:cross-mission-cost';
    await persistSessionCost({
      sessionKey,
      runtime: 'opencode',
      model: 'opencode/test-model',
      inputTokens: 1_200,
      outputTokens: 150,
      costUsd: 0.03,
      repoPath: dataDir,
    });
    const firstPacketId = 'packet-cross-mission-cost-first';
    createLane({
      repoPath: dataDir,
      branch: 'inline/cross-mission-cost-first',
      runtime: 'opencode',
      packetId: firstPacketId,
      sessionKey,
    });
    createLane({
      repoPath: dataDir,
      branch: 'inline/cross-mission-cost-second',
      runtime: 'opencode',
      packetId: 'packet-cross-mission-cost-second',
      sessionKey,
    });
    const packet: OrchestratorPacket = {
      id: firstPacketId,
      referenceLabel: 'PKT-CROSS-MISSION-COST',
      title: 'cross mission cost',
      summary: 'cross mission cost',
      workspaceTargetPath: dataDir,
      branchTarget: 'inline/cross-mission-cost-first',
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-cross-mission-cost-first',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    const status = await getMissionStatus({ includeCost: true });

    if (!('cost' in status) || !status.cost) throw new Error('Expected cost receipt.');
    expect(status.cost.totalCostUsd).toBe(0);
    expect(status.cost.packetCosts[0]).toMatchObject({
      packetId: firstPacketId,
      hasTelemetry: false,
      totalCostUsd: 0,
    });
    expect(status.cost.unattributed).toEqual({
      sessionCount: 1,
      unknownSessionCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    });
  });

  it('rolls archived retry sessions into one packet receipt without reviving or double-counting them', async () => {
    const packetId = 'packet-terminal-cost';
    const sessionKey = 'opencode-owned:terminal-cost';
    const retrySessionKey = 'opencode-owned:terminal-cost-retry';
    const sessionDir = join(ownedRoot, 'terminal-cost');
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'run.stdout.jsonl');
    const stderrPath = join(runsDir, 'run.stderr.log');
    const now = new Date().toISOString();
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, `${JSON.stringify({
      type: 'step_finish',
      part: {
        cost: 0.0035,
        tokens: { input: 350, output: 60, cache: { read: 80, write: 10 } },
      },
    })}\n`);
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'terminal cost worker',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'test',
      latestSummary: 'done',
      model: 'opencode/deepseek-v4-flash-free',
      recentRuns: [{
        id: 'run-terminal-cost',
        mode: 'launch',
        prompt: 'test',
        startedAt: now,
        finishedAt: now,
        pid: 1,
        stdoutPath,
        stderrPath,
        outcome: 'finished',
      }],
    }, null, 2)}\n`);

    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/terminal-cost',
      runtime: 'opencode',
      packetId,
      sessionKey,
    });
    await persistSessionCost({
      sessionKey,
      runtime: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
      inputTokens: 350,
      outputTokens: 60,
      costUsd: 0.0035,
      costSource: 'gateway',
      repoPath: dataDir,
    });
    rmSync(sessionDir, { recursive: true, force: true });

    setLaneStatus(lane.id, 'completed', 'system', 'completed');
    const retryLane = createLane({
      repoPath: dataDir,
      branch: 'inline/terminal-cost-retry',
      runtime: 'opencode',
      packetId,
      sessionKey: retrySessionKey,
    });
    const retrySessionDir = join(ownedRoot, 'terminal-cost-retry');
    const retryRunsDir = join(retrySessionDir, 'runs');
    mkdirSync(retryRunsDir, { recursive: true });
    const retryStdoutPath = join(retryRunsDir, 'run.stdout.jsonl');
    const retryStderrPath = join(retryRunsDir, 'run.stderr.log');
    writeFileSync(retryStdoutPath, `${JSON.stringify({
      type: 'step_finish',
      part: { cost: 0.001, tokens: { input: 100, output: 20 } },
    })}\n`);
    writeFileSync(retryStderrPath, '');
    writeFileSync(join(retrySessionDir, 'session.json'), `${JSON.stringify({
      surfaceId: retrySessionKey,
      sessionDir: retrySessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'terminal cost retry',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'retry',
      latestSummary: 'done',
      model: 'opencode/deepseek-v4-flash-free',
      recentRuns: [{
        id: 'run-terminal-cost-retry',
        mode: 'launch',
        prompt: 'retry',
        startedAt: now,
        finishedAt: now,
        pid: 2,
        stdoutPath: retryStdoutPath,
        stderrPath: retryStderrPath,
        outcome: 'finished',
      }],
    }, null, 2)}\n`);
    setLaneStatus(retryLane.id, 'completed', 'system', 'completed');
    expect(findLaneByPacket(packetId)).toBeNull();

    // Mission status intentionally includes bound terminal lanes for diagnostics.
    // Leave only open_lane history linking these archived attempts to the packet
    // so the receipt still proves cost survives without restoring live bindings.
    const archivedLanes = [lane, retryLane].map(({ id }) => updateLane(id, { packetId: null }));

    const packet = {
      id: packetId,
      referenceLabel: 'PKT-COST',
      title: 'terminal cost receipt',
      summary: 'terminal cost receipt',
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      status: 'released',
      lane: null,
    } satisfies OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-terminal-cost',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    const status = await getMissionStatus({ includeCost: true });

    expect(status.agents).toEqual([]);
    expect(status.packets).toHaveLength(1);
    expect(status.packets[0]?.lane).toBeNull();
    expect([getLane(lane.id), getLane(retryLane.id)]).toEqual(archivedLanes);
    expect('historical' in status).toBe(false);
    expect('cost' in status).toBe(true);
    if (!('cost' in status) || !status.cost) {
      throw new Error('Current mission status did not include the requested cost receipt.');
    }
    expect(Object.keys(status.cost)).toEqual(['totalCostUsd', 'packetCosts', 'tokensByRuntime', 'costByRole', 'reviews', 'unattributed']);
    expect(status.cost.totalCostUsd).toBe(0.0045);
    expect(status.cost.packetCosts).toEqual([{
      packetId,
      sessionKey: expect.any(String),
      runtime: 'opencode',
      identityId: null,
      model: 'opencode/deepseek-v4-flash-free',
      inputTokens: 450,
      outputTokens: 80,
      totalCostUsd: 0.0045,
      hasTelemetry: true,
      costSource: 'gateway',
    }]);
    expect(status.cost.tokensByRuntime.opencode).toEqual({
      inputTokens: 450,
      outputTokens: 80,
      totalCostUsd: 0.0045,
      packetCount: 1,
    });
    expect(status.cost.unattributed).toEqual({
      sessionCount: 0,
      unknownSessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    });
  });

  it('keeps reused-session usage at mission level instead of assigning it to the first packet', async () => {
    const sharedSessionKey = 'opencode-owned:shared-cost-session';
    await persistSessionCost({
      sessionKey: sharedSessionKey,
      runtime: 'opencode',
      model: 'opencode/test-model',
      inputTokens: 900,
      outputTokens: 100,
      costUsd: 0.02,
      repoPath: dataDir,
    });
    const packet = (id: string): OrchestratorPacket => ({
      id,
      referenceLabel: id.toUpperCase(),
      title: id,
      summary: id,
      workspaceTargetPath: dataDir,
      branchTarget: `inline/${id}`,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      status: 'released',
      lane: null,
    });
    const state = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-shared-session-cost',
      repoPath: dataDir,
      runtime: 'opencode' as const,
      packets: [packet('packet-a'), packet('packet-b')],
    };
    const history = new Map([
      ['packet-a', [{ sessionKey: sharedSessionKey, runtime: 'opencode' as const }]],
      ['packet-b', [{ sessionKey: sharedSessionKey, runtime: 'opencode' as const }]],
    ]);

    const cost = await aggregateMissionCost(state, history);

    expect(cost.totalCostUsd).toBe(0.02);
    expect(cost.packetCosts).toEqual([
      expect.objectContaining({ packetId: 'packet-a', hasTelemetry: false, totalCostUsd: 0 }),
      expect.objectContaining({ packetId: 'packet-b', hasTelemetry: false, totalCostUsd: 0 }),
    ]);
    expect(cost.unattributed).toEqual({
      sessionCount: 1,
      unknownSessionCount: 0,
      inputTokens: 900,
      outputTokens: 100,
      totalCostUsd: 0.02,
    });
    expect(cost.tokensByRuntime.opencode).toEqual({
      inputTokens: 900,
      outputTokens: 100,
      totalCostUsd: 0.02,
      packetCount: 0,
    });
  });

  it('counts a shared session once when two persisted lanes belong to the same mission', async () => {
    const sessionKey = 'opencode-owned:same-mission-shared-cost';
    await persistSessionCost({
      sessionKey,
      runtime: 'opencode',
      model: 'opencode/test-model',
      inputTokens: 500,
      outputTokens: 50,
      costUsd: 0.01,
      repoPath: dataDir,
    });
    const packet = (id: string): OrchestratorPacket => ({
      id,
      referenceLabel: id,
      title: id,
      summary: id,
      workspaceTargetPath: dataDir,
      branchTarget: `inline/${id}`,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    });
    const firstPacket = packet('packet-same-mission-shared-first');
    const secondPacket = packet('packet-same-mission-shared-second');
    createLane({ repoPath: dataDir, branch: firstPacket.branchTarget, runtime: 'opencode', packetId: firstPacket.id, sessionKey });
    createLane({ repoPath: dataDir, branch: secondPacket.branchTarget, runtime: 'opencode', packetId: secondPacket.id, sessionKey });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-same-mission-shared-cost',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [firstPacket, secondPacket],
    });

    const status = await getMissionStatus({ includeCost: true });

    if (!('cost' in status) || !status.cost) throw new Error('Expected cost receipt.');
    expect(status.cost.totalCostUsd).toBe(0.01);
    expect(status.cost.unattributed).toEqual({
      sessionCount: 1,
      unknownSessionCount: 0,
      inputTokens: 500,
      outputTokens: 50,
      totalCostUsd: 0.01,
    });
  });

  it('keeps every session attached to one lane in the persisted packet receipt', async () => {
    const packetId = 'packet-rebound-session-cost';
    const firstSession = 'opencode-owned:rebound-cost-first';
    const secondSession = 'opencode-owned:rebound-cost-second';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/rebound-session-cost',
      runtime: 'opencode',
      packetId,
      sessionKey: firstSession,
    });
    await persistSessionCost({
      sessionKey: firstSession,
      runtime: 'opencode',
      model: 'opencode/test-model',
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.003,
      repoPath: dataDir,
    });
    attachSession(lane.id, secondSession, 'system');
    await persistSessionCost({
      sessionKey: secondSession,
      runtime: 'opencode',
      model: 'opencode/test-model',
      inputTokens: 700,
      outputTokens: 70,
      costUsd: 0.007,
      repoPath: dataDir,
    });
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: 'PKT-REBOUND-COST',
      title: 'rebound cost receipt',
      summary: 'rebound cost receipt',
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-rebound-session-cost',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    const status = await getMissionStatus({ includeCost: true });

    if (!('cost' in status) || !status.cost) throw new Error('Expected cost receipt.');
    expect(status.cost.totalCostUsd).toBe(0.01);
    expect(status.cost.packetCosts[0]).toMatchObject({
      packetId,
      inputTokens: 1_000,
      outputTokens: 100,
      totalCostUsd: 0.01,
    });
  });
});
