/**
 * Packet fields must survive the normalize round-trip (2026-06-22).
 *
 * normalizePacket() rebuilds every packet from scratch and is the single
 * chokepoint EVERY orchestrator-state read and write funnels through. Any field
 * it forgets to copy is silently dropped on the next round-trip. The fixture
 * below intentionally satisfies Required<OrchestratorPacket> so adding a new
 * packet field forces this test to pin its normalize behavior. The persistence
 * assertion separately proves read-time projections do not enter durable state.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { normalizeOrchestratorMissionStateForPersistence } from '@/lib/orchestrator/persisted-mission';
import { normalizePacketExecutionCarrier } from '@/lib/orchestrator/normalize/decomposition';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function fullPacketFixture() {
  vi.setSystemTime(NOW);

  const packet = {
    id: 'pkt-control-1',
    referenceLabel: 'P1',
    projectId: 'project-captured',
    title: 'Control-field packet',
    summary: 'Full normalize fixture',
    origin: 'design-mode',
    workspaceTargetPath: '/repo/o8',
    branchTarget: 'inline/full-normalize',
    runtime: 'codex',
    model: null,
    dependencyLabels: ['P0'],
    dependencyPacketIds: ['pkt-control-0'],
    queueState: 'queued',
    holdIntent: 'operator',
    manualLaunchClaim: null,
    releaseState: 'pending',
    releaseStatePayload: {
      mergeCommit: 'abc123',
      releasedAt: '2026-01-01T00:01:00.000Z',
      source: 'test',
    },
    status: 'awaiting_review',
    attemptCount: 2,
    maxAttempts: 4,
    recoveryCount: 1,
    lastRecoveryAt: '2026-01-01T00:02:00.000Z',
    typecheckAutoRetries: 1,
    leaseWaitAutoRetries: 1,
    uiLoopIterations: 3,
    uiLoopStartedAt: '2026-01-01T00:00:00.000Z',
    stallRetries: 2,
    zeroDiffRuntimeRetries: 1,
    launchAttempts: 3,
    preflightRefusals: 2,
    operatorStopped: true,
    spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 500_000 },
    spendTelemetry: {
      costUsd: 0.09,
      inputTokens: 653_000,
      outputTokens: 100,
      costSource: 'gateway',
      capHit: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    contextTelemetry: {
      inputTokens: 203,
      cacheReadTokens: 40_448,
      contextTokens: 40_651,
      contextDeltaTokens: 1_024,
      sourceEventId: 'event-context-1',
      observedAt: '2026-01-01T00:00:30.000Z',
    },
    blockedReason: 'operator_stopped',
    completionSummary: 'Recovered completion summary',
    statusEvidence: {
      sessionId: 'codex-owned:pkt-control-1',
      runtime: 'codex',
      state: 'blocked',
      authority: 'lane-state',
      observedAt: '2026-01-01T00:02:30.000Z',
      summary: 'Lane control-field packet is blocked: operator_stopped.',
      evidence: [{ source: 'lane:lane-1.status', value: 'awaiting_orchestrator' }],
      fallbackReason: 'No live runtime event was available.',
    },
    storageAdmission: {
      schema: 'o8/packet-storage-admission/v1',
      state: 'held',
      reason: 'reserve_breached',
      reservationId: 'packet-storage:pkt-control-1:3',
      mutationId: 'packet-storage-reserve:pkt-control-1:3',
      ownerId: 'pkt-control-1',
      ownerGeneration: 3,
      estimateBytes: 2_147_483_648,
      estimateSource: 'same-repo-history',
      historySamples: 2,
      volumeId: 'device:1',
      physicalAvailableBytes: 12_000_000_000,
      reservedBeforeBytes: 4_000_000_000,
      requiredReserveBytes: 10_000_000_000,
      dispatchHeadroomBytes: -2_000_000_000,
      pressure: null,
      recordedAt: NOW.getTime(),
    },
    storageAdmissionEpoch: 7,
    lastEventAt: '2026-01-01T00:03:00.000Z',
    lastEventLabel: 'review_requested',
    archivedAt: '2026-01-01T00:04:00.000Z',
    review: {
      approved: true,
      findings: [{
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Pinned finding',
        resolution: 'fixed',
        fixSuggestion: 'Keep covered',
      }],
      recordedAt: '2026-01-01T00:05:00.000Z',
      reviewedHeadSha: 'def456',
      summary: 'Looks good',
      auditApprovalId: 'approval-1',
    },
    lane: {
      tileId: 'tile-1',
      tabId: 'tab-1',
      repoPath: '/repo/o8',
      worktreePath: '/repo/o8/.worktrees/pkt-control-1',
      runtime: 'codex',
      sessionKey: 'codex-owned:pkt-control-1',
      laneId: 'lane-1',
      lastHeartbeatAt: '2026-01-01T00:06:00.000Z',
      lastEventAt: '2026-01-01T00:07:00.000Z',
      lastEventLabel: 'review_ready',
      mergeMode: 'pr_only',
      mergeModeNote: 'test note',
      dependencyMaterializationMode: 'image',
    },
    packetType: 'decompose',
    decomposition: {
      targetFile: 'src/large.ts',
      postMergeSha: '789abc',
      lineCount: 801,
    },
    comparisonModels: ['gpt-5.5', 'claude-sonnet'],
    comparisonGroupId: 'cmp-1',
    comparisonIndex: 1,
    assignedModel: 'gpt-5.5',
    claudeCodeModel: 'gateway/model-y',
    claudeCodeCarrier: 'openrouter',
    executionCarrier: null,
    qualitySearch: {
      version: 1,
      role: 'robustness_complete',
      repairAttempts: 0,
      receipt: null,
    },
    tierEscalated: true,
    predictedFiles: ['src/a.ts', 'src/b.ts'],
    workerIntent: 'reviewer',
    useBrain: true,
    mergeHold: true,
    huddle: true,
    alignmentResolvedAt: '2026-01-01T00:07:30.000Z',
    workerRouting: resolveWorkerRouting({
      workerIntent: 'reviewer',
      requestedProvider: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.5',
      requestedEffort: 'high',
      confidence: 'high',
      source: 'orchestrator-state',
    }),
    dispatchRuntimePin: 'codex',
    orchestratorThreadId: 'thoughts-123',
    orchestratorTurnId: 'assistant-456',
    dispatcher: { surface: 'orchestrator', id: 'thoughts-123' },
    reviewSource: { pullRequest: 7, headSha: 'a'.repeat(40) },
    repairSource: { pullRequest: 8, headSha: 'b'.repeat(40) },
    launchContext: {
      source: 'mcp',
      presentation: 'split',
      repoContext: 'transient',
      caller: 'outside agent',
    },
    prompt: 'Implement the thing',
    allowedFiles: ['src/a.ts'],
    learnedRules: ['Preserve fields'],
    issue: {
      number: 123,
      body: 'Issue body',
      url: 'https://example.test/issue/123',
    },
    readBudget: {
      minToolCalls: 2,
      requiredReads: ['src/a.ts', 'src/b.ts'],
      planBeforeWrite: true,
    },
    edgeCaseSites: [{
      location: 'src/a.ts:10',
      description: 'Conditional branch',
      kind: 'conditional',
    }],
    deviations: {
      raw: '## Deviations\n- Used a map instead of a set',
      entries: ['Used a map instead of a set'],
      capturedAt: '2026-01-01T00:08:00.000Z',
    },
    taskContract: {
      version: 1,
      requirements: [{
        id: 'R1',
        source: 'Issue body',
        expectedBehavior: 'Preserve packet fields',
        productionPath: 'normalizeOrchestratorMissionState -> normalizePacket',
        verification: 'packet normalize test',
      }],
      smallestRoute: [{
        path: 'src/lib/orchestrator/store.ts',
        requirements: ['R1'],
        reason: 'The normalize chokepoint owns packet persistence.',
      }],
      exclusions: ['No UI changes'],
    },
    taskContractRequired: true,
    taskContractSource: 'explicit',
    problemDossierId: null,
    problemRemedyId: null,
    explainer: {
      status: 'ready',
      artifactId: 'art-explainer-1',
      quiz: null,
      changedFileCount: 3,
      generatedAt: '2026-01-01T00:09:00.000Z',
      error: null,
    },
    buyinDoc: {
      status: 'ready',
      artifactId: 'art-buyin-1',
      generatedAt: '2026-01-01T00:10:00.000Z',
      error: null,
    },
    recovery: null,
    standingLaneId: 'lane-standing-fixture',
  } satisfies Required<OrchestratorPacket>;

  return packet;
}

function stateWithPacket(packet: OrchestratorPacket) {
  const base = createEmptyOrchestratorMissionState();
  return {
    ...base,
    packets: [packet],
  };
}

describe('packet fields survive normalize', () => {
  it('refuses an unknown persisted execution carrier instead of falling back to direct credentials', () => {
    expect(() => normalizePacketExecutionCarrier('future-carrier')).toThrow(/refusing to fall back/i);
  });

  it('preserves every packet key across a normalize round-trip', () => {
    vi.useFakeTimers();
    try {
      const packet = fullPacketFixture();
      const normalized = normalizeOrchestratorMissionState(stateWithPacket(packet));
      expect(normalized.packets[0]).toEqual(packet);
      const persisted = normalizeOrchestratorMissionStateForPersistence(normalized);
      expect(persisted.packets[0]).not.toHaveProperty('statusEvidence');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invent absent optional control fields', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({
      ...fullPacketFixture(),
      projectId: undefined,
      operatorStopped: undefined,
      tierEscalated: undefined,
      dispatchRuntimePin: undefined,
      orchestratorThreadId: undefined,
      taskContractRequired: undefined,
      taskContractSource: undefined,
      storageAdmissionEpoch: undefined,
      statusEvidence: undefined,
      alignmentResolvedAt: undefined,
    }));

    expect(normalized.packets[0].projectId).toBeUndefined();
    expect(normalized.packets[0].operatorStopped).toBeUndefined();
    expect(normalized.packets[0].tierEscalated).toBeUndefined();
    expect(normalized.packets[0].dispatchRuntimePin).toBeNull();
    expect(normalized.packets[0].orchestratorThreadId).toBeUndefined();
    expect(normalized.packets[0].taskContractRequired).toBeUndefined();
    expect(normalized.packets[0].taskContractSource).toBeUndefined();
    expect(normalized.packets[0].storageAdmissionEpoch).toBe(1);
    expect(normalized.packets[0].statusEvidence).toBeUndefined();
    expect(normalized.packets[0].alignmentResolvedAt).toBeUndefined();
  });

  it('preserves an explicit disabled task-contract gate', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({
      ...fullPacketFixture(),
      taskContractRequired: false,
      taskContractSource: 'default',
    }));

    expect(normalized.packets[0].taskContractRequired).toBe(false);
    expect(normalized.packets[0].taskContractSource).toBe('default');
  });

  it('truncates an oversized deviations raw body with an explicit marker', () => {
    const oversized = 'y'.repeat(200 * 1024);
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({
      ...fullPacketFixture(),
      deviations: {
        raw: oversized,
        entries: ['one entry'],
        capturedAt: '2026-01-01T00:08:00.000Z',
      },
    }));

    const raw = normalized.packets[0].deviations?.raw ?? '';
    expect(raw.length).toBeLessThan(oversized.length);
    expect(raw).toMatch(/truncated/);
    // Entries + capturedAt still survive the round-trip untouched.
    expect(normalized.packets[0].deviations?.entries).toEqual(['one entry']);
  });
});
