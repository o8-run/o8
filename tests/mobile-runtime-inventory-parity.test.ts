import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary, FleetSnapshot } from '@/lib/fleet/types';

const inventoryFixture = vi.hoisted(() => ({
  snapshot: null as FleetSnapshot | null,
}));
const getWorkspaceReviewSnapshotMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => inventoryFixture.snapshot),
}));

vi.mock('@/lib/approvals/store', () => ({
  approvalSeverity: () => 'info',
  listApprovals: () => [],
  listUnsettledApprovalContinuations: () => [],
  toMobileApprovalCard: (value: unknown) => value,
}));

vi.mock('@/lib/runtime/ide-llm-chat-registry', () => ({
  listIdeLlmChatSessions: () => [],
}));

vi.mock('@/lib/runtime/pty-bridge', () => ({
  isBridgeSessionAlive: async () => true,
}));

vi.mock('@/lib/review/workspace', () => ({
  getWorkspaceReviewSnapshot: getWorkspaceReviewSnapshotMock,
}));

vi.mock('@/lib/render/bootstrap', () => ({
  invalidateMobileBootstrapBroker: () => {},
}));

vi.mock('@/lib/mobile/history', () => ({
  getMobileSessionTranscript: async () => [],
}));

vi.mock('@/lib/mobile/review-units', () => ({
  buildMobileReviewUnits: async () => [],
  shouldExposeWorkspaceReviewSnapshot: () => false,
  summarizeMobileReviewUnits: () => ({ reviewItems: 0, inspectOnlyReviews: 0 }),
}));

const { getMobileInboxSnapshot, invalidateInboxCache } = await import('@/lib/mobile/inbox');

function runtimeAgent(runtime: 'antigravity' | 'aider'): AgentSummary {
  const sessionKey = `${runtime}-owned:mobile-parity`;
  return {
    id: sessionKey,
    name: `${runtime} worker`,
    squadId: `squad-${runtime}`,
    runtime,
    model: runtime,
    primaryModel: runtime,
    status: 'running',
    currentTask: `Working with ${runtime}`,
    workspace: `/tmp/${runtime}-mobile-parity`,
    branch: `issue/mobile-${runtime}`,
    sessionKey,
    approvalStatus: 'none',
    lastEventAt: 'just now',
    lastActivityAt: Date.now(),
    context: {
      usedPercent: 10,
      trend: 'stable',
    },
    alerts: 0,
    runtimeSurface: {
      id: sessionKey,
      runtime,
      kind: 'runtime-session',
      ownership: 'owned',
      title: `${runtime} worker`,
      cwd: `/tmp/${runtime}-mobile-parity`,
      branch: `issue/mobile-${runtime}`,
      sourceLabel: `${runtime} owned session`,
      capabilities: {
        attach: false,
        readTail: true,
        sendInput: false,
        interrupt: false,
        resize: false,
        diffContext: true,
        reviewContext: true,
      },
      lifecycle: {
        availability: 'running',
      },
    },
  };
}

describe('mobile full runtime inventory projection', () => {
  beforeEach(() => {
    invalidateInboxCache();
    getWorkspaceReviewSnapshotMock.mockClear();
    inventoryFixture.snapshot = {
      generatedAt: new Date().toISOString(),
      meta: {
        mode: 'live',
        sourceLabel: 'test runtime inventory',
        gatewayFreshness: 'fresh',
        observablePending: false,
        mirrorMode: 'current-session-first',
        primarySessionKey: 'antigravity-owned:mobile-parity',
      },
      squads: [],
      agents: [runtimeAgent('antigravity'), runtimeAgent('aider')],
      events: [],
      artifacts: [],
    };
  });

  it('surfaces Antigravity and Aider sessions with canonical runtime presentation', async () => {
    const snapshot = await getMobileInboxSnapshot({ fresh: true });

    expect(snapshot.sessions.map((session) => session.runtime)).toEqual(['antigravity', 'aider']);
    expect(snapshot.fleetSessions.map((session) => ({
      runtime: session.runtime,
      label: session.runtimeLabel,
      accent: session.runtimeAccent,
    }))).toEqual([
      { runtime: 'antigravity', label: 'Antigravity', accent: '#0f9d58' },
      { runtime: 'aider', label: 'Aider', accent: '#dc2626' },
    ]);
    expect(getWorkspaceReviewSnapshotMock).toHaveBeenCalledWith({ fresh: false });
  });

  it('skips the workspace review for sessions-only desktop timeline reads', async () => {
    const snapshot = await getMobileInboxSnapshot({
      fresh: true,
      includeWorkspaceReview: false,
    });

    expect(snapshot.sessions).toHaveLength(2);
    expect(getWorkspaceReviewSnapshotMock).not.toHaveBeenCalled();
  });
});
