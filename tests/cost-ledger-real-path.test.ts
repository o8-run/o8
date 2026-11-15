import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeCapacitySnapshot, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

const launchRuntimeSurface = vi.hoisted(() => vi.fn(async (input: {
  runtime: string;
  existingLaneId?: string;
  repoPath?: string;
}) => ({
  ok: true as const,
  runtime: input.runtime,
  surfaceId: `codex-owned:${input.existingLaneId ?? 'capacity-snapshot'}`,
  note: 'launched capacity snapshot fixture',
  cwd: input.repoPath ?? process.cwd(),
  repoPath: input.repoPath ?? process.cwd(),
  worktree: null,
  laneId: input.existingLaneId ?? null,
})));

vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));

// #2498 — null passes through to the real capacity service; a number makes the
// snapshot take that long, standing in for the per-runtime shell-outs.
const capacityStub = vi.hoisted(() => ({ delayMs: null as number | null }));
vi.mock('@/lib/runtime/capacity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/capacity-service')>();
  return {
    ...actual,
    getRuntimeCapacityControlSnapshot: async (options?: { fresh?: boolean }) => {
      if (capacityStub.delayMs === null) return actual.getRuntimeCapacityControlSnapshot(options);
      await new Promise((resolve) => setTimeout(resolve, capacityStub.delayMs ?? 0));
      return {
        schema: 'o8/runtime-capacity-control/v1' as const,
        generatedAt: Date.now(),
        capacities: [],
        identities: [],
        runtimes: [],
      };
    },
  };
});

const cacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(cacheRoot, 'o8-cost-ledger-real-path-'));
const repoPath = join(dataDir, 'repo');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

let testRuntime: AgentRuntime;
let capacityObservation: RuntimeCapacitySnapshot;

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/search/transcripts', () => ({ syncTranscriptSearchDocument: () => undefined }));
vi.mock('@/lib/lane/lane-diff-facts', () => ({
  getLaneDiffFacts: () => ({ changedFiles: 0, addedDiffLines: 0 }),
  getLaneSpokenDiffFacts: () => undefined,
}));

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
}

function transcript(): RuntimeTranscriptEntry[] {
  return [{
    id: 'cost-ledger-completion',
    role: 'assistant',
    text: 'Implemented and verified the cost ledger.',
    timestamp: new Date('2026-08-28T16:00:00.000Z'),
  }];
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'cost ledger real path\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');

  capacityObservation = {
    runtime: 'codex',
    identityId: null,
    status: 'available',
    reason: null,
    observedAt: '2026-08-28T16:00:00.000Z',
    source: 'local-state',
    confidence: 'exact',
    buckets: [{
      id: 'weekly',
      label: 'Weekly',
      usedRatio: null,
      used: null,
      unit: null,
      remaining: null,
      resetsAt: null,
      expiresAt: null,
    }],
  };
  testRuntime = {
    id: 'codex',
    displayName: 'Cost ledger test runtime',
    capabilities: {
      discover: false,
      readTranscript: true,
      launch: false,
      resume: false,
      interrupt: false,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: false,
      capacity: { observe: true, identitySelection: false },
    },
    discoverSessions: async () => [],
    readTranscript: async () => transcript(),
    launch: async () => ({ ok: false, note: 'not supported' }),
    resume: async () => ({ ok: false, note: 'not supported' }),
    interrupt: async () => ({ ok: false, note: 'not supported' }),
    getChangedFiles: async () => [],
    getCapacity: async () => capacityObservation,
  };
  // Load the auto-registration barrel before installing the deterministic
  // fixture so a later capacity-service import cannot overwrite it.
  const { registerRuntime } = await import('@/lib/runtimes');
  registerRuntime(testRuntime);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cost ledger persisted real path', () => {
  it('stamps table estimates and captures launch/completion capacity with explicit unavailable fallback', async () => {
    const { modelRateTable, resolveRate } = await import('@/lib/cost/rate-table');
    const rate = resolveRate('codex', 'gpt-5.5')!;
    const sessionKey = 'codex-owned:rate-version-persistence';
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const estimatedLane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/rate-version-persistence',
      runtime: 'codex',
      packetId: 'packet-rate-version-persistence',
      sessionKey,
    });
    const { persistSessionCost } = await import('@/lib/orchestrator/cost-persistence');
    await persistSessionCost({
      sessionKey,
      runtime: 'codex',
      model: 'gpt-5.5',
      inputTokens: 100_000,
      outputTokens: 10_000,
      costUsd: (100_000 * rate.inputUsdPerMillion + 10_000 * rate.outputUsdPerMillion) / 1_000_000,
      repoPath,
      laneId: estimatedLane.id,
      packetId: estimatedLane.packetId,
      costSource: 'estimate',
    });
    const { getSqlite } = await import('@/lib/db');
    const estimatedRow = getSqlite().prepare(`
      SELECT metadata_json FROM usage_logs WHERE session_key = ?
    `).get(sessionKey) as { metadata_json: string };
    expect(JSON.parse(estimatedRow.metadata_json)).toEqual({
      costSource: 'estimate',
      rateTableVersion: modelRateTable.rateTableVersion,
    });

    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{
        number: 1_974_001,
        title: 'inline: verify packet capacity snapshots',
        body: 'Launch and complete one packet through the lifecycle seams.',
        url: '',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Real-path capacity snapshot regression.',
      taskContract: 'off',
    });
    const packetId = mission.packets[0]!.id;
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/capacity-snapshot-real-path',
      runtime: 'codex',
      packetId,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      const { dispatch } = await import('@/lib/lane/commands');
      await expect(dispatch({
        verb: 'launch_session',
        laneId: lane.id,
        prompt: 'Capture packet capacity.',
        actor: 'orchestrator',
      })).resolves.toMatchObject({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const findStartEvent = () => getLaneEvents(lane.id, 100).find((event) => (
      event.verb === 'capacity_snapshot' && event.payload.phase === 'start'
    ));
    await vi.waitFor(() => expect(findStartEvent()).toBeDefined());
    const startEvent = findStartEvent();
    expect(startEvent?.payload).toMatchObject({
      phase: 'start',
      packetId,
      runtime: 'codex',
      status: 'available',
      identityId: null,
      reason: null,
      source: 'local-state',
      confidence: 'exact',
      buckets: [expect.objectContaining({
        id: 'weekly',
        usedRatio: null,
        used: null,
        unit: null,
        remaining: null,
        resetsAt: null,
        expiresAt: null,
      })],
    });
    expect(startEvent?.payload.capturedAt).toEqual(expect.any(String));

    testRuntime.capabilities.capacity = undefined;
    testRuntime.getCapacity = undefined;
    const launchedSessionKey = `codex-owned:${lane.id}`;
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    try {
      await capturePacketCompletionContext(packetId, launchedSessionKey);
      await vi.waitFor(() => {
        const capacityEvents = getLaneEvents(lane.id, 100).filter((event) => event.verb === 'capacity_snapshot');
        expect(capacityEvents).toHaveLength(2);
        expect(capacityEvents[1]?.payload).toMatchObject({
          phase: 'end',
          packetId,
          sessionKey: launchedSessionKey,
          runtime: 'codex',
          status: 'unavailable',
          reason: 'adapter_observation_unavailable',
          identityId: null,
          observedAt: null,
          source: null,
          confidence: null,
          buckets: [],
        });
        expect(capacityEvents[1]?.payload.capturedAt).toEqual(expect.any(String));
      });
    } finally {
      testRuntime.capabilities.capacity = { observe: true, identitySelection: false };
      testRuntime.getCapacity = async () => capacityObservation;
    }
  });

  it('returns the launch result without waiting on a slow start capacity snapshot (#2498)', async () => {
    capacityStub.delayMs = 3_000;
    try {
      const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
      const mission = await createMission({
        issues: [{
          number: 2_498_001,
          title: 'inline: launch without waiting on the start snapshot',
          body: 'Launch one packet while the capacity snapshot is slow.',
          url: '',
        }],
        repoPath,
        runtime: 'codex',
        constraints: 'Real-path detached start snapshot regression.',
        taskContract: 'off',
      });
      const packetId = mission.packets[0]!.id;
      const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
      const lane = createLane({
        repoPath,
        worktreePath: repoPath,
        branch: 'fix/slow-start-capacity-snapshot',
        runtime: 'codex',
        packetId,
      });
      const startSnapshots = () => getLaneEvents(lane.id, 10_000).filter((event) => (
        event.verb === 'capacity_snapshot' && event.payload.phase === 'start'
      ));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
      let elapsedMs: number;
      try {
        const { dispatch } = await import('@/lib/lane/commands');
        const startedAt = Date.now();
        const result = await dispatch({
          verb: 'launch_session',
          laneId: lane.id,
          prompt: 'Launch while capacity is slow.',
          actor: 'orchestrator',
        });
        elapsedMs = Date.now() - startedAt;
        expect(result).toMatchObject({ ok: true });
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(elapsedMs, 'launch result waited on the start capacity snapshot').toBeLessThan(1_000);
      expect(startSnapshots()).toHaveLength(0);
      await vi.waitFor(() => {
        expect(startSnapshots(), 'start capacity snapshot never landed').toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
      expect(startSnapshots()[0]?.payload).toMatchObject({ phase: 'start', packetId, runtime: 'codex' });
    } finally {
      capacityStub.delayMs = null;
    }
  }, 20_000);

  it('keeps retry attempts distinct and carries the same totals through outcomes and status', async () => {
    const { getSqlite } = await import('@/lib/db');
    const columns = getSqlite().prepare('PRAGMA table_info(usage_logs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'lane_id',
      'packet_id',
      'mission_id',
      'role',
      'attempt',
      'run_id',
      'metadata_json',
    ]));

    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{
        number: 1_973_001,
        title: 'inline: verify retry cost attribution',
        body: 'Persist two attempts and verify the outcome and status receipts.',
        url: '',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Real-path cost ledger regression.',
      taskContract: 'off',
    });
    const packetId = mission.packets[0]!.id;
    const sessionKey = 'codex-owned:cost-ledger-retry';
    const { appendEvent, createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/cost-ledger-real-path',
      runtime: 'codex',
      packetId,
      sessionKey,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    const { persistSessionCost } = await import('@/lib/orchestrator/cost-persistence');
    await persistSessionCost({
      sessionKey,
      runtime: 'codex',
      model: 'gpt-test',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.1,
      repoPath,
      laneId: lane.id,
      packetId,
      role: 'worker',
    });
    appendEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId,
      source: 'operator',
      message: 'Retry with the persisted correction.',
    });
    await persistSessionCost({
      sessionKey,
      runtime: 'codex',
      model: 'gpt-test',
      inputTokens: 250,
      outputTokens: 70,
      costUsd: 0.3,
      repoPath,
      laneId: lane.id,
      packetId,
      role: 'worker',
    });

    const usageRows = getSqlite().prepare(`
      SELECT attempt, input_tokens, output_tokens, cost_usd, lane_id, packet_id, mission_id, role
      FROM usage_logs WHERE session_key = ? ORDER BY attempt
    `).all(sessionKey);
    expect(usageRows).toEqual([
      expect.objectContaining({ attempt: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.1 }),
      expect.objectContaining({ attempt: 2, input_tokens: 150, output_tokens: 50, cost_usd: 0.2 }),
    ]);
    expect(usageRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane_id: lane.id, packet_id: packetId, mission_id: mission.missionId, role: 'worker' }),
    ]));

    const reviewRoute = await import('@/app/api/orchestrator/review/route');
    const reviewResponse = await reviewRoute.POST(new NextRequest(
      'http://localhost/api/orchestrator/review',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${(await import('@/lib/ws-auth')).getOrCreateWsToken()}` },
        body: JSON.stringify({
          packetId,
          clientMutationId: 'cost-ledger-real-path-review',
          approved: true,
          findings: [{
            file: 'README.md',
            line: 1,
            severity: 'note',
            description: 'The persisted receipt matches the requested path.',
            status: 'accepted',
          }, {
            file: 'README.md',
            line: 1,
            severity: 'note',
            description: 'The retry totals remain visible on the outcome.',
            status: 'accepted',
          }],
          reviewedHeadSha: git('rev-parse', 'HEAD'),
        }),
      },
    ));
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({
      ok: true,
      result: { recorded: true, findingsCount: 2 },
    });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(packetId, sessionKey);
    await vi.waitFor(() => {
      const outcome = getSqlite().prepare(`
        SELECT attempts, total_tokens, cost_usd, review_approved, review_findings_count
        FROM session_outcomes WHERE packet_id = ?
      `).get(packetId);
      expect(outcome).toEqual({
        attempts: 2,
        total_tokens: 320,
        cost_usd: 0.3,
        review_approved: 1,
        review_findings_count: 2,
      });
    });

    const statusRoute = await import('@/app/api/orchestrator/status/route');
    const response = await statusRoute.GET(new NextRequest(
      `http://localhost/api/orchestrator/status?missionId=${mission.missionId}&includeCost=true`,
    ));
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      result: {
        cost: {
          totalCostUsd: number;
          packetCosts: Array<{ packetId: string; inputTokens: number; outputTokens: number; totalCostUsd: number }>;
          costByRole: Record<string, { inputTokens: number; outputTokens: number; totalCostUsd: number; requestCount: number }>;
        };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.cost.totalCostUsd).toBe(0.3);
    expect(payload.result.cost.packetCosts).toContainEqual(expect.objectContaining({
      packetId,
      inputTokens: 250,
      outputTokens: 70,
      totalCostUsd: 0.3,
    }));
    expect(payload.result.cost.costByRole.worker).toEqual({
      inputTokens: 250,
      outputTokens: 70,
      totalCostUsd: 0.3,
      requestCount: 2,
    });
  });

  it('preserves a rejected review verdict and its finding count on the outcome', async () => {
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{
        number: 1_973_002,
        title: 'inline: verify rejected review attribution',
        body: 'Persist the rejected review verdict on the session outcome.',
        url: '',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Real-path review ledger regression.',
      taskContract: 'off',
    });
    const packetId = mission.packets[0]!.id;
    const sessionKey = 'codex-owned:cost-ledger-rejected-review';
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/cost-ledger-rejected-review',
      runtime: 'codex',
      packetId,
      sessionKey,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    const reviewRoute = await import('@/app/api/orchestrator/review/route');
    const reviewResponse = await reviewRoute.POST(new NextRequest(
      'http://localhost/api/orchestrator/review',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${(await import('@/lib/ws-auth')).getOrCreateWsToken()}` },
        body: JSON.stringify({
          packetId,
          clientMutationId: 'cost-ledger-rejected-review',
          approved: false,
          findings: [{
            file: 'README.md',
            line: 1,
            severity: 'bug',
            description: 'The first finding remains unresolved.',
            status: 'deferred',
          }, {
            file: 'README.md',
            line: 1,
            severity: 'rule_violation',
            description: 'The second finding requires another pass.',
            status: 'deferred',
          }],
          reviewedHeadSha: git('rev-parse', 'HEAD'),
        }),
      },
    ));
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({
      ok: true,
      result: { recorded: true, findingsCount: 2 },
    });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    const { getSqlite } = await import('@/lib/db');
    await capturePacketCompletionContext(packetId, sessionKey);
    await vi.waitFor(() => {
      const outcome = getSqlite().prepare(`
        SELECT review_approved, review_findings_count
        FROM session_outcomes WHERE packet_id = ?
      `).get(packetId);
      expect(outcome).toEqual({
        review_approved: 0,
        review_findings_count: 2,
      });
    });
  });
});
