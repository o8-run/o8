import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({ busy: false, perform: vi.fn() }));
// Substitute only lock contention and runtime availability; all handlers,
// HTTP envelopes, idempotency receipts, and packet/lane reads are real.
vi.mock('@/lib/orchestrator/control-plane', async (original) => {
  const actual = await original<typeof import('@/lib/orchestrator/control-plane')>();
  return { ...actual, withLockedState: (...args: Parameters<typeof actual.withLockedState>) => {
    if (h.busy) throw new actual.ControlPlaneLockTimeoutError(10);
    return actual.withLockedState(...args);
  } };
});
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => {}),
}));
vi.mock('@/lib/runtime/actions', async (original) => ({
  ...await original<typeof import('@/lib/runtime/actions')>(),
  performRuntimeAction: h.perform,
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-lifecycle-mcp-errors-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
getOrCreateWsToken();
const { createLane, updateLane } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { handleTaskDispatch, handleRetryPacket, handleResetPacket } = await import('@/lib/mcp/operator-handlers/mission');
const { handleSteerPacket } = await import('@/lib/mcp/operator-handlers/status');
const reset = await import('@/app/api/orchestrator/reset-packet/route');
const steer = await import('@/app/api/orchestrator/steer-packet/route');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { recordMission } = await import('@/lib/db/missions-store');

function transport() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined });
    if (request.nextUrl.pathname === '/api/orchestrator/steer-packet') return steer.POST(request);
    if (request.nextUrl.pathname === '/api/orchestrator/reset-packet') return reset.POST(request);
    throw new Error(`Unexpected route: ${request.nextUrl.pathname}`);
  }));
}

let sequence = 0;
function fixture(status: 'failed' | 'archived' | 'launching') {
  const packetId = `packet-${status}-${++sequence}`;
  const lane = createLane({ repoPath: dataDir, branch: `fix/${packetId}`, runtime: 'codex', packetId, baseCommit: 'a'.repeat(40) });
  updateLane(lane.id, { status, sessionKey: null });
  const packet = { id: packetId, referenceLabel: 'inline-1', title: 'Lifecycle fixture', summary: 'Inspect failure',
    workspaceTargetPath: dataDir, branchTarget: lane.branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'held', releaseState: 'pending', status,
    lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, runtime: 'codex', repoPath: dataDir },
  } as OrchestratorPacket;
  const state = { ...createEmptyOrchestratorMissionState(), missionId: `mission-${packetId}`, repoPath: dataDir, packets: [packet] };
  recordMission({ id: state.missionId, repoPath: dataDir, runtime: 'codex', prompt: '', summary: '', constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }], missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  closeDb();
  return { packetId, missionId: state.missionId, laneId: lane.id };
}

function payload(result: Awaited<ReturnType<typeof handleSteerPacket>>) {
  expect(result.isError).toBe(true);
  const content = result.content[0];
  expect(content.type).toBe('text');
  return JSON.parse(content.type === 'text' ? content.text : '');
}

afterEach(() => { h.busy = false; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('lifecycle errors through MCP handlers and durable HTTP state', () => {
  it.each(['failed', 'archived', 'launching'] as const)('explains a refused steer on a %s packet', async (state) => {
    const { packetId } = fixture(state);
    transport();
    const result = payload(await handleSteerPacket({ packetId, message: 'continue' }));
    expect(result).toMatchObject({ ok: false, code: 'steer_unavailable', state, packetId, next: expect.any(String) });
    expect(result.message).toContain('no steerable session');
    expect(result.next).toContain(state === 'launching' ? 'get_mission_status' : 'retry_packet');
    expect(readOrchestratorControlPlaneState().packets[0].status).toBe(state);
  });

  it.each([
    ['retry', handleRetryPacket, 'failed'], ['reset', handleResetPacket, 'failed'],
    ['retry', handleRetryPacket, 'archived'], ['reset', handleResetPacket, 'archived'],
    ['retry', handleRetryPacket, 'launching'], ['reset', handleResetPacket, 'launching'],
  ] as const)('reports %s contention on a %s packet with a cause and retry hint', async (_verb, handler, state) => {
    const { packetId, missionId, laneId } = fixture(state);
    if (state === 'launching') {
      // Reset intentionally pauses pre-session launches before taking the mission
      // lock. Keep an attached launch here to exercise contention without cancellation.
      updateLane(laneId, { sessionKey: `test-runtime:${packetId}` });
    }
    transport();
    h.busy = true;
    const log = vi.spyOn(console, 'error');
    const result = payload(await handler({ packetId }));
    expect(result).toMatchObject({ ok: false, code: 'mission_store_busy', state, packetId,
      next: expect.stringContaining('get_mission_status'), retryAfterMs: expect.any(Number) });
    expect(log.mock.calls.some(call => call.some(value => typeof value === 'object' && value?.code === result.code))).toBe(true);
    closeDb();
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0].status).toBe(state);
  });

  it.each([handleRetryPacket, handleResetPacket])('preserves the route code when a packet does not exist', async (handler) => {
    transport();
    const result = payload(await handler({ packetId: 'missing-packet' }));
    expect(result).toMatchObject({ code: 'packet_not_found', state: 'not_found', next: expect.stringContaining('get_mission_status') });
    expect(result.message).toContain('not found');
  });

  it.each(['failed', 'archived', 'launching'] as const)('preserves a typed task dispatch rejection and %s state', async (state) => {
    const { packetId } = fixture(state);
    const result = payload(await handleTaskDispatch({ taskId: packetId, requestedRuntime: 'claude-code' }));
    expect(result).toMatchObject({ ok: false, code: 'task_dispatch_conflict', state, packetId,
      next: expect.stringContaining(state === 'launching' ? 'get_mission_status' : 'retry_packet') });
    expect(result.message).toContain('claimed by a codex lane');
    expect(readOrchestratorControlPlaneState().packets[0].runtime).toBe('codex');
  });

  it('reports contention during task dispatch without losing the current state', async () => {
    const { packetId } = fixture('failed');
    h.busy = true;
    const result = payload(await handleTaskDispatch({ taskId: packetId }));
    expect(result).toMatchObject({ code: 'mission_store_busy', state: 'failed', retryAfterMs: 1000 });
    expect(readOrchestratorControlPlaneState().packets[0].status).toBe('failed');
  });

  it('keeps a busy steer queued successfully instead of inventing a lifecycle failure', async () => {
    const { packetId, laneId } = fixture('launching');
    updateLane(laneId, { sessionKey: `test-runtime:${packetId}` });
    h.perform.mockResolvedValueOnce({ ok: false, status: 'unavailable', reason: 'surface_not_ready', retryable: true });
    transport();
    const result = await handleSteerPacket({ packetId, message: 'continue when ready' });
    expect(result.isError).not.toBe(true);
    const content = result.content[0];
    expect(JSON.parse(content.type === 'text' ? content.text : '')).toMatchObject({ ok: true, deliveryState: 'queued' });
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('finds the failed packet in its durable mission after another mission becomes current', async () => {
    const { packetId, missionId } = fixture('failed');
    fixture('launching');
    transport();
    const result = payload(await handleSteerPacket({ packetId, message: 'continue' }));
    expect(result).toMatchObject({ code: 'steer_unavailable', state: 'failed', missionId, packetId });
  });
});
