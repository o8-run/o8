import { execFile } from '@/lib/providers/child-process';
import { access, lstat, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { isSafeGitRef } from '@/lib/git/refs';
import { spokenReviewSnapshotFingerprint } from '@/lib/lane/lane-diff-facts';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { assertNoActiveWorkspaceArtifactRestore } from './artifact-restore-state';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import {
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
  type WorkspaceSnapshotErrorReceipt,
  type WorkspaceSnapshotRecord,
  type WorkspaceSnapshotState,
} from '@/lib/worktree/snapshot-state';
import { beginWorkspaceSnapshotGeneration } from '@/lib/worktree/snapshot-generation';
import type { WorkspaceIsolationKind } from '@/lib/worktree/types';
import { WorktreeManager } from '@/lib/worktree/manager';
import {
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from '@/lib/worktree/materialization-execution';
import { probeOwnedSessionProcessQuiescence } from './process-probes';
import {
  REPO_SETUP_POLICY_IDENTITY_KIND,
  repoSetupBoundRecipeKey,
  repoSetupCopyBindingRequirements,
  repoSetupExternalSymlinkAllowlist,
  repoSetupPolicyKey,
} from './repo-setup';
import {
  compareWorkspaceStorageScans,
  scanWorkspaceStorageState,
  type WorkspaceScanReceipt,
} from './storage-verifier';
import {
  detachDependencyMaterialization,
  type DependencyMaterializationReceipt,
} from './dependency-materializer';
import { inspectExactWorktreeQuarantine, parkExactWorktree } from './worktree-exact';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';
import { assertSettledCompletedWorkspace, sameWorkspaceSnapshot } from './completed-packet';

const execFileAsync = promisify(execFile);
const ZERO_OID = '0000000000000000000000000000000000000000';
const SAFE_REF_COMPONENT = /^[a-zA-Z0-9._-]+$/;

export interface WorkspaceStorageReceipt {
  availableBytes: number;
  logicalBytes: number | null;
  measuredAt: string;
}

export interface ImmutableWorkspaceTruth {
  branch: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  diffFingerprint: string;
  isolationKind: WorkspaceIsolationKind;
}

export type ParkWorkspaceResult =
  | { status: 'parked' | 'already_parked'; snapshot: WorkspaceSnapshotRecord }
  | { status: 'refused'; code: string; note: string; snapshot?: WorkspaceSnapshotRecord };

export interface ParkWorkspaceInput {
  repositoryUuid: string;
  packetId: string;
  operationId: string;
  allowedIgnoredPaths?: string[];
  /** Additional fresh policy guard; never relaxes workspace eligibility. */
  assertPolicyCurrent?: () => Promise<void>;
}

export interface HibernateDependencies {
  listRepos: typeof listRepos;
  findLaneByPacket: (packetId: string) => Lane | null;
  firstScan: typeof scanWorkspaceStorageState;
  secondScan: typeof scanWorkspaceStorageState;
  processProbe: typeof probeOwnedSessionProcessQuiescence;
  parkExact: typeof parkExactWorktree;
  measureStorage: typeof measureWorkspaceStorage;
  readDependencyMaterialization: (
    repoPath: string,
    worktreeId: string,
  ) => Promise<DependencyMaterializationReceipt | null>;
  detachDependencies: (
    workspacePath: string,
    receipt: DependencyMaterializationReceipt,
  ) => Promise<void>;
  restoreDependencies: (
    repoPath: string,
    worktreeId: string,
    receipt: DependencyMaterializationReceipt,
  ) => Promise<DependencyMaterializationReceipt>;
}

const DEFAULT_DEPENDENCIES: HibernateDependencies = {
  listRepos,
  findLaneByPacket: findLatestLaneByPacket,
  firstScan: scanWorkspaceStorageState,
  secondScan: scanWorkspaceStorageState,
  processProbe: probeOwnedSessionProcessQuiescence,
  parkExact: parkExactWorktree,
  measureStorage: measureWorkspaceStorage,
  readDependencyMaterialization: async (repoPath, worktreeId) => (
    (await new WorktreeManager(repoPath).get(worktreeId))?.dependencyMaterialization ?? null
  ),
  detachDependencies: detachDependencyMaterialization,
  restoreDependencies: (repoPath, worktreeId, receipt) => (
    new WorktreeManager(repoPath).restoreDependencyMaterialization(worktreeId, receipt)
  ),
};

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 1_000);
}

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
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

export function workspaceRecoveryRef(repositoryUuid: string, packetId: string, generation: number): string {
  if (!SAFE_REF_COMPONENT.test(repositoryUuid) || !SAFE_REF_COMPONENT.test(packetId)) {
    throw new Error('Repository and packet identities must be safe Git ref components.');
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Snapshot generation must be a positive safe integer.');
  }
  const suffix = generation === 1 ? '' : `-g${generation}`;
  const ref = `refs/o8/recovery/${repositoryUuid}/${packetId}${suffix}`;
  if (!isSafeGitRef(ref)) throw new Error('Generated recovery ref is invalid.');
  return ref;
}

async function isolationKind(workspacePath: string): Promise<WorkspaceIsolationKind> {
  const marker = await lstat(path.join(workspacePath, '.git'));
  if (marker.isFile()) return 'git-worktree';
  if (marker.isDirectory()) return 'apfs-cow-clone';
  throw new Error('Workspace Git metadata is neither a managed worktree nor an isolated clone.');
}

export async function readImmutableWorkspaceTruth(
  repo: RepoRegistryEntry,
  lane: Lane,
  generation = 1,
): Promise<ImmutableWorkspaceTruth> {
  const workspacePath = path.resolve(lane.worktreePath!);
  const repoPath = path.resolve(repo.localPath);
  const [topLevel, canonicalWorkspace, branch, headCommit, treeSha, kind] = await Promise.all([
    gitValue(workspacePath, ['rev-parse', '--show-toplevel']),
    realpath(workspacePath),
    gitValue(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{tree}']),
    isolationKind(workspacePath),
  ]);
  if (await realpath(topLevel) !== canonicalWorkspace || branch !== lane.branch) {
    throw new Error('Workspace path or branch does not match the reviewing lane.');
  }
  if (kind === 'git-worktree') {
    const [workspaceCommon, repoGit] = await Promise.all([
      gitValue(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      gitValue(repoPath, ['rev-parse', '--path-format=absolute', '--git-dir']),
    ]);
    if (await realpath(workspaceCommon) !== await realpath(repoGit)) {
      throw new Error('Git worktree does not share the registered repository object store.');
    }
  }
  const baseRef = lane.baseBranch.trim() || repo.defaultBranch;
  const baseTip = await gitValue(workspacePath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const baseCommit = await gitValue(workspacePath, ['merge-base', baseTip, headCommit]);
  return {
    branch,
    baseCommit,
    headCommit,
    treeSha,
    recoveryRef: workspaceRecoveryRef(repo.id, lane.packetId!, generation),
    diffFingerprint: spokenReviewSnapshotFingerprint(headCommit, baseCommit, treeSha),
    isolationKind: kind,
  };
}

export async function ensureWorkspaceRecoveryRef(
  repoPath: string,
  workspacePath: string,
  truth: ImmutableWorkspaceTruth,
): Promise<void> {
  let existing = await gitValue(repoPath, ['rev-parse', '--verify', `${truth.recoveryRef}^{commit}`])
    .catch(() => '');
  if (existing && existing !== truth.headCommit) {
    throw new Error('Recovery ref already protects a different reviewed head.');
  }
  if (!existing && truth.isolationKind === 'apfs-cow-clone') {
    await gitValue(workspacePath, [
      'push', '--no-verify', repoPath, `${truth.headCommit}:${truth.recoveryRef}`,
    ]);
    existing = await gitValue(repoPath, ['rev-parse', '--verify', `${truth.recoveryRef}^{commit}`])
      .catch(() => '');
  }
  if (!existing) {
    await gitValue(repoPath, ['update-ref', truth.recoveryRef, truth.headCommit, ZERO_OID]);
    existing = truth.headCommit;
  }
  if (existing !== truth.headCommit) throw new Error('Recovery ref CAS did not preserve the reviewed head.');
  await verifyImmutableWorkspaceTruth(repoPath, truth);
}

export async function verifyImmutableWorkspaceTruth(
  repoPath: string,
  truth: ImmutableWorkspaceTruth | Pick<WorkspaceSnapshotRecord,
    'baseCommit' | 'headCommit' | 'treeSha' | 'recoveryRef' | 'diffFingerprint'>,
): Promise<void> {
  const [base, head, tree, recovered, headTree] = await Promise.all([
    gitValue(repoPath, ['rev-parse', '--verify', `${truth.baseCommit}^{commit}`]),
    gitValue(repoPath, ['rev-parse', '--verify', `${truth.headCommit}^{commit}`]),
    gitValue(repoPath, ['rev-parse', '--verify', `${truth.treeSha}^{tree}`]),
    gitValue(repoPath, ['rev-parse', '--verify', `${truth.recoveryRef}^{commit}`]),
    gitValue(repoPath, ['rev-parse', '--verify', `${truth.headCommit}^{tree}`]),
  ]);
  if (base !== truth.baseCommit || head !== truth.headCommit || tree !== truth.treeSha
    || recovered !== truth.headCommit || headTree !== truth.treeSha) {
    throw new Error('Immutable Git object receipt no longer matches the protected recovery ref.');
  }
  if (spokenReviewSnapshotFingerprint(head, base, tree) !== truth.diffFingerprint) {
    throw new Error('Immutable diff fingerprint no longer matches the reviewed objects.');
  }
  await gitValue(repoPath, ['fsck', '--connectivity-only', '--no-dangling', head, base]);
}

export async function measureWorkspaceStorage(workspacePath: string): Promise<WorkspaceStorageReceipt> {
  const measuredAt = new Date().toISOString();
  const volume = await statfs(workspacePath, { bigint: true });
  const available = volume.bavail * volume.bsize;
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Available storage exceeds the safe receipt range.');
  }
  let logicalBytes: number | null = null;
  try {
    const args = process.platform === 'darwin' ? ['-skA', workspacePath] : ['-sk', '--apparent-size', workspacePath];
    const { stdout } = await execFileAsync('du', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const kib = Number.parseInt(stdout.trim().split(/\s+/, 1)[0] ?? '', 10);
    if (Number.isSafeInteger(kib) && kib >= 0) logicalBytes = kib * 1_024;
  } catch {
    // Logical bytes are supplemental. Volume availability remains authoritative.
  }
  return { availableBytes: Number(available), logicalBytes, measuredAt };
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
  toState: WorkspaceSnapshotState,
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
    throw new Error(`Workspace snapshot transition ${suffix} lost its compare-and-swap.`);
  }
  return result.record;
}

async function recordParkFailure(
  repo: RepoRegistryEntry,
  packetId: string,
  operationId: string,
  error: unknown,
): Promise<WorkspaceSnapshotRecord | undefined> {
  const current = getWorkspaceSnapshot(repo.id, packetId);
  if (!current || current.state === 'parked' || current.state === 'restoring') return current ?? undefined;
  const receipt: WorkspaceSnapshotErrorReceipt = {
    code: 'park_failed',
    message: compactError(error),
    phase: current.state,
    recordedAt: Date.now(),
  };
  if (current.state === 'hibernating' && !(await pathExists(current.originalPath))) {
    try {
      await verifyImmutableWorkspaceTruth(repo.localPath, current);
      const quarantine = await inspectExactWorktreeQuarantine({
        repoPath: repo.localPath,
        worktreeId: path.basename(current.originalPath),
        expectedPath: current.originalPath,
        quarantine: {
          snapshotFingerprint: current.snapshotFingerprint,
          intent: 'park',
        },
      });
      if (quarantine.state !== 'clear') {
        return transition(current, operationId, 'quarantined-after-remove', 'hibernating', {
          quarantineState: quarantine.state,
        }, receipt);
      }
      return transition(current, operationId, 'failed-after-remove', 'parked', undefined, receipt);
    } catch {
      return transition(current, operationId, 'quarantined-after-remove', 'hibernating', undefined, receipt);
    }
  }
  const target = current.state === 'parkable' || current.state === 'hibernating'
    ? 'materialized'
    : current.state;
  return transition(current, operationId, 'failed-before-remove', target, undefined, receipt);
}

/** Park a reviewing packet, or a proven settled completed owner, with exact Git and process proof. */
export async function parkWorkspace(
  input: ParkWorkspaceInput,
  overrides: Partial<HibernateDependencies> = {},
): Promise<ParkWorkspaceResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended) return { status: 'refused', code: 'lifecycle_contended', note: 'Another packet lifecycle mutation ran first.' };
    let repo: RepoRegistryEntry | undefined;
    try {
      assertNoActiveWorkspaceArtifactRestore(input.packetId);
      if (!input.operationId.trim()) throw new Error('operationId is required.');
      repo = (await deps.listRepos()).find((entry) => entry.id === input.repositoryUuid);
      if (!repo) throw new Error('Registered repository UUID was not found.');
      const registeredRepo = repo;
      const lane = deps.findLaneByPacket(input.packetId);
      if (!lane || lane.packetId !== input.packetId || !['reviewing', 'completed'].includes(lane.status)) {
        throw new Error('Only a reviewing or proven settled completed packet lane can be parked.');
      }
      if (lane.ownership !== 'managed' || !lane.worktreePath || !lane.sessionKey) {
        throw new Error('Parking requires a managed lane, exact worktree path, and owned session.');
      }
      if (path.resolve(lane.repoPath) !== path.resolve(repo.localPath)
        || path.resolve(lane.worktreePath) === path.resolve(repo.localPath)) {
        throw new Error('Lane repository or isolated worktree identity does not match the registry.');
      }
      const existing = getWorkspaceSnapshot(repo.id, input.packetId);
      let pinnedSnapshot = existing;
      const completed = lane.status === 'completed'
        ? assertSettledCompletedWorkspace(lane, undefined, existing) : null;
      const assertBoundaryCurrent = async () => {
        await input.assertPolicyCurrent?.();
        if (!completed) return;
        const current = deps.findLaneByPacket(input.packetId);
        if (!current || current.id !== lane.id || current.sessionKey !== lane.sessionKey
          || current.branch !== lane.branch || current.worktreePath !== lane.worktreePath
          || current.repoPath !== lane.repoPath) throw new Error('Completed workspace owner changed at the parking boundary.');
        const currentSnapshot = getWorkspaceSnapshot(registeredRepo.id, input.packetId);
        if (pinnedSnapshot && (!currentSnapshot || !sameWorkspaceSnapshot(currentSnapshot, pinnedSnapshot))) {
          throw new Error('Completed workspace snapshot generation changed at the parking boundary.');
        }
        assertSettledCompletedWorkspace(current, completed, pinnedSnapshot);
      };
      const boundaryGuards = completed || input.assertPolicyCurrent ? {
        beforeQuarantineRename: assertBoundaryCurrent,
        beforeQuarantineClaim: assertBoundaryCurrent,
        beforeQuarantinePurgeRename: assertBoundaryCurrent,
        beforeClaimedPurge: assertBoundaryCurrent,
        afterClaimedTreeCapture: assertBoundaryCurrent,
      } : {};
      const currentPathExists = await pathExists(lane.worktreePath);
      if (existing?.state === 'parked' && !currentPathExists) {
        if (existing.laneId === lane.id
          && path.resolve(existing.originalPath) === path.resolve(lane.worktreePath)) {
          return { status: 'already_parked', snapshot: existing };
        }
        throw new Error('A prior parked generation exists, but the replacement lane path is not materialized.');
      }
      if (!currentPathExists) throw new Error('The reviewing lane worktree path is not materialized.');
      if (existing && existing.state !== 'materialized' && existing.state !== 'parked') {
        throw new Error(`Workspace snapshot is ${existing.state}; reconcile it before parking again.`);
      }
      if (existing?.state === 'materialized'
        && path.resolve(existing.originalPath) !== path.resolve(lane.worktreePath)
        && await pathExists(existing.originalPath)) {
        throw new Error('The prior materialized snapshot path still exists; retire it before superseding the generation.');
      }

      const lifecycle = getOwnedSessionLifecycle(lane.sessionKey);
      if (!lifecycle?.getWorkspaceBinding || !lifecycle.rebindWorkspace) {
        throw new Error('The lane session does not support exact owned-workspace rebinding.');
      }
      const binding = await lifecycle.getWorkspaceBinding(lane.sessionKey);
      if (!binding || binding.sessionState !== 'active'
        || path.resolve(binding.binding.cwd) !== path.resolve(lane.worktreePath)
        || (binding.binding.packetId !== null && binding.binding.packetId !== input.packetId)) {
        throw new Error('Owned session workspace binding does not match the reviewing packet.');
      }

      const materializationIdentity = await assertManagedWorkspaceMaterialization(
        repo.localPath,
        lane.worktreePath,
      );
      return await withWorktreeMaterializationExecution(
        lane.worktreePath,
        materializationIdentity,
        async () => {
      if (!repo || !lane.worktreePath || !lane.sessionKey) {
        throw new Error('Managed workspace identity disappeared before its pinned parking boundary.');
      }

      const allowedIgnoredPaths = allowedRebuildablePaths(repo, input.allowedIgnoredPaths);
      const allowedExternalSymlinks = await repoSetupExternalSymlinkAllowlist(
        repo,
        lane.worktreePath,
      );
      const requiredCopyBindings = await repoSetupCopyBindingRequirements(repo);
      const worktreeId = path.basename(lane.worktreePath);
      const dependencyMaterialization = await deps.readDependencyMaterialization(
        repo.localPath,
        worktreeId,
      );
      if (dependencyMaterialization?.status === 'prepared') {
        throw new Error('Workspace dependency image is still prepared and cannot be parked.');
      }
      const processReceipt = await deps.processProbe(lane.sessionKey, lane.worktreePath);
      if (processReceipt.state !== 'quiescent') {
        throw new Error(`Owned workspace process state is ${processReceipt.state}.`);
      }
      const first = await deps.firstScan(lane.worktreePath, {
        allowedIgnoredPaths,
        allowedExternalSymlinks,
        requiredCopyBindings,
      });
      if (first.state !== 'verified_clean') throw new Error('First workspace storage scan did not prove a clean rebuildable tree.');
      const dependencyRecipeKey = await repoSetupBoundRecipeKey(
        repo,
        requiredCopyBindings,
        lane.worktreePath,
      );
      let truth = await readImmutableWorkspaceTruth(repo, lane, existing?.snapshotGeneration ?? 1);
      if (completed?.packet.releaseStatePayload?.headSha
        && completed.packet.releaseStatePayload.headSha !== truth.headCommit) {
        throw new Error('Completed workspace HEAD differs from its canonical release proof.');
      }
      const beforeStorage = await deps.measureStorage(lane.worktreePath);
      const sessionIdentities = [
        {
          kind: 'owned-session',
          identity: lane.sessionKey,
          runtime: lifecycle.runtimeId,
          bindingId: binding.binding.logicalWorkspaceId,
        },
        {
          kind: 'workspace-isolation',
          identity: truth.isolationKind,
          runtime: null,
          bindingId: null,
        },
        {
          kind: REPO_SETUP_POLICY_IDENTITY_KIND,
          identity: repoSetupPolicyKey(repo, requiredCopyBindings),
          runtime: null,
          bindingId: null,
        },
      ];
      const existingDiffers = existing && (
        existing.originalPath !== path.resolve(lane.worktreePath)
        || existing.laneId !== lane.id
        || existing.branch !== truth.branch
        || existing.baseCommit !== truth.baseCommit
        || existing.headCommit !== truth.headCommit
        || existing.treeSha !== truth.treeSha
        || existing.recoveryRef !== truth.recoveryRef
        || existing.diffFingerprint !== truth.diffFingerprint
        || existing.dependencyRecipeKey !== dependencyRecipeKey
        || JSON.stringify(existing.sessionIdentities) !== JSON.stringify(sessionIdentities)
      );
      if (completed && existingDiffers) {
        throw new Error('Completed workspace changed from its existing managed snapshot.');
      }
      let snapshot: WorkspaceSnapshotRecord;
      if (!existing) {
        await ensureWorkspaceRecoveryRef(repo.localPath, lane.worktreePath, truth);
        snapshot = createWorkspaceSnapshot({
          repositoryUuid: repo.id,
          packetId: input.packetId,
          laneId: lane.id,
          originalPath: path.resolve(lane.worktreePath),
          branch: truth.branch,
          baseCommit: truth.baseCommit,
          headCommit: truth.headCommit,
          treeSha: truth.treeSha,
          recoveryRef: truth.recoveryRef,
          diffFingerprint: truth.diffFingerprint,
          dependencyRecipeKey,
          sessionIdentities,
          creationId: `${input.operationId}:create`,
          receipt: {
            isolationKind: truth.isolationKind,
            dependencyMode: dependencyMaterialization?.mode ?? null,
            dependencyLeaseId: dependencyMaterialization?.leaseId ?? null,
            dependencyGeneration: dependencyMaterialization?.generation ?? null,
            dependencyWorkspaceDevice: dependencyMaterialization?.workspaceDevice ?? null,
            dependencyWorkspaceInode: dependencyMaterialization?.workspaceInode ?? null,
          },
        }).record;
      } else if (existing.state === 'materialized' && !existingDiffers) {
        await ensureWorkspaceRecoveryRef(repo.localPath, lane.worktreePath, truth);
        snapshot = existing;
      } else {
        if (existing.state !== 'materialized' && existing.state !== 'parked') {
          throw new Error(`Workspace snapshot is ${existing.state}; it cannot start a new generation.`);
        }
        const priorState = existing.state;
        truth = {
          ...truth,
          recoveryRef: workspaceRecoveryRef(repo.id, input.packetId, existing.snapshotGeneration + 1),
        };
        await ensureWorkspaceRecoveryRef(repo.localPath, lane.worktreePath, truth);
        const generation = beginWorkspaceSnapshotGeneration({
          repositoryUuid: repo.id,
          packetId: input.packetId,
          missionId: existing.missionId,
          laneId: lane.id,
          originalPath: path.resolve(lane.worktreePath),
          branch: truth.branch,
          baseCommit: truth.baseCommit,
          headCommit: truth.headCommit,
          treeSha: truth.treeSha,
          recoveryRef: truth.recoveryRef,
          diffFingerprint: truth.diffFingerprint,
          dependencyRecipeKey,
          sessionIdentities,
          reservation: existing.reservation,
          creationId: `${input.operationId}:generation`,
          expectedState: priorState,
          expectedVersion: existing.version,
          expectedGeneration: existing.snapshotGeneration,
          receipt: {
            isolationKind: truth.isolationKind,
            laneId: lane.id,
            dependencyMode: dependencyMaterialization?.mode ?? null,
            dependencyLeaseId: dependencyMaterialization?.leaseId ?? null,
            dependencyGeneration: dependencyMaterialization?.generation ?? null,
            dependencyWorkspaceDevice: dependencyMaterialization?.workspaceDevice ?? null,
            dependencyWorkspaceInode: dependencyMaterialization?.workspaceInode ?? null,
          },
        });
        if (generation.status === 'missing' || generation.status === 'conflict') {
          throw new Error('Workspace snapshot generation supersession lost its compare-and-swap.');
        }
        snapshot = generation.record;
      }
      pinnedSnapshot = snapshot;
      const second = await deps.secondScan(lane.worktreePath, {
        allowedIgnoredPaths,
        allowedExternalSymlinks,
        requiredCopyBindings,
      });
      const comparison = compareWorkspaceStorageScans(first, second);
      if (comparison.state !== 'verified_clean' || !comparison.identical) {
        throw new Error('Workspace changed across its immutable snapshot boundary.');
      }
      const secondDependencyRecipeKey = await repoSetupBoundRecipeKey(
        repo,
        requiredCopyBindings,
        lane.worktreePath,
      );
      if (secondDependencyRecipeKey !== dependencyRecipeKey) {
        throw new Error('Workspace dependency recipe changed across its immutable snapshot boundary.');
      }
      snapshot = transition(snapshot, input.operationId, 'parkable', 'parkable', {
        firstFingerprint: first.fingerprint,
        secondFingerprint: second.fingerprint,
        dependencyMode: dependencyMaterialization?.mode ?? null,
        dependencyLeaseId: dependencyMaterialization?.leaseId ?? null,
        dependencyGeneration: dependencyMaterialization?.generation ?? null,
        dependencyWorkspaceDevice: dependencyMaterialization?.workspaceDevice ?? null,
        dependencyWorkspaceInode: dependencyMaterialization?.workspaceInode ?? null,
      });
      snapshot = transition(snapshot, input.operationId, 'hibernating', 'hibernating', {
        recoveryRef: truth.recoveryRef,
        beforeAvailableBytes: beforeStorage.availableBytes,
      });
      let dependencyRemountRequired = false;
      let preparedFingerprint = second.fingerprint;
      try {
        await assertBoundaryCurrent();
        await deps.parkExact({
          repoPath: repo.localPath,
          worktreeId,
          expectedPath: lane.worktreePath,
          expectedBranch: truth.branch,
          expectedHead: truth.headCommit,
          expectedSessionKey: lane.sessionKey,
          probeProcessQuiescence: deps.processProbe,
          ...boundaryGuards,
          prepareQuarantineSource: async (workspacePath) => {
            const boundaryScan = await deps.secondScan(workspacePath, {
              allowedIgnoredPaths,
              allowedExternalSymlinks,
              requiredCopyBindings,
            });
            if (boundaryScan.state !== 'verified_clean' || boundaryScan.fingerprint !== second.fingerprint) {
              throw new Error('Workspace changed at the final destructive boundary.');
            }
            const boundaryDependencyRecipeKey = await repoSetupBoundRecipeKey(
              registeredRepo,
              requiredCopyBindings,
              workspacePath,
            );
            if (boundaryDependencyRecipeKey !== dependencyRecipeKey) {
              throw new Error('Workspace dependency recipe changed at the final destructive boundary.');
            }
            preparedFingerprint = boundaryScan.fingerprint;
            if (dependencyMaterialization?.mode === 'image') {
              dependencyRemountRequired = true;
              await deps.detachDependencies(workspacePath, dependencyMaterialization);
              const detachedScan = await deps.secondScan(workspacePath, {
                allowedIgnoredPaths,
                allowedExternalSymlinks,
                requiredCopyBindings,
              });
              if (detachedScan.state !== 'verified_clean') {
                throw new Error('Detached workspace storage scan did not prove a clean rebuildable tree.');
              }
              preparedFingerprint = detachedScan.fingerprint;
            }
            await assertBoundaryCurrent();
          },
          quarantine: {
            snapshotFingerprint: snapshot.snapshotFingerprint,
            intent: 'park',
          },
          verifyQuarantinedClone: async (quarantinePath) => {
            const quarantinedScan = await deps.secondScan(quarantinePath, {
              quarantinedFrom: lane.worktreePath!,
              allowedIgnoredPaths,
              allowedExternalSymlinks,
              requiredCopyBindings,
            });
            if (quarantinedScan.state !== 'verified_clean'
              || quarantinedScan.fingerprint !== preparedFingerprint) {
              throw new Error('Quarantined copy-on-write clone changed after the snapshot boundary.');
            }
          },
        });
        if (await pathExists(lane.worktreePath)) throw new Error('Exact worktree path still exists after parking.');
      } catch (error) {
        if (dependencyRemountRequired && dependencyMaterialization
          && await pathExists(lane.worktreePath)) {
          try {
            await deps.restoreDependencies(repo.localPath, worktreeId, dependencyMaterialization);
          } catch (restoreError) {
            throw new Error(
              `Workspace parking failed and exact dependency remount was incomplete: ${compactError(restoreError)}`,
              { cause: error },
            );
          }
        }
        throw error;
      }
      await verifyImmutableWorkspaceTruth(repo.localPath, truth);
      const afterStorage = await deps.measureStorage(path.dirname(lane.worktreePath));
      snapshot = transition(snapshot, input.operationId, 'parked', 'parked', {
        afterAvailableBytes: afterStorage.availableBytes,
        reclaimedAvailableBytes: afterStorage.availableBytes - beforeStorage.availableBytes,
        logicalBytesBefore: beforeStorage.logicalBytes,
      });
      return { status: 'parked', snapshot };
        },
      );
    } catch (error) {
      const snapshot = repo
        ? await recordParkFailure(repo, input.packetId, input.operationId, error).catch(() => undefined)
        : undefined;
      return { status: 'refused', code: 'park_refused', note: compactError(error), snapshot };
    }
  });
}

export function scansMatchAfterQuarantine(before: WorkspaceScanReceipt, after: WorkspaceScanReceipt): boolean {
  return before.state === 'verified_clean'
    && after.state === 'verified_clean'
    && before.fingerprint === after.fingerprint;
}
