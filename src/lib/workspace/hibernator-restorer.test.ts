import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type {
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
  OwnedWorkspaceBindingReceipt,
  ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session';
import type { ProcessQuiescenceReceipt } from './process-quiescence';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-hibernate-db-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { parkWorkspace, readImmutableWorkspaceTruth } = await import('./hibernator');
const { restoreWorkspace } = await import('./restorer');
const { inspectExactWorktreeQuarantine, parkExactWorktree } = await import('./worktree-exact');
const {
  repoSetupBoundRecipeKey,
  repoSetupCopyBindingRequirements,
  runRegisteredRepoSetup,
} = await import('./repo-setup');
const { scanWorkspaceStorageState } = await import('./storage-verifier');
const { reconcileWorkspaceSnapshot } = await import('./reconciler');
const { probeOwnedSessionProcessQuiescence } = await import('./process-probes');
const {
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const { closeDb } = await import('@/lib/db');
const { inboxSubject, mutateInboxSettlement } = await import('@/lib/inbox/store');
const { persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { waitForTerminalLaneWork } = await import('@/lib/lane/terminal-work');
const {
  managedWorkspaceSafetyHooksContent,
  resolveManagedWorkspaceSafetyHookRuntime,
  writeManagedWorkspaceSafetyHooks,
} = await import('@/lib/worktree/safety-hooks');
const { captureWorktreeMaterializationIdentity } = await import(
  '@/lib/worktree/materialization-identity'
);

const roots: string[] = [];
let priorWorktreeRoot: string | undefined;
let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function cleanProcess(
  sessionKey: string,
  state: 'quiescent' | 'live' | 'unknown' = 'quiescent',
): ProcessQuiescenceReceipt {
  return {
    state,
    identity: { ownership: 'owned', pidIdentity: 'not_applicable', sessionKey },
    probes: [],
    reasons: state === 'quiescent' ? [] : [`synthetic ${state}`],
    checkedAt: '2026-08-14T00:00:00.000Z',
  };
}

function fixture(label: string, isolationKind: 'git-worktree' | 'apfs-cow-clone' = 'git-worktree') {
  sequence += 1;
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-hibernate-${label}-`));
  roots.push(root);
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  const repoPath = path.join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  git(repoPath, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\nignored.cache\n.env.local\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');
  const repoId = `repo-hibernate-${sequence}`;
  const packetId = `packet-hibernate-${sequence}`;
  const worktreeId = `packet-${packetId}`;
  const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branch = `inline/${packetId}`;
  if (isolationKind === 'git-worktree') {
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
  } else {
    git(repoPath, 'clone', '-q', '--local', '--no-checkout', repoPath, worktreePath);
    git(worktreePath, 'config', 'user.email', 'o8-test@example.test');
    git(worktreePath, 'config', 'user.name', 'o8 test');
    git(worktreePath, 'checkout', '-qb', branch, 'main');
  }
  writeFileSync(path.join(worktreePath, 'tracked.txt'), `packet ${sequence}\n`);
  git(worktreePath, 'add', 'tracked.txt');
  git(worktreePath, 'commit', '-qm', 'packet work');
  const materializationStat = lstatSync(worktreePath);
  const materializationParentStat = lstatSync(path.dirname(worktreePath));
  writeFileSync(path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'), JSON.stringify({
    version: 1,
    worktrees: {
      [worktreeId]: {
        id: worktreeId,
        agentType: 'codex',
        sessionKey: `hibernate-owned-${sequence}:session`,
        baseBranch: 'main',
        createdAt: 1,
        claudeManaged: false,
        taskName: worktreeId,
        branchName: branch,
        status: 'ready',
        isolationKind,
        materializationIdentity: {
          device: materializationStat.dev,
          inode: materializationStat.ino,
          canonicalPath: realpathSync(worktreePath),
        },
        materializationParentIdentity: {
          device: materializationParentStat.dev,
          inode: materializationParentStat.ino,
          canonicalPath: realpathSync(path.dirname(worktreePath)),
        },
      },
    },
  }));
  const repo: RepoRegistryEntry = {
    id: repoId,
    name: label,
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: '2026-08-14T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: ['.env.local'],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'git-worktree',
    },
  };
  const surfaceId = `hibernate-owned-${sequence}:session`;
  const lane: Lane = {
    id: `lane-hibernate-${sequence}`,
    projectId: null,
    label,
    repoPath,
    worktreePath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: surfaceId,
    packetId,
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    lastEventAt: null,
    lastEventLabel: null,
  };
  let binding: OwnedWorkspaceBindingReceipt = {
    surfaceId,
    runtimeId: 'codex',
    sessionState: 'active',
    binding: {
      logicalWorkspaceId: `packet:${packetId}`,
      repositoryUuid: null,
      packetId,
      cwd: worktreePath,
      version: 1,
      verifiedAt: '2026-08-14T00:00:00.000Z',
    },
    activeRun: null,
    retainedRuns: [],
    retainedRunsComplete: true,
    retainedRunTotal: 0,
  };
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'codex',
    surfaceIdPrefix: `hibernate-owned-${sequence}:`,
    commandLabel: 'test-owned',
    resolveRoot: () => root,
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => binding,
    rebindWorkspace: async (_surfaceId, input) => {
      if (input.logicalWorkspaceId !== binding.binding.logicalWorkspaceId
        || input.expectedVersion !== binding.binding.version
        || path.resolve(input.expectedCwd) !== path.resolve(binding.binding.cwd)) {
        return { status: 'conflict', receipt: binding, note: 'binding mismatch' };
      }
      binding = {
        ...binding,
        binding: {
          ...binding.binding,
          repositoryUuid: input.repositoryUuid,
          packetId: input.packetId,
          cwd: path.resolve(input.nextCwd),
          version: binding.binding.version + 1,
        },
      };
      return { status: 'rebound', receipt: binding };
    },
  });
  return {
    root,
    repo,
    lane,
    surfaceId,
    worktreeId,
    getBinding: () => binding,
    setRetainedRuns: (
      retainedRuns: OwnedWorkspaceBindingReceipt['retainedRuns'],
      ledger: { complete: boolean; total: number | null } = {
        complete: true,
        total: retainedRuns.length,
      },
    ) => {
      binding = {
        ...binding,
        activeRun: null,
        retainedRuns,
        retainedRunsComplete: ledger.complete,
        retainedRunTotal: ledger.total,
      };
    },
  };
}

function dependencies(f: ReturnType<typeof fixture>, processState: 'quiescent' | 'live' | 'unknown' = 'quiescent') {
  return {
    listRepos: async () => [f.repo],
    findLaneByPacket: () => f.lane,
    processProbe: async (sessionKey: string) => cleanProcess(sessionKey, processState),
    measureStorage: async (target: string) => ({
      availableBytes: existsSync(target) ? 1_000_000 : 2_000_000,
      logicalBytes: existsSync(target) ? 100_000 : null,
      measuredAt: '2026-08-14T00:00:00.000Z',
    }),
  };
}

function completedFixture(label: string) {
  const f = fixture(label);
  const lane = createLane({ repoPath: f.repo.localPath, worktreePath: f.lane.worktreePath!,
    branch: f.lane.branch, baseBranch: f.lane.baseBranch, runtime: 'codex', sessionKey: f.surfaceId,
    packetId: f.lane.packetId!, ownership: 'managed', baseCommit: git(f.repo.localPath, 'rev-parse', 'main') });
  Object.assign(f.lane, lane, { status: 'reviewing' });
  setLaneStatus(f.lane.id, 'reviewing');
  return f;
}

function settleCompletedPacket(f: ReturnType<typeof fixture>, readOnly = false) {
  const tabId = `thoughts-completed-park-${sequence}`;
  persistCanonicalChatHistoryRecord(tabId, { repoPath: f.repo.localPath, messages: [
    { id: 'completed-answer', role: 'assistant', content: 'Work is merged.', timestamp: 100 },
  ] });
  const packet: OrchestratorPacket = {
    id: f.lane.packetId!, referenceLabel: 'P1', title: 'Completed workspace', summary: '',
    workspaceTargetPath: f.repo.localPath, branchTarget: f.lane.branch, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
    status: 'awaiting_review', blockedReason: null, review: null, attemptCount: 1,
    orchestratorThreadId: tabId,
    lane: { tileId: 'fixture', tabId: f.surfaceId, repoPath: f.repo.localPath,
      worktreePath: f.lane.worktreePath, runtime: 'codex', sessionKey: f.surfaceId, laneId: f.lane.id },
  };
  markPacketReleased(packet, { source: readOnly ? 'read_only_completed' : 'approve_and_merge',
    headSha: readOnly ? null : git(f.lane.worktreePath!, 'rev-parse', 'HEAD'),
    mergeCommit: readOnly ? null : git(f.lane.worktreePath!, 'rev-parse', 'HEAD') });
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `completed-park-${sequence}`, repoPath: f.repo.localPath, packets: [packet] });
  const subject = inboxSubject('conversation', tabId, f.repo.localPath);
  mutateInboxSettlement(subject, 'settle', () => {});
  setLaneStatus(f.lane.id, 'completed');
  f.lane.status = 'completed';
  return subject;
}

async function materializedSnapshot(f: ReturnType<typeof fixture>) {
  expect(getLane(f.lane.id)).toMatchObject({ status: 'reviewing', worktreePath: f.lane.worktreePath, sessionKey: f.surfaceId });
  const parked = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
    operationId: 'completed-snapshot-prepare-park' }, dependencies(f));
  expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });
  expect(getLane(f.lane.id)).toMatchObject({ status: 'reviewing', worktreePath: f.lane.worktreePath, sessionKey: f.surfaceId });
  const restored = await restoreWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
    operationId: 'completed-snapshot-prepare-restore' }, dependencies(f));
  expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored' });
}

beforeEach(() => {
  priorWorktreeRoot = process.env.O8_WORKTREE_ROOT;
});

afterEach(async () => {
  // Finish owned terminal callbacks before changing their root environment or removing fixtures.
  await waitForTerminalLaneWork();
  if (priorWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorWorktreeRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('workspace hibernate and restore services', { timeout: 60_000 }, () => {
  it.each([false, true])('parks a settled completed packet (previous snapshot %s) and explicitly restores after Unsettle', async previousSnapshot => {
    const f = completedFixture(`settled-completed-roundtrip-${previousSnapshot}`);
    if (previousSnapshot) await materializedSnapshot(f);
    const subject = settleCompletedPacket(f);
    const before = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!);
    if (!previousSnapshot) expect(before).toBeNull();
    const head = git(f.lane.worktreePath!, 'rev-parse', 'HEAD');
    const parked = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'settled-completed-park' }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked', snapshot: {
      laneId: f.lane.id, snapshotGeneration: before?.snapshotGeneration ?? 1, headCommit: head,
    } });
    const protectedSnapshot = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;
    expect(git(f.repo.localPath, 'rev-parse', protectedSnapshot.recoveryRef)).toBe(head);
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(f.lane.status).toBe('completed');
    mutateInboxSettlement(subject, 'unsettle', () => {});
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)?.state).toBe('parked');
    const restored = await restoreWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'settled-completed-explicit-restore' }, dependencies(f));
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored' });
    expect(git(f.lane.worktreePath!, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.lane.status).toBe('completed');
  });

  it('parks a canonically completed read-only packet without requiring a merge', async () => {
    const f = completedFixture('settled-completed-read-only');
    settleCompletedPacket(f, true);
    const result = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'settled-read-only-park' }, dependencies(f));
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'parked' });
    expect(f.lane.status).toBe('completed');
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
  });

  it('restores the exact completed parked generation after maintenance clears its lane path', async () => {
    const f = completedFixture('completed-null-path-restore');
    const originalPath = f.lane.worktreePath!;
    const subject = settleCompletedPacket(f);
    const parked = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'completed-null-path-park' }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });
    const saved = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;
    updateLane(f.lane.id, { worktreePath: null }, 'system', { phase: 'bounded_maintenance', worktreeRemoved: true });
    f.lane.worktreePath = null;
    mutateInboxSettlement(subject, 'unsettle', () => {});
    const restored = await restoreWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'completed-null-path-restore' }, dependencies(f));
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'restored' });
    expect(git(originalPath, 'rev-parse', 'HEAD')).toBe(saved.headCommit);
    expect(f.getBinding().binding.cwd).toBe(originalPath);
    expect(getLane(f.lane.id)).toMatchObject({ status: 'completed', worktreePath: originalPath, sessionKey: f.surfaceId });
  });

  it('refuses the first completed park if current release HEAD changes at its final boundary', async () => {
    const f = completedFixture('completed-head-race');
    settleCompletedPacket(f);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toBeNull();
    let scans = 0;
    const result = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'completed-head-race' }, { ...dependencies(f), secondScan: async (...args) => {
        const scan = await scanWorkspaceStorageState(...args);
        if (++scans === 2) {
          const state = readOrchestratorControlPlaneState({ strict: true });
          const packet = state.packets.find(candidate => candidate.id === f.lane.packetId)!;
          markPacketReleased(packet, { source: 'approve_and_merge', headSha: 'd'.repeat(40), mergeCommit: packet.releaseStatePayload!.mergeCommit });
          writeOrchestratorControlPlaneState(state);
        }
        return scan;
      } });
    expect(scans).toBeGreaterThanOrEqual(2);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('refuses completed Restore when current canonical release HEAD differs from its parked snapshot', async () => {
    const f = completedFixture('completed-stale-head-restore');
    settleCompletedPacket(f);
    const parked = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'completed-stale-head-park' }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });
    const state = readOrchestratorControlPlaneState({ strict: true });
    const packet = state.packets.find(candidate => candidate.id === f.lane.packetId)!;
    markPacketReleased(packet, { source: 'approve_and_merge', headSha: 'd'.repeat(40), mergeCommit: packet.releaseStatePayload!.mergeCommit });
    writeOrchestratorControlPlaneState(state);
    const restored = await restoreWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: 'completed-stale-head-restore' }, dependencies(f));
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)?.state).toBe('parked');
  });

  it.each(['unmanaged', 'active-subject', 'wrong-lane', 'dirty', 'live', 'unknown-process'] as const)(
    'refuses settled-completed parking for %s without touching its checkout', async refusal => {
      const f = completedFixture(`settled-completed-${refusal}`);
      await materializedSnapshot(f);
      const subject = settleCompletedPacket(f);
      if (refusal === 'unmanaged') f.lane.ownership = 'attached';
      if (refusal === 'active-subject') mutateInboxSettlement(subject, 'unsettle', () => {});
      if (refusal === 'wrong-lane') f.lane.id += '-replacement';
      if (refusal === 'dirty') writeFileSync(path.join(f.lane.worktreePath!, 'tracked.txt'), 'unsaved work\n');
      const result = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
        operationId: `settled-completed-refuse-${refusal}` }, dependencies(f,
        refusal === 'live' ? 'live' : refusal === 'unknown-process' ? 'unknown' : 'quiescent'));
      expect(result).toMatchObject({ status: 'refused' });
      expect(existsSync(f.lane.worktreePath!)).toBe(true);
      expect(f.lane.status).toBe('completed');
    },
  );

  it.each(['unsettle', 'new-work'] as const)('rechecks completed ownership at the final park boundary after %s', async action => {
    const f = completedFixture(`settled-completed-${action}-race`);
    await materializedSnapshot(f);
    const subject = settleCompletedPacket(f);
    let scans = 0;
    const result = await parkWorkspace({ repositoryUuid: f.repo.id, packetId: f.lane.packetId!,
      operationId: `settled-completed-${action}-race` }, {
      ...dependencies(f),
      secondScan: async (...args) => {
        const scan = await scanWorkspaceStorageState(...args);
        if (++scans === 2) {
          if (action === 'unsettle') mutateInboxSettlement(subject, 'unsettle', () => {});
          else { setLaneStatus(f.lane.id, 'running'); f.lane.status = 'running'; }
        }
        return scan;
      },
    });
    expect(scans, 'the race must reach the existing final boundary').toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(f.lane.status).toBe(action === 'new-work' ? 'running' : 'completed');
  });

  it('parks and restores an unchanged copied environment binding', async () => {
    const f = fixture('copy-env-roundtrip');
    const contents = 'TOKEN=registered-source\n';
    const safetyHooks = managedWorkspaceSafetyHooksContent(
      await resolveManagedWorkspaceSafetyHookRuntime(),
    );
    writeFileSync(path.join(f.repo.localPath, '.env.local'), contents);
    writeFileSync(path.join(f.lane.worktreePath!, '.env.local'), contents);
    await writeManagedWorkspaceSafetyHooks(
      f.repo.localPath,
      f.lane.worktreePath!,
      await captureWorktreeMaterializationIdentity(f.lane.worktreePath!),
    );

    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-roundtrip-park',
    }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);

    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-roundtrip-restore',
    }, dependencies(f));
    expect(restored).toMatchObject({ status: 'restored' });
    expect(readFileSync(path.join(f.lane.worktreePath!, '.env.local'), 'utf8')).toBe(contents);
    expect(readFileSync(
      path.join(f.lane.worktreePath!, '.claude', 'settings.local.json'),
      'utf8',
    )).toBe(safetyHooks);
  });

  it('refuses a restore-time destination ancestor swap without writing outside the workspace', async () => {
    const f = fixture('copy-env-restore-parent-race');
    f.repo.setup.envFiles = ['config/.env.local'];
    const source = path.join(f.repo.localPath, 'config/.env.local');
    const destination = path.join(f.lane.worktreePath!, 'config/.env.local');
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(source, 'TOKEN=must-not-escape\n');
    writeFileSync(destination, 'TOKEN=must-not-escape\n');
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-restore-parent-race-park',
    }, dependencies(f));
    expect(parked).toMatchObject({ status: 'parked' });

    const external = path.join(f.root, 'external-restore-target');
    const capturedParent = path.join(f.root, 'captured-restore-parent');
    mkdirSync(external);
    writeFileSync(path.join(external, 'sentinel'), 'external bytes survive\n');
    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-restore-parent-race-restore',
    }, {
      ...dependencies(f),
      runSetup: (repo, workspacePath, options) => runRegisteredRepoSetup(repo, workspacePath, {
        ...options,
        beforeBindingCreate: async (_relativePath, parentPath) => {
          renameSync(parentPath, capturedParent);
          symlinkSync(external, parentPath, 'dir');
        },
      }),
    });

    expect(restored).toMatchObject({ status: 'refused' });
    expect(readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('external bytes survive\n');
    expect(existsSync(path.join(external, '.env.local'))).toBe(false);
    expect(existsSync(path.join(capturedParent, '.env.local'))).toBe(false);
  });

  it('holds restored ownership through registered setup and refuses a same-name replacement', async () => {
    const f = fixture('restore-setup-owner-swap');
    const secret = 'TOKEN=must-stay-with-owned-workspace\n';
    writeFileSync(path.join(f.repo.localPath, '.env.local'), secret);
    writeFileSync(path.join(f.lane.worktreePath!, '.env.local'), secret);
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'restore-setup-owner-swap-park',
    }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });

    const retainedOwner = path.join(f.root, 'retained-restored-owner');
    const occupantSentinel = path.join(f.lane.worktreePath!, 'occupant-sentinel');
    const installMarker = path.join(f.root, 'install-ran');
    let setupStarted = false;
    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'restore-setup-owner-swap-restore',
    }, {
      ...dependencies(f),
      afterExactRestore: (workspacePath) => {
        renameSync(workspacePath, retainedOwner);
        mkdirSync(workspacePath);
        writeFileSync(occupantSentinel, 'unrelated occupant survives\n');
      },
      runSetup: async (repo, workspacePath, options) => {
        setupStarted = true;
        return runRegisteredRepoSetup(repo, workspacePath, {
          ...options,
          run: async () => {
            writeFileSync(installMarker, 'install ran\n');
          },
        });
      },
    });

    expect(restored).toMatchObject({ status: 'refused' });
    expect(setupStarted).toBe(false);
    expect(readFileSync(occupantSentinel, 'utf8')).toBe('unrelated occupant survives\n');
    expect(existsSync(path.join(f.lane.worktreePath!, '.env.local'))).toBe(false);
    expect(existsSync(path.join(retainedOwner, '.env.local'))).toBe(false);
    expect(readFileSync(path.join(f.repo.localPath, '.env.local'), 'utf8')).toBe(secret);
    expect(existsSync(installMarker)).toBe(false);
  }, 60_000);

  it('does not create a missing setup ancestor after the restored root is replaced', async () => {
    const f = fixture('restore-setup-missing-parent-swap');
    f.repo.setup.envFiles = ['config/.env.local'];
    const source = path.join(f.repo.localPath, 'config/.env.local');
    const originalBinding = path.join(f.lane.worktreePath!, 'config/.env.local');
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.dirname(originalBinding), { recursive: true });
    writeFileSync(source, 'TOKEN=must-not-create-outside\n');
    writeFileSync(originalBinding, 'TOKEN=must-not-create-outside\n');
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'restore-setup-missing-parent-swap-park',
    }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });

    const retainedOwner = path.join(f.root, 'retained-setup-parent-owner');
    const external = path.join(f.root, 'external-setup-parent');
    mkdirSync(external);
    writeFileSync(path.join(external, 'sentinel'), 'external bytes survive\n');
    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'restore-setup-missing-parent-swap-restore',
    }, {
      ...dependencies(f),
      runSetup: (repo, workspacePath, options) => runRegisteredRepoSetup(repo, workspacePath, {
        ...options,
        beforeBindingParentPrepare: async () => {
          renameSync(workspacePath, retainedOwner);
          symlinkSync(external, workspacePath, 'dir');
        },
      }),
    });

    expect(restored).toMatchObject({ status: 'refused' });
    expect(readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('external bytes survive\n');
    expect(existsSync(path.join(external, 'config'))).toBe(false);
    expect(existsSync(path.join(retainedOwner, 'config'))).toBe(false);
  }, 60_000);

  it('refuses an edited ignored environment copy and leaves every byte in place', async () => {
    const f = fixture('copy-env-edited');
    writeFileSync(path.join(f.repo.localPath, '.env.local'), 'TOKEN=registered-source\n');
    const edited = 'TOKEN=workspace-edit-that-must-survive\n';
    const destination = path.join(f.lane.worktreePath!, '.env.local');
    writeFileSync(destination, edited);

    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-edited-park',
    }, dependencies(f));

    expect(result).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(edited);
  });

  it('refuses source drift between scans and preserves the verified workspace copy', async () => {
    const f = fixture('copy-env-source-drift');
    const original = 'TOKEN=registered-source\n';
    const source = path.join(f.repo.localPath, '.env.local');
    const destination = path.join(f.lane.worktreePath!, '.env.local');
    writeFileSync(source, original);
    writeFileSync(destination, original);
    let changed = false;

    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-source-drift-park',
    }, {
      ...dependencies(f),
      secondScan: async (workspacePath, options) => {
        if (!changed) {
          changed = true;
          writeFileSync(source, 'TOKEN=drifted-source\n');
        }
        return scanWorkspaceStorageState(workspacePath, options);
      },
    });

    expect(result).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(original);
  });

  it('rechecks a copied environment binding at the destructive boundary', async () => {
    const f = fixture('copy-env-boundary-drift');
    const original = 'TOKEN=registered-source\n';
    const source = path.join(f.repo.localPath, '.env.local');
    const destination = path.join(f.lane.worktreePath!, '.env.local');
    writeFileSync(source, original);
    writeFileSync(destination, original);

    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-boundary-drift-park',
    }, {
      ...dependencies(f),
      parkExact: async (input) => {
        writeFileSync(source, 'TOKEN=boundary-drift\n');
        return parkExactWorktree(input);
      },
    });

    expect(result).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(original);
  });

  it('refuses restore from source bytes different from the parked snapshot binding', async () => {
    const f = fixture('copy-env-post-park-drift');
    const original = 'TOKEN=registered-source\n';
    const source = path.join(f.repo.localPath, '.env.local');
    writeFileSync(source, original);
    writeFileSync(path.join(f.lane.worktreePath!, '.env.local'), original);
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-post-park-drift-park',
    }, dependencies(f));
    expect(parked).toMatchObject({ status: 'parked' });

    writeFileSync(source, 'TOKEN=new-source-after-park\n');
    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'copy-env-post-park-drift-restore',
    }, dependencies(f));

    expect(restored).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({ state: 'parked' });
  });

  it.each([
    ['absent source with a destination', (f: ReturnType<typeof fixture>) => {
      writeFileSync(path.join(f.lane.worktreePath!, '.env.local'), 'TOKEN=orphaned-copy\n');
    }],
    ['present source with a missing destination', (f: ReturnType<typeof fixture>) => {
      writeFileSync(path.join(f.repo.localPath, '.env.local'), 'TOKEN=registered-source\n');
    }],
    ['non-file destination truth', (f: ReturnType<typeof fixture>) => {
      writeFileSync(path.join(f.repo.localPath, '.env.local'), 'TOKEN=registered-source\n');
      mkdirSync(path.join(f.lane.worktreePath!, '.env.local'));
    }],
  ])('fails closed for %s', async (_label, arrange) => {
    const f = fixture(`copy-env-missing-${sequence}`);
    arrange(f);

    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `copy-env-missing-${sequence}`,
    }, dependencies(f));

    expect(result).toMatchObject({ status: 'refused' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('parks and restores the exact checkout with the same owned transcript identity', async () => {
    const f = fixture('roundtrip');
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'roundtrip-park',
    }, dependencies(f));
    expect(parked.status).toBe('parked');
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({ state: 'parked' });

    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'roundtrip-restore',
    }, dependencies(f));
    expect(restored.status).toBe('restored');
    expect(git(f.lane.worktreePath!, 'rev-parse', 'HEAD')).toBe(
      getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)?.headCommit,
    );
    expect(f.getBinding()).toMatchObject({
      surfaceId: f.surfaceId,
      binding: {
        logicalWorkspaceId: `packet:${f.lane.packetId}`,
        repositoryUuid: f.repo.id,
        cwd: f.lane.worktreePath,
        version: 2,
      },
    });
  });

  it('parks and restores an isolated copy-on-write clone through quarantine', async () => {
    const f = fixture('cow-roundtrip', 'apfs-cow-clone');
    await writeManagedWorkspaceSafetyHooks(
      f.repo.localPath,
      f.lane.worktreePath!,
      await captureWorktreeMaterializationIdentity(f.lane.worktreePath!),
    );
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'cow-roundtrip-park',
    }, dependencies(f));
    expect(parked, JSON.stringify(parked)).toMatchObject({ status: 'parked' });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);

    const restored = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'cow-roundtrip-restore',
    }, dependencies(f));
    expect(restored).toMatchObject({ status: 'restored' });
    expect(git(f.lane.worktreePath!, 'rev-parse', 'HEAD')).toBe(
      getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)?.headCommit,
    );
  }, 120_000);

  it.each(['content', 'path', 'identity', 'exclude-content'] as const)(
    'preserves the quarantined clone when %s changes after manifest verification',
    async (change) => {
      const f = fixture(`cow-quarantine-${change}`, 'apfs-cow-clone');
      await writeManagedWorkspaceSafetyHooks(
        f.repo.localPath,
        f.lane.worktreePath!,
        await captureWorktreeMaterializationIdentity(f.lane.worktreePath!),
      );
      let heldPath = '';
      const result = await parkWorkspace({
        repositoryUuid: f.repo.id,
        packetId: f.lane.packetId!,
        operationId: `cow-quarantine-${change}`,
      }, {
        ...dependencies(f),
        parkExact: async (input) => parkExactWorktree({
          ...input,
          verifyQuarantinedClone: async (quarantinePath) => {
            heldPath = quarantinePath;
            const tracked = path.join(quarantinePath, 'tracked.txt');
            if (change === 'content') writeFileSync(tracked, 'changed source\n');
            if (change === 'path') renameSync(tracked, path.join(quarantinePath, 'moved.txt'));
            if (change === 'identity') {
              const contents = readFileSync(tracked);
              renameSync(tracked, path.join(path.dirname(quarantinePath), 'original-tracked'));
              writeFileSync(tracked, contents);
            }
            if (change === 'exclude-content') {
              writeFileSync(path.join(quarantinePath, '.git/info/o8-managed-excludes-.git'),
                '.claude/settings.local.json\n.o8/\nextra-ignore\n');
            }
            await input.verifyQuarantinedClone!(quarantinePath);
          },
        }),
      });
      expect(result.status).toBe('refused');
      expect(heldPath).not.toBe('');
      const preservedPath = existsSync(heldPath) ? heldPath : f.lane.worktreePath!;
      expect(existsSync(path.join(preservedPath, '.git'))).toBe(true);
      expect(existsSync(path.join(preservedPath, change === 'path' ? 'moved.txt' : 'tracked.txt')))
        .toBe(true);
      if (change === 'content') {
        expect(readFileSync(path.join(preservedPath, 'tracked.txt'), 'utf8')).toBe('changed source\n');
      }
      expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)?.state).not.toBe('parked');
    },
  );

  it.each([
    ['dirty tracked', (workspace: string) => writeFileSync(path.join(workspace, 'tracked.txt'), 'late dirty\n')],
    ['untracked', (workspace: string) => writeFileSync(path.join(workspace, 'untracked.txt'), 'late\n')],
    ['undeclared ignored', (workspace: string) => writeFileSync(path.join(workspace, 'ignored.cache'), 'late\n')],
    ['external symlink', (workspace: string) => symlinkSync('/tmp', path.join(workspace, 'outside-link'))],
  ])('refuses %s state without removing a byte', async (_label, mutate) => {
    const f = fixture(`refuse-${sequence}`);
    mutate(f.lane.worktreePath!);
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `refuse-${sequence}`,
    }, dependencies(f));
    expect(result.status).toBe('refused');
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it.each(['live', 'unknown'] as const)('refuses %s process truth without removing the path', async (state) => {
    const f = fixture(`process-${state}`);
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `process-${state}`,
    }, dependencies(f, state));
    expect(result.status).toBe('refused');
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('remounts the exact dependency lease when preparation refuses before manifest capture', async () => {
    const f = fixture('dependency-park-rollback');
    const receipt = {
      mode: 'image' as const,
      status: 'mounted' as const,
      installCommand: 'npm ci --ignore-scripts',
      recipeKey: 'a'.repeat(64),
      leaseId: 'lease-park-rollback',
      generation: 'generation-park-rollback',
      workspaceDevice: lstatSync(f.lane.worktreePath!).dev,
      workspaceInode: lstatSync(f.lane.worktreePath!).ino,
    };
    const order: string[] = [];
    const scanDetachedStates: boolean[] = [];
    let detached = false;
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'dependency-park-rollback',
    }, {
      ...dependencies(f),
      readDependencyMaterialization: async () => receipt,
      secondScan: async (workspacePath, options) => {
        scanDetachedStates.push(detached);
        return scanWorkspaceStorageState(workspacePath, options);
      },
      detachDependencies: async (workspacePath, expected) => {
        expect(workspacePath).toBe(f.lane.worktreePath);
        expect(expected).toBe(receipt);
        detached = true;
        order.push('detach');
      },
      restoreDependencies: async (_repoPath, _worktreeId, expected) => {
        order.push('remount');
        return expected;
      },
      parkExact: async (input) => {
        order.push('park-gates');
        await input.prepareQuarantineSource?.(input.expectedPath);
        const scansAfterPreparation = scanDetachedStates.length;
        const processReceipt = await input.probeProcessQuiescence(
          input.expectedSessionKey,
          input.expectedPath,
        );
        expect(processReceipt.state).toBe('quiescent');
        expect(scanDetachedStates).toHaveLength(scansAfterPreparation);
        throw new Error('deterministic refusal before manifest capture');
      },
    });

    expect(result).toMatchObject({ status: 'refused', code: 'park_refused' });
    expect(order).toEqual(['park-gates', 'detach', 'remount']);
    expect(scanDetachedStates).toEqual([false, false, true]);
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('exact-restores the source before remounting after post-rename verification fails', async () => {
    const f = fixture('dependency-post-rename-rollback', 'apfs-cow-clone');
    const receipt = {
      mode: 'image' as const,
      status: 'mounted' as const,
      installCommand: 'npm ci --ignore-scripts',
      recipeKey: 'b'.repeat(64),
      leaseId: 'lease-post-rename-rollback',
      generation: 'generation-post-rename-rollback',
      workspaceDevice: lstatSync(f.lane.worktreePath!).dev,
      workspaceInode: lstatSync(f.lane.worktreePath!).ino,
    };
    const order: string[] = [];
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'dependency-post-rename-rollback',
    }, {
      ...dependencies(f),
      readDependencyMaterialization: async () => receipt,
      detachDependencies: async () => { order.push('detach'); },
      restoreDependencies: async (_repoPath, _worktreeId, expected) => {
        expect(existsSync(f.lane.worktreePath!)).toBe(true);
        order.push('remount');
        return expected;
      },
      parkExact: async (input) => {
        const verify = input.verifyQuarantinedClone!;
        return parkExactWorktree({
          ...input,
          verifyQuarantinedClone: async (quarantinePath) => {
            await verify(quarantinePath);
            order.push('post-rename-verify');
            throw new Error('deterministic post-rename verification refusal');
          },
        });
      },
    });

    expect(result).toMatchObject({ status: 'refused', code: 'park_refused' });
    expect(order).toEqual(['detach', 'post-rename-verify', 'remount']);
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(await inspectExactWorktreeQuarantine({
      repoPath: f.repo.localPath,
      worktreeId: f.worktreeId,
      expectedPath: f.lane.worktreePath!,
      quarantine: {
        snapshotFingerprint: result.snapshot!.snapshotFingerprint,
        intent: 'park',
      },
    })).toMatchObject({ state: 'clear', originalExists: true, quarantineExists: false });
  });

  it('fails closed when a prepared dependency lease cannot be remounted', async () => {
    const f = fixture('dependency-remount-refusal');
    const receipt = {
      mode: 'image' as const,
      status: 'mounted' as const,
      installCommand: 'npm ci --ignore-scripts',
      recipeKey: 'c'.repeat(64),
      leaseId: 'lease-remount-refusal',
      generation: 'generation-remount-refusal',
      workspaceDevice: lstatSync(f.lane.worktreePath!).dev,
      workspaceInode: lstatSync(f.lane.worktreePath!).ino,
    };
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'dependency-remount-refusal',
    }, {
      ...dependencies(f),
      readDependencyMaterialization: async () => receipt,
      detachDependencies: async () => undefined,
      restoreDependencies: async () => { throw new Error('synthetic remount refusal'); },
      parkExact: async (input) => {
        await input.prepareQuarantineSource?.(input.expectedPath);
        throw new Error('synthetic pre-capture refusal');
      },
    });

    expect(result).toMatchObject({
      status: 'refused',
      code: 'park_refused',
      note: expect.stringContaining('exact dependency remount was incomplete'),
    });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('refuses parking when an older retained run marker survives the newer run', async () => {
    const f = fixture('older-marker-live');
    f.setRetainedRuns([
      {
        id: 'newer-run',
        outcome: 'finished',
        pid: 5252,
        commandIdentity: 'worker',
        processGroupId: 5252,
        processMarker: 'newer-marker',
      },
      {
        id: 'older-run',
        outcome: 'finished',
        pid: 4241,
        commandIdentity: 'worker',
        processGroupId: 4241,
        processMarker: 'older-marker',
      },
    ]);
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'older-marker-live',
    }, {
      ...dependencies(f),
      processProbe: (sessionKey, workspacePath) => probeOwnedSessionProcessQuiescence(
        sessionKey,
        workspacePath,
        {
          run: async (command, args) => {
            if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
            if (command === 'ps') {
              return {
                code: 0,
                stdout: '9001 escaped-worker O8_OWNED_RUN_MARKER=older-marker\n',
                stderr: '',
              };
            }
            if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
            if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
            throw new Error(`unexpected command: ${command}`);
          },
        },
      ),
    });

    expect(result.status).toBe('refused');
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('reopens a prepared spawn journal and blocks parking until the exact marked child is gone', async () => {
    const f = fixture('prepared-spawn-crash');
    const sessionRoot = path.join(f.root, 'prepared-sessions');
    const sessionDir = path.join(sessionRoot, 'session');
    const runsDir = path.join(sessionDir, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const runId = `prepared-run-${sequence}`;
    const now = new Date().toISOString();
    const preparedRun = {
      id: runId,
      mode: 'launch' as const,
      prompt: 'prepared crash seam',
      startedAt: now,
      pid: 0,
      commandIdentity: path.basename(process.execPath),
      processMarker: runId,
      spawnState: 'prepared' as const,
      stdoutPath: path.join(runsDir, `${runId}.jsonl`),
      stderrPath: path.join(runsDir, `${runId}.stderr.log`),
      outcome: 'running' as const,
    };
    const session: OwnedSessionRecord = {
      surfaceId: f.surfaceId,
      sessionDir,
      cwd: f.lane.worktreePath!,
      repoPath: f.lane.worktreePath!,
      workspaceBinding: {
        logicalWorkspaceId: `packet:${f.lane.packetId}`,
        repositoryUuid: f.repo.id,
        packetId: f.lane.packetId,
        cwd: f.lane.worktreePath!,
        version: 1,
        verifiedAt: now,
      },
      title: 'prepared crash seam',
      createdAt: now,
      updatedAt: now,
      latestPrompt: preparedRun.prompt,
      latestSummary: preparedRun.prompt,
      activeRun: preparedRun,
      recentRuns: [preparedRun],
      runIdentityLedger: { version: 1, totalRuns: 1, complete: true },
    };
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));

    let child: ChildProcess | null = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: f.lane.worktreePath!,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, O8_OWNED_RUN_MARKER: runId },
    });
    await once(child, 'spawn');
    try {
      const adapter: OwnedRuntimeAdapter = {
        runtimeId: `prepared-crash-${sequence}`,
        surfaceIdPrefix: f.surfaceId.split(':', 1)[0] + ':',
        rootEnvVar: `O8_TEST_PREPARED_CRASH_ROOT_${sequence}`,
        rootDefault: sessionRoot,
        binaryName: 'node',
        binaryEnvOverride: `O8_TEST_PREPARED_CRASH_BIN_${sequence}`,
        humanLabel: 'Prepared crash test',
        squadShortName: 'PreparedCrash',
        launchArgs: () => [],
        resumeArgs: () => [],
        parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'running', completedTurn: false }),
      };
      const store = createOwnedSessionStore(adapter);
      registerOwnedSessionLifecycleHandler({
        runtimeId: adapter.runtimeId,
        surfaceIdPrefix: adapter.surfaceIdPrefix,
        commandLabel: 'prepared-crash-test',
        resolveRoot: () => sessionRoot,
        sessionState: (surfaceId) => store.sessionState(surfaceId),
        archiveSession: (surfaceId) => store.archiveSession(surfaceId),
        getWorkspaceBinding: (surfaceId) => store.getWorkspaceBinding!(surfaceId),
        rebindWorkspace: (surfaceId, input) => store.rebindWorkspace!(surfaceId, input),
      });

      await expect(store.getWorkspaceBinding!(f.surfaceId)).resolves.toMatchObject({
        activeRun: { spawnState: 'prepared', processMarker: runId },
        retainedRuns: [{ spawnState: 'prepared', processMarker: runId }],
        retainedRunTotal: 1,
      });
      await expect(store.sweepOrphanedSessions(new Set(), 0)).resolves.toBe(0);
      expect(existsSync(path.join(sessionDir, 'session.json'))).toBe(true);
      const parked = await parkWorkspace({
        repositoryUuid: f.repo.id,
        packetId: f.lane.packetId!,
        operationId: 'prepared-spawn-crash',
      }, {
        ...dependencies(f),
        processProbe: probeOwnedSessionProcessQuiescence,
      });
      expect(parked.status).toBe('refused');
      expect(existsSync(f.lane.worktreePath!)).toBe(true);

      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      child = null;

      let clearedBinding: OwnedWorkspaceBindingReceipt | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        clearedBinding = await store.getWorkspaceBinding!(f.surfaceId);
        if (clearedBinding?.retainedRuns.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(clearedBinding).toMatchObject({
        activeRun: null,
        retainedRuns: [],
        retainedRunsComplete: true,
        retainedRunTotal: 1,
      });
      await expect(probeOwnedSessionProcessQuiescence(f.surfaceId, f.lane.worktreePath!))
        .resolves.toMatchObject({ state: 'quiescent' });
      const reconciled = JSON.parse(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')) as OwnedSessionRecord;
      expect(reconciled.runIdentityLedger).toEqual({ version: 1, totalRuns: 1, complete: true });
      expect(reconciled.recentRuns[0]).toMatchObject({
        id: runId,
        spawnState: 'reconciled_clear',
        outcome: 'failed',
      });
    } finally {
      if (child?.pid) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  it('refuses parking after run seventeen even when all retained identities are clear', async () => {
    const f = fixture('retained-ledger-overflow');
    f.setRetainedRuns(Array.from({ length: 16 }, (_, index) => ({
      id: `retained-${index + 2}`,
      outcome: 'finished' as const,
      pid: 4_002 + index,
      commandIdentity: 'worker',
      processGroupId: 4_002 + index,
      processMarker: `marker-${index + 2}`,
    })), { complete: false, total: 17 });
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'retained-ledger-overflow',
    }, {
      ...dependencies(f),
      processProbe: (sessionKey, workspacePath) => probeOwnedSessionProcessQuiescence(
        sessionKey,
        workspacePath,
        {
          run: async (command, args) => {
            if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
            if (command === 'ps') return { code: 0, stdout: '', stderr: '' };
            if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
            if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
            throw new Error(`unexpected command: ${command}`);
          },
        },
      ),
    });

    expect(result.status).toBe('refused');
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it.each([
    ['attached lane', (lane: Lane) => { lane.ownership = 'attached'; }],
    ['merging lane', (lane: Lane) => { lane.status = 'merging'; }],
  ])('refuses a %s before any removal', async (_label, mutate) => {
    const f = fixture(`lane-refusal-${sequence}`);
    mutate(f.lane);
    const result = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `lane-refusal-${sequence}`,
    }, dependencies(f));
    expect(result.status).toBe('refused');
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
  });

  it('refuses restore when the preserved branch moved and leaves the recovery ref intact', async () => {
    const f = fixture('branch-move');
    await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'branch-move-park',
    }, dependencies(f));
    const snapshot = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;
    git(f.repo.localPath, 'update-ref', `refs/heads/${snapshot.branch}`, snapshot.baseCommit);

    const result = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'branch-move-restore',
    }, dependencies(f));
    expect(result.status).toBe('refused');
    expect(existsSync(snapshot.originalPath)).toBe(false);
    expect(git(f.repo.localPath, 'rev-parse', snapshot.recoveryRef)).toBe(snapshot.headCommit);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({ state: 'parked' });
  });

  it('refuses an occupied original path without replacing it', async () => {
    const f = fixture('path-collision');
    await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'path-collision-park',
    }, dependencies(f));
    mkdirSync(f.lane.worktreePath!);
    writeFileSync(path.join(f.lane.worktreePath!, 'owner.txt'), 'unrelated\n');

    const result = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'path-collision-restore',
    }, dependencies(f));
    expect(result.status).toBe('refused');
    expect(existsSync(path.join(f.lane.worktreePath!, 'owner.txt'))).toBe(true);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({
      state: 'restoring',
      lastError: {
        code: 'restore_failed',
        message: expect.stringContaining('original path is occupied'),
      },
    });
  });

  it('refuses restore when a protected Git object is missing', async () => {
    const f = fixture('missing-object');
    const parked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'missing-object-park',
    }, dependencies(f));
    expect(parked).toMatchObject({ status: 'parked' });
    const snapshot = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;
    const gitDir = git(f.repo.localPath, 'rev-parse', '--absolute-git-dir');
    const objectPath = path.join(gitDir, 'objects', snapshot.headCommit.slice(0, 2), snapshot.headCommit.slice(2));
    expect(existsSync(objectPath)).toBe(true);
    rmSync(objectPath);

    const result = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'missing-object-restore',
    }, dependencies(f));
    expect(result.status).toBe('refused');
    expect(existsSync(snapshot.originalPath)).toBe(false);
  });

  it('reconciles crashes before and after removal without guessing', async () => {
    const prepared = fixture('crash-parkable');
    const preparedSnapshot = await stageParkable(prepared, 'crash-parkable');
    const preparedReceipt = await reconcileWorkspaceSnapshot(preparedSnapshot, {
      listRepos: async () => [prepared.repo],
    });
    expect(preparedReceipt).toMatchObject({
      fromState: 'parkable',
      toState: 'materialized',
      disposition: 'reconciled',
    });
    expect(existsSync(prepared.lane.worktreePath!)).toBe(true);

    const before = fixture('crash-before');
    const beforeSnapshot = await stageHibernating(before, 'crash-before');
    const beforeReceipt = await reconcileWorkspaceSnapshot(beforeSnapshot, { listRepos: async () => [before.repo] });
    expect(beforeReceipt).toMatchObject({ toState: 'materialized', disposition: 'reconciled' });
    expect(existsSync(before.lane.worktreePath!)).toBe(true);

    const after = fixture('crash-after');
    const afterSnapshot = await stageHibernating(after, 'crash-after');
    await parkExactWorktree({
      repoPath: after.repo.localPath,
      worktreeId: after.worktreeId,
      expectedPath: after.lane.worktreePath!,
      expectedBranch: afterSnapshot.branch,
      expectedHead: afterSnapshot.headCommit,
      expectedSessionKey: after.surfaceId,
      probeProcessQuiescence: dependencies(after).processProbe,
      quarantine: {
        snapshotFingerprint: afterSnapshot.snapshotFingerprint,
        intent: 'park',
      },
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(afterSnapshot.headCommit);
        expect(git(quarantinePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      },
    });
    const afterReceipt = await reconcileWorkspaceSnapshot(afterSnapshot, { listRepos: async () => [after.repo] });
    expect(afterReceipt).toMatchObject({ toState: 'parked', disposition: 'reconciled' });
    expect(existsSync(after.lane.worktreePath!)).toBe(false);
  });

  it.each(['stage-created', 'external-create', 'prepared-stage', 'moved-path'] as const)(
    'reconciles and retries an interrupted restore from the %s crash boundary',
    async (crashBoundary) => {
    const f = fixture(`crash-restore-${crashBoundary}`);
    await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `crash-restore-${crashBoundary}-park`,
    }, dependencies(f));
    const parked = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;
    const restoring = transitionWorkspaceSnapshot({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      transitionId: `crash-restore-${crashBoundary}:restoring`,
      expectedState: 'parked',
      expectedVersion: parked.version,
      toState: 'restoring',
    });
    if (restoring.status !== 'applied') throw new Error('restoring stage failed');
    const restoreInput = {
      repoPath: f.repo.localPath,
      worktreeId: f.worktreeId,
      expectedPath: f.lane.worktreePath!,
      branch: parked.branch,
      head: parked.headCommit,
      tree: parked.treeSha,
      baseBranch: f.lane.baseBranch,
      agentType: f.lane.runtime,
      sessionKey: f.surfaceId,
      createdAt: Date.parse(f.lane.createdAt),
      isolationKind: 'git-worktree' as const,
    };
    const runnerPath = path.join(f.root, `restore-${crashBoundary}-runner.ts`);
    const exactModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(exactModuleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        const crash = async () => process.exit(86);
        await restoreExactWorktree({
          ...input,
          ${crashBoundary === 'stage-created'
            ? 'afterRestoreStageCreated: crash'
            : crashBoundary === 'external-create'
              ? 'afterRestoreExternalCreate: crash'
              : crashBoundary === 'prepared-stage'
                ? 'afterRestoreStagePrepared: crash'
                : 'beforeRestoreOwnershipCommit: crash'}
        });
        process.exit(0);
      }
      void main();
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
        RESTORE_INPUT: JSON.stringify(restoreInput),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const [exitCode] = await once(child, 'close') as [number | null];
    expect(exitCode, stderr).toBe(86);

    const receipt = await reconcileWorkspaceSnapshot(restoring.record, {
      listRepos: async () => [f.repo],
      processProbe: dependencies(f).processProbe,
    });

    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      fromState: 'restoring',
      toState: 'parked',
      disposition: 'reconciled',
    });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({
      state: 'parked',
    });
    const retry = await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: `crash-restore-${crashBoundary}-retry`,
    }, dependencies(f));
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: 'restored' });
    expect(existsSync(f.lane.worktreePath!)).toBe(true);
    expect(git(f.lane.worktreePath!, 'rev-parse', 'HEAD')).toBe(parked.headCommit);
  }, 60_000);

  it('finishes an exact receipted copy-on-write quarantine after a crash', async () => {
    const f = fixture('crash-cow-quarantine', 'apfs-cow-clone');
    let quarantineRoot = '';
    const baseDependencies = dependencies(f);
    const interrupted = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'crash-cow-quarantine',
    }, {
      ...baseDependencies,
      parkExact: async (input) => {
        const verify = input.verifyQuarantinedClone!;
        return parkExactWorktree({
          ...input,
          verifyQuarantinedClone: async (quarantinePath) => {
            await verify(quarantinePath);
            quarantineRoot = path.dirname(quarantinePath);
            chmodSync(quarantineRoot, 0o555);
          },
        });
      },
    });
    expect(interrupted).toMatchObject({
      status: 'refused',
      snapshot: { state: 'hibernating' },
    });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    chmodSync(quarantineRoot, 0o755);
    const snapshot = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;

    const receipt = await reconcileWorkspaceSnapshot(snapshot, {
      listRepos: async () => [f.repo],
      processProbe: baseDependencies.processProbe,
    });

    expect(receipt).toMatchObject({ toState: 'parked', disposition: 'reconciled' });
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({ state: 'parked' });
  });

  it('keeps a crashed copy-on-write quarantine when its copied source drifts', async () => {
    const f = fixture('crash-cow-copy-drift', 'apfs-cow-clone');
    const source = path.join(f.repo.localPath, '.env.local');
    const contents = 'TOKEN=registered-source\n';
    writeFileSync(source, contents);
    writeFileSync(path.join(f.lane.worktreePath!, '.env.local'), contents);
    let quarantineRoot = '';
    const baseDependencies = dependencies(f);
    const interrupted = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.lane.packetId!,
      operationId: 'crash-cow-copy-drift',
    }, {
      ...baseDependencies,
      parkExact: async (input) => {
        const verify = input.verifyQuarantinedClone!;
        return parkExactWorktree({
          ...input,
          verifyQuarantinedClone: async (quarantinePath) => {
            await verify(quarantinePath);
            quarantineRoot = path.dirname(quarantinePath);
            chmodSync(quarantineRoot, 0o555);
          },
        });
      },
    });
    expect(interrupted).toMatchObject({ status: 'refused', snapshot: { state: 'hibernating' } });
    chmodSync(quarantineRoot, 0o755);
    writeFileSync(source, 'TOKEN=changed-after-quarantine\n');
    const snapshot = getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)!;

    const receipt = await reconcileWorkspaceSnapshot(snapshot, {
      listRepos: async () => [f.repo],
      processProbe: baseDependencies.processProbe,
    });

    expect(receipt).toMatchObject({
      toState: 'hibernating',
      disposition: 'quarantined',
      note: expect.stringContaining('copied environment sources changed'),
    });
    expect(existsSync(f.lane.worktreePath!)).toBe(false);
    expect(getWorkspaceSnapshot(f.repo.id, f.lane.packetId!)).toMatchObject({ state: 'hibernating' });
  });
});

async function stageHibernating(f: ReturnType<typeof fixture>, operationId: string) {
  const snapshot = await stageParkable(f, operationId);
  const hibernating = transitionWorkspaceSnapshot({
    repositoryUuid: f.repo.id,
    packetId: f.lane.packetId!,
    transitionId: `${operationId}:hibernating`,
    expectedState: 'parkable',
    expectedVersion: snapshot.version,
    toState: 'hibernating',
  });
  if (hibernating.status !== 'applied') throw new Error('hibernating stage failed');
  return hibernating.record;
}

async function stageParkable(f: ReturnType<typeof fixture>, operationId: string) {
  const truth = await readImmutableWorkspaceTruth(f.repo, f.lane);
  if (truth.isolationKind === 'apfs-cow-clone') {
    git(f.repo.localPath, 'fetch', '--no-tags', f.lane.worktreePath!, truth.headCommit);
  }
  git(f.repo.localPath, 'update-ref', truth.recoveryRef, truth.headCommit);
  const requiredCopyBindings = await repoSetupCopyBindingRequirements(f.repo);
  const snapshot = createWorkspaceSnapshot({
    repositoryUuid: f.repo.id,
    packetId: f.lane.packetId!,
    laneId: f.lane.id,
    originalPath: f.lane.worktreePath!,
    branch: truth.branch,
    baseCommit: truth.baseCommit,
    headCommit: truth.headCommit,
    treeSha: truth.treeSha,
    recoveryRef: truth.recoveryRef,
    diffFingerprint: truth.diffFingerprint,
    dependencyRecipeKey: await repoSetupBoundRecipeKey(
      f.repo,
      requiredCopyBindings,
      f.lane.worktreePath!,
    ),
    sessionIdentities: [
      { kind: 'owned-session', identity: f.surfaceId, runtime: 'codex', bindingId: `packet:${f.lane.packetId}` },
      { kind: 'workspace-isolation', identity: 'git-worktree' },
    ],
    creationId: `${operationId}:create`,
  }).record;
  const parkable = transitionWorkspaceSnapshot({
    repositoryUuid: f.repo.id,
    packetId: f.lane.packetId!,
    transitionId: `${operationId}:parkable`,
    expectedState: 'materialized',
    expectedVersion: snapshot.version,
    toState: 'parkable',
  });
  if (parkable.status !== 'applied') throw new Error('parkable stage failed');
  return parkable.record;
}
