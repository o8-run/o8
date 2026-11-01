import { completedParkedWorkspace, type CompletedRestorePin } from './completed-packet';
import { getSqlite } from '@/lib/db';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { spokenReviewSnapshotFingerprint } from '@/lib/lane/lane-diff-facts';
import { findLatestLaneByPacket, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import {
  getWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
  type WorkspaceSnapshotErrorReceipt,
  type WorkspaceSnapshotRecord,
} from '@/lib/worktree/snapshot-state';
import type { WorkspaceIsolationKind } from '@/lib/worktree/types';
import { WorktreeManager } from '@/lib/worktree/manager';
import {
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from '@/lib/worktree/materialization-execution';
import { verifyImmutableWorkspaceTruth } from './hibernator';
import { probeOwnedSessionProcessQuiescence } from './process-probes';
import { prepareArchivedReviewRecovery, assertArchivedReviewRecoveryCurrent, publishRecoveredReviewLane, completeArchivedReviewRecovery, type ArchivedReviewRecovery } from './archived-review-recovery';
import {
  REPO_SETUP_POLICY_IDENTITY_KIND,
  repoSetupCopyBindingRequirements,
  repoSetupExternalSymlinkAllowlist,
  repoSetupPolicyMatchesSnapshot,
  runRegisteredRepoSetup,
} from './repo-setup';
import {
  compareWorkspaceStorageScans,
  scanWorkspaceStorageState,
  type WorkspaceStorageVerifierOptions,
} from './storage-verifier';
import { parkExactWorktree, restoreExactWorktree } from './worktree-exact';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';
import { writeManagedWorkspaceSafetyHooks } from '@/lib/worktree/safety-hooks';
import {
  queueDependencyImagePublication,
  type DependencyMaterializationReceipt,
} from './dependency-materializer';


export interface RestoreWorkspaceInput {
  repositoryUuid: string;
  packetId: string;
  operationId: string;
  allowedIgnoredPaths?: string[];
  expectedSnapshot?: { generation: number; version: number; fingerprint: string };
}

export type RestoreWorkspaceResult =
  | { status: 'restored' | 'already_materialized'; snapshot: WorkspaceSnapshotRecord }
  | { status: 'refused'; code: string; note: string; snapshot?: WorkspaceSnapshotRecord };

export interface RestoreDependencies {
  listRepos: typeof listRepos;
  findLaneByPacket: (packetId: string) => Lane | null;
  restoreExact: typeof restoreExactWorktree;
  parkExact: typeof parkExactWorktree;
  runSetup: typeof runRegisteredRepoSetup;
  firstScan: typeof scanWorkspaceStorageState;
  secondScan: typeof scanWorkspaceStorageState;
  processProbe: typeof probeOwnedSessionProcessQuiescence;
  writeSafetyHooks: typeof writeManagedWorkspaceSafetyHooks;
  detachDependencies: (repoPath: string, worktreeId: string) => Promise<void>;
  recordDependencyMaterialization: (
    repoPath: string,
    worktreeId: string,
    receipt: DependencyMaterializationReceipt,
  ) => Promise<void>;
  queueDependencyPublication: typeof queueDependencyImagePublication;
  afterExactRestore?: (workspacePath: string) => Promise<void> | void;
}

const DEFAULT_DEPENDENCIES: RestoreDependencies = {
  listRepos,
  findLaneByPacket: findLatestLaneByPacket,
  restoreExact: restoreExactWorktree,
  parkExact: parkExactWorktree,
  runSetup: runRegisteredRepoSetup,
  firstScan: scanWorkspaceStorageState,
  secondScan: scanWorkspaceStorageState,
  processProbe: probeOwnedSessionProcessQuiescence,
  writeSafetyHooks: writeManagedWorkspaceSafetyHooks,
  detachDependencies: (repoPath, worktreeId) => (
    new WorktreeManager(repoPath).detachDependencyMaterialization(worktreeId)
  ),
  recordDependencyMaterialization: (repoPath, worktreeId, receipt) => (
    new WorktreeManager(repoPath).recordDependencyMaterialization(worktreeId, receipt)
  ),
  queueDependencyPublication: queueDependencyImagePublication,
};

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 1_000);
}

function isolationFromSnapshot(snapshot: WorkspaceSnapshotRecord): WorkspaceIsolationKind {
  const identity = snapshot.sessionIdentities.find((entry) => entry.kind === 'workspace-isolation')?.identity;
  if (identity === 'git-worktree' || identity === 'apfs-cow-clone') return identity;
  throw new Error('Workspace snapshot does not identify its isolation provider.');
}

function allowedRebuildablePaths(repo: RepoRegistryEntry, extra: string[] | undefined): string[] {
  return [...new Set([
    ...repo.setup.envFiles,
    'node_modules', '.o8-install-runtime', '.claude/settings.json', '.claude/settings.local.json', '.next/cache', '.turbo', '.venv', 'vendor', 'target', 'Pods', 'DerivedData',
    ...(extra ?? []),
  ])];
}

function transition(
  snapshot: WorkspaceSnapshotRecord,
  operationId: string,
  suffix: string,
  toState: 'restoring' | 'materialized' | 'parked',
  receipt?: Record<string, string | number | boolean | null>,
  error?: WorkspaceSnapshotErrorReceipt,
): WorkspaceSnapshotRecord {
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: `${operationId}:${suffix}`,
    expectedState: snapshot.state,
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState,
    receipt,
    error,
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error(`Workspace restore transition ${suffix} lost its compare-and-swap.`);
  }
  return result.record;
}

async function gitValue(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await materializationAwareExecFile('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function verifyRestoredWorkspaceCheckout(
  snapshot: WorkspaceSnapshotRecord,
  workspacePath = snapshot.originalPath,
): Promise<void> {
  const [branch, head, tree] = await Promise.all([
    gitValue(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{tree}']),
  ]);
  if (branch !== snapshot.branch || head !== snapshot.headCommit || tree !== snapshot.treeSha) {
    throw new Error('Restored checkout does not match its original branch, head, and tree.');
  }
  if (spokenReviewSnapshotFingerprint(head, snapshot.baseCommit, tree) !== snapshot.diffFingerprint) {
    throw new Error('Restored checkout does not match the immutable diff receipt.');
  }
}

async function recordRestoreFailure(
  repo: RepoRegistryEntry,
  snapshot: WorkspaceSnapshotRecord,
  operationId: string,
  error: unknown,
  deps: RestoreDependencies,
  allowedIgnoredPaths: string[],
  allowedExternalSymlinks: WorkspaceStorageVerifierOptions['allowedExternalSymlinks'],
  requiredCopyBindings: WorkspaceStorageVerifierOptions['requiredCopyBindings'],
): Promise<WorkspaceSnapshotRecord> {
  const failure: WorkspaceSnapshotErrorReceipt = {
    code: 'restore_failed',
    message: compactError(error),
    phase: snapshot.state,
    recordedAt: Date.now(),
  };
  let current = getWorkspaceSnapshot(repo.id, snapshot.packetId) ?? snapshot;
  if (current.state !== 'restoring') return current;
  let pathState: 'present' | 'absent' | 'unknown' = 'unknown';
  try {
    await lstat(current.originalPath);
    pathState = 'present';
  } catch (error) {
    pathState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
  if (pathState === 'absent') {
    return transition(current, operationId, 'failed-path-absent', 'parked', undefined, failure);
  }
  if (pathState === 'unknown') {
    const quarantined: WorkspaceSnapshotErrorReceipt = {
      ...failure,
      message: `${failure.message} The original path could not be inspected, so it remains quarantined.`,
    };
    return transition(current, operationId, 'failed-path-unknown', 'restoring', undefined, quarantined);
  }

  try {
    await deps.detachDependencies(repo.localPath, path.basename(current.originalPath));
    const scan = await deps.firstScan(current.originalPath, {
      allowedIgnoredPaths,
      allowedExternalSymlinks,
      requiredCopyBindings,
    });
    if (scan.state !== 'verified_clean') throw new Error('Failed restore left non-rebuildable workspace changes.');
    const sessionIdentity = current.sessionIdentities.find((entry) => entry.kind === 'owned-session');
    if (!sessionIdentity) throw new Error('Snapshot has no owned session identity.');
    const processReceipt = await deps.processProbe(sessionIdentity.identity, current.originalPath);
    if (processReceipt.state !== 'quiescent') throw new Error('Failed restore still has a live or unknown process user.');
    await deps.parkExact({
      repoPath: repo.localPath,
      worktreeId: path.basename(current.originalPath),
      expectedPath: current.originalPath,
      expectedBranch: current.branch,
      expectedHead: current.headCommit,
      expectedSessionKey: sessionIdentity.identity,
      probeProcessQuiescence: async (sessionKey, workspacePath) => {
        const boundaryScan = await deps.secondScan(workspacePath, {
          allowedIgnoredPaths,
          allowedExternalSymlinks,
          requiredCopyBindings,
        });
        if (boundaryScan.state !== 'verified_clean' || boundaryScan.fingerprint !== scan.fingerprint) {
          throw new Error('Failed restore changed at the rollback destructive boundary.');
        }
        return deps.processProbe(sessionKey, workspacePath);
      },
      quarantine: {
        snapshotFingerprint: current.snapshotFingerprint,
        intent: 'restore-rollback',
      },
      verifyQuarantinedClone: async (quarantinePath) => {
        const quarantineScan = await deps.secondScan(quarantinePath, {
          allowedIgnoredPaths,
          allowedExternalSymlinks,
          requiredCopyBindings,
        });
        if (quarantineScan.state !== 'verified_clean' || quarantineScan.fingerprint !== scan.fingerprint) {
          throw new Error('Failed copy-on-write restore changed during rollback quarantine.');
        }
        const quarantineProcess = await deps.processProbe(sessionIdentity.identity, quarantinePath);
        if (quarantineProcess.state !== 'quiescent') {
          throw new Error('Failed copy-on-write restore has a process user after quarantine.');
        }
      },
    });
    current = getWorkspaceSnapshot(repo.id, snapshot.packetId) ?? current;
    return transition(current, operationId, 'failed-rolled-back', 'parked', undefined, failure);
  } catch (rollbackError) {
    const quarantined: WorkspaceSnapshotErrorReceipt = {
      ...failure,
      message: `${failure.message} Rollback held the materialized path: ${compactError(rollbackError)}`,
    };
    return transition(current, operationId, 'failed-quarantined', 'restoring', undefined, quarantined);
  }
}

export async function rollbackInterruptedRestore(
  input: {
    repo: RepoRegistryEntry;
    snapshot: WorkspaceSnapshotRecord;
    operationId: string;
    error: unknown;
    allowedIgnoredPaths?: string[];
  },
  overrides: Partial<RestoreDependencies> = {},
): Promise<WorkspaceSnapshotRecord> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const allowedIgnoredPaths = allowedRebuildablePaths(input.repo, input.allowedIgnoredPaths);
  const allowedExternalSymlinks = await repoSetupExternalSymlinkAllowlist(
    input.repo,
    input.snapshot.originalPath,
  );
  const requiredCopyBindings = await repoSetupCopyBindingRequirements(input.repo);
  return recordRestoreFailure(
    input.repo,
    input.snapshot,
    input.operationId,
    input.error,
    deps,
    allowedIgnoredPaths,
    allowedExternalSymlinks,
    requiredCopyBindings,
  );
}

/** Restore a parked packet to the exact original path and owned session identity. */
export async function restoreWorkspace(
  input: RestoreWorkspaceInput,
  overrides: Partial<RestoreDependencies> = {},
): Promise<RestoreWorkspaceResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended) return { status: 'refused', code: 'lifecycle_contended', note: 'Another packet lifecycle mutation ran first.' };
    let repo: RepoRegistryEntry | undefined;
    let lane: Lane | null = null;
    let snapshot: WorkspaceSnapshotRecord | null = null;
    let archivedRecovery: ArchivedReviewRecovery | null = null;
    let completedPin: CompletedRestorePin | null = null;
    let allowedIgnoredPaths: string[] = [];
    let allowedExternalSymlinks: WorkspaceStorageVerifierOptions['allowedExternalSymlinks'] = {};
    let requiredCopyBindings: WorkspaceStorageVerifierOptions['requiredCopyBindings'] = {};
    try {
      if (!input.operationId.trim()) throw new Error('operationId is required.');
      repo = (await deps.listRepos()).find((entry) => entry.id === input.repositoryUuid);
      if (!repo) throw new Error('Registered repository UUID was not found.');
      const registeredRepo = repo;
      lane = deps.findLaneByPacket(input.packetId);
      if (!lane || lane.packetId !== input.packetId || lane.ownership !== 'managed') {
        throw new Error('Only a managed reviewing packet lane can be restored.');
      }
      snapshot = getWorkspaceSnapshot(repo.id, input.packetId);
      if (!snapshot) throw new Error('Workspace snapshot was not found.');
      if (lane.status === 'archived') {
        const expected = input.expectedSnapshot;
        if (!expected || expected.generation !== snapshot.snapshotGeneration || expected.version !== snapshot.version
          || expected.fingerprint !== snapshot.snapshotFingerprint) throw new Error('The requested parked generation changed.');
        archivedRecovery = await prepareArchivedReviewRecovery(lane, snapshot);
      } else if (lane.status === 'completed') {
        const completed = completedParkedWorkspace(lane, snapshot);
        if (!completed) throw new Error('Completed Restore requires the matching parked generation and canonical release HEAD.');
        completedPin = { snapshot, releaseHead: completed.releaseHead };
      } else if (lane.status !== 'reviewing') throw new Error('Only a managed reviewing packet lane can be restored.');
      if (snapshot.state === 'materialized') return { status: 'already_materialized', snapshot };
      if (snapshot.state !== 'parked') throw new Error(`Workspace snapshot is ${snapshot.state}; reconcile it before restoring.`);
      if (path.resolve(lane.repoPath) !== path.resolve(repo.localPath)
        || path.resolve(lane.worktreePath ?? snapshot.originalPath) !== path.resolve(snapshot.originalPath)) {
        throw new Error('Lane repository or original path does not match the parked snapshot.');
      }
      requiredCopyBindings = await repoSetupCopyBindingRequirements(repo);
      const expectedPolicyKey = snapshot.sessionIdentities
        .find((entry) => entry.kind === REPO_SETUP_POLICY_IDENTITY_KIND)?.identity ?? null;
      if (!await repoSetupPolicyMatchesSnapshot(
        repo,
        requiredCopyBindings,
        snapshot.dependencyRecipeKey,
        expectedPolicyKey,
      )) {
        throw new Error('Registered repo setup changed after parking; exact restore requires the saved recipe.');
      }
      await verifyImmutableWorkspaceTruth(repo.localPath, snapshot);
      const isolationKind = isolationFromSnapshot(snapshot);
      allowedIgnoredPaths = allowedRebuildablePaths(repo, input.allowedIgnoredPaths);
      allowedExternalSymlinks = await repoSetupExternalSymlinkAllowlist(
        repo,
        snapshot.originalPath,
      );
      if (archivedRecovery) {
        try {
          await lstat(snapshot.originalPath);
          throw new Error('The original workspace path is occupied.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const processReceipt = await deps.processProbe(archivedRecovery.binding.surfaceId, snapshot.originalPath, { allowArchivedRecovery: true });
        if (processReceipt.state !== 'quiescent') throw new Error('Archived session process quiescence is unproved.');
        assertArchivedReviewRecoveryCurrent(archivedRecovery, false);
      }
      snapshot = transition(snapshot, input.operationId, 'restoring', 'restoring', {
        originalPath: snapshot.originalPath,
        isolationKind,
        archiveRecovery: archivedRecovery ? true : null,
        archiveRecoveryLaneId: archivedRecovery ? lane.id : null,
        archiveRecoveryApprovalId: archivedRecovery?.approvalId ?? null,
        archiveRecoveryOriginalVersion: archivedRecovery ? snapshot.version : null,
        archiveRecoverySessionFingerprint: archivedRecovery?.binding.recordFingerprint ?? null,
      });
      const assertCompletedRestoreCurrent = () => {
        if (!completedPin) return null;
        const current = deps.findLaneByPacket(input.packetId);
        const currentSnapshot = getWorkspaceSnapshot(registeredRepo.id, input.packetId);
        if (!current || !currentSnapshot || !completedParkedWorkspace(current, currentSnapshot, undefined, completedPin)) {
          throw new Error('Completed workspace owner, release HEAD or pinned generation changed during explicit Restore.');
        }
        return current;
      };
      assertCompletedRestoreCurrent();
      await deps.restoreExact({
        repoPath: repo.localPath,
        worktreeId: path.basename(snapshot.originalPath),
        expectedPath: snapshot.originalPath,
        branch: snapshot.branch,
        head: snapshot.headCommit,
        tree: snapshot.treeSha,
        baseBranch: lane.baseBranch,
        agentType: lane.runtime,
        sessionKey: lane.sessionKey ?? undefined,
        createdAt: Date.parse(lane.createdAt),
        isolationKind,
      });
      await deps.afterExactRestore?.(snapshot.originalPath);
      assertCompletedRestoreCurrent();
      const materializationIdentity = await assertManagedWorkspaceMaterialization(
        repo.localPath,
        snapshot.originalPath,
      );
      return await withWorktreeMaterializationExecution(
        snapshot.originalPath,
        materializationIdentity,
        async () => {
      if (!repo || !lane || !snapshot) {
        throw new Error('Restore ownership disappeared before its pinned setup boundary.');
      }
      const setupReceipt = await deps.runSetup(repo, snapshot.originalPath, {
        requiredCopyBindings,
        materializationIdentity,
        expectedRecipeKey: snapshot.dependencyRecipeKey ?? undefined,
      });
      if (setupReceipt.recipeKey !== snapshot.dependencyRecipeKey) {
        throw new Error('Restored setup receipt does not match the saved recipe.');
      }
      if (setupReceipt.install.materialization) {
        await deps.recordDependencyMaterialization(
          repo.localPath,
          path.basename(snapshot.originalPath),
          setupReceipt.install.materialization,
        );
      }
      await deps.writeSafetyHooks(repo.localPath, snapshot.originalPath, materializationIdentity);
      await verifyRestoredWorkspaceCheckout(snapshot);
      const first = await deps.firstScan(snapshot.originalPath, {
        allowedIgnoredPaths,
        allowedExternalSymlinks,
        requiredCopyBindings,
      });
      if (first.state !== 'verified_clean') throw new Error('Restored workspace did not pass its first storage verification.');

      if (archivedRecovery) {
        assertArchivedReviewRecoveryCurrent(archivedRecovery);
        const recovery = archivedRecovery;
        const lifecycle = getOwnedSessionLifecycle(recovery.binding.surfaceId);
        if (!lifecycle?.recoverArchivedWorkspace) throw new Error('Session recovery capability disappeared.');
        await lifecycle.recoverArchivedWorkspace(recovery.binding.surfaceId, recovery.binding,
          () => publishRecoveredReviewLane(recovery));
      }
      for (const identity of snapshot.sessionIdentities.filter((entry) => entry.kind === 'owned-session')) {
        const lifecycle = getOwnedSessionLifecycle(identity.identity);
        if (!lifecycle?.getWorkspaceBinding || !lifecycle.rebindWorkspace || !identity.bindingId) {
          throw new Error(`Owned session ${identity.identity} cannot be rebound exactly.`);
        }
        const binding = await lifecycle.getWorkspaceBinding(identity.identity);
        if (!binding || binding.sessionState !== 'active') {
          throw new Error(`Owned session ${identity.identity} is unavailable for exact rebind.`);
        }
        const rebound = await lifecycle.rebindWorkspace(identity.identity, {
          logicalWorkspaceId: identity.bindingId,
          repositoryUuid: repo.id,
          packetId: input.packetId,
          expectedCwd: snapshot.originalPath,
          nextCwd: snapshot.originalPath,
          expectedVersion: binding.binding.version,
        });
        if (rebound.status !== 'rebound' && rebound.status !== 'idempotent') {
          throw new Error(`Owned session ${identity.identity} rebind was ${rebound.status}.`);
        }
      }
      const second = await deps.secondScan(snapshot.originalPath, {
        allowedIgnoredPaths,
        allowedExternalSymlinks,
        requiredCopyBindings,
      });
      const comparison = compareWorkspaceStorageScans(first, second);
      if (comparison.state !== 'verified_clean' || !comparison.identical) {
        throw new Error('Restored workspace changed across session rebinding.');
      }
      for (const identity of snapshot.sessionIdentities.filter((entry) => entry.kind === 'owned-session')) {
        const processReceipt = await deps.processProbe(identity.identity, snapshot.originalPath);
        if (processReceipt.state !== 'quiescent') {
          throw new Error(`Restored owned session process state is ${processReceipt.state}.`);
        }
      }
      const restoringSnapshot = snapshot;
      const complete = () => transition(restoringSnapshot, input.operationId, 'materialized', 'materialized', {
        setupRecipeKey: setupReceipt.recipeKey,
        dependencyMode: setupReceipt.install.materialization?.mode ?? null,
        dependencyLeaseId: setupReceipt.install.materialization?.leaseId ?? null,
        dependencyGeneration: setupReceipt.install.materialization?.generation ?? null,
        dependencyWorkspaceDevice: setupReceipt.install.materialization?.workspaceDevice ?? null,
        dependencyWorkspaceInode: setupReceipt.install.materialization?.workspaceInode ?? null,
        envBindingCount: setupReceipt.envBindings.length,
        firstFingerprint: first.fingerprint,
        secondFingerprint: second.fingerprint,
      });
      snapshot = archivedRecovery ? await completeArchivedReviewRecovery(archivedRecovery, complete)
        : completedPin ? getSqlite().transaction(() => {
          const current = assertCompletedRestoreCurrent()!;
          const materialized = complete();
          if (current.worktreePath === null) {
            updateLane(current.id, { worktreePath: materialized.originalPath }, 'system', { phase: 'workspace_restored' });
          }
          return materialized;
        }).immediate() : complete();
      if (setupReceipt.install.materialization) {
        deps.queueDependencyPublication(
          snapshot.originalPath,
          setupReceipt.install.materialization,
        );
      }
      return { status: 'restored', snapshot };
        },
      );
    } catch (error) {
      if (archivedRecovery && snapshot) {
        const current = getWorkspaceSnapshot(snapshot.repositoryUuid, snapshot.packetId);
        const held = current?.state === 'restoring'
          && current.snapshotGeneration === archivedRecovery.snapshot.snapshotGeneration
          && current.snapshotFingerprint === archivedRecovery.snapshot.snapshotFingerprint
          && current.version === archivedRecovery.snapshot.version + 1
          ? transition(current, input.operationId, 'archive-recovery-held', 'restoring',
          { archiveRecovery: true }, { code: 'archive_recovery_incomplete', message: compactError(error),
            phase: 'restoring', recordedAt: Date.now() }) : current;
        return { status: 'refused', code: 'archive_recovery_incomplete', note: compactError(error), snapshot: held ?? undefined };
      }
      const failedSnapshot = repo && snapshot
        ? await recordRestoreFailure(
            repo,
            snapshot,
            input.operationId,
            error,
            deps,
            allowedIgnoredPaths,
            allowedExternalSymlinks,
            requiredCopyBindings,
          ).catch(() => undefined)
        : undefined;
      return { status: 'refused', code: 'restore_refused', note: compactError(error), snapshot: failedSnapshot };
    }
  });
}
