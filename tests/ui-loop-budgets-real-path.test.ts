import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  perform: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  performRuntimeAction: h.perform,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-budgets-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const steerRoute = await import('@/app/api/orchestrator/ui-loop/steer/route');
const { closeDb } = await import('@/lib/db');
const { reportAgentEvent } = await import('@/lib/lane/agent-report');
const { createLane, deleteLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { getResourceLeaseStore } = await import('@/lib/leases/resource-lease-default-store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { resetPacketFields } = await import('@/lib/orchestrator/operator-mission-service/rerun-with-feedback');
const { setUiLoopSettleTimeoutForTest } = await import('@/lib/orchestrator/ui-loop');
const {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} = await import('@/lib/orchestrator/store');
const { listInboxItems } = await import('@/lib/supervisor/inbox');

const createdLaneIds: string[] = [];
const createdRepoPaths: string[] = [];

function runGit(repoPath: string, args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

function createRepo(): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-budget-repo-'));
  createdRepoPaths.push(repoPath);
  runGit(repoPath, ['init', '-b', 'main']);
  writeFileSync(join(repoPath, 'README.md'), 'UI loop budget fixture\n');
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  return repoPath;
}

function packetFixture(input: {
  id: string;
  repoPath: string;
  uiLoopIterations?: number;
  uiLoopStartedAt?: string;
}): OrchestratorPacket {
  return {
    id: input.id,
    referenceLabel: 'P1',
    title: 'Edit the selected element',
    summary: 'Apply the Design Mode element edit.',
    origin: 'design-mode',
    uiLoopIterations: input.uiLoopIterations ?? 0,
    uiLoopStartedAt: input.uiLoopStartedAt ?? new Date().toISOString(),
    workspaceTargetPath: input.repoPath,
    branchTarget: 'main',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'running',
    archivedAt: null,
    review: null,
    lane: null,
  };
}

function persistPacket(packet: OrchestratorPacket) {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-ui-loop-budgets',
    repoPath: packet.workspaceTargetPath ?? '',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
}

function createWarmLane(packet: OrchestratorPacket, attachWorktree = true) {
  const repoPath = packet.workspaceTargetPath!;
  const lane = createLane({
    repoPath,
    ...(attachWorktree ? { worktreePath: repoPath } : {}),
    branch: attachWorktree ? 'main' : `feat/${packet.id}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: packet.id,
    sessionKey: `test-owned:${packet.id}`,
    label: `warm-${packet.id}`,
  });
  createdLaneIds.push(lane.id);
  return lane;
}

function postRequest(repoPath: string, text: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/ui-loop/steer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: repoPath, text }),
  });
}

async function postJson(repoPath: string, text: string) {
  const response = await steerRoute.POST(postRequest(repoPath, text));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ok: true; result: Record<string, unknown> }>;
}

function completedRuntimeAction(input: { surfaceId: string }) {
  return {
    ok: true,
    action: 'steer' as const,
    surfaceId: input.surfaceId,
    sessionKey: input.surfaceId,
    runtime: 'codex' as const,
    status: 'completed' as const,
    note: 'steered',
  };
}

async function settleTurn(laneId: string, repoPath: string) {
  reportAgentEvent({ laneId, event: 'progress', message: 'turn settled' });
  await vi.waitFor(async () => {
    expect((await getResourceLeaseStore().status(`ui-loop:${repoPath}`)).holder).toBeNull();
  });
}

beforeEach(async () => {
  h.perform.mockReset();
  h.perform.mockImplementation(async (input: { surfaceId: string }) => completedRuntimeAction(input));
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  await updateOperatorDefaults({
    uiLoopMaxIterations: 8,
    uiLoopMaxMinutes: 30,
    uiLoopMaxDiffBytes: 65_536,
    uiLoopMaxDiffFiles: 12,
    uiLoopPreviewTimeoutMs: 20_000,
  });
});

afterEach(() => {
  setUiLoopSettleTimeoutForTest(null);
  for (const repoPath of createdRepoPaths.splice(0)) rmSync(repoPath, { recursive: true, force: true });
  for (const laneId of createdLaneIds.splice(0)) deleteLane(laneId);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('UI loop single-writer lease and budgets real path', () => {
  it('queues concurrent edits in order and rejects the fourth request', async () => {
    const repoPath = createRepo();
    const packet = packetFixture({ id: 'pkt-ui-loop-queue', repoPath });
    persistPacket(packet);
    const lane = createWarmLane(packet);
    let resolveFirst!: () => void;
    h.perform
      .mockImplementationOnce((input: { surfaceId: string }) => new Promise((resolve) => {
        resolveFirst = () => resolve(completedRuntimeAction(input));
      }))
      .mockImplementation(async (input: { surfaceId: string }) => completedRuntimeAction(input));

    const firstResponse = steerRoute.POST(postRequest(repoPath, 'first edit'));
    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(1));
    const second = await postJson(repoPath, 'second edit');
    const third = await postJson(repoPath, 'third edit');
    const fourth = await postJson(repoPath, 'fourth edit');
    expect(second.result).toMatchObject({ queued: true, position: 1 });
    expect(third.result).toMatchObject({ queued: true, position: 2 });
    expect(fourth.result).toMatchObject({ rejected: 'queue_full' });
    expect(h.perform).toHaveBeenCalledTimes(1);

    resolveFirst();
    await expect((await firstResponse).json()).resolves.toMatchObject({
      ok: true,
      result: { kind: 'steered' },
    });
    reportAgentEvent({ laneId: lane.id, event: 'progress', message: 'first settled' });
    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(2));
    expect(h.perform.mock.calls[1]?.[0]?.message).toContain('second edit');

    reportAgentEvent({ laneId: lane.id, event: 'progress', message: 'second settled' });
    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(3));
    expect(h.perform.mock.calls[2]?.[0]?.message).toContain('third edit');
    await settleTurn(lane.id, repoPath);
  });

  it('releases an unsettled turn and promotes the next queued edit after the deadline', async () => {
    const repoPath = createRepo();
    const packet = packetFixture({ id: 'pkt-ui-loop-unsettled', repoPath });
    persistPacket(packet);
    const lane = createWarmLane(packet);
    setUiLoopSettleTimeoutForTest(300);

    await expect(postJson(repoPath, 'silent first edit')).resolves.toMatchObject({
      result: { kind: 'steered' },
    });
    const second = await postJson(repoPath, 'promoted second edit');
    expect(second.result).toMatchObject({ queued: true, position: 1 });
    expect(h.perform).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(h.perform.mock.calls[1]?.[0]?.message).toContain('promoted second edit');
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'ui_loop_turn_unsettled',
        payload: expect.objectContaining({
          packetId: packet.id,
          laneId: lane.id,
          waitedMs: expect.any(Number),
        }),
      }),
    ]));
    await settleTurn(lane.id, repoPath);
  });

  it('blocks the next steer after the packet spends its iteration budget', async () => {
    const repoPath = createRepo();
    await updateOperatorDefaults({ uiLoopMaxIterations: 2 });
    const packet = packetFixture({ id: 'pkt-ui-loop-iterations', repoPath });
    persistPacket(packet);
    const lane = createWarmLane(packet);

    await expect(postJson(repoPath, 'iteration one')).resolves.toMatchObject({ result: { kind: 'steered' } });
    await settleTurn(lane.id, repoPath);
    await expect(postJson(repoPath, 'iteration two')).resolves.toMatchObject({ result: { kind: 'steered' } });
    await settleTurn(lane.id, repoPath);
    const blocked = await postJson(repoPath, 'iteration three');

    expect(blocked.result).toMatchObject({
      blocked: 'iterations',
      values: {
        iterations: 2,
        maxIterations: 2,
        diffMeasured: false,
        diffBytes: 0,
        diffFiles: 0,
      },
    });
    expect(getLane(lane.id)?.status).toBe('awaiting_human');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'ui_loop_budget_exhausted:iterations',
      uiLoopIterations: 2,
    });
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'ui_loop_budget_exhausted',
        payload: expect.objectContaining({
          reason: 'iterations',
          iterations: 2,
          diffMeasured: false,
          diffBytes: 0,
          diffFiles: 0,
        }),
      }),
    ]));
    expect(listInboxItems({ includeAllProjects: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        packetId: packet.id,
        kind: 'bounded_retry_exhausted',
        status: 'human_required',
        payload: expect.objectContaining({
          blockedReason: 'ui_loop_budget_exhausted:iterations',
          note: expect.stringContaining('continue, reset, or hand back'),
        }),
      }),
    ]));
    expect(h.perform).toHaveBeenCalledTimes(2);
  });

  it('blocks a packet whose Design Mode wall-time budget elapsed', async () => {
    const repoPath = createRepo();
    await updateOperatorDefaults({ uiLoopMaxMinutes: 1 });
    const packet = packetFixture({
      id: 'pkt-ui-loop-time',
      repoPath,
      uiLoopStartedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    persistPacket(packet);
    const lane = createWarmLane(packet);

    const blocked = await postJson(repoPath, 'late edit');
    expect(blocked.result).toMatchObject({ blocked: 'time' });
    expect((blocked.result.values as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(getLane(lane.id)?.status).toBe('awaiting_human');
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('blocks a packet whose current real worktree diff exceeds the byte budget', async () => {
    const repoPath = createRepo();
    await updateOperatorDefaults({ uiLoopMaxDiffBytes: 64 });
    const packet = packetFixture({ id: 'pkt-ui-loop-diff', repoPath });
    persistPacket(packet);
    const lane = createWarmLane(packet);
    writeFileSync(join(repoPath, 'README.md'), `changed\n${'x'.repeat(512)}\n`);

    const blocked = await postJson(repoPath, 'large diff edit');
    expect(blocked.result).toMatchObject({ blocked: 'diff_bytes' });
    expect(blocked.result.values).toMatchObject({ diffMeasured: true });
    expect((blocked.result.values as { diffBytes: number }).diffBytes).toBeGreaterThan(64);
    expect(getLane(lane.id)?.status).toBe('awaiting_human');
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('steers normally when the lane diff cannot be measured', async () => {
    const repoPath = createRepo();
    const packet = packetFixture({ id: 'pkt-ui-loop-unmeasured', repoPath });
    persistPacket(packet);
    const lane = createWarmLane(packet, false);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    try {
      await expect(postJson(repoPath, 'unmeasured diff edit')).resolves.toMatchObject({
        result: { kind: 'steered' },
      });
      expect(debug).toHaveBeenCalledWith(
        '[ui-loop] Diff unavailable; treating the diff budget as unmeasured.',
        expect.objectContaining({
          laneId: lane.id,
          diffMeasured: false,
          diffBytes: 0,
          diffFiles: 0,
        }),
      );
      await settleTurn(lane.id, repoPath);
    } finally {
      debug.mockRestore();
    }
  });

  it('preserves UI-loop counters through reset fields and packet normalization', () => {
    const repoPath = createRepo();
    const packet = packetFixture({
      id: 'pkt-ui-loop-reset',
      repoPath,
      uiLoopIterations: 5,
      uiLoopStartedAt: '2026-08-28T08:00:00.000Z',
    });
    resetPacketFields(packet);
    expect(packet).toMatchObject({
      uiLoopIterations: 5,
      uiLoopStartedAt: '2026-08-28T08:00:00.000Z',
    });

    const normalized = normalizeOrchestratorMissionState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-ui-loop-reset',
      repoPath,
      packets: [packet],
    });
    expect(normalized.packets[0]).toMatchObject({
      uiLoopIterations: 5,
      uiLoopStartedAt: '2026-08-28T08:00:00.000Z',
    });
  });
});
