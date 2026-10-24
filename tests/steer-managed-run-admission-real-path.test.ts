import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTilePane } from '@/components/desktop/workspace-terminal/AgentTilePane';
import { PacketRow } from '@/components/desktop/repo-focus/tabs/AgentRows';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/components/desktop/workspace-terminal/SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));

const perform = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: perform }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/orchestrator/headless-loop', () => ({
  runHeadlessSprintTick: vi.fn(async () => ({ launched: 0, active: 0 })),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-steer-run-admission-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const { closeDb } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { holdPacketLifecycleMutation } = await import('@/lib/orchestrator/packet-lifecycle-guard');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const stateRoute = await import('@/app/api/orchestrator/state/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');
const tickRoute = await import('@/app/api/orchestrator/headless-tick/route');

let sequence = 0;
function fixture(operatorStopped = false) {
  const id = `pkt-steer-runs-${++sequence}`;
  const repoPath = join(dataDir, id);
  const sessionKey = `claude-code-owned:${id}`;
  const lane = createLane({
    repoPath, worktreePath: repoPath, branch: `inline/${id}`, runtime: 'claude-code',
    packetId: id, sessionKey,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: id, runtime: 'claude-code',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
    releaseState: 'pending', status: 'awaiting_review', operatorStopped,
    blockedReason: operatorStopped ? 'operator_stopped' : null,
    lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
      worktreePath: repoPath, runtime: 'claude-code', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, packets: [packet] });
  perform.mockResolvedValue({ ok: true, status: 'accepted', sessionKey, note: 'accepted' });
  return { packet, lane, sessionKey };
}

function request(path: string, body: unknown, method = 'POST', token = getOrCreateWsToken()) {
  return new NextRequest(`http://localhost${path}`, { method, headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
function steer(packetId: string) {
  return steerRoute.POST(request('/api/orchestrator/steer-packet', {
    packetId, message: 'Run the remaining verification', idempotencyKey: `steer-${packetId}`,
  }));
}
function register(packet: OrchestratorPacket, suffix = 'first', token = getOrCreateWsToken()) {
  const id = `run${sequence}${suffix}`;
  return runsRoute.POST(request('/api/panel/managed-runs', {
    id, session: `cortex-run-${id}`, command: 'node --version',
    cwd: packet.workspaceTargetPath, packetId: packet.id, laneId: packet.lane?.laneId,
  }, 'POST', token));
}

beforeEach(() => perform.mockReset());
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('steered-turn managed-run admission through production routes', () => {
  it('admits the current standing worker but fences managed registration before settlement despite an accepted steer', async () => {
    const { packet, lane } = fixture();
    const { saveStandingLane } = await import('@/lib/lane/standing-store');
    packet.standingLaneId = lane.id;
    packet.status = 'running';
    setLaneStatus(lane.id, 'running', 'system', 'standing_task');
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    const state = { model: 'fixture', effort: 'high' as const, stopped: false, removed: false, blockedReason: null,
      tasks: [{ id: packet.id, prompt: 'standing task', branch: packet.branchTarget!, phase: 'running' as const }] };
    saveStandingLane(lane.id, state);
    const token = mintPacketWorkerToken(packet.id);
    const admitted = await register(packet, 'standingActive', token);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect((await steer(packet.id)).status).toBe(200);
    saveStandingLane(lane.id, { ...state, tasks: [{ ...state.tasks[0], phase: 'publishing' }] });
    closeDb();
    const refused = await register(packet, 'standingSettling', token);
    expect(refused.status).toBe(409);
    expect(findManagedRun(`run${sequence}standingSettling`)).toBeNull();
    saveStandingLane(lane.id, { ...state, tasks: [{ ...state.tasks[0], phase: 'dispatching', startedAt: new Date().toISOString() }] });
    setLaneStatus(lane.id, 'launching', 'system', 'standing_dispatch');
    packet.lane = { ...packet.lane!, sessionKey: 'claude-code-owned:foreign-session', worktreePath: null };
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    expect((await register(packet, 'standingForeign', token)).status).toBe(409);
  });

  it('admits the steered packet worker through durable credentials and closes admission on exit', async () => {
    const { packet, lane, sessionKey } = fixture();
    const token = mintPacketWorkerToken(packet.id);
    expect((await steer(packet.id)).status).toBe(200);
    closeDb();
    const admitted = await register(packet, 'worker', token);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect(findManagedRun(`run${sequence}worker`)).toMatchObject({ packetId: packet.id, status: 'running' });
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
    const packetStatus = readOrchestratorControlPlaneState().packets.find(candidate => candidate.id === packet.id)!.status;
    const refused = await register(packet, 'workerAfterExit', token);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'packet_not_accepting_managed_runs',
      packetStatus,
      message: expect.stringContaining(packetStatus),
      hint: expect.stringContaining('rerun_with_feedback'),
    });
    expect(findManagedRun(`run${sequence}workerAfterExit`)).toBeNull();
  });

  it('gives a held worker a reset action without allowing registration', async () => {
    const { packet } = fixture(true);
    const response = await register(packet, 'heldWorker', mintPacketWorkerToken(packet.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: 'packet_held',
      packetStatus: 'awaiting_review',
      message: expect.stringContaining('awaiting_review'),
      hint: expect.stringContaining('reset'),
    });
    expect(findManagedRun(`run${sequence}heldWorker`)).toBeNull();
  });

  it('refreshes the rendered worker badge and outcome after steering a reviewing lane', async () => {
    const { packet, lane, sessionKey } = fixture();
    packet.completionSummary = 'Earlier worker outcome';
    packet.queueState = 'queued';
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    const agent = { name: 'Worker', status: 'reviewing', runtime: 'claude-code',
      statusEvidence: { sessionId: sessionKey, runtime: 'claude-code' as const, state: 'review-ready' as const,
        authority: 'runtime-event' as const, observedAt: '2026-10-21T12:00:00.000Z', summary: 'Earlier worker outcome', evidence: [] } };
    const render = (current: OrchestratorPacket) => renderToStaticMarkup(createElement(AgentTilePane, {
      sessionKey, agent, packet: current, focused: true, onClose() {}, onFocus() {},
    }));
    expect(render(packet)).toContain('Earlier worker outcome');
    expect((await steer(packet.id)).status).toBe(200);
    expect(getLane(lane.id)?.status).toBe('running');
    closeDb();
    const refreshed = await stateRoute.GET(new NextRequest('http://localhost/api/orchestrator/state', {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(refreshed.status).toBe(200);
    const { mission } = await refreshed.json() as { mission: { packets: OrchestratorPacket[] } };
    const hydrated = mission.packets.find(candidate => candidate.id === packet.id)!;
    expect(render(hydrated)).toContain('aria-label="working · lane"');
    // Packet snapshots restored from persistence do not carry the route's
    // transient status evidence. The current packet must still beat old discovery.
    const current = readOrchestratorControlPlaneState().packets.find(candidate => candidate.id === packet.id)!;
    expect(current.status, current.blockedReason ?? '').toBe('running');
    const html = render(current);
    expect(html.includes('aria-label="Running"')).toBe(true);
    expect(html).not.toContain('Earlier worker outcome');
    expect(html).not.toContain('Review the finished work');
    expect(renderToStaticMarkup(createElement(PacketRow, { packet: current, active: false }))).toContain('aria-label="running"');
  });

  it('admits a delayed steer after the previous turn exits', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockResolvedValueOnce({ ok: false, status: 'unavailable', reason: 'surface_not_ready' });
    expect((await steer(packet.id)).status).toBe(200);
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
    perform.mockResolvedValue({ ok: true, status: 'queued', sessionKey, note: 'accepted' });
    expect((await tickRoute.POST(request('/api/orchestrator/headless-tick', {}))).status).toBe(200);
    closeDb();
    const response = await register(packet);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('ignores an old run exit during delivery but closes admission on the accepted run exit', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockImplementationOnce(async () => {
      recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, runId: 'old-turn', exitCode: 0 });
      return { ok: true, status: 'queued', sessionKey, runId: 'accepted-turn', note: 'accepted' };
    });
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet)).status).toBe(200);
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, runId: 'accepted-turn', exitCode: 0 });
    expect((await register(packet, 'afterAcceptedExit')).status).toBe(409);
  });

  it.each(['awaiting_review', 'released'] as const)('admits an accepted %s turn across reopen, then refuses its exit', async (priorStatus) => {
    const { packet, lane, sessionKey } = fixture();
    if (priorStatus === 'released') {
      // Legacy completion stamped release without canonical merge evidence.
      packet.status = 'released';
      packet.releaseState = 'released';
      writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
        missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    }
    expect((await register(packet, 'before')).status).toBe(409);
    const response = await steer(packet.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(getLane(lane.id)?.status).toBe('running');
    closeDb();
    const admitted = await register(packet);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect(findManagedRun(`run${sequence}first`)?.packetId).toBe(packet.id);
    // The normal reconciler may already have projected the active turn.
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath,
      packets: [{ ...packet, status: 'running', queueState: 'queued' }] });
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      surfaceId: sessionKey, exitCode: 0, classification: 'clean-exit',
    });
    expect((await register(packet, 'late')).status).toBe(409);
    expect(findManagedRun(`run${sequence}late`)).toBeNull();
  });

  it('does not grant admission when the runtime refuses the steer', async () => {
    const { packet } = fixture();
    perform.mockResolvedValue({ ok: false, status: 'unavailable', note: 'no warm session' });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not resume or admit an operator-stopped packet', async () => {
    const { packet } = fixture(true);
    expect((await steer(packet.id)).status).toBe(409);
    expect(perform).not.toHaveBeenCalled();
    expect((await register(packet)).status).toBe(409);
  });

  it('keeps a concurrent operator hold authoritative after runtime acceptance', async () => {
    const { packet } = fixture();
    perform.mockImplementation(async () => {
      const { persistLanePacketHold } = await import('@/lib/lane/packet-stop-hold');
      await persistLanePacketHold(packet.id);
      return { ok: true, status: 'accepted', note: 'accepted' };
    });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not carry admission into a rebound session', async () => {
    const { packet, lane } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet)).status).toBe(200);
    updateLane(lane.id, { sessionKey: 'claude-code-owned:unaccepted-successor' });
    expect((await register(packet, 'rebound')).status).toBe(409);
  });

  it('cannot revive accepted-run admission by replaying a snapshot after Stop', async () => {
    const { packet } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet, 'beforeStop')).status).toBe(200);
    const cached = readOrchestratorControlPlaneState();
    const guard = await holdPacketLifecycleMutation({ packetId: packet.id, kind: 'stop' });

    expect((await stateRoute.POST(request('/api/orchestrator/state', { mission: cached }))).status).toBe(200);
    closeDb();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      operatorStopped: true, queueState: 'held', releaseStatePayload: { source: guard?.source },
    });
    expect((await register(packet, 'afterStop')).status).toBe(409);
    expect(findManagedRun(`run${sequence}afterStop`)).toBeNull();
  });

  it('refuses further managed runs when an accepted turn is archived through the state API', async () => {
    const { packet } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet, 'beforeArchive')).status).toBe(200);
    const archivedAt = new Date().toISOString();
    expect((await stateRoute.PATCH(request('/api/orchestrator/state', {
      packetId: packet.id, updates: { archivedAt },
    }, 'PATCH'))).status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.archivedAt).toBe(archivedAt);
    expect((await register(packet, 'afterArchive')).status).toBe(409);
    expect(findManagedRun(`run${sequence}afterArchive`)).toBeNull();
  });

  it.each(['archived', 'released'] as const)('does not steer a %s packet', async (state) => {
    const { packet } = fixture();
    if (state === 'archived') {
      packet.status = 'archived';
      packet.archivedAt = new Date().toISOString();
    } else {
      const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
      markPacketReleased(packet, { source: 'read_only_completed' });
    }
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    expect((await steer(packet.id)).status).toBe(409);
    expect(perform).not.toHaveBeenCalled();
    expect((await register(packet)).status).toBe(409);
  });

  it('does not grant an unrelated session rebound during runtime acceptance', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockImplementation(async () => {
      updateLane(lane.id, { sessionKey: 'claude-code-owned:unaccepted-successor' });
      return { ok: true, status: 'accepted', sessionKey, note: 'accepted original turn' };
    });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not admit a turn that exits before the steer response', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockImplementation(async () => {
      recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
        surfaceId: sessionKey, exitCode: 0, classification: 'clean-exit',
      });
      return { ok: true, status: 'accepted', sessionKey, note: 'finished immediately' };
    });
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet)).status).toBe(409);
  });

  it('keeps an admitted turn authorized after a concurrent steer is refused as still-busy', async () => {
    // #2342 — a second steer that the runtime refuses as busy still appends
    // its own steered_packet + steer_failed lane events. Those must not read
    // as newer lifecycle evidence that closes the FIRST turn's live grant.
    const { packet, lane, sessionKey } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet, 'first')).status).toBe(200);

    perform.mockResolvedValueOnce({ ok: false, status: 'unavailable', note: 'still busy' });
    const busyResponse = await steerRoute.POST(request('/api/orchestrator/steer-packet', {
      packetId: packet.id, message: 'A second nudge while busy',
      idempotencyKey: `steer-busy-${packet.id}`,
    }));
    expect(busyResponse.status, await busyResponse.clone().text()).toBe(409);

    expect(getLane(lane.id)).toMatchObject({ status: 'running', sessionKey });
    expect((await register(packet, 'afterBusyRefusal')).status).toBe(200);
  });
});
