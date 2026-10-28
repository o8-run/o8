import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeSession } from '@/lib/runtimes/types';

const root = mkdtempSync(join(tmpdir(), 'o8-auth-before-attach-'));
const dataDir = join(root, 'data');
const ownedRoot = join(dataDir, 'owned-codex');
const repoPath = join(dataDir, 'fixture-repo');
const shimPath = join(root, 'codex-auth-shim.js');
const shimModePath = join(root, 'shim-mode');
const execCountPath = join(root, 'exec-count');
const exitOrderingRace = vi.hoisted(() => ({ enabled: false, injected: false }));
const inventoryRace = vi.hoisted(() => ({
  enabled: false,
  primeStatus: null as number | null,
  primeAgentStatus: null as string | null,
  surfaceId: null as string | null,
  staleSession: null as RuntimeSession | null,
}));

// Replay the actual pre-exit discovery receipt for this surface while the real
// exit and lane reconciliation run, without relying on incidental cache timing.
vi.mock('@/lib/runtimes/codex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/codex')>();
  return { ...actual, codexRuntime: { ...actual.codexRuntime,
    discoverSessions: async (...args: Parameters<typeof actual.codexRuntime.discoverSessions>) => {
      const sessions = await actual.codexRuntime.discoverSessions(...args);
      if (!inventoryRace.enabled) return sessions;
      if (!inventoryRace.staleSession) {
        const target = sessions.find(session => session.sessionKey === inventoryRace.surfaceId);
        if (target) inventoryRace.staleSession = structuredClone(target);
      }
      return sessions.map(session => session.sessionKey === inventoryRace.surfaceId && inventoryRace.staleSession
        ? structuredClone(inventoryRace.staleSession) : session);
    },
  } };
});

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
process.env.O8_CODEX_BIN = shimPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'o8 test']);
execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'test@o8.dev']);
writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, 'commit', '-qm', 'test: seed fixture']);

writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.130.0'); process.exit(0); }
const mode = fs.readFileSync(${JSON.stringify(shimModePath)}, 'utf8');
if (args[0] === 'exec') {
  const path = ${JSON.stringify(execCountPath)};
  const count = Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '0') + 1;
  fs.writeFileSync(path, String(count));
  if (mode === 'auth-delay') {
    setTimeout(() => {
      process.stderr.write('Failed to refresh token: 401 refresh_token_reused\\n');
      process.exit(1);
    }, 5000);
    return;
  }
  if (mode === 'clean-delay') {
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  process.stderr.write('Failed to refresh token: 401 refresh_token_reused\\n');
  process.exit(1);
}
process.exit(64);
`);
chmodSync(shimPath, 0o700);

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn(async () => ({
      ready: true,
      checkedAt: new Date().toISOString(),
      waitedMs: 0,
      attempts: 1,
      evidence: 'test',
    })),
  };
});

vi.mock('@/lib/lane/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/registry')>();
  return {
    ...actual,
    getLaneEvents: (laneId: string, limit?: number) => {
      const snapshot = actual.getLaneEvents(laneId, limit);
      const attach = snapshot.findLast((event) => (
        event.verb === 'attach_session'
        && event.payload.launchAttachProvenance === 'accepted_launch_session_v1'
      ));
      if (exitOrderingRace.enabled && !exitOrderingRace.injected && attach) {
        const surfaceId = String(attach.payload.sessionKey);
        const sessionPath = join(
          process.env.CORTEX_IDE_OWNED_CODEX_ROOT!,
          surfaceId.replace(/^codex-owned:/, ''),
          'session.json',
        );
        const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as {
          activeRun?: { id?: string };
        };
        const runId = session.activeRun?.id;
        if (!runId) throw new Error('Expected the accepted owned run before race injection.');
        actual.appendEvent(laneId, 'runtime_process_exit', 'system', {
          runtime: 'codex', surfaceId, runId, exitCode: 1, signal: null,
          classification: 'nonzero-exit', runtimeOutcome: 'failed', authRecoveryRequired: true,
        });
        exitOrderingRace.injected = true;
      }
      return snapshot;
    },
  };
});

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return {
    ...actual,
    launchRuntimeSurface: async (request: Parameters<typeof actual.launchRuntimeSurface>[0]) => {
      const result = await actual.launchRuntimeSurface(request);
      if (inventoryRace.enabled && result.ok && result.surfaceId) {
        inventoryRace.surfaceId = result.surfaceId;
        const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');
        const { GET } = await import('@/app/api/runtime/inventory/route');
        invalidateRuntimeInventoryCache();
        const response = await GET(new NextRequest('http://localhost/api/runtime/inventory?fresh=1'));
        const snapshot = await response.json() as {
          agents?: Array<{ sessionKey?: string; status?: string }>;
        };
        inventoryRace.primeStatus = response.status;
        inventoryRace.primeAgentStatus = snapshot.agents
          ?.find((agent) => agent.sessionKey === result.surfaceId)
          ?.status ?? null;
      }
      if (!exitOrderingRace.enabled && result.ok && request.existingLaneId && result.surfaceId) {
        await waitForRuntimeExit(request.existingLaneId, result.surfaceId);
      }
      return result;
    },
  };
});

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

const { dispatch } = await import('@/lib/lane/commands');
const { addRepo } = await import('@/lib/repos/registry');
const {
  appendEvent,
  attachSession,
  createLane,
  deleteLane,
  getLane,
  getLaneEvents,
  listLanes,
  setLaneStatus,
  updateLane,
} = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { runSilentExitTriageForLane } = await import('@/lib/supervisor/silent-exit-detector');
const { acceptedLaunchAttachmentProvenance } = await import('@/lib/lane/current-auth-exit');
const { GET: getRuntimeInventory } = await import('@/app/api/runtime/inventory/route');
const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');

await addRepo(repoPath);

async function createManagedWorktree(packetId: string, branch: string) {
  const { captureWorktreeMaterializationIdentity } = await import(
    '@/lib/worktree/materialization-identity'
  );
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { managedPacketWorktreeId } = await import('@/lib/worktree/root-layout');
  const worktreeId = managedPacketWorktreeId(packetId);
  if (!worktreeId) throw new Error(`Unable to resolve a worktree id for ${packetId}`);
  const worktreeBase = join(repoPath, '.cortex-worktrees');
  const worktreePath = join(worktreeBase, worktreeId);
  mkdirSync(worktreeBase, { recursive: true });
  execFileSync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branch]);
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(worktreeBase);
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: packetId,
    branchName: branch,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
  return worktreePath;
}

async function waitForRuntimeExit(laneId: string, surfaceId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const event = getLaneEvents(laneId, 100).find((candidate) => (
      candidate.verb === 'runtime_process_exit'
      && candidate.payload.surfaceId === surfaceId
    ));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for immediate runtime exit on ${laneId}.`);
}

beforeEach(() => {
  exitOrderingRace.enabled = false;
  exitOrderingRace.injected = false;
  inventoryRace.enabled = false;
  inventoryRace.primeStatus = null;
  inventoryRace.primeAgentStatus = null;
  inventoryRace.surfaceId = null;
  inventoryRace.staleSession = null;
  writeFileSync(shimModePath, 'auth');
  writeFileSync(execCountPath, '0');
  for (const lane of listLanes()) deleteLane(lane.id);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Codex authentication exit before launch attachment', () => {
  it('parks the exact accepted launch and keeps the mission held through silent-exit reconciliation', async () => {
    const packetId = `pkt-auth-before-attach-${Date.now()}`;
    const missionId = `mission-auth-before-attach-${Date.now()}`;
    const branch = `test/auth-before-attach-${Date.now()}`;
    const worktreePath = await createManagedWorktree(packetId, branch);
    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      actor: 'orchestrator',
    });
    setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    appendEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: `reservation:${packetId}:1`,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: 'inline-1',
        title: 'Immediate authentication exit',
        summary: 'Exercise exit before attachment.',
        workspaceTargetPath: worktreePath,
        branchTarget: branch,
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'launching',
        blockedReason: null,
        lane: null,
        review: null,
      }],
    });
    writeFileSync(shimModePath, 'auth-delay');
    inventoryRace.enabled = true;

    const launched = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'Write one fixture note.',
      model: 'gpt-5.6-terra',
      effort: 'high',
      clientMutationId: `packet-launch:${packetId}:1`,
      actor: 'orchestrator',
    });

    expect(launched.ok, launched.note).toBe(true);
    expect(inventoryRace.primeStatus).toBe(200);
    expect(inventoryRace.primeAgentStatus).toBe('running');
    expect(Number(readFileSync(execCountPath, 'utf8'))).toBe(1);
    const eventsAfterLaunch = getLaneEvents(lane.id, 100);
    const exitIndex = eventsAfterLaunch.findIndex((event) => event.verb === 'runtime_process_exit');
    const attachIndex = eventsAfterLaunch.findIndex((event) => event.verb === 'attach_session');
    const provenanceIndex = eventsAfterLaunch.findIndex((event) => (
      event.payload.launchAttachProvenance === 'accepted_launch_session_v1'
    ));
    const bookkeepingIndex = eventsAfterLaunch.findIndex((event, index) => (
      index > provenanceIndex && event.verb === 'update' && event.payload.model === 'gpt-5.6-terra'
    ));
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThan(exitIndex);
    expect(provenanceIndex).toBe(attachIndex);
    expect(eventsAfterLaunch[attachIndex]?.payload.acceptedAuthExitRunId).toBe(
      eventsAfterLaunch[exitIndex]?.payload.runId,
    );
    expect(eventsAfterLaunch.some((event) => (
      event.verb === 'update' && event.payload.launchAttachProvenance
    ))).toBe(false);
    expect(bookkeepingIndex).toBeGreaterThan(provenanceIndex);
    expect(eventsAfterLaunch[exitIndex]?.payload.authRecoveryRequired).toBe(true);
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      lastEventLabel: 'codex_auth_recovery_required',
    });

    invalidateRuntimeInventoryCache();
    const inventoryResponse = await getRuntimeInventory(
      new NextRequest('http://localhost/api/runtime/inventory?fresh=1'),
    );
    expect(inventoryResponse.status).toBe(200);
    const inventorySnapshot = await inventoryResponse.json() as {
      agents?: Array<{ sessionKey?: string; status?: string }>;
    };
    const attachedSessionKey = getLane(lane.id)?.sessionKey;
    expect(attachedSessionKey).toBeTruthy();
    expect(inventorySnapshot.agents?.find((agent) => (
      agent.sessionKey === attachedSessionKey
    ))?.status).toBe('running');
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      lastEventLabel: 'codex_auth_recovery_required',
    });

    updateLane(lane.id, { lastEventAt: new Date(Date.now() - 120_000).toISOString() }, 'system');
    await runSilentExitTriageForLane(lane.id);
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      lastEventLabel: 'codex_auth_recovery_required',
    });

    await syncOrchestratorControlPlaneState();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'Codex sign-in expired on this machine. Run `codex login`, then reset and dispatch this packet again.',
    });
    expect(Number(readFileSync(execCountPath, 'utf8'))).toBe(1);

    const held = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({
      ...held,
      packets: held.packets.map((packet) => packet.id === packetId
        ? { ...packet, blockedReason: 'Repository policy review required.' }
        : packet),
    });
    await syncOrchestratorControlPlaneState();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'Repository policy review required.',
    });

    setLaneStatus(lane.id, 'awaiting_input', 'system', 'awaiting_input');
    invalidateRuntimeInventoryCache();
    const ordinaryWaitResponse = await getRuntimeInventory(
      new NextRequest('http://localhost/api/runtime/inventory?fresh=1'),
    );
    expect(ordinaryWaitResponse.status).toBe(200);
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      lastEventLabel: 'session_running',
    });
    expect(Number(readFileSync(execCountPath, 'utf8'))).toBe(1);
    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
    deleteLane(lane.id);
  }, 30_000);

  it('rechecks an auth exit that lands between classification and session-launched bookkeeping', async () => {
    const packetId = `pkt-auth-ordering-${Date.now()}`;
    const branch = `test/auth-ordering-${Date.now()}`;
    const worktreePath = await createManagedWorktree(packetId, branch);
    const lane = createLane({
      repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex',
      packetId, actor: 'orchestrator',
    });
    setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    appendEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: `reservation:${packetId}:1`,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: `mission-auth-ordering-${Date.now()}`,
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId, referenceLabel: 'ordering-1', title: 'Auth exit ordering',
        summary: 'Exercise an exit between classification and launch bookkeeping.',
        workspaceTargetPath: worktreePath, branchTarget: branch, runtime: 'codex',
        model: 'gpt-5.6-terra', dependencyLabels: [], dependencyPacketIds: [],
        queueState: 'queued', releaseState: 'pending', status: 'launching',
        blockedReason: null, lane: null, review: null,
      }],
    });
    writeFileSync(shimModePath, 'clean-delay');
    exitOrderingRace.enabled = true;

    const launched = await dispatch({
      verb: 'launch_session', laneId: lane.id, prompt: 'Exercise the launch ordering race.',
      model: 'gpt-5.6-terra', effort: 'high',
      clientMutationId: `packet-launch:${packetId}:1`, actor: 'orchestrator',
    });
    expect(launched.ok, launched.note).toBe(true);
    expect(exitOrderingRace.injected).toBe(true);
    const events = getLaneEvents(lane.id, 100);
    const attachIndex = events.findIndex((event) => event.verb === 'attach_session');
    const exitIndex = events.findIndex((event) => event.verb === 'runtime_process_exit');
    const launchedIndex = events.findIndex((event) => event.payload.eventLabel === 'session_launched');
    const heldIndex = events.findIndex((event) => event.payload.eventLabel === 'codex_auth_recovery_required');
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(attachIndex);
    expect(launchedIndex).toBeGreaterThan(exitIndex);
    expect(heldIndex).toBeGreaterThan(launchedIndex);
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input', lastEventLabel: 'codex_auth_recovery_required',
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await runSilentExitTriageForLane(lane.id);
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input', lastEventLabel: 'codex_auth_recovery_required',
    });
    expect(Number(readFileSync(execCountPath, 'utf8'))).toBe(1);
    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
    deleteLane(lane.id);
  }, 30_000);

  it('preserves persisted terminal and operator-stopped lane intent', async () => {
    const cases = [
      { laneStatus: 'archived', label: 'discarded', packetStatus: 'archived' },
      { laneStatus: 'completed', label: 'merged', packetStatus: 'awaiting_review' },
      { laneStatus: 'paused', label: 'operator_stopped', packetStatus: 'blocked' },
    ] as const;
    const packets = [];
    for (const [index, fixture] of cases.entries()) {
      const packetId = `pkt-terminal-auth-${fixture.laneStatus}-${Date.now()}`;
      const surfaceId = `codex-owned:terminal-${fixture.laneStatus}`;
      const lane = createLane({
        repoPath,
        branch: `test/terminal-${fixture.laneStatus}`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        actor: 'orchestrator',
      });
      setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
      appendEvent(lane.id, 'update', 'orchestrator', {
        storageAdmissionOwnerGeneration: index + 1,
        storageAdmissionReservationId: `reservation:${packetId}:${index + 1}`,
      });
      appendEvent(lane.id, 'runtime_process_exit', 'system', {
        runtime: 'codex', surfaceId, runId: `run-${index + 1}`,
        runtimeOutcome: 'failed', authRecoveryRequired: true,
      });
      const current = getLane(lane.id)!;
      const provenance = acceptedLaunchAttachmentProvenance({
        lane: current,
        events: getLaneEvents(lane.id, 100),
        surfaceId,
        clientMutationId: `packet-launch:${packetId}:${index + 1}`,
      });
      expect(provenance).not.toBeNull();
      attachSession(lane.id, surfaceId, 'orchestrator', provenance ?? {});
      setLaneStatus(lane.id, fixture.laneStatus, 'orchestrator', fixture.label);
      packets.push({
        id: packetId,
        referenceLabel: `terminal-${index + 1}`,
        title: `Preserve ${fixture.laneStatus}`,
        summary: 'Stale authentication evidence cannot revive this lane.',
        workspaceTargetPath: repoPath,
        branchTarget: `test/terminal-${fixture.laneStatus}`,
        runtime: 'codex' as const,
        model: 'gpt-5.6-terra',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: fixture.laneStatus === 'paused' ? 'held' as const : 'queued' as const,
        holdIntent: fixture.laneStatus === 'paused' ? 'operator' as const : undefined,
        releaseState: 'pending' as const,
        status: fixture.laneStatus === 'paused' ? 'blocked' as const : 'launching' as const,
        blockedReason: fixture.laneStatus === 'paused' ? 'Stopped by operator' : null,
        operatorStopped: fixture.laneStatus === 'paused' ? true : undefined,
        lane: null,
        review: null,
      });
    }
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: `mission-terminal-auth-${Date.now()}`,
      repoPath,
      runtime: 'codex',
      packets,
    });

    await syncOrchestratorControlPlaneState();
    const persisted = readOrchestratorControlPlaneState();
    for (const fixture of cases) {
      const packet = persisted.packets.find((candidate) => candidate.title === `Preserve ${fixture.laneStatus}`);
      expect(packet?.status).toBe(fixture.packetStatus);
      expect(packet?.blockedReason ?? '').not.toContain('Codex sign-in expired');
      if (fixture.laneStatus === 'paused') {
        expect(packet).toMatchObject({ queueState: 'held', blockedReason: 'Stopped by operator', operatorStopped: true });
      }
    }
  });
});
