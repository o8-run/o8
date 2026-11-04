import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.hoisted(() => ({
  calls: [] as Array<{
    packetId?: string;
    runtime?: string;
    model?: string;
    branchName?: string;
    clientMutationId?: string;
  }>,
  outcome: 'success' as 'success' | 'failure',
  gate: null as Promise<void> | null,
  dependencyMode: null as 'native' | 'image' | null,
}));
const authPreflightMock = vi.hoisted(() => ({
  calls: [] as Array<{
    runtime: string;
    model?: string | null;
    cwd?: string | null;
    options?: { claudeCodeCarrier?: string | null };
  }>,
}));

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: {
    packetId?: string;
    runtime?: string;
    model?: string;
    branchName?: string;
    repoPath: string;
    clientMutationId?: string;
  }) => {
    if (launchMock.gate) await launchMock.gate;
    launchMock.calls.push({
      packetId: input.packetId,
      runtime: input.runtime,
      model: input.model,
      branchName: input.branchName,
      clientMutationId: input.clientMutationId,
    });
    if (launchMock.outcome === 'failure') {
      return { ok: false, surfaceId: '', note: 'mock pre-effect failure' };
    }
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId}`,
      note: 'mock launch',
      worktree: {
        path: input.repoPath,
        dependencyMaterialization: launchMock.dependencyMode
          ? { mode: launchMock.dependencyMode }
          : undefined,
      },
    };
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async (
    runtime: string,
    model?: string | null,
    cwd?: string | null,
    options?: { claudeCodeCarrier?: string | null },
  ) => {
    authPreflightMock.calls.push({ runtime, model, cwd, options });
  }),
}));

const {
  archiveLane,
  createLane,
  findLaneByPacket,
  getLane,
  setLaneStatus,
  updateLane,
} = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readDispatchHaltState, setDispatchHaltState } = await import('@/lib/orchestrator/dispatch-halt');
const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
const {
  MAX_PARALLEL_DISPATCHES,
  MAX_LAUNCH_ATTEMPTS,
  RUNTIME_PARALLEL_CAP,
  buildRemainingLaunchBudget,
  getBootRecoveryLaunchBlocker,
  getDispatchBlocker,
  runDispatchTick,
} = await import('@/lib/orchestrator/scheduling');
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketStorageAdmissionCoordinator } from '@/lib/orchestrator/storage-admission';
import {
  createPacketStorageAdmissionCoordinator,
  packetStorageLaunchGeneration,
  PacketStorageAdmissionError,
  reconcileExpiredPacketStorageReservations,
} from '@/lib/orchestrator/storage-admission';
import { createStoragePressureAdmissionCoordinator } from '@/lib/orchestrator/storage-pressure-policy';
import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import { resetPacketFields } from '@/lib/orchestrator/operator-mission-service/rerun-with-feedback';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { launchPacketWithStorageAdmission } from '@/lib/orchestrator/dispatch-packet-launch';
import { updateOperatorDefaults } from '@/lib/operator/defaults';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import { inboxSubject, mutateInboxSettlement } from '@/lib/inbox/store';
import { assertInboxCanSettle } from '@/lib/inbox/subjects';
import { waitForTerminalLaneWork } from '@/lib/lane/terminal-work';
import {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';

function makeRepo(initialBranch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-scheduling-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', `--initial-branch=${initialBranch}`);
  writeFileSync(join(dir, 'README.md'), 'scheduling test\n');
  git('add', 'README.md');
  git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return dir;
}

function commitChange(repoPath: string, fileName: string, body: string) {
  writeFileSync(join(repoPath, fileName), body);
  execFileSync('git', ['add', fileName], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', `change ${fileName}`], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

function packetFixture(
  repoPath: string,
  id: string,
  overrides: Partial<OrchestratorPacket> = {},
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `packet ${id}`,
    status: 'queued',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
    ...overrides,
  } as OrchestratorPacket;
}

function missionFixture(repoPath: string, packets: OrchestratorPacket[]): OrchestratorMissionState {
  return {
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packets.map((packet) => packet.id).join('-')}`,
    repoPath,
    packets,
  };
}

function storageReceipt(id: string, state: 'reserved' | 'committed' | 'held' | 'released' | 'quarantined') {
  return {
    schema: 'o8/packet-storage-admission/v1' as const,
    state,
    reason: state,
    reservationId: `packet-storage:${id}:1`,
    mutationId: `packet-storage-${state}:${id}:1`,
    ownerId: id,
    ownerGeneration: 1,
    estimateBytes: 2_147_483_648,
    estimateSource: 'source-size-fallback' as const,
    historySamples: 0,
    volumeId: 'device:test',
    physicalAvailableBytes: 40_000_000_000,
    reservedBeforeBytes: 0,
    requiredReserveBytes: 10_000_000_000,
    dispatchHeadroomBytes: 30_000_000_000,
    recordedAt: Date.now(),
  };
}

function injectedAdmission(id: string, calls: string[]): PacketStorageAdmissionCoordinator {
  return {
    reserveForLaunch: async (candidate) => {
      calls.push('reserve');
      const generation = packetStorageLaunchGeneration(candidate);
      const reserved = {
        ...storageReceipt(id, 'reserved'),
        reservationId: `packet-storage:${id}:${generation}`,
        mutationId: `packet-storage-reserve:${id}:${generation}`,
        ownerGeneration: generation,
      };
      return {
        receipt: reserved,
        reservation: {
          reservationId: reserved.reservationId,
          volumeId: 'device:test',
          targetPath: '/repo',
          exactBytes: reserved.estimateBytes,
          ownerId: id,
          ownerGeneration: generation,
          generation: 1,
          state: 'reserved',
          leaseExpiresAt: Date.now() + 60_000,
          preMeasurement: {
            status: 'observed', targetPath: '/repo', probePath: '/', volumeId: 'device:test',
            availableBytes: 40_000_000_000, freeBytes: 40_000_000_000,
            totalBytes: 100_000_000_000, observedAt: Date.now(), error: null,
          },
          postMeasurement: null,
          lastMutationId: reserved.mutationId,
          lastReason: 'admitted',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          terminalAt: null,
        },
        baselineWorkspacePaths: [],
      };
    },
    commitAfterLaunch: async (lease) => {
      calls.push('commit');
      return { ...lease.receipt, state: 'committed', reason: 'committed' };
    },
    settleFailedLaunch: async (_candidate, lease) => {
      calls.push('release');
      return { ...lease.receipt, state: 'released', reason: 'released' };
    },
  };
}

function permissiveAdmission(): PacketStorageAdmissionCoordinator {
  return {
    reserveForLaunch: async (candidate) => injectedAdmission(candidate.id, [])
      .reserveForLaunch(candidate),
    commitAfterLaunch: async (lease) => ({
      ...lease.receipt,
      state: 'committed',
      reason: 'committed',
    }),
    settleFailedLaunch: async (_candidate, lease) => ({
      ...lease.receipt,
      state: 'released',
      reason: 'released',
    }),
  };
}

describe('dispatch scheduling caps and waves', () => {
  beforeEach(() => {
    launchMock.calls.length = 0;
    launchMock.outcome = 'success';
    launchMock.gate = null;
    launchMock.dependencyMode = null;
    authPreflightMock.calls.length = 0;
    setDispatchHaltState(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('exports the configured global and runtime dispatch caps', () => {
    expect(MAX_PARALLEL_DISPATCHES).toBeGreaterThanOrEqual(1);
    expect(RUNTIME_PARALLEL_CAP.gemini).toBe(3);
  });

  it('persists the dependency materialization path on the packet lane binding', async () => {
    launchMock.dependencyMode = 'image';
    const repoPath = makeRepo();
    const next = await runDispatchTick(
      missionFixture(repoPath, [packetFixture(repoPath, 'materialization-receipt')]),
      {
        launchBudget: { maxLaunches: 1 },
        storageAdmission: permissiveAdmission(),
      },
    );

    expect(next.packets[0]?.lane?.dependencyMaterializationMode).toBe('image');
    expect(normalizeOrchestratorMissionState(next).packets[0]?.lane?.dependencyMaterializationMode)
      .toBe('image');
  }, 20_000);

  it('subtracts active lane rows from the remaining launch budget', () => {
    const before = buildRemainingLaunchBudget();
    const codex = createLane({
      repoPath: '/tmp/o8-scheduling-active-repo',
      branch: `inline/active-codex-${Date.now()}`,
      runtime: 'codex',
    });
    const gemini = createLane({
      repoPath: '/tmp/o8-scheduling-active-repo',
      branch: `inline/active-gemini-${Date.now()}`,
      runtime: 'gemini',
    });
    setLaneStatus(codex.id, 'running', 'system', 'active');
    setLaneStatus(gemini.id, 'launching', 'system', 'active');

    const after = buildRemainingLaunchBudget();

    expect(after.maxLaunches).toBe(Math.max(0, before.maxLaunches - 2));
    expect(after.perRuntime?.gemini).toBe(Math.max(0, (before.perRuntime?.gemini ?? 0) - 1));
  });

  it('honors MAX_PARALLEL_DISPATCHES via the launch budget passed to the real tick', async () => {
    const repoPath = makeRepo();
    const packets = [1, 2, 3].map((index) => packetFixture(repoPath, `cap-${index}`));

    const next = await runDispatchTick(missionFixture(repoPath, packets), {
      launchBudget: { maxLaunches: Math.min(2, MAX_PARALLEL_DISPATCHES) },
      storageAdmission: permissiveAdmission(),
    });

    expect(launchMock.calls.map((call) => call.packetId)).toHaveLength(Math.min(2, MAX_PARALLEL_DISPATCHES));
    expect(next.packets.filter((packet) => packet.status === 'launching')).toHaveLength(Math.min(2, MAX_PARALLEL_DISPATCHES));
    expect(next.packets.filter((packet) => packet.status === 'queued')).toHaveLength(3 - Math.min(2, MAX_PARALLEL_DISPATCHES));
  }, 20_000);

  it('reserves before the real launch, commits after settlement, and projects the receipt', async () => {
    const repoPath = makeRepo();
    const calls: string[] = [];
    const next = await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'admitted')]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: injectedAdmission('admitted', calls),
    });
    expect(calls).toEqual(['reserve', 'commit']);
    expect(launchMock.calls).toHaveLength(1);
    expect(next.packets[0]).toMatchObject({
      status: 'launching',
      storageAdmission: { state: 'committed', ownerId: 'admitted' },
    });
  }, 20_000);

  it('claims one persisted execution for concurrent callers of the real packet launch entry', async () => {
    const repoPath = makeRepo();
    const candidate = normalizeOrchestratorMissionState(missionFixture(
      repoPath,
      [packetFixture(repoPath, 'exclusive-launch')],
    )).packets[0]!;
    let release!: () => void;
    launchMock.gate = new Promise<void>((resolve) => { release = resolve; });
    const admission = injectedAdmission(candidate.id, []);
    const input = {
      packet: candidate,
      allPackets: [candidate],
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex', source: 'scheduler-dispatch' }),
      storageAdmission: admission,
    };

    const first = launchPacketWithStorageAdmission(input);
    await vi.waitFor(() => expect(getSqlite().prepare(
      "SELECT COUNT(*) AS count FROM idempotency_keys WHERE verb = 'packet_storage_launch' AND result_json IS NULL",
    ).get()).toEqual({ count: 1 }));
    await expect(launchPacketWithStorageAdmission(input)).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'launch_in_progress' },
    });
    release();
    await expect(first).resolves.toMatchObject({ laneId: expect.any(String) });
    expect(launchMock.calls.filter((call) => call.packetId === candidate.id)).toHaveLength(1);
  }, 20_000);

  it('preflights the carrier pinned on the persisted packet through the real launch entry', async () => {
    const repoPath = makeRepo();
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState(missionFixture(
      repoPath,
      [packetFixture(repoPath, 'persisted-carrier-preflight', {
        runtime: 'claude-code',
        claudeCodeCarrier: 'openrouter',
      })],
    )));
    const candidate = readOrchestratorControlPlaneState().packets[0]!;

    await launchPacketWithStorageAdmission({
      packet: candidate,
      allPackets: [candidate],
      workerRouting: resolveWorkerRouting({
        requestedRuntime: 'claude-code',
        source: 'scheduler-dispatch',
      }),
      storageAdmission: injectedAdmission(candidate.id, []),
    });

    expect(authPreflightMock.calls).toContainEqual(expect.objectContaining({
      runtime: 'claude-code',
      cwd: repoPath,
      options: { claudeCodeCarrier: 'openrouter' },
    }));
  }, 20_000);

  it('carries a persisted 3code model pin through packet routing into the launch entry', async () => {
    const repoPath = makeRepo();
    await updateOperatorDefaults({ threecodeWorkerModel: 'deepseek.deepseek-v4-pro' });
    try {
      writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState(missionFixture(
        repoPath,
        [packetFixture(repoPath, 'threecode-persisted-model', { runtime: '3code' })],
      )));
      const candidate = readOrchestratorControlPlaneState().packets[0]!;
      const launched = await launchPacketWithStorageAdmission({
        packet: candidate,
        allPackets: [candidate],
        workerRouting: resolveWorkerRouting({ requestedRuntime: '3code', source: 'scheduler-dispatch' }),
        storageAdmission: injectedAdmission(candidate.id, []),
      });

      expect(launched.workerRouting).toMatchObject({
        selectedRuntime: '3code',
        selectedModel: 'deepseek.deepseek-v4-pro',
      });
      expect(authPreflightMock.calls).toContainEqual(expect.objectContaining({
        runtime: '3code',
        model: 'deepseek.deepseek-v4-pro',
        cwd: repoPath,
      }));
      expect(launchMock.calls).toContainEqual(expect.objectContaining({
        runtime: '3code',
        model: 'deepseek.deepseek-v4-pro',
      }));
      expect(getLane(launched.laneId)?.model).toBe('deepseek.deepseek-v4-pro');
    } finally {
      await updateOperatorDefaults({ threecodeWorkerModel: null });
    }
  }, 20_000);

  it('uses the durable admission generation for the launch mutation after reset', async () => {
    const repoPath = makeRepo();
    const prior = storageReceipt('generation-reset', 'held');
    const candidate = packetFixture(repoPath, 'generation-reset', {
      launchAttempts: 0,
      storageAdmission: prior,
    });
    await runDispatchTick(missionFixture(repoPath, [candidate]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: injectedAdmission('generation-reset', []),
    });
    expect(launchMock.calls).toEqual([
      expect.objectContaining({
        packetId: 'generation-reset',
        clientMutationId: 'packet-launch:generation-reset:2',
      }),
    ]);
  }, 20_000);

  it('mints a fresh durable reservation after a commit-fold crash and retired reset generation', async () => {
    const repoPath = makeRepo();
    const directory = mkdtempSync(join(tmpdir(), 'o8-scheduling-admission-crash-'));
    const file = join(directory, 'admission.db');
    let now = 1_000;
    let estimateCalls = 0;
    let db = new Database(file);
    ensureV38StorageAdmissionSchema(db);
    const buildAdmission = () => {
      const store = new StorageAdmissionStore(db, {
        now: () => now,
        observeVolume: async (targetPath) => ({
          status: 'observed', targetPath, probePath: repoPath, volumeId: 'device:test',
          availableBytes: 10_000, freeBytes: 10_000, totalBytes: 20_000,
          observedAt: now, error: null,
        }),
      });
      return createPacketStorageAdmissionCoordinator({
        sqlite: db,
        store,
        now: () => now,
        observeEstimate: async () => {
          estimateCalls += 1;
          return {
            status: 'observed', exactBytes: 200, source: 'source-size-fallback',
            historySamples: 0, workspacePaths: [], error: null,
          };
        },
        observeWorkspacePaths: async () => [],
        resolveReservationTarget: () => repoPath,
        observeReservationVolume: async (targetPath) => ({
          status: 'observed', targetPath, probePath: repoPath, volumeId: 'device:test',
          availableBytes: 10_000, freeBytes: 10_000, totalBytes: 20_000,
          observedAt: now, error: null,
        }),
        resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
      });
    };

    const firstAdmission = buildAdmission();
    const crashAfterCommit: PacketStorageAdmissionCoordinator = {
      reserveForLaunch: (candidate, ordinal) => firstAdmission.reserveForLaunch(candidate, ordinal),
      settleFailedLaunch: (candidate, lease) => firstAdmission.settleFailedLaunch(candidate, lease),
      commitAfterLaunch: async (lease) => {
        await firstAdmission.commitAfterLaunch(lease);
        throw new Error('simulated crash before scheduling fold-back');
      },
    };
    const initial = await runDispatchTick(
      missionFixture(repoPath, [packetFixture(repoPath, 'fold-crash', { launchAttempts: 2 })]),
      { launchBudget: { maxLaunches: 1 }, storageAdmission: crashAfterCommit },
    );
    expect(initial.packets[0]).toMatchObject({
      status: 'blocked',
      storageAdmission: null,
    });
    expect(db.prepare(`
      SELECT owner_generation, state FROM storage_admission_reservations
      WHERE owner_id = 'fold-crash'
    `).all()).toEqual([{ owner_generation: 3, state: 'committed' }]);
    db.close();

    now = 2_000;
    db = new Database(file);
    ensureV38StorageAdmissionSchema(db);
    await expect(reconcileExpiredPacketStorageReservations({
      store: new StorageAdmissionStore(db, { now: () => now }),
      now: () => now,
    })).resolves.toMatchObject({ inspected: 0 });

    const activeLane = findLaneByPacket('fold-crash');
    expect(activeLane?.sessionKey).toBeTruthy();
    const ownedRoot = join(directory, 'owned-codex');
    const ownedSession = join(ownedRoot, 'fold-crash');
    mkdirSync(ownedSession, { recursive: true });
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    writeFileSync(join(ownedSession, 'session.json'), JSON.stringify({
      surfaceId: activeLane!.sessionKey,
      cwd: activeLane!.worktreePath,
      repoPath,
      laneId: activeLane!.id,
      packetId: 'fold-crash',
      launchMutationId: 'packet-launch:fold-crash:3',
      activeRun: { outcome: 'running' },
    }));
    const preFoldPacket = packetFixture(repoPath, 'fold-crash', { launchAttempts: 2 });
    const recovered = await launchPacketWithStorageAdmission({
      packet: preFoldPacket,
      allPackets: [preFoldPacket],
      workerRouting: resolveWorkerRouting({
        requestedRuntime: 'codex',
        source: 'scheduler-dispatch',
      }),
      storageAdmission: buildAdmission(),
    });
    expect(recovered).toMatchObject({
      laneId: activeLane!.id,
      sessionKey: activeLane!.sessionKey,
      storageAdmission: { state: 'committed', ownerGeneration: 3 },
    });
    expect(launchMock.calls).toHaveLength(1);

    updateLane(activeLane!.id, { packetId: '', worktreePath: null });
    archiveLane(activeLane!.id, 'user');
    expect(findLaneByPacket('fold-crash')).toBeNull();
    const resetPacket = initial.packets[0]!;
    resetPacketFields(resetPacket);
    expect(resetPacket.storageAdmissionEpoch).toBe(4);
    const relaunched = await runDispatchTick(
      missionFixture(repoPath, [resetPacket]),
      { launchBudget: { maxLaunches: 1 }, storageAdmission: buildAdmission() },
    );

    expect(relaunched.packets[0]).toMatchObject({
      status: 'launching',
      storageAdmission: { state: 'committed', ownerGeneration: 4 },
    });
    expect(launchMock.calls.map((call) => call.clientMutationId)).toEqual([
      'packet-launch:fold-crash:3',
      'packet-launch:fold-crash:4',
    ]);
    expect(db.prepare(`
      SELECT owner_generation, state FROM storage_admission_reservations
      WHERE owner_id = 'fold-crash' ORDER BY owner_generation
    `).all()).toEqual([
      { owner_generation: 3, state: 'committed' },
      { owner_generation: 4, state: 'committed' },
    ]);
    expect(estimateCalls).toBe(2);
    db.close();
    vi.unstubAllEnvs();
  }, 20_000);

  it('settles a failed real launch and persists the released capacity receipt', async () => {
    const repoPath = makeRepo();
    const calls: string[] = [];
    launchMock.outcome = 'failure';
    const next = await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'failed-launch')]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: injectedAdmission('failed-launch', calls),
    });
    expect(calls).toEqual(['reserve', 'release']);
    expect(next.packets[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'mock pre-effect failure',
      storageAdmission: { state: 'released', ownerId: 'failed-launch' },
    });
  }, 20_000);

  it('runs pressure parking through the real dispatch service before launching the packet', async () => {
    const repoPath = makeRepo();
    const calls: string[] = [];
    const base = injectedAdmission('pressure-entry', calls);
    const originalReserve = base.reserveForLaunch;
    base.reserveForLaunch = async (packet, ordinal = 0) => {
      calls.push(`attempt:${ordinal}`);
      if (ordinal === 0) {
        throw new PacketStorageAdmissionError(
          'held',
          { ...storageReceipt(packet.id, 'held'), reason: 'reserve_breached' },
        );
      }
      return originalReserve(packet, ordinal);
    };
    base.commitAfterLaunch = async (admissionLease) => {
      calls.push('commit');
      return { ...admissionLease.receipt, state: 'committed', reason: 'committed' };
    };
    const completed = createLane({
      repoPath: '/repos/completed',
      branch: 'inline/completed',
      runtime: 'codex',
      packetId: 'completed-candidate',
      ownership: 'managed',
      sessionKey: 'codex-owned:completed-candidate',
    });
    setLaneStatus(completed.id, 'completed', 'system', 'read_only_completed');
    await waitForTerminalLaneWork();
    // Parking is injected below; retain its association after terminal cleanup drains.
    updateLane(completed.id, { worktreePath: '/worktrees/completed' });
    const completedPacket = packetFixture(completed.repoPath, completed.packetId!, {
      branchTarget: completed.branch,
      lane: {
        tileId: completed.id, tabId: completed.sessionKey!, laneId: completed.id,
        repoPath: completed.repoPath, worktreePath: '/worktrees/completed',
        runtime: 'codex', sessionKey: completed.sessionKey,
      },
    });
    markPacketReleased(completedPacket, { source: 'read_only_completed' });
    writeOrchestratorControlPlaneState(missionFixture(completed.repoPath, [completedPacket]));
    const subject = inboxSubject('runtime', completed.sessionKey!, completed.repoPath, completed.projectId);
    mutateInboxSettlement(subject, 'settle', () => assertInboxCanSettle(subject, []));
    const pressureAdmission = createStoragePressureAdmissionCoordinator(base, {
      mode: () => 'pressure',
      listLanes: () => [getLane(completed.id)!],
      listRepos: async () => [{
        id: 'repo-completed', name: 'completed', localPath: completed.repoPath, remoteUrl: null,
        defaultBranch: 'main', addedAt: new Date().toISOString(), lastOpenedAt: null,
        storagePressureParkingDisabled: false,
        setup: {
          envMode: 'copy', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
          buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
          workspaceIsolationPreference: 'auto',
        },
      }],
      getSnapshot: () => null,
      observeVolume: async (targetPath) => ({
        status: 'observed', targetPath, probePath: '/', volumeId: 'device:test',
        availableBytes: 1_000, freeBytes: 1_000, totalBytes: 2_000, observedAt: 100, error: null,
      }),
      measureAllocatedBytes: async () => 2_000_000_000,
      parkWorkspace: async (input) => {
        await input.assertPolicyCurrent?.();
        calls.push('park');
        return { status: 'parked', snapshot: {} as never };
      },
      readParkedReclaimedBytes: () => 1_000_000_000,
    });

    const next = await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'pressure-entry')]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });

    expect(calls).toEqual(['attempt:0', 'park', 'attempt:1', 'reserve', 'commit']);
    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['pressure-entry']);
    expect(next.packets[0]).toMatchObject({
      status: 'launching',
      storageAdmission: {
        state: 'committed',
        pressure: { status: 'admitted_after_parking', candidates: [{ packetId: 'completed-candidate' }] },
      },
    });
  }, 20_000);

  it('carries outside launch provenance into the first supervisor announcement', async () => {
    const repoPath = makeRepo();
    const watchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      watchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    }));
    const launchContext = {
      source: 'cli' as const,
      presentation: 'split' as const,
      repoContext: 'transient' as const,
      caller: 'outside terminal',
    };

    await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'outside-worker', { launchContext })]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: permissiveAdmission(),
    });

    expect(watchBodies).toContainEqual(expect.objectContaining({ launchContext }));
  }, 20_000);

  it('uses a transient repository\'s real default branch when main does not exist', async () => {
    const repoPath = makeRepo('master');

    await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'master-default')]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: permissiveAdmission(),
    });

    expect(findLaneByPacket('master-default')?.baseBranch).toBe('master');
    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['master-default']);
  }, 20_000);

  it('honors an explicit per-runtime launch budget for Gemini', async () => {
    const repoPath = makeRepo();
    const cap = 3;
    const packets = [1, 2, 3, 4].map((index) => packetFixture(repoPath, `gemini-${index}`, {
      runtime: 'gemini',
      workerRouting: { requestedRuntime: 'gemini' } as OrchestratorPacket['workerRouting'],
    }));

    const next = await runDispatchTick(missionFixture(repoPath, packets), {
      launchBudget: { maxLaunches: 10, perRuntime: { gemini: cap } },
      storageAdmission: permissiveAdmission(),
    });

    expect(launchMock.calls.map((call) => call.packetId)).toHaveLength(cap);
    expect(launchMock.calls.every((call) => call.runtime === 'gemini')).toBe(true);
    expect(next.packets.filter((packet) => packet.status === 'launching')).toHaveLength(cap);
    expect(next.packets.find((packet) => packet.id === 'gemini-4')?.status).toBe('queued');
  }, 20_000);

  it('dispatches only the released dependency wave before later packets', async () => {
    const repoPath = makeRepo();
    const first = packetFixture(repoPath, 'wave-first');
    const second = packetFixture(repoPath, 'wave-second', {
      dependencyPacketIds: ['wave-first'],
    });

    const next = await runDispatchTick(missionFixture(repoPath, [first, second]), {
      launchBudget: { maxLaunches: 10 },
      storageAdmission: permissiveAdmission(),
    });

    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['wave-first']);
    expect(next.packets.find((packet) => packet.id === 'wave-first')?.status).toBe('launching');
    expect(next.packets.find((packet) => packet.id === 'wave-second')?.status).toBe('queued');
  }, 20_000);

  it('skips recovery dispatches still inside the cooldown window', async () => {
    const repoPath = makeRepo();
    const packet = packetFixture(repoPath, 'cooldown', {
      status: 'recovering',
      recoveryCount: 1,
      lastRecoveryAt: new Date().toISOString(),
    });

    const next = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('recovering');
  }, 20_000);

  it('persists the dispatch halt gate and blocks launches until cleared', async () => {
    const repoPath = makeRepo();
    const packet = packetFixture(repoPath, 'halt-gate');

    setDispatchHaltState(true, 'test halt');
    expect(readDispatchHaltState()).toMatchObject({
      halted: true,
      reason: 'test halt',
    });

    const halted = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(halted.packets[0].status).toBe('queued');
    expect(readDispatchHaltState().halted).toBe(true);

    setDispatchHaltState(false);
    expect(readDispatchHaltState()).toMatchObject({
      halted: false,
      reason: null,
    });

    const resumed = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: permissiveAdmission(),
    });

    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['halt-gate']);
    expect(resumed.packets[0].status).toBe('launching');
  }, 20_000);

  it('salvages committed recovery work to review instead of redispatching', async () => {
    const repoPath = makeRepo();
    execFileSync('git', ['checkout', '-b', 'inline/recovery-committed'], { cwd: repoPath, stdio: 'pipe' });
    commitChange(repoPath, 'WORK.md', 'committed worker output\n');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/recovery-committed',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'recovery-committed',
    });
    setLaneStatus(lane.id, 'recovering', 'system', 'silent_exit_work_present');
    const packet = packetFixture(repoPath, 'recovery-committed', {
      status: 'recovering',
      recoveryCount: 0,
      lastRecoveryAt: new Date(Date.now() - 120_000).toISOString(),
      lane: {
        tileId: 'tile-recovery-committed',
        tabId: 'tab-recovery-committed',
        repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        laneId: lane.id,
        sessionKey: null,
        lastHeartbeatAt: null,
        lastEventAt: new Date().toISOString(),
        lastEventLabel: 'silent_exit_work_present',
      },
    });
    expect(await hasReviewableCompletionDiff(repoPath, 'main', repoPath)).toBe(true);

    const next = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('awaiting_review');
    expect(next.packets[0].lastEventLabel).toBe('session_recovery_autocommit');
  }, 20_000);

  it('caps launch/attach relaunches on the PACKET so a fresh lane cannot reset the budget', () => {
    const repoPath = makeRepo();
    // A launch that failed to attach: the lane fell back to idle with a
    // launch_error label, which getDispatchBlocker normally re-admits for retry.
    const launchFailedLane = {
      tileId: 'tile-thrash',
      tabId: 'tab-thrash',
      repoPath,
      worktreePath: repoPath,
      runtime: 'codex' as const,
      laneId: 'lane-thrash',
      lastEventLabel: 'launch_error',
    };
    const base = packetFixture(repoPath, 'launch-thrash', {
      status: 'queued',
      queueState: 'queued',
      lane: launchFailedLane,
    });

    // Below the cap: the launch_error retry path re-admits the packet (null).
    expect(
      getDispatchBlocker({ ...base, launchAttempts: MAX_LAUNCH_ATTEMPTS - 1 }, []),
    ).toBeNull();

    // At the cap: blocked — even though it's a fresh lane, the packet-scoped
    // counter survived the redispatch and stops the launching<->idle thrash.
    expect(
      getDispatchBlocker({ ...base, launchAttempts: MAX_LAUNCH_ATTEMPTS }, []),
    ).toMatch(/Launch attempts exceeded/);
  });
});

describe('boot recovery launch guard (#1460)', () => {
  beforeEach(() => {
    launchMock.calls.length = 0;
    launchMock.outcome = 'success';
    setDispatchHaltState(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  const guardedPacket = (overrides: Partial<OrchestratorPacket> = {}) =>
    packetFixture('/tmp/o8-boot-guard', 'boot-guard', {
      status: 'queued',
      queueState: 'queued',
      releaseState: 'pending',
      workerRouting: undefined,
      ...overrides,
    });

  it('allows a live queued packet with a pinned runtime', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: 'claude-code',
    })).toBeNull();
  });

  it('skips archived missions', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionArchived: true,
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: 'codex',
    })).toBe('mission is not live');
  });

  it('skips unpinned runtime recovery', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: null,
    })).toBe('runtime is not pinned');
  });

  it('does not treat normalized selectedRuntime as an explicit boot pin', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket({
        runtime: 'claude-code',
        dispatchRuntimePin: null,
      }),
      pinnedRuntime: null,
    })).toBe('runtime is not pinned');
  });

  it('blocks a normalized queued never-launched claude-code packet through the real dispatch tick', async () => {
    const repoPath = makeRepo();
    const stalePacket = packetFixture(repoPath, 'boot-never-launched', {
      runtime: 'claude-code',
      workerRouting: undefined,
      dispatchRuntimePin: undefined,
    });
    const normalized = normalizeOrchestratorMissionState(missionFixture(repoPath, [stalePacket]));

    expect(normalized.packets[0].workerRouting?.requestedRuntime).toBe('claude-code');
    expect(normalized.packets[0].dispatchRuntimePin).toBeNull();

    const next = await runDispatchTick(normalized, {
      launchBudget: { maxLaunches: 1 },
      enforceBootRecoveryGuard: true,
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('queued');
    expect(next.packets[0].dispatchRuntimePin).toBeNull();
  }, 20_000);

  it('skips review states that no longer expect a worker', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket({ status: 'awaiting_review' }),
      pinnedRuntime: 'codex',
    })).toBe('lane state does not expect a worker (awaiting_review)');
  });
});
