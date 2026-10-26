import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-delegate-effort-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/lane/commands', () => ({ dispatch: h.dispatch }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({
  getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] },
    reasoningEfforts: { 'gpt-5.6-terra': ['low', 'high'] } }),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/dispatch/edge-case-surfacer', () => ({ surfaceEdgeCases: () => ({ sites: [] }) }));
vi.mock('@/lib/dispatch/read-budget', () => ({ computeReadBudget: () => null, resolveModelTier: () => 'frontier' }));
vi.mock('@/lib/orchestrator/preservation-envelope', () => ({ computePredictedFiles: () => [] }));
vi.mock('@/lib/operator/defaults', () => ({
  getOperatorDefaultsSync: () => ({ values: {
    subscriptionProfile: 'both', workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex',
    codexWorkerEffort: 'adaptive', workerStartMode: 'immediate',
  }, sources: { workerRuntimes: 'file' } }),
}));
vi.mock('@/lib/projects/context', () => ({
  getProjectContext: vi.fn(async () => ({ id: null, repoInProject: false })),
  buildProjectTaskBrief: () => ({}),
}));
vi.mock('@/lib/prompts/v1', () => ({ buildProjectBriefPromptV1: (_brief: unknown, prompt: string) => prompt }));

const { POST } = await import('@/app/api/orchestrator/delegate/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/orchestrator/delegate', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Inspect the fixture.', repoPath: dataDir,
      runtime: 'codex', model: 'gpt-5.6-terra', ...body }),
  });
}

beforeEach(() => {
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (command: { verb: string }) => command.verb === 'open_lane'
    ? { ok: true, laneId: 'fixture-effort-lane' }
    : { ok: true, lane: { sessionKey: 'codex-owned:fixture-effort', worktreePath: null } });
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  getSqlite().prepare('DELETE FROM idempotency_keys').run();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('delegate effort correction through persisted request state', () => {
  const malformed = ['turbo', '', 'HIGH', 1, false, {}, ['high']];
  const cases = ['requestedEffort', 'thinkingEffort'].flatMap((field) =>
    malformed.map((value) => ({ [field]: value })));
  cases.push({ requestedEffort: 'high', thinkingEffort: 'low' });

  it.each(cases)('does not reserve a rejected effort request: %j', async (invalid) => {
    const clientMutationId = 'correct-effort';
    const rejected = await POST(request({ clientMutationId, ...invalid }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false, code: 'requestedEffort' in invalid && 'thinkingEffort' in invalid
        ? 'conflicting_effort' : 'invalid_effort',
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(readOrchestratorControlPlaneState().packets).toEqual([]);
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 0 });
    // A restart must not turn a validation error into a permanent body conflict.
    closeDb();
    const corrected = { clientMutationId, requestedEffort: 'high' };
    const accepted = await POST(request(corrected));
    expect(accepted.status).toBe(200);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ verb: 'launch_session', effort: 'high' }));
    const packets = readOrchestratorControlPlaneState().packets;
    expect(packets).toHaveLength(1);
    expect(packets[0].workerRouting).toMatchObject({ requestedEffort: 'high', selectedEffort: 'high' });

    closeDb();
    const replay = await POST(request(corrected));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ ok: true, replayed: true });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    const conflict = await POST(request({ ...corrected, requestedEffort: 'low' }));
    expect(conflict.status).toBe(409);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(1);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: packets[0].id, workerRouting: { requestedEffort: 'high', selectedEffort: 'high' },
    });
  });

  it.each([
    {}, { requestedEffort: null, thinkingEffort: null }, { requestedEffort: 'adaptive' },
    { thinkingEffort: 'high' }, { requestedEffort: 'high', thinkingEffort: 'high' },
  ])('preserves accepted effort aliases: %j', async (effort) => {
    const response = await POST(request({ clientMutationId: 'valid-effort', ...effort }));
    expect(response.status).toBe(200);
    const expected = effort.requestedEffort ?? effort.thinkingEffort ?? 'adaptive';
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ verb: 'launch_session', effort: expected }));
  });
});
