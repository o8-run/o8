import { once } from 'node:events';
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));

const worktreeFailure = vi.hoisted(() => new Error('synthetic packet worktree provision failure'));

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: vi.fn(async () => {
      throw worktreeFailure;
    }),
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/workspace/manifest/terminal-release', () => ({
  settleTerminalWorkspaceManifestAndLeases: vi.fn(async () => undefined),
  settleWorkspaceManifestOnTerminal: vi.fn(),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-storage-provision-failure-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;

for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const gib = 1024 * 1024 * 1024;
const availableBytes = 20 * gib;
const estimateBytes = 8 * gib;

function packet(id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: 'exercise storage release after provision failure',
    workspaceTargetPath: repoPath,
    branchTarget: `packet/${id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
  };
}

function mission(target: OrchestratorPacket): OrchestratorMissionState {
  return {
    missionId: `mission-${target.id}`,
    repoPath,
    runtime: 'codex',
    packets: [target],
    updatedAt: new Date().toISOString(),
  } as OrchestratorMissionState;
}

function observed(targetPath: string): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: worktreeRoot,
    volumeId: 'device:provision-failure-test',
    availableBytes,
    freeBytes: availableBytes,
    totalBytes: 100 * gib,
    observedAt: Date.now(),
    error: null,
  };
}

let apiBase: string;
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, apiBase);
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  const req = new NextRequest(url, { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } });
  const routes: Record<string, () => Promise<Response>> = {
    '/api/orchestrator/lead': async () => (await import('@/lib/orchestrator/http/lead')).GET(req),
    '/api/orchestrator/status': async () => (await import('@/app/api/orchestrator/status/route')).GET(req),
    '/api/orchestrator/lane-events': async () => (await import('@/app/api/orchestrator/lane-events/route')).GET(req),
    '/api/orchestrator/packet-transcript': async () => (await import('@/app/api/orchestrator/packet-transcript/route')).GET(req),
    '/api/operator/status': async () => (await import('@/app/api/operator/status/route')).GET(req),
  };
  try {
    const result = await (routes[url.pathname]?.() ?? Promise.resolve(Response.json({})));
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(await result.text());
  } catch (error) { response.writeHead(500).end(String(error)); }
});

function parseResult(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text!);
}

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  apiBase = `http://127.0.0.1:${address.port}`;
  const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
  setApiBase(apiBase);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'api-port'), String(address.port));
  vi.stubEnv('O8_API_PORT', String(address.port));
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), 'storage provision failure real path\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.name=o8 test',
    '-c', 'user.email=o8@test.invalid',
    'commit', '-m', 'init',
  ], { cwd: repoPath, stdio: 'pipe' });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});


async function storageFixture(volumeId?: string) {
  const observeFixtureVolume = async (targetPath: string) => ({ ...observed(targetPath), ...(volumeId ? { volumeId } : {}) });
  const [
    { launchPacketWithStorageAdmission },
    { resolveWorkerRouting },
    { createPacketStorageAdmissionCoordinator },
    { StorageAdmissionStore },
    controlPlane,
    laneRegistry,
    { getSqlite },
  ] = await Promise.all([
    import('@/lib/orchestrator/dispatch-packet-launch'),
    import('@/lib/agents/routing'),
    import('@/lib/orchestrator/storage-admission'),
    import('@/lib/workspace/storage-admission'),
    import('@/lib/orchestrator/control-plane'),
    import('@/lib/lane/registry'),
    import('@/lib/db'),
  ]);
  const sqlite = getSqlite();
  const store = new StorageAdmissionStore(sqlite, {
    now: Date.now,
    observeVolume: observeFixtureVolume,
  });
  const storageAdmission = createPacketStorageAdmissionCoordinator({
    sqlite,
    store,
    now: Date.now,
    observeEstimate: async () => ({
      status: 'observed',
      exactBytes: estimateBytes,
      source: 'source-size-fallback',
      historySamples: 0,
      workspacePaths: [],
      error: null,
    }),
    resolveReservationTarget: () => worktreeRoot,
    observeRootIdentity: async () => ({
      canonicalPath: worktreeRoot,
      device: 'provision-failure-test',
      inode: '1',
    }),
    observeReservationVolume: observeFixtureVolume,
    resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 10 * gib }),
  });

  return { sqlite, storageAdmission, controlPlane, laneRegistry, launchPacketWithStorageAdmission, resolveWorkerRouting };
}

describe('packet storage admission provision failure real path', () => {
  it('releases the failed owner and admits the next launch at the same free space', async () => {
    const { sqlite, storageAdmission, controlPlane, laneRegistry, launchPacketWithStorageAdmission, resolveWorkerRouting } = await storageFixture();

    const launchAndReadFailure = async (packetId: string) => {
      const candidate = packet(packetId);
      controlPlane.writeOrchestratorControlPlaneState(mission(candidate));
      await expect(launchPacketWithStorageAdmission({
        packet: candidate,
        allPackets: [candidate],
        workerRouting: resolveWorkerRouting({
          requestedRuntime: 'codex',
          source: 'scheduler-dispatch',
        }),
        storageAdmission,
      })).rejects.toMatchObject({
        message: expect.stringContaining('packet_worktree_provision_failed'),
      });
      const lane = laneRegistry.findLatestLaneByPacket(packetId)!;
      const event = laneRegistry.getLaneEvents(lane.id, 200)
        .find((candidateEvent) => candidateEvent.verb === 'worktree_provision_failed');
      const reservation = sqlite.prepare(`
        SELECT reservation_id, state, last_reason, last_mutation_id
        FROM storage_admission_reservations
        WHERE owner_id = ?
        ORDER BY owner_generation DESC
        LIMIT 1
      `).get(packetId) as {
        reservation_id: string;
        state: string;
        last_reason: string;
        last_mutation_id: string;
      };
      return { event, lane, reservation };
    };

    const first = await launchAndReadFailure('pkt-storage-provision-failure-one');
    expect(first.lane).toMatchObject({ status: 'failed', worktreePath: null });
    expect(first.reservation).toMatchObject({ state: 'released', last_reason: 'released' });
    expect(sqlite.prepare(`
      SELECT COUNT(*)
      FROM storage_admission_reservations
      WHERE owner_id = ? AND state = 'reserved'
    `).pluck().get('pkt-storage-provision-failure-one')).toBe(0);
    expect(sqlite.prepare(`
      SELECT operation
      FROM storage_admission_mutations
      WHERE mutation_id = ? AND reservation_id = ?
    `).pluck().get(first.reservation.last_mutation_id, first.reservation.reservation_id)).toBe('release');
    expect(first.event?.payload).toMatchObject({
      storageRelease: {
        decision: 'released',
        ownerGeneration: 1,
        releasedReservations: 1,
        retainedOwnerIds: [],
      },
    });

    const second = await launchAndReadFailure('pkt-storage-provision-failure-two');
    expect(second.lane).toMatchObject({ status: 'failed', worktreePath: null });
    expect(second.reservation).toMatchObject({ state: 'released', last_reason: 'released' });
    expect(second.event).toBeDefined();
  }, 30_000);

  it('records an unprovable release scope on the provision failure event', async () => {
    const [{ getSqlite }, laneRegistry, { StorageAdmissionStore }, { packetWorktreeProvisionError }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/lane/registry'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/runtime/packet-worktree-guard'),
    ]);
    const packetId = 'pkt-storage-provision-unprovable';
    const lane = laneRegistry.createLane({
      repoPath,
      branch: `packet/${packetId}`,
      runtime: 'codex',
      packetId,
    });
    laneRegistry.setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    const store = new StorageAdmissionStore(getSqlite(), {
      now: Date.now,
      observeVolume: async (targetPath) => observed(targetPath),
    });
    await store.reserve({
      mutationId: `reserve-${packetId}`,
      reservationId: `packet-storage:${packetId}:1`,
      targetPath: worktreeRoot,
      exactBytes: estimateBytes,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: Date.now() + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 10 * gib },
    });

    packetWorktreeProvisionError(
      { existingLaneId: lane.id, packetId, isolate: true },
      'codex',
      repoPath,
      worktreeFailure,
      worktreeFailure.message,
    );

    expect(laneRegistry.getLane(lane.id)?.status).toBe('awaiting_input');
    expect(store.getReservation(`packet-storage:${packetId}:1`)).toMatchObject({ state: 'reserved' });
    expect(laneRegistry.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          storageRelease: expect.objectContaining({
            decision: 'deferred',
            ownerGeneration: null,
            releasedBytes: 0,
            releasedReservations: 0,
            retainedOwnerIds: [packetId],
            reason: 'release_scope_unprovable',
          }),
        }),
      }),
    ]));
  });

  it.each(['', '-index.noindex', '-abcd-index.noindex'])('retains storage when a packet-named checkout exists before lane binding (%s)', async (suffix) => {
    const [
      { getSqlite },
      laneRegistry,
      { recordLaneEvent },
      { StorageAdmissionStore },
      { packetWorktreeProvisionError },
      { managedPacketWorktreeId },
    ] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/lane/registry'),
      import('@/lib/lane/events'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/runtime/packet-worktree-guard'),
      import('@/lib/worktree/root-layout'),
    ]);
    const packetId = `pkt-storage-provision-materialized${suffix.replaceAll('.', '-')}`;
    const reservationId = `packet-storage:${packetId}:1`;
    const materializedRoot = join(root, 'materialized-worktrees');
    mkdirSync(materializedRoot, { recursive: true });
    const lane = laneRegistry.createLane({
      repoPath,
      branch: `packet/${packetId}`,
      runtime: 'codex',
      packetId,
    });
    laneRegistry.setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    const store = new StorageAdmissionStore(getSqlite(), {
      now: Date.now,
      observeVolume: async (targetPath) => ({
        ...observed(targetPath),
        volumeId: `device:materialized-provision-test:${suffix || 'legacy'}`,
      }),
    });
    const admitted = await store.reserve({
      mutationId: `reserve-${packetId}`,
      reservationId,
      targetPath: materializedRoot,
      exactBytes: estimateBytes,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: Date.now() + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 10 * gib },
    });
    expect(admitted.decision).toBe('reserved');
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId,
    });
    mkdirSync(join(materializedRoot, `${managedPacketWorktreeId(packetId)}${suffix}`), { recursive: true });

    packetWorktreeProvisionError(
      { existingLaneId: lane.id, packetId, isolate: true },
      'codex',
      repoPath,
      worktreeFailure,
      worktreeFailure.message,
    );

    expect(laneRegistry.getLane(lane.id)?.status).toBe('awaiting_input');
    expect(store.getReservation(reservationId)).toMatchObject({ state: 'reserved' });
    expect(laneRegistry.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          storageRelease: expect.objectContaining({
            decision: 'deferred',
            reason: 'materialized_worktree_present',
          }),
        }),
      }),
    ]));
  });
});


describe('provision failure diagnostics through agent entry points (#4071)', () => {
  const packetId = 'pkt-diagnostic-provision-failure';
  const reason = { code: 'packet_worktree_provision_failed', cause: worktreeFailure.message };

  beforeAll(async () => {
    const { storageAdmission, controlPlane, launchPacketWithStorageAdmission, resolveWorkerRouting } = await storageFixture('device:diagnostic-provision-test');
    const candidate = packet(packetId);
    controlPlane.writeOrchestratorControlPlaneState(mission(candidate));
    await expect(launchPacketWithStorageAdmission({
      packet: candidate, allPackets: [candidate], storageAdmission,
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex', source: 'scheduler-dispatch' }),
    })).rejects.toThrow('packet_worktree_provision_failed');
  });

  it('returns the failed lane and durable cause through get_mission_status after reopening SQLite', async () => {
    (await import('@/lib/db')).closeDb();
    const { handleGetMissionStatus } = await import('@/lib/mcp/operator-handlers/mission');
    const result = parseResult(await handleGetMissionStatus({ missionId: `mission-${packetId}` }));
    expect(result.packets[0].lane).toMatchObject({ status: 'failed', terminalReason: reason });
    expect(result.packets[0].terminalReason).toMatchObject(reason);
    expect(result.agents[0].terminalReason).toMatchObject(reason);
  });

  it('returns durable reasons through o8_lane_events even with an exhausted transition cursor', async () => {
    const { handleLaneEvents } = await import('@/lib/mcp/operator-handlers/status');
    const { findLatestLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLatestLaneByPacket(packetId)!;
    const result = parseResult(await handleLaneEvents({ since: Number.MAX_SAFE_INTEGER, timeoutMs: 0, lanes: [lane.id] }));
    expect(result.data.events).toEqual([]);
    expect(result.data.terminalReasons).toEqual([expect.objectContaining({ laneId: lane.id, packetId, terminalReason: reason })]);
  });

  it('explains a packet without a session through o8_packet_transcript', async () => {
    const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
    const result = parseResult(await handleTranscript({ packetId }));
    expect(result.data.note).toBe('no_session_binding');
    expect(result.data.terminalReason).toMatchObject(reason);
    expect(result.summary).toContain(worktreeFailure.message);
  });

  it('includes sessionless provision failures in the o8_status diagnostic snapshot', async () => {
    const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
    const result = parseResult(await handleStatus({}));
    expect(result.data.terminalReasons).toContainEqual(expect.objectContaining({ packetId, terminalReason: reason }));
  });

  it('prints the failed packet reason through CLI JSON and human status', async () => {
    const { runStatus } = await import('../cli/src/commands/status');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runStatus({ human: false, verbose: false });
      const result = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''));
      expect(result.terminalReasons).toContainEqual(expect.objectContaining({ packetId, terminalReason: reason }));
      output.mockClear();
      await runStatus({ human: true, verbose: false });
      const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(text).toContain(packetId);
      expect(text).toContain(reason.code);
      expect(text).toContain(reason.cause);
    } finally { output.mockRestore(); }
  });

  it('keeps the cause after noisy history and filters unrelated lane snapshots', async () => {
    const { findLatestLaneByPacket } = await import('@/lib/lane/registry');
    const { recordLaneEvent } = await import('@/lib/lane/events');
    const { handleLaneEvents } = await import('@/lib/mcp/operator-handlers/status');
    const { getSqlite } = await import('@/lib/db');
    const lane = findLatestLaneByPacket(packetId)!;
    for (let index = 0; index < 501; index++) recordLaneEvent(lane.id, 'update', 'system', { progress: index });
    const before = getSqlite().prepare('SELECT COUNT(*) FROM lane_events').pluck().get();
    const result = parseResult(await handleLaneEvents({ since: Number.MAX_SAFE_INTEGER, timeoutMs: 0, lanes: [lane.id] }));
    expect(result.data.terminalReasons).toEqual([expect.objectContaining({ laneId: lane.id, terminalReason: reason })]);
    const absent = parseResult(await handleLaneEvents({ timeoutMs: 0, lanes: ['missing-lane'] }));
    expect(absent.data.terminalReasons).toEqual([]);
    expect(getSqlite().prepare('SELECT COUNT(*) FROM lane_events').pluck().get()).toBe(before);
  });

  it('includes terminal causes in the historical mission fallback', async () => {
    const { recordMission } = await import('@/lib/db/missions-store');
    const { handleGetMissionStatus } = await import('@/lib/mcp/operator-handlers/mission');
    recordMission({ id: 'diagnostic-history', repoPath, runtime: 'codex', prompt: '', summary: '',
      constraints: '', totalWaves: 1, packetMeta: [{ id: packetId, title: 'diagnostic history', referenceLabel: 'HISTORY' }] });
    // Legacy archive rows have no full snapshot; exercise that fallback explicitly.
    (await import('@/lib/db')).getSqlite().prepare('UPDATE missions SET mission_state_json = NULL WHERE id = ?').run('diagnostic-history');
    const result = parseResult(await handleGetMissionStatus({ missionId: 'diagnostic-history' }));
    expect(result.historical).toBe(true);
    expect(result.packets[0].lane).toMatchObject({ status: 'failed', terminalReason: reason });
    expect(result.agents[0].terminalReason).toMatchObject(reason);
  });

  it('uses the latest sessionless lane instead of a prior attempt transcript', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { recordLaneEvent } = await import('@/lib/lane/events');
    const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
    const id = 'pkt-stale-session-binding';
    const old = createLane({ repoPath, branch: 'prior-attempt', packetId: id, runtime: 'codex', sessionKey: 'codex:prior-attempt' });
    setLaneStatus(old.id, 'failed');
    const latest = createLane({ repoPath, branch: 'latest-attempt', packetId: id, runtime: 'codex' });
    setLaneStatus(latest.id, 'failed', 'system', reason.code);
    recordLaneEvent(latest.id, 'worktree_provision_failed', 'system', reason);
    const result = parseResult(await handleTranscript({ packetId: id }));
    expect(result.data).toMatchObject({ sessionKey: null, note: 'no_session_binding', terminalReason: reason });
  });

  it('keeps parsed runtime failures even when the process exits zero', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { recordLaneEvent } = await import('@/lib/lane/events');
    const { handleLaneEvents } = await import('@/lib/mcp/operator-handlers/status');
    const lane = createLane({ repoPath, branch: 'parsed-runtime-failure', runtime: 'codex' });
    setLaneStatus(lane.id, 'failed', 'system', 'runtime_failed');
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      runtimeOutcome: 'failed', classification: 'clean-exit', exitCode: 0, stderr: 'fixture parsed runtime failure',
    });
    const result = parseResult(await handleLaneEvents({ lanes: [lane.id], timeoutMs: 0 }));
    expect(result.data.terminalReasons[0].terminalReason).toEqual({ code: 'runtime_process_exit', cause: 'fixture parsed runtime failure' });
  });

  it('bounds global status diagnostics with the newest reasons first', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
    for (let index = 0; index < 51; index++) {
      const lane = createLane({ repoPath, branch: `diagnostic-history-${index}`, runtime: 'codex' });
      setLaneStatus(lane.id, 'completed');
    }
    const latest = createLane({ repoPath, branch: 'newest-diagnostic', packetId: 'pkt-newest-failure', runtime: 'codex' });
    setLaneStatus(latest.id, 'failed', 'system', 'newest_failure', { reason: 'newest fixture cause' });
    // Refresh the snapshot after these writes instead of reusing an earlier status read.
    const result = parseResult(await handleStatus({ fresh: true }));
    expect(result.data.terminalReasons).toHaveLength(50);
    expect(result.data.terminalReasonsTruncated).toBe(true);
    expect(result.data.terminalReasons[0]).toMatchObject({ packetId: 'pkt-newest-failure',
      terminalReason: { code: 'newest_failure', cause: 'newest fixture cause' } });
  });

  it('does not attribute a prior attempt failure to a new live lane', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { handleGetMissionStatus } = await import('@/lib/mcp/operator-handlers/mission');
    const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
    const lane = createLane({ repoPath, branch: 'retry-diagnostics', packetId, runtime: 'codex' });
    setLaneStatus(lane.id, 'launching', 'system', 'launching_session');
    const result = parseResult(await handleGetMissionStatus({ missionId: `mission-${packetId}` }));
    expect(result.packets[0].lane).toMatchObject({ laneId: lane.id, status: 'launching', terminalReason: null });
    expect(parseResult(await handleTranscript({ packetId })).data.terminalReason).toBeNull();
  });

});
