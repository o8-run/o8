import { spawn } from 'node:child_process';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { inboxSubject, mutateInboxSettlement, readInboxState, recordInboxConversationEvent } from '@/lib/inbox/store';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, PATCH, GET, DELETE } from '@/app/api/v2/chat-history/route';
import { GET as list } from '@/app/api/mobile/orchestrator/threads/route';
import { GET as historyList } from '@/app/api/v2/chat-history/list/route';
import { GET as workspaceStatus } from '@/app/api/orchestrator/workspace/route';
import { GET as controlPlaneStatus } from '@/app/api/orchestrator/state/route';
import { GET as inventory } from '@/app/api/runtime/inventory/route';
import { createLane, getLane, setLaneStatus, updateLane } from '@/lib/lane/registry';
import { waitForTerminalLaneWork } from '@/lib/lane/terminal-work';
import { createApproval } from '@/lib/approvals/store';
import { getSqlite } from '@/lib/db';
import { persistCanonicalChatHistoryRecord, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { threadGitContext } from '@/lib/repos/thread-git-context';
import { enqueueComposerSend } from '@/lib/orchestrator/composer-queue';
import { createWorkspaceSnapshot, getWorkspaceSnapshot, transitionWorkspaceSnapshot } from '@/lib/worktree/snapshot-state';
import * as workspaceParking from '@/lib/workspace/hibernator';
import * as storageAdmission from '@/lib/workspace/storage-admission';
import * as operatorDefaults from '@/lib/operator/defaults';
import * as repos from '@/lib/repos/registry';
import * as realtime from '@/lib/realtime/publisher';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { createStoragePressureAdmissionCoordinator } from '@/lib/orchestrator/storage-pressure-policy';
import { PacketStorageAdmissionError, type PacketStorageAdmissionCoordinator, type PacketStorageAdmissionReceipt } from '@/lib/orchestrator/storage-admission';
import type { LaneStatus } from '@/lib/lane/types';
import { collectAutoSettleCandidates, runInboxAutoSettleSweep } from '@/lib/inbox/settlement';

// Runtime discovery is an external provider boundary. The lanes, approvals,
// transcript, mutation, persisted metadata and both listing routes are real.
const fixture = vi.hoisted(() => {
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const claudeHome = `${process.env.CORTEX_IDE_DATA_DIR}/inbox-claude`;
  process.env.CLAUDE_HOME = claudeHome;
  return { previousClaudeHome, claudeHome, realTranscript: false, scans: 0, agents: [] as Array<Record<string, unknown>>,
    transcript: [] as Array<{ id: string; role: 'user'; text: string; timestamp: Date; activityAt?: Date }> };
});
vi.mock('@/lib/runtimes', async original => {
  const actual = await original<typeof import('@/lib/runtimes')>();
  return { ...actual, getRuntime: (id: Parameters<typeof actual.getRuntime>[0]) => {
    const runtime = actual.getRuntime(id);
    return fixture.realTranscript ? runtime : runtime ? { ...runtime, readTranscript: async () => fixture.transcript } : undefined;
  } };
});
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => { fixture.scans++; return { agents: fixture.agents }; } }));
const prefix = `thoughts-inbox-${process.pid}`;
const ids: string[] = [];
const request = (body: Record<string, unknown>, query = '') => new NextRequest(`http://localhost/api/v2/chat-history${query}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const mutate = (tabId: string, inboxAction: string) => PATCH(request({ tabId, inboxAction }));

/** Observe completion of work descended from this settlement operation,
 * including a detached post-step. Polling belongs to the test, outside its scope.
 * No production observer/export is needed, so the pre-change route still runs.
 */
async function runAndDrain<T>(operation: () => Promise<T>): Promise<T> {
  const scope = new AsyncLocalStorage<object>();
  const owner = {};
  const pending = new Map<number, string>();
  const scheduled = new Set(['PROMISE', 'Timeout', 'Immediate', 'Microtask', 'TickObject']);
  const hook = createHook({
    init(id, type) {
      if (scope.getStore() === owner && scheduled.has(type)) pending.set(id, type);
    },
    promiseResolve(id) { if (pending.get(id) === 'PROMISE') pending.delete(id); },
    destroy(id) { if (pending.get(id) !== 'PROMISE') pending.delete(id); },
  });
  hook.enable();
  try {
    const result = await scope.run(owner, operation);
    if (result instanceof Response) await result.arrayBuffer();
    await expect.poll(() => [...pending.values()].sort(), {
      timeout: 2_000,
      message: 'All request-owned post-step promises/callbacks must finish before checking the policy refusal.',
    }).toEqual([]);
    return result;
  } finally { hook.disable(); scope.disable(); }
}
const mutateAndDrain = (tabId: string, inboxAction: string) => runAndDrain(() => mutate(tabId, inboxAction));

async function seed(suffix: string, timestamp = 100) {
  const tabId = `${prefix}-${suffix}`;
  ids.push(tabId);
  expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId, repoPath: process.cwd(), messages: [
      { id: 'u', role: 'user', content: 'Hello', timestamp },
      { id: 'a', role: 'assistant', content: 'Finished', timestamp: timestamp + 1 },
    ] }),
  }))).status).toBe(200);
  return tabId;
}
async function listed(tabId: string) {
  const data = await (await list(new NextRequest('http://localhost/api/mobile/orchestrator/threads?limit=500'))).json();
  return data.threads.find((thread: { id: string }) => thread.id === tabId);
}

async function parkingCandidate(tabId: string, laneStatus: LaneStatus = 'completed', releasedAt?: string) {
  const packetId = `${tabId}-candidate`;
  const repositoryUuid = `${tabId}-repo`;
  const workspacePath = join(getDataDir(), `${packetId}-checkout`);
  const sessionKey = `codex:${packetId}`;
  const lane = createLane({ repoPath: process.cwd(), worktreePath: workspacePath, branch: 'fixture-candidate',
    runtime: 'codex', sessionKey, packetId, baseCommit: 'a'.repeat(40) });
  setLaneStatus(lane.id, laneStatus);
  const packet: OrchestratorPacket = { id: packetId, referenceLabel: 'P1', title: 'Parking candidate', summary: '',
    workspaceTargetPath: process.cwd(), branchTarget: lane.branch, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
    status: 'awaiting_review', blockedReason: null, review: null, attemptCount: 1, orchestratorThreadId: tabId,
    lane: { tileId: 'fixture', tabId: sessionKey, repoPath: process.cwd(), worktreePath: workspacePath,
      runtime: 'codex', sessionKey, laneId: lane.id } };
  const pressurePacket: OrchestratorPacket = { ...packet, id: `${tabId}-held-dispatch`,
    lane: null, orchestratorThreadId: `${tabId}-another-thread`, status: 'blocked', releaseState: 'pending' };
  markPacketReleased(packet, { source: 'approve_and_merge', mergeCommit: 'b'.repeat(40), headSha: 'b'.repeat(40), releasedAt });
  const observation = (targetPath: string): storageAdmission.StorageVolumeObservation => ({
    status: 'observed', targetPath, probePath: process.cwd(), volumeId: 'device:inbox-parking-fixture',
    availableBytes: 50, freeBytes: 50, totalBytes: 1_000, observedAt: Date.now(), error: null,
  });
  // A real durable reserve-breach decision, not a mode flag or a guessed disk threshold.
  const held = await new storageAdmission.StorageAdmissionStore(getSqlite(), { observeVolume: async target => observation(target) }).reserve({
    mutationId: `${tabId}:reserve`, reservationId: `${tabId}:reservation`, targetPath: process.cwd(),
    exactBytes: 100, ownerId: pressurePacket.id, ownerGeneration: 1, leaseExpiresAt: Date.now() + 60_000,
    policy: { reserveRatio: 0, absoluteFloorBytes: 100 },
  });
  expect(held).toMatchObject({ decision: 'held', reason: 'reserve_breached' });
  pressurePacket.storageAdmission = { schema: 'o8/packet-storage-admission/v1', state: 'held', reason: held.reason,
    reservationId: `${tabId}:reservation`, mutationId: held.mutationId, ownerId: pressurePacket.id, ownerGeneration: 1,
    estimateBytes: 100, estimateSource: 'same-repo-history', historySamples: 1, volumeId: held.observation!.volumeId,
    physicalAvailableBytes: held.observation!.availableBytes, reservedBeforeBytes: held.activeReservedBytes,
    requiredReserveBytes: held.requiredReserveBytes, dispatchHeadroomBytes: held.headroomBytes, pressure: null,
    recordedAt: held.recordedAt };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: `${tabId}-mission`,
    repoPath: process.cwd(), packets: [packet, pressurePacket] });
  const snapshot = createWorkspaceSnapshot({ repositoryUuid, packetId, laneId: lane.id,
    originalPath: workspacePath, branch: lane.branch, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    treeSha: 'c'.repeat(40), recoveryRef: `refs/o8/workspace-snapshots/${packetId}`, diffFingerprint: 'fixture-candidate-diff',
    sessionIdentities: [{ kind: 'owned-session', identity: sessionKey }], creationId: `${packetId}:create` }).record;
  const repo = { id: repositoryUuid, localPath: process.cwd(), storagePressureParkingDisabled: false } as RepoRegistryEntry;
  await waitForTerminalLaneWork();
  // The post-step is stubbed, so no checkout is materialized. Terminal cleanup
  // correctly drops absent paths; establish this test's exact current association
  // after that work drains, without fabricating completion or bypassing park guards.
  updateLane(lane.id, { worktreePath: workspacePath }, 'system', { phase: 'test_parking_association' });
  expect(getLane(lane.id)).toMatchObject({ status: laneStatus, packetId, worktreePath: workspacePath });
  expect(readOrchestratorControlPlaneState({ strict: true }).packets.find(candidate => candidate.id === packetId))
    .toMatchObject({ releaseState: 'released', releaseStatePayload: { source: 'approve_and_merge' },
      lane: { laneId: lane.id, sessionKey, worktreePath: workspacePath } });
  return { packet, pressurePacket, lane, repo, snapshot, observation };
}

async function autoParkingCandidate(tabId: string, reason: 'released' | 'idle') {
  const f = await parkingCandidate(tabId, 'completed', reason === 'idle' ? '2000-01-01T00:00:00.000Z' : undefined);
  const subject = inboxSubject('conversation', tabId, process.cwd());
  let now = Date.now();
  if (reason === 'idle') {
    for (const status of ['busy', 'ready']) recordInboxConversationEvent({ event: 'status',
      data: { threadId: tabId, repoPath: process.cwd(), status } });
    const finished = readInboxState(subject);
    expect(finished.runStatus).toBe('idle');
    expect(Date.parse(finished.runAt!)).toBeGreaterThan(Date.parse(f.packet.releaseStatePayload!.releasedAt!));
    now = Date.parse(finished.runAt!) + 4 * 86_400_000;
  }
  const options = { force: true, agents: [], idleDays: reason === 'idle' ? 3 : 0, now };
  expect(collectAutoSettleCandidates(options.idleDays, now).find(candidate => candidate.subject.id === tabId))
    .toMatchObject({ verdict: { reason } });
  return { ...f, subject, options };
}

function parkingPolicy(f: Awaited<ReturnType<typeof parkingCandidate>>, mode: 'manual' | 'pressure' | 'settled' = 'pressure') {
  const defaults = operatorDefaults.getOperatorDefaultsSync();
  const modeSpy = vi.spyOn(operatorDefaults, 'getOperatorDefaultsSync').mockReturnValue({ ...defaults,
    values: { ...defaults.values, workspaceParkingMode: mode, storageReserveRatio: 0, storageReserveFloorGb: 100 / 1_073_741_824 } });
  const reposSpy = vi.spyOn(repos, 'listReposFresh').mockResolvedValue([f.repo]);
  const volumeSpy = vi.spyOn(storageAdmission, 'observeStorageVolume').mockImplementation(async target => f.observation(target));
  return { modeSpy, reposSpy, volumeSpy, restore: () => { modeSpy.mockRestore(); reposSpy.mockRestore(); volumeSpy.mockRestore(); } };
}
afterAll(async () => {
  await waitForTerminalLaneWork();
  if (fixture.previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = fixture.previousClaudeHome;
  for (const tabId of ids) await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
});

describe('inbox settlement through operator mutation and native listings', () => {
  it.each(['released', 'idle'] as const)('parks only after the existing server %s sweep commits settlement, and Undo never restores', async reason => {
    const tabId = await seed(`parking-auto-${reason}`);
    const f = await autoParkingCandidate(tabId, reason);
    const policy = parkingPolicy(f);
    const observed: Array<Record<string, unknown>> = [];
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockImplementation(async () => {
      observed.push({ inTransaction: getSqlite().inTransaction, state: readInboxState(f.subject) });
      return { status: 'refused', code: 'fixture_held', note: 'Automatic parking remains a separate post-step.' };
    });
    const lane = () => getSqlite().prepare('SELECT * FROM lanes WHERE id = ?').get(f.lane.id);
    const release = () => {
      const packet = readOrchestratorControlPlaneState({ strict: true }).packets.find(packet => packet.id === f.packet.id)!;
      return { status: packet.status, releaseState: packet.releaseState, releaseStatePayload: packet.releaseStatePayload };
    };
    const admissionWrites = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM storage_admission_mutations').get() as { count: number }).count;
    const before = { lane: lane(), release: release(), admissionWrites: admissionWrites(),
      messages: readPersistedLlmChat(tabId)!.history.messages };
    try {
      expect(await runAndDrain(() => runInboxAutoSettleSweep(f.options))).toContain(tabId);
      expect(readInboxState(f.subject)).toMatchObject({ settledOverride: 'settled', autoSettledReason: reason });
      expect(park).toHaveBeenCalledTimes(1);
      expect(park.mock.calls[0][0]).toMatchObject({ repositoryUuid: f.repo.id, packetId: f.packet.id });
      expect(observed).toMatchObject([{ inTransaction: false, state: {
        settledOverride: 'settled', settledAt: expect.any(String), autoSettledReason: reason,
      } }]);
      expect(await listed(tabId)).toMatchObject({ settledOverride: 'settled', autoSettledReason: reason });
      expect(lane()).toEqual(before.lane);
      expect(release()).toEqual(before.release);
      expect(admissionWrites()).toBe(before.admissionWrites);
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
      expect(await runAndDrain(() => runInboxAutoSettleSweep(f.options))).not.toContain(tabId);
      expect(park).toHaveBeenCalledTimes(1);
      expect((await mutateAndDrain(tabId, 'unsettle')).status).toBe(200);
      expect(readInboxState(f.subject).settledOverride).toBe('active');
      expect((await listed(tabId)).autoSettledReason).toBeNull();
      expect(await runAndDrain(() => runInboxAutoSettleSweep(f.options))).not.toContain(tabId);
      expect(park).toHaveBeenCalledTimes(1);
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
      expect(readPersistedLlmChat(tabId)!.history.messages).toEqual(before.messages);
    } finally { park.mockRestore(); policy.restore(); }
  });

  it.each(['released', 'idle'] as const)('parks on the %s settle in settled mode with no storage pressure', async reason => {
    const tabId = await seed(`parking-settled-${reason}`);
    const f = await autoParkingCandidate(tabId, reason);
    const policy = parkingPolicy(f, 'settled');
    policy.volumeSpy.mockImplementation(async target => ({ ...f.observation(target), availableBytes: 900, freeBytes: 900 }));
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockResolvedValue({ status: 'refused', code: 'fixture', note: 'Fixture' } as never);
    try {
      expect(await runAndDrain(() => runInboxAutoSettleSweep(f.options))).toContain(tabId);
      expect(park).toHaveBeenCalledTimes(1);
      expect(park.mock.calls[0]![0]).toMatchObject({ repositoryUuid: f.repo.id, packetId: f.packet.id });
    } finally { park.mockRestore(); policy.restore(); }
  });

  it.each(['repository-opt-out', 'unfinished-lane'] as const)('keeps the %s guard in settled mode', async guard => {
    const tabId = await seed(`parking-settled-${guard}`);
    const f = await autoParkingCandidate(tabId, 'released');
    if (guard === 'repository-opt-out') f.repo.storagePressureParkingDisabled = true;
    else setLaneStatus(f.lane.id, 'reviewing');
    const policy = parkingPolicy(f, 'settled');
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockResolvedValue({ status: 'refused', code: 'must_not_run', note: 'Unexpected' } as never);
    try {
      await runAndDrain(() => runInboxAutoSettleSweep(f.options));
      expect(park).not.toHaveBeenCalled();
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
    } finally { park.mockRestore(); policy.restore(); }
  });

  it.each([
    ['released', 'manual'], ['idle', 'manual'],
    ['released', 'repository-opt-out'], ['idle', 'repository-opt-out'],
    ['released', 'thread-opt-out'], ['idle', 'thread-opt-out'],
    ['released', 'healthy'], ['idle', 'healthy'],
  ] as const)('keeps the server %s sweep parking guard for %s', async (reason, guard) => {
    const tabId = await seed(`parking-auto-${reason}-${guard}`);
    const f = await autoParkingCandidate(tabId, reason);
    if (guard === 'repository-opt-out') f.repo.storagePressureParkingDisabled = true;
    if (guard === 'thread-opt-out') expect((await PATCH(request({ tabId, inboxAction: 'auto-settle',
      inboxRevision: readInboxState(f.subject).inboxRevision ?? 0, enabled: false }))).status).toBe(200);
    const policy = parkingPolicy(f, guard === 'manual' ? 'manual' : 'pressure');
    if (guard === 'healthy') policy.volumeSpy.mockImplementation(async target => ({ ...f.observation(target), availableBytes: 900, freeBytes: 900 }));
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockResolvedValue({ status: 'refused', code: 'must_not_run', note: 'Unexpected automatic parking.' });
    try {
      const settled = await runAndDrain(() => runInboxAutoSettleSweep(f.options));
      if (guard === 'thread-opt-out') {
        expect(settled).not.toContain(tabId);
        expect(readInboxState(f.subject)).toMatchObject({ settledOverride: null, autoSettleDisabledAt: expect.any(String) });
      } else {
        expect(settled).toContain(tabId);
        expect(readInboxState(f.subject)).toMatchObject({ settledOverride: 'settled', autoSettledReason: reason });
      }
      expect(park).not.toHaveBeenCalled();
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
    } finally { park.mockRestore(); policy.restore(); }
  });

  it.each(['completed', 'reviewing'] as const)('requires real completed settled ownership for automatic pressure parking (%s)', async status => {
    const tabId = await seed(`pressure-automation-${status}`);
    const f = await parkingCandidate(tabId, status);
    const subject = inboxSubject('conversation', tabId, process.cwd());
    mutateInboxSettlement(subject, 'settle', () => {});
    const reserve = vi.fn(async () => { throw new PacketStorageAdmissionError('Real durable reserve breach',
      f.pressurePacket.storageAdmission! as PacketStorageAdmissionReceipt); });
    const base: PacketStorageAdmissionCoordinator = { reserveForLaunch: reserve,
      commitAfterLaunch: async lease => lease.receipt, settleFailedLaunch: async (_packet, lease) => lease.receipt };
    const park = vi.fn(async (input: import('@/lib/workspace/hibernator').ParkWorkspaceInput) => {
      expect(getLane(f.lane.id)?.status).toBe('completed');
      expect(readInboxState(subject).settledOverride).toBe('settled');
      await input.assertPolicyCurrent?.();
      return { status: 'refused' as const, code: 'fixture_held', note: 'Exact physical parking is covered by the managed Git service tests.' };
    });
    const coordinator = createStoragePressureAdmissionCoordinator(base, { mode: () => 'pressure',
      listLanes: () => [getLane(f.lane.id)!], listRepos: async () => [f.repo],
      observeVolume: async target => f.observation(target), measureAllocatedBytes: async () => 400,
      getSnapshot: () => null, parkWorkspace: park });
    const admissionCount = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM storage_admission_mutations').get() as { count: number }).count;
    const before = admissionCount();
    await expect(coordinator.reserveForLaunch(f.pressurePacket)).rejects.toMatchObject({ receipt: { pressure: { status: 'exhausted' } } });
    expect(park).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(admissionCount()).toBe(before);
  });

  it('returns durable Settle before a pending parking post-step and performs no storage admission retry', async () => {
    const tabId = await seed('parking-postcommit');
    const f = await parkingCandidate(tabId);
    const policy = parkingPolicy(f);
    const subject = inboxSubject('conversation', tabId, process.cwd());
    let releasePark!: () => void;
    const pending = new Promise<void>(resolve => { releasePark = resolve; });
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockImplementation(async () => {
      expect(getSqlite().inTransaction).toBe(false);
      expect(readInboxState(subject).settledOverride).toBe('settled');
      await pending;
      return { status: 'refused', code: 'fixture_held', note: 'The post-step remains separate.' };
    });
    const admissionWrites = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM storage_admission_mutations').get() as { count: number }).count;
    const before = admissionWrites();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([mutate(tabId, 'settle'), new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 1_000); })]);
      expect(response, 'Settle must answer while filesystem parking is pending').not.toBeNull();
      expect(response!.status).toBe(200);
      expect(readInboxState(subject)).toMatchObject({ settledOverride: 'settled', settledAt: expect.any(String) });
      await expect.poll(() => park.mock.calls.length).toBe(1);
      expect(park.mock.calls[0][0]).toMatchObject({ repositoryUuid: f.repo.id, packetId: f.packet.id });
      expect(admissionWrites()).toBe(before);
      releasePark();
      await pending;
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
      expect((await listed(tabId)).settledOverride).toBe('settled');
    } finally { if (deadline) clearTimeout(deadline); releasePark(); park.mockRestore(); policy.restore(); }
  });

  it.each(['parked', 'already_parked'] as const)('publishes real %s completion after Settle answers and exposes the current receipt', async status => {
    const tabId = await seed(`parking-delayed-${status}`);
    const f = await parkingCandidate(tabId);
    const policy = parkingPolicy(f);
    let releasePark!: () => void;
    const pending = new Promise<void>(resolve => { releasePark = resolve; });
    const publish = vi.spyOn(realtime, 'publishRealtimeMutation').mockResolvedValue(true);
    const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockImplementation(async input => {
      await pending;
      let snapshot = f.snapshot;
      for (const state of ['parkable', 'hibernating', 'parked'] as const) {
        snapshot = transitionWorkspaceSnapshot({ repositoryUuid: f.repo.id, packetId: f.packet.id,
          transitionId: `${input.operationId}:${state}`, expectedState: snapshot.state, expectedVersion: snapshot.version,
          expectedGeneration: snapshot.snapshotGeneration, toState: state,
          receipt: state === 'parked' ? { reclaimedAvailableBytes: -1024 } : {} }).record!;
      }
      return { status, snapshot };
    });
    try {
      expect((await mutate(tabId, 'settle')).status).toBe(200);
      await expect.poll(() => park.mock.calls.length).toBe(1);
      expect(publish).not.toHaveBeenCalled();
      expect(await listed(tabId)).not.toHaveProperty('parkedWorkspaces');
      releasePark();
      await expect.poll(() => publish.mock.calls.length).toBe(1);
      expect(publish.mock.calls[0][0]).toMatchObject({ mutation: {
        mutationId: park.mock.calls[0][0].operationId, source: 'server', action: 'workspace.park', status: 'completed',
        packetId: f.packet.id, repoPath: f.lane.repoPath,
      } });
      expect(publish.mock.calls[0][0].mutation).not.toHaveProperty('laneStatus');
      expect(await listed(tabId)).toMatchObject({ settledOverride: 'settled', parkedWorkspaces: [{
        packetId: f.packet.id, repositoryUuid: f.repo.id, reclaimedAvailableBytes: -1024,
      }] });
      expect((await mutateAndDrain(tabId, 'unsettle')).status).toBe(200);
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)?.state).toBe('parked');
      expect(publish).toHaveBeenCalledTimes(1);
    } finally { releasePark(); park.mockRestore(); publish.mockRestore(); policy.restore(); }
  });

  it.each(['manual', 'opted-out', 'healthy', 'wrong-volume', 'unknown-volume', 'missing-target', 'reviewing'] as const)(
    'keeps settlement separate and skips automatic parking for %s', async reason => {
      const tabId = await seed(`parking-skip-${reason}`);
      const f = await parkingCandidate(tabId, reason === 'reviewing' ? 'reviewing' : 'completed');
      if (reason === 'missing-target') {
        const state = readOrchestratorControlPlaneState({ strict: true });
        state.packets.find(packet => packet.id === f.pressurePacket.id)!.workspaceTargetPath = null;
        writeOrchestratorControlPlaneState(state);
      }
      if (reason === 'opted-out') f.repo.storagePressureParkingDisabled = true;
      const policy = parkingPolicy(f, reason === 'manual' ? 'manual' : 'pressure');
      if (reason === 'healthy') policy.volumeSpy.mockImplementation(async target => ({ ...f.observation(target), availableBytes: 900, freeBytes: 900 }));
      if (reason === 'wrong-volume') policy.volumeSpy.mockImplementation(async target => ({ ...f.observation(target), volumeId: 'device:other' }));
      if (reason === 'unknown-volume') policy.volumeSpy.mockImplementation(async target => ({ ...f.observation(target), status: 'unknown', volumeId: null }));
      const park = vi.spyOn(workspaceParking, 'parkWorkspace').mockResolvedValue({ status: 'refused', code: 'must_not_run', note: 'Unexpected parking.' });
      try {
        expect((await mutateAndDrain(tabId, 'settle')).status).toBe(200);
        expect(park).not.toHaveBeenCalled();
        expect(readInboxState(inboxSubject('conversation', tabId, process.cwd())).settledOverride).toBe('settled');
        expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
      } finally { park.mockRestore(); policy.restore(); }
    },
  );

  it.each([2_147_483_648, 0, null])('projects a parked packet receipt (%s bytes) without restoring on Unsettle', async reclaimedAvailableBytes => {
    const tabId = await seed(`parked-${reclaimedAvailableBytes ?? 'unknown'}`);
    const packetId = `${tabId}-packet`;
    const repositoryUuid = `${tabId}-repo`;
    const sessionKey = `codex:${packetId}`;
    const workspacePath = join(getDataDir(), `${packetId}-absent-checkout`);
    const lane = createLane({ repoPath: process.cwd(), worktreePath: workspacePath, branch: 'fixture-parked',
      runtime: 'codex', sessionKey, packetId, baseCommit: 'a'.repeat(40) });
    setLaneStatus(lane.id, 'completed');
    const packet: OrchestratorPacket = { id: packetId, referenceLabel: 'P1', title: 'Parked packet', summary: '',
      workspaceTargetPath: process.cwd(), branchTarget: lane.branch, runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
      status: 'awaiting_review', blockedReason: null, review: null, attemptCount: 1, orchestratorThreadId: tabId,
      lane: { tileId: 'fixture', tabId: sessionKey, repoPath: process.cwd(), worktreePath: workspacePath,
        runtime: 'codex', sessionKey, laneId: lane.id } };
    markPacketReleased(packet, { source: 'approve_and_merge', mergeCommit: 'b'.repeat(40), headSha: 'b'.repeat(40) });
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: `${tabId}-mission`,
      repoPath: process.cwd(), packets: [packet] });
    let snapshot = createWorkspaceSnapshot({ repositoryUuid, packetId, laneId: lane.id,
      originalPath: workspacePath, branch: lane.branch, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
      treeSha: 'c'.repeat(40), recoveryRef: `refs/o8/workspace-snapshots/${packetId}`, diffFingerprint: 'fixture-diff',
      sessionIdentities: [{ kind: 'owned-session', identity: sessionKey }], creationId: `${packetId}:create` }).record;
    for (const state of ['parkable', 'hibernating', 'parked'] as const) {
      snapshot = transitionWorkspaceSnapshot({ repositoryUuid, packetId, transitionId: `${packetId}:${state}`,
        expectedState: snapshot.state, expectedVersion: snapshot.version, expectedGeneration: snapshot.snapshotGeneration,
        toState: state, receipt: state === 'parked' && reclaimedAvailableBytes !== null ? { reclaimedAvailableBytes } : {} }).record!;
    }
    await waitForTerminalLaneWork();
    updateLane(lane.id, { worktreePath: null }, 'system', { phase: 'bounded_maintenance', worktreeRemoved: true });
    expect(getLane(lane.id)).toMatchObject({ status: 'completed', worktreePath: null });
    const messages = readPersistedLlmChat(tabId)!.history.messages;
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    const expected = [{ packetId, repositoryUuid, reclaimedAvailableBytes }];
    const repoRead = vi.spyOn(repos, 'listRepos').mockResolvedValue([{ id: repositoryUuid, localPath: process.cwd() } as RepoRegistryEntry]);
    try {
      const state = await controlPlaneStatus(new NextRequest('http://localhost/api/orchestrator/state',
        { headers: { host: 'localhost' } }));
      expect(state.status).toBe(200);
      const body = await state.json();
      expect(body.agents).toEqual([]);
      expect(body.mission.packets.find((row: OrchestratorPacket) => row.id === packetId))
        .toMatchObject({ status: 'released', queueState: 'held', releaseState: 'released', lane: packet.lane });
      expect(readOrchestratorControlPlaneState({ strict: true }).packets.find(row => row.id === packetId))
        .toMatchObject({ lane: packet.lane });
      expect(getWorkspaceSnapshot(repositoryUuid, packetId)).toEqual(snapshot);
      const status = await workspaceStatus(new NextRequest(`http://localhost/api/orchestrator/workspace?packetId=${packetId}`,
        { headers: { host: 'localhost' } }));
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ result: { state: 'parked', canRestore: true, canPark: false } });
      updateLane(lane.id, { worktreePath: `${workspacePath}-conflict` }, 'system');
      const conflict = await workspaceStatus(new NextRequest(`http://localhost/api/orchestrator/workspace?packetId=${packetId}`,
        { headers: { host: 'localhost' } }));
      expect(await conflict.json()).toMatchObject({ result: { canRestore: false } });
      expect(await listed(tabId)).not.toHaveProperty('parkedWorkspaces');
      updateLane(lane.id, { worktreePath: null }, 'system');
    } finally { repoRead.mockRestore(); }
    expect(await listed(tabId)).toMatchObject({ settledOverride: 'settled', parkedWorkspaces: expected });
    const histories = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
    expect(histories.conversations.find((row: { tabId: string }) => row.tabId === tabId))
      .toMatchObject({ settledOverride: 'settled', parkedWorkspaces: expected });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle', approvalStatus: 'none' }];
    try {
      const runtime = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
      expect(runtime.agents[0]).toMatchObject({ parentInboxSubject: { kind: 'conversation', id: tabId }, parkedWorkspaces: expected });
      expect((await mutate(tabId, 'unsettle')).status).toBe(200);
      expect(readInboxState(inboxSubject('conversation', tabId, process.cwd())).settledOverride).toBe('active');
      expect(getWorkspaceSnapshot(repositoryUuid, packetId)).toEqual(snapshot);
      expect(existsSync(workspacePath)).toBe(false);
      expect(readPersistedLlmChat(tabId)!.history.messages).toEqual(messages);
      expect(readPersistedLlmChat(tabId)!.history).not.toHaveProperty('archivedAt', expect.any(String));
    } finally { fixture.agents = []; }
  });

  it.each(['missing-lane', 'wrong-session', 'wrong-packet', 'wrong-repo', 'conflicting-path', 'attached', 'reviewing'] as const)(
    'clears a released packet binding through state GET when its completed owner is %s', async mismatch => {
      const f = await parkingCandidate(await seed(`stale-binding-${mismatch}`));
      const state = readOrchestratorControlPlaneState({ strict: true });
      const packet = state.packets.find(row => row.id === f.packet.id)!;
      if (mismatch === 'missing-lane') packet.lane!.laneId = 'missing-lane';
      if (mismatch === 'wrong-session') packet.lane!.sessionKey = 'codex:another-session';
      writeOrchestratorControlPlaneState(state);
      if (mismatch === 'wrong-packet') updateLane(f.lane.id, { packetId: f.pressurePacket.id }, 'system');
      if (mismatch === 'wrong-repo') getSqlite().prepare('UPDATE lanes SET repo_path = ? WHERE id = ?').run(`${process.cwd()}-other`, f.lane.id);
      if (mismatch === 'conflicting-path') updateLane(f.lane.id, { worktreePath: `${f.snapshot.originalPath}-other` }, 'system');
      if (mismatch === 'attached') getSqlite().prepare('UPDATE lanes SET ownership = ? WHERE id = ?').run('attached', f.lane.id);
      if (mismatch === 'reviewing') updateLane(f.lane.id, { status: 'reviewing' }, 'system');
      const response = await controlPlaneStatus(new NextRequest('http://localhost/api/orchestrator/state',
        { headers: { host: 'localhost' } }));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(readOrchestratorControlPlaneState({ strict: true }).packets.find(row => row.id === f.packet.id))
        .toMatchObject({ status: 'released', queueState: 'held', releaseState: 'released', lane: null });
      expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)).toEqual(f.snapshot);
    },
  );

  it('round-trips settle/unsettle and repeat timestamps without archiving or dropping messages', async () => {
    const tabId = await seed('roundtrip');
    expect(await listed(tabId)).toMatchObject({ settledOverride: null, settledAt: null, unsettledAt: null });
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    const settled = await listed(tabId);
    const archiveRows = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
    expect(archiveRows.conversations.find((row: { tabId: string }) => row.tabId === tabId)).toMatchObject({ settledOverride: 'settled', settledAt: settled.settledAt });
    expect(settled).toMatchObject({ inboxSubject: { kind: 'conversation', id: tabId }, settledOverride: 'settled', settledAt: expect.any(String), unsettledAt: null });
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    expect(await listed(tabId)).toEqual(settled);
    expect((await mutate(tabId, 'unsettle')).status).toBe(200);
    const active = await listed(tabId);
    expect(active).toMatchObject({ settledOverride: 'active', settledAt: null, unsettledAt: expect.any(String) });
    await mutate(tabId, 'unsettle');
    expect(await listed(tabId)).toEqual(active);
    const pending = createApproval({ source: 'test', runtime: 'llm-chat', agent: 'fixture', sessionKey: `llm-chat:${tabId}`,
      title: 'Chat approval', description: 'Pending', summary: 'Pending', risk: 'low' });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(pending.id);
    const saved = await (await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`))).json();
    expect(saved.messages.map((m: { id: string }) => m.id)).toEqual(['u', 'a']);
    expect(saved.archivedAt).toBeNull();
  });

  it('omits null inbox fields from GET rows while preserving capability and the full PATCH shape', async () => {
    const tabId = await seed('compact-get');
    const readHistory = async () => {
      const body = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
      return body.conversations.find((row: { tabId: string }) => row.tabId === tabId);
    };
    const empty = await readHistory();
    expect(empty.inboxSubject).toMatchObject({ kind: 'conversation', id: tabId });
    for (const field of ['settledOverride', 'settledAt', 'unsettledAt', 'parentInboxSubject']) {
      expect(empty).not.toHaveProperty(field);
    }
    const settled = await (await mutate(tabId, 'settle')).json();
    expect(settled).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'settled',
      settledAt: expect.any(String), unsettledAt: null });
    const settledRow = await readHistory();
    expect(settledRow).toMatchObject({ inboxSubject: empty.inboxSubject, settledOverride: 'settled', settledAt: settled.settledAt });
    expect(settledRow).not.toHaveProperty('unsettledAt');
    expect(settledRow).not.toHaveProperty('parentInboxSubject');
    const active = await (await mutate(tabId, 'unsettle')).json();
    expect(active).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'active',
      settledAt: null, unsettledAt: expect.any(String) });
    const activeRow = await readHistory();
    expect(activeRow).toMatchObject({ settledOverride: 'active', unsettledAt: active.unsettledAt });
    expect(activeRow).not.toHaveProperty('settledAt');

    const previousAgents = fixture.agents;
    fixture.agents = [{ sessionKey: `codex:compact-${process.pid}`, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } } }];
    try {
      const body = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
      expect(body.agents[0].inboxSubject).toMatchObject({ kind: 'runtime', id: fixture.agents[0].sessionKey });
      for (const field of ['settledOverride', 'settledAt', 'unsettledAt', 'parentInboxSubject']) {
        expect(body.agents[0]).not.toHaveProperty(field);
      }
      const patch = await (await PATCH(request({ sessionKey: fixture.agents[0].sessionKey, inboxAction: 'unsettle' }))).json();
      expect(patch).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'active', settledAt: null,
        unsettledAt: expect.any(String) });
    } finally { fixture.agents = previousAgents; }
  });

  it.each([-1, 1])('rejects queued-turn grace with clock skew direction %s', async direction => {
    const tabId = await seed(`grace-${direction}`, Date.now() + direction * 60_000);
    // An unadopted user send, rather than an assistant-completed turn.
    await POST(new NextRequest('http://localhost/api/v2/chat-history', { method: 'POST', body: JSON.stringify({ tabId, replace: true, messages: [{ id: 'u', role: 'user', content: 'queued', timestamp: Date.now() + direction * 60_000 }] }) }));
    expect((await mutate(tabId, 'settle')).status).toBe(409);
  });

  it('settles a plain chat without a runtime inventory scan but scans for bound runtime sessions', async () => {
    const tabId = await seed('noscan');
    const git = threadGitContext(process.cwd());
    expect(await listed(tabId)).toMatchObject({ repoSlug: git.repoSlug, branch: git.branch ?? null });
    fixture.scans = 0;
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    expect((await mutate(tabId, 'unsettle')).status).toBe(200);
    expect(fixture.scans).toBe(0);
    const record = readPersistedLlmChat(tabId)!.history;
    persistCanonicalChatHistoryRecord(tabId, { ...record, orchestratorSessionIds: { claude: 'bound-noscan' } });
    fixture.agents = [{ sessionKey: 'claude-code:bound-noscan', status: 'running', runtime: 'claude-code' }];
    try {
      expect((await mutate(tabId, 'settle')).status).toBe(409);
      expect(fixture.scans).toBe(1);
      fixture.agents = [{ sessionKey: 'claude-code:bound-noscan', status: 'idle', runtime: 'claude-code' }];
      expect((await mutate(tabId, 'settle')).status).toBe(200);
    } finally { fixture.agents = []; }
  });

  it('lists a run start that survives repeated busy events and clears when idle', async () => {
    const tabId = await seed('timer');
    const event = (status: string) => recordInboxConversationEvent({ event: 'status', data: { threadId: tabId, repoPath: process.cwd(), status } });
    expect((await listed(tabId)).runStartedAt).toBeNull();
    event('busy');
    const started = (await listed(tabId)).runStartedAt;
    expect(started).toEqual(expect.any(String));
    await new Promise(r => setTimeout(r, 5));
    event('busy');
    expect((await listed(tabId)).runStartedAt).toBe(started);
    event('ready');
    expect((await listed(tabId)).runStartedAt).toBeNull();
  });

  it('rejects an actual durable queued send', async () => {
    const tabId = await seed('queued');
    enqueueComposerSend({ id: `${prefix}-queue`, repoPath: process.cwd(), threadId: tabId, intent: 'send-next', payload: {
      text: 'next', wireMessage: 'next', images: [], routing: { backend: 'codex', model: 'gpt-5', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false },
    } });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
  });

  it('persists a standalone runtime subject and rejects running and pending approval', async () => {
    const sessionKey = `codex:inbox-${process.pid}`;
    const lane = createLane({ repoPath: process.cwd(), branch: 'fixture', runtime: 'codex', sessionKey, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle', approvalStatus: 'none' }];
    const patch = () => PATCH(request({ sessionKey, inboxAction: 'settle' }));
    setLaneStatus(lane.id, 'running');
    expect((await patch()).status).toBe(409);
    setLaneStatus(lane.id, 'idle');
    fixture.agents[0].status = 'reviewing';
    expect((await patch()).status).toBe(200);
    fixture.agents[0].status = 'idle';
    const snapshot = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(snapshot.agents[0]).toMatchObject({ inboxSubject: { kind: 'runtime', id: sessionKey }, settledOverride: 'settled', settledAt: expect.any(String) });
    expect(snapshot.agents[0]).not.toHaveProperty('parentInboxSubject');
    createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey, title: 'Approval', description: 'Pending', summary: 'Pending', risk: 'low' });
    expect((await patch()).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE session_key = ?').run(sessionKey);
    expect((await PATCH(request({ sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
    fixture.agents[0].lastActivityAt = Date.now() + 1_000;
    const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
    expect((await read()).settledOverride).toBe('active');
    fixture.transcript = [{ id: 'runtime-run', role: 'user', text: 'Actual new run', timestamp: new Date(Date.now() + 1), activityAt: new Date(Date.now() + 1) }];
    expect(await read()).not.toHaveProperty('settledOverride');
    expect((await patch()).status).toBe(409); // Recent runtime user message not yet adopted.
    fixture.transcript = [];
  });

  it('reads lanes once per poll and writes no app_state rows after adopting unchanged activity', async () => {
    fixture.agents = Array.from({ length: 4 }, (_, index) => ({
      sessionKey: `codex:poll-${process.pid}-${index}`, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } },
    }));
    const poll = () => inventory(new NextRequest('http://localhost/api/runtime/inventory'));
    expect((await poll()).status).toBe(200); // Adopt the initial observations.
    expect((await PATCH(request({ sessionKey: fixture.agents[0].sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
    const statementPrototype = Object.getPrototypeOf(getSqlite().prepare('SELECT 1')) as {
      all: (...parameters: unknown[]) => unknown[];
      run: (...parameters: unknown[]) => unknown;
    };
    const all = statementPrototype.all;
    let laneReads = 0;
    const trace = vi.spyOn(statementPrototype, 'all').mockImplementation(function(this: { source: string }, ...parameters: unknown[]) {
      if (/\bFROM\s+["`]?lanes\b/i.test(this.source)) laneReads += 1;
      return all.apply(this, parameters);
    });
    const run = statementPrototype.run;
    let stateWrites = 0;
    const writes = vi.spyOn(statementPrototype, 'run').mockImplementation(function(this: { source: string }, ...parameters: unknown[]) {
      if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?app_state\b/i.test(this.source)) stateWrites += 1;
      return run.apply(this, parameters);
    });
    const transaction = vi.spyOn(getSqlite(), 'transaction');
    try {
      for (let index = 0; index < 3; index++) {
        const snapshot = await (await poll()).json();
        expect(snapshot.agents).toHaveLength(4);
        expect(snapshot.agents[0].settledOverride).toBe('active');
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(stateWrites).toBe(0);
      expect(laneReads).toBe(1); // First poll refreshes after PATCH; subsequent revision checks reuse it.
      fixture.agents[0].runtimeSurface = { lifecycle: { lastRunStartedAt: new Date(Date.now() + 1_000).toISOString() } };
      const advanced = await (await poll()).json();
      expect(advanced.agents[0]).not.toHaveProperty('settledOverride');
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(stateWrites).toBe(1);
    } finally {
      trace.mockRestore();
      writes.mockRestore();
      transaction.mockRestore();
      fixture.agents = [];
    }
  });

  it('shares canonical workspace identities across reads and mutations until the bounded TTL expires', async () => {
    const root = join(getDataDir(), 'inbox-workspace-cache');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const link = join(root, 'link');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    symlinkSync(first, link);
    const tabId = await seed('workspace-cache');
    const file = join(getDataDir(), 'chat-history', `${tabId}.json`);
    const history = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...history, repoPath: link }));
    const native = vi.spyOn(realpathSync, 'native');
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    const read = async () => {
      const snapshot = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
      return snapshot.conversations.find((row: { tabId: string }) => row.tabId === tabId);
    };
    try {
      clock.mockReturnValue(now);
      expect((await mutate(tabId, 'unsettle')).status).toBe(200);
      unlinkSync(link);
      symlinkSync(second, link);
      expect(await read()).toMatchObject({ inboxSubject: { workspace: first }, settledOverride: 'active' });
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(1);
      clock.mockReturnValue(now + 30_001);
      const moved = await read();
      expect(moved).toMatchObject({ inboxSubject: { workspace: second } });
      expect(moved).not.toHaveProperty('settledOverride');
      expect((await mutate(tabId, 'unsettle')).status).toBe(200);
      expect(await read()).toMatchObject({ inboxSubject: { workspace: second }, settledOverride: 'active' });
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(2);
      // Eviction forces resolution again even before the TTL expires.
      for (let index = 0; index < 256; index++) inboxSubject('runtime', 'cache-bound', join(root, `offline-${index}`));
      expect(inboxSubject('conversation', tabId, link).workspace).toBe(second);
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(3);
    } finally {
      native.mockRestore();
      clock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates lane identities after both external commits and local writes', async () => {
    const sessionKey = `codex:lane-cache-${process.pid}`;
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } } }];
    const lane = createLane({ repoPath: process.cwd(), branch: 'cache-invalidation', runtime: 'codex', sessionKey, baseCommit: 'a'.repeat(40) });
    const otherWorkspace = join(getDataDir(), 'inbox-external-workspace');
    mkdirSync(otherWorkspace, { recursive: true });
    const external = new Database(getSqlite().name);
    const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
    try {
      expect((await read()).inboxSubject.workspace).toBe(realpathSync.native(process.cwd()));
      external.prepare('UPDATE lanes SET repo_path = ? WHERE id = ?').run(otherWorkspace, lane.id);
      expect((await read()).inboxSubject.workspace).toBe(otherWorkspace);
      getSqlite().prepare('UPDATE lanes SET repo_path = ? WHERE id = ?').run(process.cwd(), lane.id);
      expect((await read()).inboxSubject.workspace).toBe(realpathSync.native(process.cwd()));
    } finally {
      external.close();
      fixture.agents = [];
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it('represents packet workers under the parent and blocks independent settlement', async () => {
    const tabId = await seed('parent');
    const sessionKey = `codex:child-${process.pid}`;
    const packetId = `inbox-child-${process.pid}`;
    const lane = createLane({ repoPath: process.cwd(), branch: 'fixture-child', runtime: 'codex', sessionKey, packetId, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const packet = { id: packetId, referenceLabel: 'inline-1', title: 'Child', summary: 'Child',
      workspaceTargetPath: process.cwd(), branchTarget: 'fixture-child', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
      status: 'idle', review: null, orchestratorThreadId: tabId } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'inbox-parent', repoPath: process.cwd(), packets: [packet] });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle', approvalStatus: 'none' }];
    expect((await PATCH(request({ sessionKey, inboxAction: 'settle' }))).status).toBe(409);
    setLaneStatus(lane.id, 'running');
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    setLaneStatus(lane.id, 'idle');
    const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey: 'review:synthetic',
      title: 'Packet approval', description: 'Pending', summary: 'Pending', risk: 'low', metadata: { Packet: packetId, Lane: lane.id } });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(approval.id);
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    const snapshot = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(snapshot.agents[0]).toMatchObject({ inboxSubject: { kind: 'conversation', id: tabId },
      parentInboxSubject: { kind: 'conversation', id: tabId }, settledOverride: 'settled' });
    expect(readFileSync(join(getDataDir(), 'chat-history', `${tabId}.json`), 'utf8')).toContain('Finished');
    setLaneStatus(lane.id, 'archived');
    const standalone = createLane({ repoPath: process.cwd(), branch: 'new-standalone', runtime: 'codex', sessionKey, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const reused = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(reused.agents[0]).toMatchObject({ inboxSubject: { kind: 'runtime', id: sessionKey } });
    expect(reused.agents[0]).not.toHaveProperty('parentInboxSubject');
    setLaneStatus(standalone.id, 'running');
    fixture.agents[0].status = 'running';
    expect((await mutate(tabId, 'settle')).status).toBe(200);
  });

  it('waits for a concurrent transcript append and reloads settlement in a fresh process', async () => {
    const tabId = await seed('race');
    const marker = join(getDataDir(), `${tabId}-locked`);
    const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
      import { writeFileSync } from 'node:fs';
      const store = (await import('./src/lib/llm/chat-history-store.ts')).default;
      store.withCanonicalChatHistoryLock(process.env.B01_TAB_ID, () => {
        writeFileSync(process.env.B01_MARKER, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        const record = store.readPersistedLlmChat(process.env.B01_TAB_ID).history;
        store.persistCanonicalChatHistoryRecord(process.env.B01_TAB_ID, { ...record,
          messages: [...record.messages, { id: 'race', role: 'assistant', content: 'Concurrent reply', timestamp: 102 }] });
      });
    `], { cwd: process.cwd(), env: { ...process.env, B01_TAB_ID: tabId, B01_MARKER: marker }, stdio: 'pipe' });
    let childOutput = '';
    child.stderr?.on('data', chunk => { childOutput += String(chunk); });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 45_000;
    try {
      while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(marker), childOutput).toBe(true);
      expect((await mutate(tabId, 'settle')).status).toBe(200);
      expect((await exited)[0]).toBe(0);
      const saved = await (await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`))).json();
      expect(saved.messages.map((m: { id: string }) => m.id)).toEqual(['u', 'a', 'race']);
      const reload = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
        const store = (await import('./src/lib/inbox/store.ts')).default;
        const state = store.inboxProjection(store.inboxSubject('conversation', process.env.B01_TAB_ID, process.cwd()));
        if (state.settledOverride !== 'settled' || !state.settledAt) process.exitCode = 1;
      `], { cwd: process.cwd(), env: { ...process.env, B01_TAB_ID: tabId }, stdio: 'pipe' });
      expect((await once(reload, 'exit'))[0]).toBe(0);
      expect(await listed(tabId)).toMatchObject({ settledOverride: 'settled', settledAt: expect.any(String) });
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
      rmSync(marker, { force: true });
    }
  }, 120_000);

  it('ignores inferred provider timestamps and clears only on authentic runtime activity', async () => {
    const sessionKey = 'claude-code:inbox-authentic';
    const project = join(fixture.claudeHome, 'projects', 'inbox-project');
    mkdirSync(project, { recursive: true });
    const file = join(project, 'inbox-authentic.jsonl');
    const historical = { type: 'user', uuid: 'historical', message: { content: 'Historical message' } };
    writeFileSync(file, JSON.stringify(historical) + '\n');
    fixture.realTranscript = true;
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'claude-code', status: 'idle', approvalStatus: 'none' }];
    try {
      expect((await PATCH(request({ sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
      const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
      expect((await read()).settledOverride).toBe('active');
      writeFileSync(file, [historical, { type: 'user', uuid: 'new-run', timestamp: new Date(Date.now() + 1).toISOString(), message: { content: 'New run' } }].map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(await read()).not.toHaveProperty('settledOverride');
    } finally { fixture.realTranscript = false; }
  });

  it('rejects invalid actions and unknown or wrong-workspace subjects', async () => {
    const tabId = await seed('validation');
    expect((await mutate(tabId, 'invalid')).status).toBe(400);
    expect((await mutate(`${prefix}-missing`, 'settle')).status).toBe(404);
    expect((await PATCH(request({ tabId, inboxAction: 'settle' }, '?workspace=/different'))).status).toBe(404);
    expect((await PATCH(request({ sessionKey: 'codex:unknown', inboxAction: 'settle' }))).status).toBe(404);
  });
});
