import { describe, expect, it } from 'vitest';
import { aggregateMissionCost, runtimeFromSessionKey, type LaneSessionInfo } from './cost-aggregator';
import type { OrchestratorMissionState, OrchestratorPacket } from './types';

function stubPacket(overrides: Partial<OrchestratorPacket>): OrchestratorPacket {
  return {
    id: 'packet-cost',
    referenceLabel: 'PKT-COST',
    title: 'cost receipt',
    summary: 'cost receipt',
    workspaceTargetPath: null,
    branchTarget: '',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    lane: null,
    ...overrides,
  };
}

function stubState(packet: OrchestratorPacket): OrchestratorMissionState {
  return {
    version: 2,
    prompt: 'test',
    summary: 'test',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  };
}

describe('runtimeFromSessionKey', () => {
  it('recognizes OpenCode owned and provider session keys without widening unknown prefixes', () => {
    expect(runtimeFromSessionKey('claude-code-owned:session-xyz')).toBe('claude-code');
    expect(runtimeFromSessionKey('pi-owned:session-xyz')).toBe('pi');
    expect(runtimeFromSessionKey('qwen-owned:session-xyz')).toBe('qwen');
    expect(runtimeFromSessionKey('opencode-owned:session-xyz')).toBe('opencode');
    expect(runtimeFromSessionKey('opencode:session-xyz')).toBe('opencode');
    expect(runtimeFromSessionKey('unknown:session-xyz')).toBeNull();
  });
});

describe('aggregateMissionCost', () => {
  it('prefers live lane session data over a stale packet lane binding', async () => {
    const packet = stubPacket({
      lane: {
        tileId: 'stale-tile',
        tabId: 'stale-tab',
        repoPath: null,
        runtime: 'claude-code',
        sessionKey: 'claude-code:stale',
      },
    });
    const liveLane: LaneSessionInfo = {
      sessionKey: 'opencode-owned:live-session',
      runtime: 'opencode',
    };

    const result = await aggregateMissionCost(
      stubState(packet),
      new Map([[packet.id, liveLane]]),
    );

    expect(result.packetCosts[0]).toMatchObject({
      sessionKey: 'opencode-owned:live-session',
      runtime: 'opencode',
      hasTelemetry: false,
    });
  });

  it('keeps telemetry unavailable when neither persisted nor live session data exists', async () => {
    const result = await aggregateMissionCost(stubState(stubPacket({})));

    expect(result.packetCosts[0]).toMatchObject({
      sessionKey: null,
      hasTelemetry: false,
      totalCostUsd: 0,
    });
    expect(result.totalCostUsd).toBe(0);
  });

  it('uses newer live totals while retaining persisted per-role subtotals', async () => {
    const sessionKey = 'codex:live-over-persisted';
    const packet = stubPacket({
      lane: {
        tileId: 'live-tile',
        tabId: 'live-tab',
        repoPath: null,
        runtime: 'codex',
        sessionKey,
      },
    });
    const [{ getRuntime }, { registerRuntime }, { logUsage }] = await Promise.all([
      import('@/lib/runtimes'),
      import('@/lib/runtimes/registry'),
      import('@/lib/db/usage'),
    ]);
    const originalRuntime = getRuntime('codex');
    logUsage({
      userId: null,
      model: 'persisted-model',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.1,
      sessionKey,
      packetId: packet.id,
      role: 'worker',
      attempt: 1,
    });
    logUsage({
      userId: null,
      model: 'persisted-model',
      provider: 'openai',
      inputTokens: 40,
      outputTokens: 10,
      costUsd: 0.05,
      sessionKey,
      packetId: packet.id,
      role: 'reviewer',
      attempt: 2,
    });
    registerRuntime({
      ...originalRuntime!,
      capabilities: { ...originalRuntime!.capabilities, costTelemetry: true },
      getTelemetry: async () => ({
        inputTokens: 500,
        outputTokens: 100,
        estimatedCostUsd: 1.5,
        model: 'live-model',
        costSource: 'gateway',
      }),
    });

    try {
      const result = await aggregateMissionCost(stubState(packet));

      expect(result).toMatchObject({
        totalCostUsd: 1.5,
        packetCosts: [{
          inputTokens: 500,
          outputTokens: 100,
          totalCostUsd: 1.5,
          model: 'live-model',
          costSource: 'gateway',
        }],
      });
      expect(result.costByRole.worker).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalCostUsd: 0.1,
        requestCount: 1,
      });
      expect(result.costByRole.reviewer).toEqual({
        inputTokens: 40,
        outputTokens: 10,
        totalCostUsd: 0.05,
        requestCount: 1,
      });
    } finally {
      if (originalRuntime) registerRuntime(originalRuntime);
    }
  });
});
